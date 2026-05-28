'use strict';

/**
 * Market Intelligence Agent
 *
 * Autonomous agent that reads the internet — crypto news, trend articles, sector analysis —
 * synthesizes what it learns using AI, builds actionable intelligence, and feeds that
 * intelligence back into strategy decisions, token discovery weighting, and self-evolution.
 *
 * Cycle:
 *   1. Fetch headlines + article snippets from multiple live sources
 *   2. Optionally fetch full article text for the top 3 stories
 *   3. AI synthesis → structured IntelligenceReport
 *   4. Store report in portfolio.intelligence (persisted across restarts)
 *   5. Expose helpers the rest of the bot consumes every scan cycle
 */

const axios = require('axios');
const logger = require('../utils/logger');

// ── RSS helpers ─────────────────────────────────────────────────────────────

const SOURCES = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'TheBlock', url: 'https://www.theblock.co/rss.xml' },
  { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/' },
];

const REDDIT_URLS = [
  'https://www.reddit.com/r/CryptoCurrency/hot.json?limit=25',
  'https://www.reddit.com/r/defi/hot.json?limit=15',
  'https://www.reddit.com/r/solana/hot.json?limit=10',
  'https://www.reddit.com/r/bnbchainofficial/hot.json?limit=10',
];

const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular';
const COINGECKO_TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
const DEFILLAMA_NEWS_URL = 'https://defillama.com/';

function parseRssItems(xml, sourceName, maxItems = 15) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/gi;
  const titleRx = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
  const linkRx = /<link>([\s\S]*?)<\/link>/i;
  const descRx = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i;
  const dateRx = /<pubDate>([\s\S]*?)<\/pubDate>/i;

  let m;
  while ((m = itemRx.exec(xml)) !== null && items.length < maxItems) {
    const block = m[1];
    const title = (block.match(titleRx)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const url = (block.match(linkRx)?.[1] || '').trim();
    const desc = (block.match(descRx)?.[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 400);
    const date = (block.match(dateRx)?.[1] || '').trim();
    if (title && url) {
      items.push({ title, url, description: desc, publishedAt: date, source: sourceName });
    }
  }
  return items;
}

async function fetchRssSource(source) {
  try {
    const res = await axios.get(source.url, {
      timeout: 12000,
      headers: { 'User-Agent': 'DEXBot-Intelligence/1.0' },
      responseType: 'text',
    });
    return parseRssItems(String(res.data || ''), source.name, 15);
  } catch (err) {
    logger.debug(`[Intelligence] RSS fetch failed for ${source.name}: ${err.message}`);
    return [];
  }
}

async function fetchRedditPosts() {
  const posts = [];
  for (const url of REDDIT_URLS) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'DEXBot-Intelligence/1.0' },
      });
      const children = res.data?.data?.children || [];
      for (const child of children.slice(0, 10)) {
        const d = child.data;
        if (!d?.title) continue;
        posts.push({
          title: d.title,
          url: `https://reddit.com${d.permalink || ''}`,
          description: String(d.selftext || '').slice(0, 300),
          score: d.score || 0,
          comments: d.num_comments || 0,
          source: `r/${d.subreddit || 'crypto'}`,
          publishedAt: new Date((d.created_utc || 0) * 1000).toISOString(),
        });
      }
    } catch (err) {
      logger.debug(`[Intelligence] Reddit fetch failed: ${err.message}`);
    }
  }
  return posts;
}

async function fetchCryptoCompareHeadlines() {
  try {
    const res = await axios.get(CRYPTOCOMPARE_URL, { timeout: 10000 });
    const items = Array.isArray(res.data?.Data)
      ? res.data.Data
      : Array.isArray(res.data?.Data?.List)
        ? res.data.Data.List
        : [];
    return items.slice(0, 20).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      description: item.body ? String(item.body).slice(0, 400) : '',
      source: item.source_info?.name || 'CryptoCompare',
      publishedAt: new Date((item.published_on || 0) * 1000).toISOString(),
      tags: String(item.categories || '').split('|').filter(Boolean),
    }));
  } catch (err) {
    logger.debug(`[Intelligence] CryptoCompare fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchCoinGeckoTrending() {
  try {
    const res = await axios.get(COINGECKO_TRENDING_URL, { timeout: 10000 });
    const coins = res.data?.coins || [];
    return coins.slice(0, 10).map((c) => ({
      symbol: String(c.item?.symbol || '').toUpperCase(),
      name: c.item?.name || '',
      rank: c.item?.market_cap_rank || null,
      score: c.item?.score || 0,
      platforms: c.item?.platforms || {},
    }));
  } catch (err) {
    logger.debug(`[Intelligence] CoinGecko trending fetch failed: ${err.message}`);
    return [];
  }
}

// ── Article full-text fetcher (best-effort) ──────────────────────────────────

async function fetchArticleSnippet(url, maxChars = 800) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 DEXBot-Intelligence/1.0' },
      responseType: 'text',
    });
    const html = String(res.data || '');
    // Strip scripts, styles, and all tags
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text.slice(0, maxChars);
  } catch (_) {
    return '';
  }
}

// ── AI Synthesis ─────────────────────────────────────────────────────────────

function buildSynthesisPrompt(articles, trendingCoins, currentStats, openPositions) {
  // Keep prompt compact to stay within Groq token limits
  const articleBlocks = articles.slice(0, 20).map((a, i) =>
    `[${i + 1}] "${a.title}" (${a.source})`
  ).join('\n');

  const trendingBlock = trendingCoins.length
    ? `TRENDING: ${trendingCoins.map((c) => c.symbol).join(', ')}`
    : '';

  const statsBlock = currentStats
    ? `BOT STATS: trades=${currentStats.closedTrades||0} WR=${currentStats.closedTrades > 0 ? ((currentStats.wins||0)/(currentStats.closedTrades||1)*100).toFixed(0) : 0}% PF=${Number(currentStats.profitFactor||0).toFixed(2)}`
    : '';

  return `You are a crypto quant analyst. Analyze these ${articles.length} news headlines and market data, then return a JSON intelligence report.

HEADLINES (${new Date().toUTCString()}):
${articleBlocks}

${trendingBlock}
${statsBlock}
OPEN POSITIONS: ${openPositions || 'none'}

Return ONLY valid JSON (no markdown, no code fences):
{
  "macroSentiment": "bullish|bearish|neutral|volatile",
  "sentimentScore": 0-100,
  "hotSectors": ["AI","DeFi","..."],
  "coldSectors": ["NFT","..."],
  "narrativeThemes": ["theme1","theme2"],
  "watchlistTokens": [{"symbol":"XYZ","chain":"bsc|kucoin|solana|any","confidence":0-100,"reason":"brief reason","articleSource":"source"}],
  "avoidTokens": [{"symbol":"ABC","reason":"brief reason"}],
  "strategyRecommendation": {"preferredType":"momentum|swing|both","aggressiveness":"conservative|normal|aggressive","reason":"brief"},
  "riskWarnings": ["warning1","warning2"],
  "selfImprovementInsights": [{"observation":"...","suggestedAction":"...","urgency":"high|medium|low"}],
  "summary": "One sentence market summary"
}`;
}

async function callCerebrasForSynthesis(prompt) {
  const cerebrasKey = process.env.CEREBRAS_API_KEY || '';
  if (!cerebrasKey) return null;

  const fullPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON.`;
  try {
    const res = await axios.post(
      'https://api.cerebras.ai/v1/chat/completions',
      {
        model: process.env.CEREBRAS_INTELLIGENCE_MODEL || process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.3,
        max_tokens: 1500,
      },
      {
        headers: { Authorization: `Bearer ${cerebrasKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn(`[Intelligence] Cerebras synthesis failed: ${err.message}`);
    return null;
  }
}

async function callMistralForSynthesis(prompt) {
  const mistralKey = process.env.MISTRAL_API_KEY || '';
  if (!mistralKey) return null;

  const fullPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON.`;
  try {
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: process.env.MISTRAL_INTELLIGENCE_MODEL || process.env.MISTRAL_MODEL || 'mistral-small-latest',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.3,
        max_tokens: 1500,
      },
      {
        headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
        timeout: 45000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn(`[Intelligence] Mistral synthesis failed: ${err.message}`);
    return null;
  }
}

async function callGroqForSynthesis(prompt) {
  const groqKey = process.env.GROQ_API_KEY || '';
  if (!groqKey) return null;

  const fullPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: process.env.GROQ_INTELLIGENCE_MODEL || 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: fullPrompt }],
          temperature: 0.3,
          max_tokens: 1500,
        },
        {
          headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          timeout: 45000,
        }
      );
      const text = res.data?.choices?.[0]?.message?.content || '';
      if (!text) return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const delayMs = attempt * 15000; // 15s, 30s
        logger.warn(`[Intelligence] Groq 429 rate limit — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      logger.warn(`[Intelligence] Groq synthesis failed: ${err.message}`);
      return null;
    }
  }
  return null;
}

async function callNvidiaForSynthesis(prompt) {
  const nvidiaKey = process.env.NVIDIA_API_KEY || '';
  if (!nvidiaKey) return null;

  const fullPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation — just the raw JSON.`;
  try {
    const res = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        model: 'meta/llama-3.3-70b-instruct',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.3,
        max_tokens: 2000,
      },
      {
        headers: { Authorization: `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
        timeout: 45000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn(`[Intelligence] NVIDIA synthesis failed: ${err.message}`);
    return null;
  }
}

async function callGeminiForSynthesis(prompt) {
  const geminiKey = process.env.GEMINI_API_KEY || '';
  if (!geminiKey) return null;

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response?.text() || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn(`[Intelligence] Gemini synthesis failed: ${err.message}`);
    return null;
  }
}

async function synthesizeWithAI(articles, trendingCoins, currentStats, openPositions) {
  const prompt = buildSynthesisPrompt(articles, trendingCoins, currentStats, openPositions);

  // 1. Cerebras: 1M tokens/day, fastest, own rate pool
  const cerebrasResult = await callCerebrasForSynthesis(prompt);
  if (cerebrasResult && cerebrasResult.macroSentiment) {
    cerebrasResult._synthesizedBy = 'cerebras';
    return cerebrasResult;
  }

  // 2. Groq (8b-instant, separate pool from trading AI)
  const groqResult = await callGroqForSynthesis(prompt);
  if (groqResult && groqResult.macroSentiment) {
    groqResult._synthesizedBy = 'groq';
    return groqResult;
  }

  // 3. NVIDIA fallback
  const nvidiaResult = await callNvidiaForSynthesis(prompt);
  if (nvidiaResult && nvidiaResult.macroSentiment) {
    nvidiaResult._synthesizedBy = 'nvidia';
    return nvidiaResult;
  }

  // 4. Mistral: 1B tokens/month, strong reasoning
  const mistralResult = await callMistralForSynthesis(prompt);
  if (mistralResult && mistralResult.macroSentiment) {
    mistralResult._synthesizedBy = 'mistral';
    return mistralResult;
  }

  // 5. Last resort: Gemini
  const geminiResult = await callGeminiForSynthesis(prompt);
  if (geminiResult && geminiResult.macroSentiment) {
    geminiResult._synthesizedBy = 'gemini';
    return geminiResult;
  }

  return null;
}

// ── Intelligence Report validation ───────────────────────────────────────────

function sanitizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const validSentiments = new Set(['bullish', 'bearish', 'neutral', 'volatile']);
  const macroSentiment = validSentiments.has(raw.macroSentiment) ? raw.macroSentiment : 'neutral';
  const sentimentScore = Math.max(0, Math.min(100, Number(raw.sentimentScore || 50)));
  const hotSectors = Array.isArray(raw.hotSectors) ? raw.hotSectors.map(String).slice(0, 10) : [];
  const coldSectors = Array.isArray(raw.coldSectors) ? raw.coldSectors.map(String).slice(0, 10) : [];
  const narrativeThemes = Array.isArray(raw.narrativeThemes) ? raw.narrativeThemes.map(String).slice(0, 10) : [];

  const watchlistTokens = Array.isArray(raw.watchlistTokens)
    ? raw.watchlistTokens
        .filter((t) => t && typeof t.symbol === 'string' && t.symbol.length <= 20)
        .map((t) => ({
          symbol: String(t.symbol).toUpperCase().trim(),
          chain: String(t.chain || 'any').toLowerCase(),
          confidence: Math.max(0, Math.min(100, Number(t.confidence || 50))),
          reason: String(t.reason || '').slice(0, 200),
          articleSource: String(t.articleSource || '').slice(0, 100),
        }))
        .slice(0, 20)
    : [];

  const avoidTokens = Array.isArray(raw.avoidTokens)
    ? raw.avoidTokens
        .filter((t) => t && typeof t.symbol === 'string')
        .map((t) => ({ symbol: String(t.symbol).toUpperCase().trim(), reason: String(t.reason || '').slice(0, 200) }))
        .slice(0, 20)
    : [];

  const strategyRecommendation = raw.strategyRecommendation && typeof raw.strategyRecommendation === 'object'
    ? {
        preferredType: ['momentum', 'swing', 'both'].includes(raw.strategyRecommendation.preferredType) ? raw.strategyRecommendation.preferredType : 'both',
        aggressiveness: ['conservative', 'normal', 'aggressive'].includes(raw.strategyRecommendation.aggressiveness) ? raw.strategyRecommendation.aggressiveness : 'normal',
        reason: String(raw.strategyRecommendation.reason || '').slice(0, 300),
      }
    : { preferredType: 'both', aggressiveness: 'normal', reason: '' };

  const riskWarnings = Array.isArray(raw.riskWarnings) ? raw.riskWarnings.map(String).slice(0, 10) : [];

  const selfImprovementInsights = Array.isArray(raw.selfImprovementInsights)
    ? raw.selfImprovementInsights
        .filter((i) => i && typeof i.observation === 'string')
        .map((i) => ({
          observation: String(i.observation).slice(0, 300),
          suggestedAction: String(i.suggestedAction || '').slice(0, 300),
          urgency: ['high', 'medium', 'low'].includes(i.urgency) ? i.urgency : 'low',
        }))
        .slice(0, 10)
    : [];

  return {
    macroSentiment,
    sentimentScore,
    hotSectors,
    coldSectors,
    narrativeThemes,
    watchlistTokens,
    avoidTokens,
    strategyRecommendation,
    riskWarnings,
    selfImprovementInsights,
    summary: String(raw.summary || '').slice(0, 600),
    _synthesizedBy: raw._synthesizedBy || 'unknown',
    _generatedAt: Date.now(),
    _articleCount: 0, // filled by caller
  };
}

// ── Main class ───────────────────────────────────────────────────────────────

class MarketIntelligenceAgent {
  constructor({ portfolio, config, agentMemory = null, marketState = null }) {
    this.portfolio = portfolio;
    this.config = config;
    this.agentMemory = agentMemory;
    this.marketState = marketState;
    this.locked = false;
    this.lastRunAt = 0;
    // C6 (Phase C): documented previously-silent clamp. Floor of 15min
    // prevents rate-limit churn against RSS+LLM providers; values below 15
    // are deliberately rounded up. Set INTELLIGENCE_INTERVAL_MINUTES=15 (or
    // higher) explicitly to avoid surprise on operator-shorter envs.
    this.intervalMs = Math.max(15 * 60_000, Number(process.env.INTELLIGENCE_INTERVAL_MINUTES || 30) * 60_000);
  }

  /** Access (and lazily initialise) the intelligence store in portfolio state */
  getStore() {
    if (!this.portfolio.intelligence || typeof this.portfolio.intelligence !== 'object') {
      this.portfolio.intelligence = { report: null, lastRunAt: 0, runCount: 0 };
    }
    return this.portfolio.intelligence;
  }

  /** Return the latest report, or null if never generated */
  getReport() {
    return this.getStore().report || null;
  }

  /**
   * Check if a symbol+chain is on the AI watchlist.
   * Returns { matched: true, confidence, reason } or { matched: false }
   */
  isOnWatchlist(symbol, chain) {
    const report = this.getReport();
    if (!report) return { matched: false };
    const sym = String(symbol || '').toUpperCase();
    const ch = String(chain || '').toLowerCase();
    const entry = report.watchlistTokens?.find(
      (t) => t.symbol === sym && (t.chain === 'any' || t.chain === ch || !t.chain)
    );
    if (!entry) return { matched: false };
    return { matched: true, confidence: entry.confidence, reason: entry.reason };
  }

  /**
   * Check if a symbol is on the avoid list.
   */
  isOnAvoidList(symbol) {
    const report = this.getReport();
    if (!report) return { avoid: false };
    const sym = String(symbol || '').toUpperCase();
    const entry = report.avoidTokens?.find((t) => t.symbol === sym);
    if (!entry) return { avoid: false };
    return { avoid: true, reason: entry.reason };
  }

  /**
   * Return a score boost (0-30 confidence points) if the sector or themes match.
   * Called per-token during evaluateForStrategy.
   */
  getSectorBoostPct(tokenData) {
    const report = this.getReport();
    if (!report) return 0;

    const symbol = String(tokenData?.symbol || '').toUpperCase();
    const name = String(tokenData?.name || '').toLowerCase();
    const tags = Array.isArray(tokenData?.tags) ? tokenData.tags.map((t) => String(t).toLowerCase()) : [];

    // Direct watchlist hit → strong boost
    const watchlistHit = report.watchlistTokens?.find((t) => t.symbol === symbol);
    if (watchlistHit) return Math.min(30, Math.max(10, Math.round(watchlistHit.confidence / 4)));

    // Sector keyword overlap
    const allText = [name, ...tags].join(' ');
    const hotMatch = (report.hotSectors || []).some((sector) =>
      allText.includes(sector.toLowerCase().replace(/[\s_-]/g, ''))
    );
    if (hotMatch) return 8;

    return 0;
  }

  /**
   * Returns macro aggressiveness multiplier for position sizing.
   * bullish+aggressive → 1.1, bearish+conservative → 0.75, else 1.0
   */
  getMacroSizeMultiplier() {
    const regime = String(this.marketState?.macroRegime?.regime || '').toLowerCase();
    if (regime === 'risk_off') return 0.50;
    if (regime === 'capitulation') return 0.30;
    if (regime === 'reversal_pending') return 0.80;
    if (regime === 'bull_pullback') return 1.00;

    const report = this.getReport();
    if (!report) return 1.0;
    const { macroSentiment, strategyRecommendation } = report;
    if (macroSentiment === 'bullish' && strategyRecommendation?.aggressiveness === 'aggressive') return 1.10;
    if (macroSentiment === 'bearish' || strategyRecommendation?.aggressiveness === 'conservative') return 0.80;
    if (macroSentiment === 'volatile') return 0.85;
    return 1.0;
  }

  /**
   * Format intelligence context for self-evolution and AI prompts.
   */
  getContextForEvolution() {
    const report = this.getReport();
    if (!report) return null;

    return {
      macroSentiment: report.macroSentiment,
      sentimentScore: report.sentimentScore,
      hotSectors: report.hotSectors,
      coldSectors: report.coldSectors,
      narrativeThemes: report.narrativeThemes,
      strategyRecommendation: report.strategyRecommendation,
      riskWarnings: report.riskWarnings,
      selfImprovementInsights: report.selfImprovementInsights,
      watchlistCount: (report.watchlistTokens || []).length,
      avoidCount: (report.avoidTokens || []).length,
      summary: report.summary,
      ageMinutes: report._generatedAt ? Math.round((Date.now() - report._generatedAt) / 60000) : null,
    };
  }

  /**
   * Main intelligence cycle. Called on a timer.
   * Fetches articles, trending coins, synthesizes intelligence report with AI.
   */
  async runCycle(currentStats, openPositionSummary) {
    if (!this.config.intelligence?.enabled && process.env.INTELLIGENCE_ENABLED === 'false') {
      return { skipped: true, reason: 'disabled' };
    }

    const now = Date.now();
    if (this.locked) return { skipped: true, reason: 'locked' };
    if (this.lastRunAt > 0 && now - this.lastRunAt < this.intervalMs) {
      return { skipped: true, reason: 'interval' };
    }

    this.locked = true;
    this.lastRunAt = now;

    try {
      logger.info('[Intelligence] Starting market intelligence cycle — reading the internet...');

      // ── 1. Gather raw data ────────────────────────────────────────────────
      const [rssResults, redditPosts, ccHeadlines, trendingCoins] = await Promise.allSettled([
        Promise.all(SOURCES.map(fetchRssSource)).then((arrays) => arrays.flat()),
        fetchRedditPosts(),
        fetchCryptoCompareHeadlines(),
        fetchCoinGeckoTrending(),
      ]);

      const rssArticles = rssResults.status === 'fulfilled' ? rssResults.value : [];
      const reddit = redditPosts.status === 'fulfilled' ? redditPosts.value : [];
      const cc = ccHeadlines.status === 'fulfilled' ? ccHeadlines.value : [];
      const trending = trendingCoins.status === 'fulfilled' ? trendingCoins.value : [];

      // Merge & deduplicate by title similarity
      const allArticles = [...rssArticles, ...cc, ...reddit];
      const seen = new Set();
      const deduped = allArticles.filter((a) => {
        const key = String(a.title || '').toLowerCase().slice(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      logger.info(`[Intelligence] Gathered ${deduped.length} articles + ${trending.length} trending coins`);

      if (deduped.length < 3 && trending.length === 0) {
        logger.warn('[Intelligence] Too few articles fetched — skipping synthesis');
        this.locked = false;
        return { skipped: true, reason: 'insufficient_data' };
      }

      // ── 2. Optionally fetch full text for top 3 high-engagement articles ──
      const topByEngagement = deduped
        .filter((a) => a.url && a.url.startsWith('http'))
        .slice(0, 5);

      const enrichedTop = await Promise.all(
        topByEngagement.map(async (a) => {
          const snippet = await fetchArticleSnippet(a.url, 600);
          return { ...a, fullSnippet: snippet || a.description || '' };
        })
      );

      // Replace first N articles with enriched versions
      const enrichedMap = new Map(enrichedTop.map((a) => [a.url, a]));
      const finalArticles = deduped.map((a) => enrichedMap.get(a.url) || a);

      // ── 3. AI Synthesis ───────────────────────────────────────────────────
      const rawReport = await synthesizeWithAI(finalArticles, trending, currentStats, openPositionSummary);

      if (!rawReport) {
        logger.warn('[Intelligence] AI synthesis returned no result — keeping previous report');
        this.locked = false;
        return { skipped: false, synthesized: false, reason: 'ai_failed' };
      }

      const report = sanitizeReport(rawReport);
      if (!report) {
        logger.warn('[Intelligence] Report failed validation');
        this.locked = false;
        return { skipped: false, synthesized: false, reason: 'validation_failed' };
      }

      report._articleCount = finalArticles.length;

      // ── 4. Store ──────────────────────────────────────────────────────────
      const store = this.getStore();
      store.report = report;
      store.lastRunAt = now;
      store.runCount = (store.runCount || 0) + 1;

      // ── 5. Log summary ────────────────────────────────────────────────────
      logger.warn(`[Intelligence] Report ready | sentiment=${report.macroSentiment}(${report.sentimentScore}) | hotSectors=[${report.hotSectors.join(',')}] | watchlist=${report.watchlistTokens.length} | avoid=${report.avoidTokens.length} | by=${report._synthesizedBy}`);
      if (report.summary) logger.info(`[Intelligence] ${report.summary}`);
      if (report.riskWarnings?.length) {
        report.riskWarnings.forEach((w) => logger.warn(`[Intelligence] RISK: ${w}`));
      }
      if (report.selfImprovementInsights?.length) {
        report.selfImprovementInsights
          .filter((i) => i.urgency === 'high')
          .forEach((i) => logger.warn(`[Intelligence] SELF-IMPROVE: ${i.observation} → ${i.suggestedAction}`));
      }

      // ── 6. Feed memory: strategy discoveries + avoid list + deep research ─
      if (this.agentMemory) {
        // Record strategy discoveries from self-improvement insights
        if (Array.isArray(report.selfImprovementInsights)) {
          for (const insight of report.selfImprovementInsights) {
            this.agentMemory.recordDiscovery({
              source: `intelligence/${report._synthesizedBy}`,
              theme: report.hotSectors?.[0] || 'general',
              sector: report.hotSectors?.[0] || '',
              insight: insight.observation || '',
              proposedAction: insight.suggestedAction || '',
              urgency: insight.urgency || 'medium',
            });
          }
        }

        // Blacklist avoid tokens in memory too (12h)
        if (Array.isArray(report.avoidTokens)) {
          for (const t of report.avoidTokens.slice(0, 10)) {
            this.agentMemory.addToBlacklist(t.symbol, `Intelligence: ${t.reason}`, 12 * 3_600_000, 'intelligence');
          }
        }

        // Store general market knowledge
        if (report.summary) {
          this.agentMemory.addKnowledge({
            category: 'market_macro',
            insight: report.summary,
            source: `intelligence/${report._synthesizedBy}`,
            confidence: report.sentimentScore || 50,
          });
        }

        // Deep research on top watchlist tokens (non-blocking, staggered to avoid rate limits)
        if (Array.isArray(report.watchlistTokens) && report.watchlistTokens.length > 0) {
          const topWatchlist = report.watchlistTokens.slice(0, 3);
          let delay = 5000;
          for (const token of topWatchlist) {
            const d = delay;
            setTimeout(() => {
              this.agentMemory.deepResearchToken({
                symbol: token.symbol,
                chain: token.chain || 'any',
                confidence: token.confidence || 50,
                articleSource: token.articleSource || 'intelligence',
                reason: token.reason || '',
              }).catch(() => {});
            }, d);
            delay += 8000; // stagger each deep research by 8s
          }
        }

        await this.agentMemory.saveIfDirty();
      }

      return { skipped: false, synthesized: true, report };
    } catch (err) {
      logger.error(`[Intelligence] Cycle error: ${err.message}`);
      return { skipped: false, synthesized: false, reason: err.message };
    } finally {
      this.locked = false;
    }
  }
}

module.exports = MarketIntelligenceAgent;
