'use strict';

/**
 * AgentMemory — persistent long-term memory across restarts.
 *
 * Stores:
 *   tradeLessons      — what went wrong/right on specific trades, with conditions
 *   strategyDiscoveries — new strategy ideas derived from news/intelligence
 *   tokenBlacklist    — per-token avoidance with expiry
 *   tokenPreferences  — per-token boosts from deep research
 *   evolutionOutcomes — did a self-evolution patch improve things?
 *   knowledgeBase     — general market insights from intelligence cycles
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const SqlCoordination = require('../utils/sqlCoordination');
const { mergeFromRemote: pureMergeFromRemote } = require('./memory/merge');
const _blacklistModule = require('./memory/blacklist');
const _statsModule = require('./memory/stats');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const BOT_DATA_DIR = process.env.BOT_DATA_DIR || 'data';
const MEMORY_PATH = path.join(PROJECT_ROOT, BOT_DATA_DIR, 'agent-memory.json');
const MAX_LESSONS = 300;
const MAX_DISCOVERIES = 100;
const MAX_KNOWLEDGE = 200;
const MAX_EVOLUTION_LOG = 50;

function stableKnowledgeId(item = {}) {
  const category = String(item.category || 'general').trim().toLowerCase();
  const source = String(item.source || '').trim().toLowerCase();
  const insight = String(item.insight || '').trim().toLowerCase();
  return `knowledge:${crypto.createHash('sha1').update(`${category}|${source}|${insight}`).digest('hex').slice(0, 16)}`;
}

class AgentMemory {
  constructor({ logger, config = {} } = {}) {
    this.logger = logger || console;
    this.config = config || {};
    this.sql = new SqlCoordination({
      logger: this.logger,
      botId: `${process.env.BOT_PROFILE || 'bot'}:${process.pid}`,
    });
    this.data = {
      version: 2,
      tradeLessons: [],
      strategyDiscoveries: [],
      tokenBlacklist: {},
      tokenPreferences: {},
      evolutionOutcomes: [],
      knowledgeBase: [],
      regimeWinRates: {},
      chainPatterns: {},
      tokenAgePatterns: {},
      exitClassificationStats: {},
      symbolWinRates: {},
      indicatorPatterns: {},
      aiUsage: { date: new Date().toISOString().slice(0, 10), lessonCalls: 0, deepResearchCalls: 0 },
    };
    this._dirty = false;
    this._saving = false;
    this._sqlVer = null;
  }

  // ── Load / Save ──────────────────────────────────────────────────────────

  async load() {
    // SQL-first (shared across paper/live), fallback to disk.
    try {
      const sqlRes = await this.sql.kvGet('agent-memory:shared');
      if (sqlRes.ok && sqlRes.found && sqlRes.value) {
        const parsed = JSON.parse(sqlRes.value);
        if (parsed && parsed.version) {
          this.data = {
            version: 2,
            tradeLessons: Array.isArray(parsed.tradeLessons) ? parsed.tradeLessons : [],
            strategyDiscoveries: Array.isArray(parsed.strategyDiscoveries) ? parsed.strategyDiscoveries : [],
            tokenBlacklist: (parsed.tokenBlacklist && typeof parsed.tokenBlacklist === 'object') ? parsed.tokenBlacklist : {},
            tokenPreferences: (parsed.tokenPreferences && typeof parsed.tokenPreferences === 'object') ? parsed.tokenPreferences : {},
            evolutionOutcomes: Array.isArray(parsed.evolutionOutcomes) ? parsed.evolutionOutcomes : [],
            knowledgeBase: Array.isArray(parsed.knowledgeBase) ? parsed.knowledgeBase : [],
            regimeWinRates: (parsed.regimeWinRates && typeof parsed.regimeWinRates === 'object') ? parsed.regimeWinRates : {},
            chainPatterns: (parsed.chainPatterns && typeof parsed.chainPatterns === 'object') ? parsed.chainPatterns : {},
            tokenAgePatterns: (parsed.tokenAgePatterns && typeof parsed.tokenAgePatterns === 'object') ? parsed.tokenAgePatterns : {},
            exitClassificationStats: (parsed.exitClassificationStats && typeof parsed.exitClassificationStats === 'object') ? parsed.exitClassificationStats : {},
          };
          this._sqlVer = sqlRes.ver || null;
          this._pruneExpired();
          this.logger.info(`[AgentMemory/SQL] Loaded shared memory: ${this.data.tradeLessons.length} lessons, ${this.data.strategyDiscoveries.length} discoveries, ${Object.keys(this.data.tokenBlacklist).length} blacklisted`);
          return;
        }
      }
    } catch (err) {
      this.logger.warn(`[AgentMemory/SQL] Load error (fallback to disk): ${err.message}`);
    }

    try {
      const raw = await fs.readFile(MEMORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version) {
        this.data = {
          version: 2,
          tradeLessons: Array.isArray(parsed.tradeLessons) ? parsed.tradeLessons : [],
          strategyDiscoveries: Array.isArray(parsed.strategyDiscoveries) ? parsed.strategyDiscoveries : [],
          tokenBlacklist: (parsed.tokenBlacklist && typeof parsed.tokenBlacklist === 'object') ? parsed.tokenBlacklist : {},
          tokenPreferences: (parsed.tokenPreferences && typeof parsed.tokenPreferences === 'object') ? parsed.tokenPreferences : {},
          evolutionOutcomes: Array.isArray(parsed.evolutionOutcomes) ? parsed.evolutionOutcomes : [],
          knowledgeBase: Array.isArray(parsed.knowledgeBase) ? parsed.knowledgeBase : [],
          regimeWinRates: (parsed.regimeWinRates && typeof parsed.regimeWinRates === 'object') ? parsed.regimeWinRates : {},
          chainPatterns: (parsed.chainPatterns && typeof parsed.chainPatterns === 'object') ? parsed.chainPatterns : {},
          tokenAgePatterns: (parsed.tokenAgePatterns && typeof parsed.tokenAgePatterns === 'object') ? parsed.tokenAgePatterns : {},
          exitClassificationStats: (parsed.exitClassificationStats && typeof parsed.exitClassificationStats === 'object') ? parsed.exitClassificationStats : {},
          symbolWinRates: (parsed.symbolWinRates && typeof parsed.symbolWinRates === 'object') ? parsed.symbolWinRates : {},
        };
        this._pruneExpired();
        this.logger.info(`[AgentMemory] Loaded: ${this.data.tradeLessons.length} lessons, ${this.data.strategyDiscoveries.length} discoveries, ${Object.keys(this.data.tokenBlacklist).length} blacklisted`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn(`[AgentMemory] Load error (starting fresh): ${err.message}`);
      }
    }
  }

  async save() {
    if (this._saving) return;
    this._saving = true;
    try {
      // Best-effort SQL save with optimistic concurrency + merge.
      const savedToSql = await this._saveToSqlShared();
      if (savedToSql) {
        this._dirty = false;
        return;
      }

      const dir = path.dirname(MEMORY_PATH);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(MEMORY_PATH, JSON.stringify(this.data, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      this.logger.warn(`[AgentMemory] Save error: ${err.message}`);
    } finally {
      this._saving = false;
    }
  }

  async saveIfDirty() {
    if (this._dirty) await this.save();
  }

  _mergeFromRemote(remote) {
    if (!remote || typeof remote !== 'object') return;
    // Week 2 (re-landed in Week 5): delegate to pure memory/merge.js.
    // This is the bug-class blocker for 2026-05-16 silent wipe of 6/13 fields:
    // the pure merge handles ALL DATA_SHAPE_KEYS (enforced by reflection test).
    const normalizeAiUsage = (v = {}) => ({
      date: v.date || new Date().toISOString().slice(0, 10),
      lessonCalls: Number(v.lessonCalls) || 0,
      deepResearchCalls: Number(v.deepResearchCalls) || 0,
    });
    const mergeAiUsage = (a = {}, b = {}) => {
      const aNorm = normalizeAiUsage(a);
      const bNorm = normalizeAiUsage(b);
      // Same date: sum; different date: keep newer date's counters.
      if (aNorm.date === bNorm.date) {
        return {
          date: aNorm.date,
          lessonCalls: aNorm.lessonCalls + bNorm.lessonCalls,
          deepResearchCalls: aNorm.deepResearchCalls + bNorm.deepResearchCalls,
        };
      }
      return aNorm.date > bNorm.date ? aNorm : bNorm;
    };
    this.data = pureMergeFromRemote({
      current: this.data,
      remote,
      caps: { MAX_LESSONS, MAX_DISCOVERIES, MAX_KNOWLEDGE, MAX_EVOLUTION_LOG },
      helpers: { stableKnowledgeId, normalizeAiUsage, mergeAiUsage },
    });
    this._pruneExpired();
  }

  async _saveToSqlShared() {
    try {
      // Try optimistic write.
      const payload = JSON.stringify(this.data);
      if (this._sqlVer) {
        const put = await this.sql.kvPut('agent-memory:shared', payload, { expectedVer: this._sqlVer });
        if (put.ok) return true;
        if (put.reason !== 'version_conflict') return false;
      }

      // Conflict: reload, merge, then unconditional put (or retry optimistic).
      const latest = await this.sql.kvGet('agent-memory:shared');
      if (latest.ok && latest.found && latest.value) {
        try {
          const remote = JSON.parse(latest.value);
          this._mergeFromRemote(remote);
        } catch (_) {
          // ignore
        }
      }

      // Store merged state. (Unconditional to avoid infinite conflict loops.)
      const finalPayload = JSON.stringify(this.data);
      const put2 = await this.sql.kvPut('agent-memory:shared', finalPayload);
      if (put2.ok) {
        // Refresh ver for next optimistic update.
        const reread = await this.sql.kvGet('agent-memory:shared');
        if (reread.ok && reread.found) this._sqlVer = reread.ver || null;
        return true;
      }
    } catch (err) {
      this.logger.warn(`[AgentMemory/SQL] Save error (fallback to disk): ${err.message}`);
    }
    return false;
  }

  // ── Trade Lessons ────────────────────────────────────────────────────────

  /**
   * Record a lesson from a closed trade.
   * Called after loss (or notable win) with the position's entry conditions.
   */
  recordLesson({ symbol, chain, strategy, entryConditions, outcome, pnlUsd, pnlPct, reason, lesson, entryRegime, holdMinutes }) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      botProfile: process.env.BOT_PROFILE || 'unknown',
      symbol: String(symbol || '').toUpperCase(),
      chain: String(chain || 'unknown'),
      strategy: String(strategy || 'momentum'),
      entryConditions: entryConditions || {},
      outcome: outcome === 'win' ? 'win' : 'loss',
      pnlUsd: Number(pnlUsd || 0),
      pnlPct: Number(pnlPct || 0),
      reason: String(reason || ''),
      lesson: String(lesson || ''),
      hitCount: 0,
      entryRegime: String(entryRegime || 'unknown'),
      holdMinutes: Number(holdMinutes || 0),
    };

    this.data.tradeLessons.unshift(entry);
    if (this.data.tradeLessons.length > MAX_LESSONS) {
      this.data.tradeLessons = this.data.tradeLessons.slice(0, MAX_LESSONS);
    }

    // Counter buckets extracted to src/agent/memory/stats.js (Week 7 Track C, 2026-05-17).
    // Delegates symbol/regime/chain/tokenAge/exitClassification updates in one call.
    const exitCode = String(entryConditions?.exitClassification || 'unknown');
    const tokenAgeBucket = entryConditions?.tokenAgeBucket || 'unknown';
    _statsModule.recordTradeOutcome(this.data, entry, {
      ts: entry.ts,
      tokenAgeBucket,
      exitClassification: exitCode,
    });
    entry.exitClassification = exitCode;

    this._dirty = true;
    this.logger.info(`[AgentMemory] Lesson recorded for ${entry.symbol} [${entry.outcome} ${entry.pnlUsd >= 0 ? '+' : ''}$${entry.pnlUsd.toFixed(2)}]: ${entry.lesson.slice(0, 100)}`);
  }

  /**
   * Check if current token/conditions match past lessons.
   * Returns { blocked: bool, reason: string, matchedLessons: [] }
   */
  checkLessons(symbol, conditions = {}) {
    const sym = String(symbol || '').toUpperCase();
    const lessons = this.data.tradeLessons;
    const matched = [];
    let blockScore = 0;

    for (const lesson of lessons) {
      if (lesson.outcome !== 'loss') continue;

      let score = 0;
      // Same symbol
      if (lesson.symbol === sym) score += 40;

      // Similar RSI range (within 10)
      const ec = lesson.entryConditions || {};
      if (conditions.rsi && ec.rsi && Math.abs(Number(conditions.rsi) - Number(ec.rsi)) < 10) score += 15;

      // Same strategy
      if (conditions.strategy && lesson.strategy === conditions.strategy) score += 10;

      // Same chain
      if (conditions.chain && lesson.chain === conditions.chain) score += 5;

      // Recent volume spike match
      if (conditions.volumeSpike && ec.volumeSpike) {
        const diff = Math.abs(Number(conditions.volumeSpike) - Number(ec.volumeSpike));
        if (diff < 1.0) score += 10;
      }

      // Recent lesson (decay by age — older lessons weigh less)
      const ageHours = (Date.now() - lesson.ts) / 3_600_000;
      const decayFactor = Math.max(0.2, 1 - (ageHours / (7 * 24))); // full weight for 1 week, 20% at 5 weeks
      score = Math.round(score * decayFactor);

      // Regime match bonus/penalty
      const currentRegime = conditions.regime || 'unknown';
      if (currentRegime !== 'unknown' && lesson.entryRegime && lesson.entryRegime !== 'unknown') {
        if (lesson.entryRegime === currentRegime) {
          score += 20; // Same regime: highly relevant
        } else {
          score = Math.round(score * 0.4); // Different regime: mostly irrelevant
        }
      }

      if (score >= 30) {
        lesson.hitCount = (lesson.hitCount || 0) + 1;
        matched.push({ lesson, score });
        blockScore = Math.max(blockScore, score);
      }
    }

    matched.sort((a, b) => b.score - a.score);

    // Lowered thresholds: previously 70/40 was so strict only near-identical setups triggered.
    // Now 60 blocks high-confidence repeats and 35 warns on partial matches, so the agent
    // actually applies its lessons rather than collecting them as decoration.
    const blockThreshold = Number(this.config?.memoryBlockThreshold || 60);
    const warnThreshold = Number(this.config?.memoryWarnThreshold || 35);

    if (blockScore >= blockThreshold) {
      const top = matched[0].lesson;
      return {
        blocked: true,
        reason: `Memory block: similar setup lost $${Math.abs(top.pnlUsd).toFixed(2)} — ${top.lesson.slice(0, 120)}`,
        matchedLessons: matched.slice(0, 3),
      };
    }

    if (blockScore >= warnThreshold) {
      return {
        blocked: false,
        warned: true,
        reason: `Memory warning: similar conditions led to loss — ${matched[0]?.lesson?.lesson?.slice(0, 80) || ''}`,
        matchedLessons: matched.slice(0, 3),
      };
    }

    return { blocked: false, warned: false, matchedLessons: [] };
  }

  // ── Strategy Discoveries ─────────────────────────────────────────────────

  recordDiscovery({ source, theme, insight, proposedAction, urgency, sector }) {
    // Deduplicate by theme + insight similarity (avoid flooding on same news cycle)
    const isDuplicate = this.data.strategyDiscoveries.some(
      (d) => d.theme === theme && d.insight === insight && (Date.now() - d.ts) < 4 * 3_600_000
    );
    if (isDuplicate) return;

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      source: String(source || 'intelligence'),
      theme: String(theme || ''),
      sector: String(sector || ''),
      insight: String(insight || '').slice(0, 500),
      proposedAction: String(proposedAction || '').slice(0, 300),
      urgency: ['high', 'medium', 'low'].includes(urgency) ? urgency : 'medium',
      applied: false,
    };

    this.data.strategyDiscoveries.unshift(entry);
    if (this.data.strategyDiscoveries.length > MAX_DISCOVERIES) {
      this.data.strategyDiscoveries = this.data.strategyDiscoveries.slice(0, MAX_DISCOVERIES);
    }
    this._dirty = true;
    this.logger.info(`[AgentMemory] Discovery recorded [${entry.urgency}]: ${entry.theme} — ${entry.insight.slice(0, 80)}`);
  }

  getPendingDiscoveries() {
    return this.data.strategyDiscoveries.filter((d) => !d.applied).slice(0, 10);
  }

  markDiscoveryApplied(id) {
    const d = this.data.strategyDiscoveries.find((x) => x.id === id);
    if (d) { d.applied = true; d.appliedAt = Date.now(); this._dirty = true; }
  }

  // ── Token Blacklist ──────────────────────────────────────────────────────

  // Blacklist helpers extracted to src/agent/memory/blacklist.js (Week 7 Track C, 2026-05-17).
  // Delegating wrappers preserve original signature + set _dirty flag.
  addToBlacklist(symbol, reason, durationMs = _blacklistModule.DEFAULT_DURATION_MS, source = 'memory') {
    const ok = _blacklistModule.addToBlacklist(this.data, symbol, reason, durationMs, source, { logger: this.logger });
    if (ok) this._dirty = true;
    return ok;
  }

  isBlacklisted(symbol) {
    const before = Object.keys(this.data.tokenBlacklist || {}).length;
    const result = _blacklistModule.isBlacklisted(this.data, symbol);
    const after = Object.keys(this.data.tokenBlacklist || {}).length;
    if (after < before) this._dirty = true; // expiry pruned entry on lookup
    return result;
  }

  // ── Token Preferences ────────────────────────────────────────────────────

  setTokenPreference(symbol, { boost, reason, durationMs = 6 * 3_600_000, researchSummary } = {}) {
    const sym = String(symbol || '').toUpperCase();
    this.data.tokenPreferences[sym] = {
      boost: Math.min(50, Math.max(0, Number(boost || 0))),
      reason: String(reason || '').slice(0, 200),
      researchSummary: String(researchSummary || '').slice(0, 500),
      addedAt: Date.now(),
      expiresAt: Date.now() + durationMs,
    };
    this._dirty = true;
    this.logger.info(`[AgentMemory] Token preference set: ${sym} +${boost}% for ${Math.round(durationMs / 3_600_000)}h`);
  }

  getTokenPreference(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const entry = this.data.tokenPreferences[sym];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      delete this.data.tokenPreferences[sym];
      this._dirty = true;
      return null;
    }
    return entry;
  }

  // ── Evolution Outcomes ───────────────────────────────────────────────────

  recordEvolutionOutcome({
    patchSummary,
    patchId,
    patchType,
    paramsChanged,
    pfBefore, pfAfter,
    wrBefore, wrAfter,
    sampleSizeBefore, sampleSizeAfter,
    holdoutWindowHours,
    regimeFamily,
    verdict,
  }) {
    const pfDelta = Number(pfAfter || 0) - Number(pfBefore || 0);
    const wrDelta = Number(wrAfter || 0) - Number(wrBefore || 0);
    // Causal confidence: scaled by sample size of the post-patch window. Small samples
    // can't be trusted for verdict — we treat them as inconclusive even if metrics swing.
    const minSampleForCausal = 10;
    const postSample = Number(sampleSizeAfter || 0);
    let causalConfidence = 0;
    if (postSample >= minSampleForCausal) {
      causalConfidence = Math.min(1, (postSample - minSampleForCausal) / 30 + 0.4);
    } else if (postSample >= 5) {
      causalConfidence = 0.25;
    }
    // Self-derived verdict: ignore caller verdict if causal confidence is low — small
    // samples produce false positives. Caller verdict is honored only for sufficient samples.
    let derivedVerdict = String(verdict || 'unknown');
    if (causalConfidence < 0.3) {
      derivedVerdict = 'inconclusive';
    } else if (pfDelta >= 0.05 && wrDelta >= 2) {
      derivedVerdict = 'improved';
    } else if (pfDelta <= -0.05 || wrDelta <= -3) {
      derivedVerdict = 'regressed';
    } else if (Math.abs(pfDelta) < 0.05 && Math.abs(wrDelta) < 2) {
      derivedVerdict = 'neutral';
    }
    this.data.evolutionOutcomes.unshift({
      ts: Date.now(),
      patchId: String(patchId || ''),
      patchType: String(patchType || ''),
      paramsChanged: paramsChanged || null,
      patchSummary: String(patchSummary || '').slice(0, 200),
      pfBefore: Number(pfBefore || 0),
      pfAfter: Number(pfAfter || 0),
      pfDelta,
      wrBefore: Number(wrBefore || 0),
      wrAfter: Number(wrAfter || 0),
      wrDelta,
      sampleSizeBefore: Number(sampleSizeBefore || 0),
      sampleSizeAfter: postSample,
      holdoutWindowHours: Number(holdoutWindowHours || 0),
      regimeFamily: String(regimeFamily || 'unknown'),
      causalConfidence: Number(causalConfidence.toFixed(2)),
      callerVerdict: String(verdict || 'unknown'),
      verdict: derivedVerdict,
    });
    if (this.data.evolutionOutcomes.length > MAX_EVOLUTION_LOG) {
      this.data.evolutionOutcomes = this.data.evolutionOutcomes.slice(0, MAX_EVOLUTION_LOG);
    }
    this._dirty = true;
  }

  getEvolutionSummary() {
    const recent = this.data.evolutionOutcomes.slice(0, 10);
    const improved = recent.filter((r) => r.verdict === 'improved').length;
    const regressed = recent.filter((r) => r.verdict === 'regressed').length;
    const inconclusive = recent.filter((r) => r.verdict === 'inconclusive').length;
    const neutral = recent.filter((r) => r.verdict === 'neutral').length;
    const avgCausalConfidence = recent.length > 0
      ? recent.reduce((sum, r) => sum + Number(r.causalConfidence || 0), 0) / recent.length
      : 0;
    return {
      total: recent.length,
      improved,
      regressed,
      inconclusive,
      neutral,
      avgCausalConfidence: Number(avgCausalConfidence.toFixed(2)),
    };
  }

  // Recommend whether to keep applying patches based on causal track record.
  // If recent patches show high regression rate or low causal confidence, recommend pause.
  shouldPauseEvolution() {
    const recent = this.data.evolutionOutcomes.slice(0, 8);
    if (recent.length < 4) return { paused: false, reason: 'insufficient_history' };
    const regressed = recent.filter((r) => r.verdict === 'regressed').length;
    const inconclusive = recent.filter((r) => r.verdict === 'inconclusive').length;
    const avgCausal = recent.reduce((s, r) => s + Number(r.causalConfidence || 0), 0) / recent.length;
    if (regressed >= 3) return { paused: true, reason: `${regressed} of last ${recent.length} patches regressed` };
    if (avgCausal < 0.3 && inconclusive >= 4) return { paused: true, reason: `${inconclusive} inconclusive (samples too small)` };
    return { paused: false, reason: 'ok' };
  }

  // ── Knowledge Base ───────────────────────────────────────────────────────

  addKnowledge({ category, insight, source, confidence }) {
    const isDuplicate = this.data.knowledgeBase.some(
      (k) => k.insight === insight && (Date.now() - k.ts) < 12 * 3_600_000
    );
    if (isDuplicate) return;

    this.data.knowledgeBase.unshift({
      id: stableKnowledgeId({ category, insight, source }),
      ts: Date.now(),
      category: String(category || 'general'),
      insight: String(insight || '').slice(0, 400),
      source: String(source || ''),
      confidence: Math.min(100, Math.max(0, Number(confidence || 50))),
    });
    if (this.data.knowledgeBase.length > MAX_KNOWLEDGE) {
      this.data.knowledgeBase = this.data.knowledgeBase.slice(0, MAX_KNOWLEDGE);
    }
    this._dirty = true;
  }

  getKnowledge(category = null, limit = 10) {
    const items = category
      ? this.data.knowledgeBase.filter((k) => k.category === category)
      : this.data.knowledgeBase;
    return items.slice(0, limit);
  }

  ensureChartPatternPlaybook() {
    const entries = [
      {
        category: 'chart_patterns',
        insight: 'For established liquid tokens, trust 4H and 1D chart patterns more than low-timeframe noise. Prefer BTC, ETH, major alts, and names doing at least $50M daily volume.',
        source: 'operator_playbook',
        confidence: 92,
      },
      {
        category: 'chart_patterns',
        insight: 'Bullish reversal patterns to monitor on established tokens: double bottom, triple bottom, inverse head and shoulders, falling wedge, and rounding bottom. Require support hold plus breakout confirmation.',
        source: 'operator_playbook',
        confidence: 90,
      },
      {
        category: 'chart_patterns',
        insight: 'Bearish reversal patterns to respect on established tokens: double top, triple top, head and shoulders, rising wedge, and bump-and-run style exhaustion. Treat these as reasons to avoid fresh longs unless invalidated.',
        source: 'operator_playbook',
        confidence: 90,
      },
      {
        category: 'chart_patterns',
        insight: 'Continuation structures worth tracking on established tokens: flag, pennant, rectangle, symmetrical triangle, ascending triangle, and descending triangle. Use breakout direction and volume follow-through as confirmation.',
        source: 'operator_playbook',
        confidence: 88,
      },
      {
        category: 'chart_patterns',
        insight: 'Do not use chart patterns alone. Combine them with support/resistance, RSI or MACD divergence, and on-chain or sentiment context before acting.',
        source: 'operator_playbook',
        confidence: 95,
      },
    ];

    let added = 0;
    for (const entry of entries) {
      const exists = this.data.knowledgeBase.some(
        (item) => item.category === entry.category && item.insight === entry.insight
      );
      if (exists) continue;
      this.addKnowledge(entry);
      added += 1;
    }
    return added;
  }

  ensureCoreTrainingPlaybook() {
    const entries = [
      {
        category: 'agent_training',
        insight: 'Use rule-based technical analysis as the execution baseline: RSI, MACD, EMA trend, Bollinger Bands, support/resistance, volume, and price action must be deterministic, logged, and backtested before live use.',
        source: 'operator_training_playbook',
        confidence: 96,
      },
      {
        category: 'agent_training',
        insight: 'Validation hierarchy is mandatory: historical backtest, walk-forward validation, paper trading, shadow live, canary live, then scaled live. Paper profits alone are not enough for live promotion.',
        source: 'operator_training_playbook',
        confidence: 98,
      },
      {
        category: 'agent_training',
        insight: 'Use hyperopt and benchmark research to tune parameters, but reject candidates that only work on one window, one symbol, or one regime. Prefer robust edges over maximum backtest profit.',
        source: 'operator_training_playbook',
        confidence: 94,
      },
      {
        category: 'ml_predictive_models',
        insight: 'ML models may predict direction, volatility, risk, or signal quality from OHLCV, indicators, sentiment, and on-chain features, but they should act as scoring inputs or vetoes until walk-forward and paper/live discrepancy evidence is strong.',
        source: 'operator_training_playbook',
        confidence: 92,
      },
      {
        category: 'ml_predictive_models',
        insight: 'Prefer simple models first, such as Random Forest or XGBoost-style tabular learners, before deep time-series models. LSTM/Transformer models require larger clean datasets and stricter out-of-sample tests.',
        source: 'operator_training_playbook',
        confidence: 90,
      },
      {
        category: 'reinforcement_learning',
        insight: 'Treat reinforcement learning as research-only until proven. The RL state should include price, indicators, volatility, sentiment, liquidity, position state, and regime; rewards must penalize drawdown, churn, slippage, and failed exits.',
        source: 'operator_training_playbook',
        confidence: 90,
      },
      {
        category: 'reinforcement_learning',
        insight: 'RL policies must not control live execution directly. They can propose candidates in paper/shadow mode, then must pass the same promotion gates, discrepancy checks, canary sizing, and rollback rules as any other strategy.',
        source: 'operator_training_playbook',
        confidence: 97,
      },
      {
        category: 'sentiment_analysis',
        insight: 'Use news, Reddit, X/social volume, Fear and Greed, and on-chain activity as context features. Sentiment can boost, filter, or veto a quantitative setup, but it should not override stale quotes, liquidity limits, or risk gates.',
        source: 'operator_training_playbook',
        confidence: 94,
      },
      {
        category: 'sentiment_analysis',
        insight: 'Sentiment sources must be scored for freshness, confidence, and source quality. Decay old sentiment quickly and quarantine news-driven lessons during abnormal regimes or rumor spikes.',
        source: 'operator_training_playbook',
        confidence: 91,
      },
      {
        category: 'hybrid_agentic_ai',
        insight: 'Use the LLM as a reasoning layer for thesis, contradiction checks, sentiment interpretation, and risk review. Keep execution permission deterministic through structured proposal, risk review, approval, and telemetry records.',
        source: 'operator_training_playbook',
        confidence: 96,
      },
      {
        category: 'hybrid_agentic_ai',
        insight: 'When ML/RL/LLM signals disagree with deterministic risk controls, risk controls win. When paper and live performance conflict, live execution quality and discrepancy scoring downgrade paper-derived knowledge.',
        source: 'operator_training_playbook',
        confidence: 98,
      },
      {
        category: 'data_quality',
        insight: 'Do not run heavyweight ML, RL, hyperopt, or validation on sparse history. Require sufficient OHLCV coverage across bull, bear, sideways, high-volatility, and low-volatility windows before trusting model or parameter results.',
        source: 'operator_training_playbook',
        confidence: 97,
      },
      {
        category: 'data_quality',
        insight: 'For sparse or newly discovered tokens, prefer conservative rule-based filters, liquidity checks, quote freshness, honeypot/security checks, and small/no size instead of predictive modeling.',
        source: 'operator_training_playbook',
        confidence: 95,
      },
      {
        category: 'risk_management',
        insight: 'Every strategy family must respect position sizing, stop logic, drawdown halts, diversification, chain/venue heat, slippage limits, quote freshness, and reconciliation before any learned edge is allowed to trade live.',
        source: 'operator_training_playbook',
        confidence: 99,
      },
      {
        category: 'promotion_governance',
        insight: 'Successful paper experiments should become promotion candidates only after sample-size gates, regime tags, walk-forward validation, paper/live discrepancy scoring, shadow observation, canary sizing, and rollback rules pass.',
        source: 'operator_training_playbook',
        confidence: 99,
      },
    ];

    let added = 0;
    for (const entry of entries) {
      const exists = this.data.knowledgeBase.some(
        (item) => item.category === entry.category && item.insight === entry.insight
      );
      if (exists) continue;
      this.addKnowledge(entry);
      added += 1;
    }
    return added;
  }

  // ── AI Lesson Generation ─────────────────────────────────────────────────

  /**
   * Ask AI to generate a lesson from a closed losing trade.
   * Called asynchronously — non-blocking for the main sell flow.
   */
  async generateLessonWithAI(position, finalPnlUsd) {
    const conditions = {
      symbol: position.symbol || position.tokenSymbol,
      chain: position.chain,
      strategy: position.strategy || position.strategyName,
      entryPrice: position.entryPrice,
      exitReason: position.lastExitReason || position.exitClassification || 'unknown',
      exitClassification: position.exitClassification || 'unknown',
      exitClassificationReasoning: position.exitClassificationReasoning || '',
      entryLiquidityUsd: Number(position.entryLiquidityUsd || 0),
      exitLiquidityUsd: Number(position.exitLiquidityUsd || 0),
      tokenAgeBucket: position.tokenAgeBucket || 'unknown',
      marketRegime: position.marketRegime || 'unknown',
      rsi: position.entryRsi || position.technicalDetails?.rsi,
      volumeSpike: position.entryVolumeSpike || position.technicalDetails?.volumeSpike,
      netBuyFlow: position.entryNetBuyFlow || position.technicalDetails?.netBuyFlowUsd10m,
      holdDurationHours: position.openedAt ? ((Date.now() - Date.parse(position.openedAt)) / 3_600_000).toFixed(1) : null,
      pnlPct: position.entryPrice > 0
        ? (((position.lastPrice || position.exitPriceAtClose || position.entryPrice) - position.entryPrice) / position.entryPrice * 100).toFixed(2)
        : null,
    };

    const isLoss = finalPnlUsd < 0;
    const prompt = `You are analyzing a crypto trade outcome to extract a trading lesson.

Trade details:
- Symbol: ${conditions.symbol} on ${conditions.chain}
- Strategy: ${conditions.strategy}
- Entry price: $${conditions.entryPrice}
- Exit reason: ${conditions.exitReason}
- RSI at entry: ${conditions.rsi ?? 'unknown'}
- Volume spike at entry: ${conditions.volumeSpike ?? 'unknown'}x
- Net buy flow 10m: $${conditions.netBuyFlow ?? 'unknown'}
- Hold duration: ${conditions.holdDurationHours ?? '?'} hours
- Final PnL: ${finalPnlUsd >= 0 ? '+' : ''}$${finalPnlUsd.toFixed(2)} (${conditions.pnlPct}%)
- Outcome: ${isLoss ? 'LOSS' : 'WIN'}

Generate a concise, actionable lesson in ONE sentence (max 150 chars) that describes:
- What condition to avoid or seek in the future
- Be specific about the numbers/signals that were problematic or successful

Return ONLY valid JSON: {"lesson": "...", "avoidPattern": "brief pattern description", "confidence": 0-100}`;

    // Paper bots never spend AI on lessons regardless of key/config — paper
    // exists to be free, not to burn the live key on synthetic trades.
    const paperProfile = String(process.env.BOT_PROFILE || '').toLowerCase() === 'paper'
      || process.env.PAPER_TRADING === 'true'
      || this.config?.paperTrading === true;
    const paperAiEnabled = this.config?.agentMemory?.paperAiEnabled === true;
    const allowAiPath = !paperProfile || paperAiEnabled;

    // Daily lesson-call budget. When exceeded, skip the AI call and fall back
    // to the deterministic rule-based lesson so we never blow the daily cap.
    const today = new Date().toISOString().slice(0, 10);
    if (!this.data.aiUsage || this.data.aiUsage.date !== today) {
      this.data.aiUsage = { date: today, lessonCalls: 0, deepResearchCalls: 0 };
    }
    const dailyLimit = Number(this.config?.agentMemory?.dailyAiLessonLimit);
    const lessonsEnabled = this.config?.agentMemory?.aiLessonsEnabled !== false;
    const overBudget = Number.isFinite(dailyLimit) && dailyLimit > 0
      && Number(this.data.aiUsage.lessonCalls || 0) >= dailyLimit;

    // Try Groq (fast, own pool for intelligence/evolution)
    const groqKey = process.env.GROQ_API_KEY || '';
    if (groqKey && allowAiPath && lessonsEnabled && !overBudget) {
      try {
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: process.env.GROQ_INTELLIGENCE_MODEL || 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 200,
          },
          { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const text = res.data?.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.lesson) {
            // Count this against the daily AI budget.
            this.data.aiUsage.lessonCalls = Number(this.data.aiUsage.lessonCalls || 0) + 1;
            this.recordLesson({
              symbol: conditions.symbol,
              chain: conditions.chain,
              strategy: conditions.strategy,
              entryConditions: {
                ...conditions,
                tokenAgeBucket: position.tokenAgeBucket || 'unknown',
              },
              outcome: isLoss ? 'loss' : 'win',
              pnlUsd: finalPnlUsd,
              pnlPct: Number(conditions.pnlPct || 0),
              reason: conditions.exitReason,
              lesson: parsed.lesson,
              entryRegime: position.marketRegime || 'unknown',
              holdMinutes: Math.round((Date.now() - Date.parse(position.openedAt || '')) / 60_000),
            });

            // If notable loss, also blacklist temporarily
            if (isLoss && finalPnlUsd < -2 && parsed.confidence > 70) {
              const holdHours = Number(conditions.holdDurationHours || 24);
              const blacklistDuration = Math.min(holdHours * 4 * 3_600_000, 72 * 3_600_000);
              this.addToBlacklist(conditions.symbol, `Loss pattern: ${parsed.avoidPattern || parsed.lesson.slice(0, 80)}`, blacklistDuration, 'trade_lesson');
            }

            await this.saveIfDirty();
            return parsed.lesson;
          }
        }
      } catch (err) {
        this.logger.warn(`[AgentMemory] AI lesson generation failed: ${err.message}`);
      }
    }

    // Fallback: generate a basic rule-based lesson
    const basicLesson = isLoss
      ? `Avoid ${conditions.symbol} on ${conditions.chain}: lost $${Math.abs(finalPnlUsd).toFixed(2)} after ${conditions.holdDurationHours}h (RSI=${conditions.rsi}, volSpike=${conditions.volumeSpike}x)`
      : `${conditions.symbol} won +$${finalPnlUsd.toFixed(2)}: RSI=${conditions.rsi}, volSpike=${conditions.volumeSpike}x worked well`;

    this.recordLesson({
      symbol: conditions.symbol,
      chain: conditions.chain,
      strategy: conditions.strategy,
      entryConditions: {
        ...conditions,
        tokenAgeBucket: position.tokenAgeBucket || 'unknown',
      },
      outcome: isLoss ? 'loss' : 'win',
      pnlUsd: finalPnlUsd,
      pnlPct: Number(conditions.pnlPct || 0),
      reason: conditions.exitReason,
      lesson: basicLesson,
      entryRegime: position.marketRegime || 'unknown',
      holdMinutes: Math.round((Date.now() - Date.parse(position.openedAt || '')) / 60_000),
    });
    await this.saveIfDirty();
    return basicLesson;
  }

  // ── Deep Token Research ──────────────────────────────────────────────────

  /**
   * Triggered when intelligence watchlists a token.
   * Fetches extra on-chain data and stores enriched profile in preferences.
   */
  async deepResearchToken({ symbol, chain, confidence, articleSource, reason }) {
    this.logger.info(`[AgentMemory] Deep research: ${symbol} on ${chain} (confidence=${confidence})`);

    // Fetch DexScreener data for more context
    let dexData = null;
    try {
      const searchChain = chain === 'bsc' ? 'bsc' : chain === 'solana' ? 'solana' : 'ethereum';
      const res = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`,
        { timeout: 10000 }
      );
      const pairs = res.data?.pairs || [];
      // Find the most liquid pair on the right chain
      const chainPairs = pairs.filter((p) => p.chainId === searchChain || p.chainId === 'bsc');
      if (chainPairs.length > 0) {
        chainPairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
        const top = chainPairs[0];
        dexData = {
          priceUsd: top.priceUsd,
          priceChange24h: top.priceChange?.h24,
          volume24h: top.volume?.h24,
          liquidityUsd: top.liquidity?.usd,
          txns24h: (top.txns?.h24?.buys || 0) + (top.txns?.h24?.sells || 0),
          pairAddress: top.pairAddress,
        };
      }
    } catch (_) {
      // Non-fatal — proceed without DexScreener
    }

    // Ask AI to synthesize research
    let researchSummary = reason;
    const groqKey = process.env.GROQ_API_KEY || '';
    if (groqKey && dexData) {
      try {
        const prompt = `You are a crypto researcher. Analyze this token for a trading bot.

Token: ${symbol} on ${chain}
Intelligence confidence: ${confidence}/100
Why watchlisted: ${reason}
Article source: ${articleSource}

On-chain data:
- Price: $${dexData.priceUsd}
- 24h change: ${dexData.priceChange24h}%
- 24h volume: $${Number(dexData.volume24h || 0).toLocaleString()}
- Liquidity: $${Number(dexData.liquidityUsd || 0).toLocaleString()}
- 24h transactions: ${dexData.txns24h}

Provide a brief research summary and trading recommendation.
Return ONLY JSON: {"summary": "2-3 sentences", "action": "BUY_WATCH|HOLD_WATCH|AVOID", "confidenceAdjust": -20 to +20, "keyRisk": "main risk in 1 sentence"}`;

        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: process.env.GROQ_INTELLIGENCE_MODEL || 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 300,
          },
          { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const text = res.data?.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          researchSummary = parsed.summary || reason;
          const adjustedConfidence = Math.min(100, Math.max(0, confidence + Number(parsed.confidenceAdjust || 0)));

          if (parsed.action === 'AVOID') {
            this.addToBlacklist(symbol, `Deep research: ${parsed.keyRisk || parsed.summary}`, 12 * 3_600_000, 'deep_research');
            this.logger.warn(`[AgentMemory] Deep research: ${symbol} marked AVOID — ${parsed.keyRisk}`);
          } else {
            const boost = Math.max(0, Math.min(30, adjustedConfidence / 4));
            this.setTokenPreference(symbol, {
              boost,
              reason: `Deep research: ${parsed.summary?.slice(0, 120)}`,
              durationMs: 8 * 3_600_000,
              researchSummary,
            });
          }

          if (parsed.keyRisk) {
            this.addKnowledge({
              category: 'token_research',
              insight: `${symbol}: ${parsed.keyRisk}`,
              source: articleSource || 'intelligence',
              confidence: adjustedConfidence,
            });
          }

          await this.saveIfDirty();
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`[AgentMemory] Deep research AI failed for ${symbol}: ${err.message}`);
      }
    }

    // Fallback: store with base confidence as boost
    const boost = Math.min(25, confidence / 4);
    this.setTokenPreference(symbol, {
      boost,
      reason: researchSummary,
      durationMs: 6 * 3_600_000,
    });
    await this.saveIfDirty();
    return { summary: researchSummary, action: 'BUY_WATCH' };
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  _pruneExpired() {
    // Blacklist pruning extracted to src/agent/memory/blacklist.js (Week 7 Track C)
    _blacklistModule.pruneExpired(this.data);
    // Token preferences pruned inline (no module yet — would be Week 7+ if needed)
    const now = Date.now();
    for (const [sym, entry] of Object.entries(this.data.tokenPreferences || {})) {
      if (entry.expiresAt && now > entry.expiresAt) delete this.data.tokenPreferences[sym];
    }
  }

  getRegimeContext(regime = 'unknown', strategy = 'momentum') {
    const key = `${regime}:${strategy}`;
    if (!this.data.regimeWinRates) this.data.regimeWinRates = {};
    const r = this.data.regimeWinRates[key] || { wins: 0, losses: 0 };
    const total = r.wins + r.losses;
    const winRate = total > 0 ? Math.round((r.wins / total) * 100) : null;
    const insights = [];
    if (total >= 5) {
      if (winRate >= 60) insights.push(`✅ ${regime}: ${winRate}% win rate (${total} ${strategy} trades)`);
      else if (winRate <= 35) insights.push(`⚠️ ${regime}: only ${winRate}% win rate (${total} ${strategy} trades) — require higher confidence`);
      else insights.push(`➡️ ${regime}: ${winRate}% win rate (${total} ${strategy} trades)`);
    }
    return { key, winRate, totalTrades: total, insights };
  }

  getChainContext(chain = 'unknown', strategy = 'momentum') {
    const key = `${chain}:${strategy}`;
    if (!this.data.chainPatterns) this.data.chainPatterns = {};
    const p = this.data.chainPatterns[key] || { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 };
    const total = p.wins + p.losses;
    const winRate = total > 0 ? Math.round((p.wins / total) * 100) : null;
    const avgHold = p.tradeCount > 0 ? Math.round(p.totalHoldMinutes / p.tradeCount) : null;
    const insights = [];
    if (total >= 3) {
      if (winRate !== null) insights.push(`${chain} ${strategy}: ${winRate}% win rate (${total} trades)`);
      if (avgHold !== null) insights.push(`${chain} avg hold: ${avgHold}min`);
    }
    return { key, winRate, totalTrades: total, avgHoldMinutes: avgHold, insights };
  }

  // Per-symbol context: tracks recent wins/losses on a name so we can demand
  // higher AI confidence before re-entering a repeat-loser.
  getSymbolContext(symbol = '', strategy = 'momentum', windowDays = 14) {
    if (!this.data.symbolWinRates) this.data.symbolWinRates = {};
    const key = `${String(symbol || '').toUpperCase()}:${strategy}`;
    const r = this.data.symbolWinRates[key];
    if (!r) return { key, recentLosses: 0, recentWins: 0, totalPnlUsd: 0, penaltyPct: 0, insights: [] };
    const ageMs = Date.now() - Number(r.lastTradeTs || 0);
    const stale = ageMs > windowDays * 24 * 3600 * 1000;
    if (stale) return { key, recentLosses: 0, recentWins: 0, totalPnlUsd: 0, penaltyPct: 0, insights: [] };
    const recentLosses = Number(r.losses || 0);
    const recentWins = Number(r.wins || 0);
    const totalPnlUsd = Number(r.totalPnlUsd || 0);
    // Penalty: +5pp AI floor per loss (capped at +20pp). Wins reduce penalty by 3pp.
    const penaltyPct = Math.max(0, Math.min(20, recentLosses * 5 - recentWins * 3));
    const insights = [];
    if (recentLosses >= 3 && recentWins === 0) {
      insights.push(`⚠️ ${symbol} has lost ${recentLosses}× in last ${windowDays}d (cumulative $${totalPnlUsd.toFixed(2)})`);
    } else if (recentLosses >= 2) {
      insights.push(`${symbol} recent record: ${recentWins}W/${recentLosses}L`);
    }
    return { key, recentLosses, recentWins, totalPnlUsd, penaltyPct, insights };
  }

  getTokenAgeContext(tokenAgeBucket = 'unknown', strategy = 'momentum') {
    const key = `${tokenAgeBucket}:${strategy}`;
    if (!this.data.tokenAgePatterns) this.data.tokenAgePatterns = {};
    const p = this.data.tokenAgePatterns[key] || { wins: 0, losses: 0, tradeCount: 0 };
    const total = p.wins + p.losses;
    const winRate = total > 0 ? Math.round((p.wins / total) * 100) : null;
    const insights = [];
    if (total >= 3 && winRate !== null) {
      if (winRate < 35) insights.push(`⚠️ ${tokenAgeBucket} tokens (${strategy}): ${winRate}% win rate — require higher confidence`);
      else insights.push(`${tokenAgeBucket} tokens (${strategy}): ${winRate}% win rate (${total} trades)`);
    }
    return { key, winRate, totalTrades: total, insights };
  }

  getContextForAI(options = {}) {
    const recentLessons = this.data.tradeLessons.slice(0, 10).map((l) => ({
      symbol: l.symbol,
      outcome: l.outcome,
      pnl: l.pnlUsd,
      lesson: l.lesson,
      ageHours: Math.round((Date.now() - l.ts) / 3_600_000),
    }));
    const pendingDiscoveries = this.getPendingDiscoveries().slice(0, 5).map((d) => ({
      theme: d.theme,
      insight: d.insight,
      urgency: d.urgency,
    }));
    const priorityCategories = new Set([
      'risk_management',
      'promotion_governance',
      'data_quality',
      'agent_training',
      'ml_predictive_models',
      'reinforcement_learning',
      'sentiment_analysis',
      'hybrid_agentic_ai',
      'chart_patterns',
    ]);
    const operatorKnowledge = this.data.knowledgeBase
      .filter((k) => priorityCategories.has(String(k.category || '').toLowerCase()))
      .slice(0, 12)
      .map((k) => ({
        category: k.category,
        insight: k.insight,
        confidence: k.confidence,
      }));

    const regimeCtx = options.regime ? this.getRegimeContext(options.regime, options.strategy || 'momentum') : null;
    const chainCtx = options.chain ? this.getChainContext(options.chain, options.strategy || 'momentum') : null;
    const ageCtx = options.tokenAgeBucket ? this.getTokenAgeContext(options.tokenAgeBucket, options.strategy || 'momentum') : null;

    const enrichedKnowledge = [
      ...operatorKnowledge,
      ...(regimeCtx?.insights || []).map(i => ({ category: 'regime_pattern', insight: i, confidence: 80 })),
      ...(chainCtx?.insights || []).map(i => ({ category: 'chain_pattern', insight: i, confidence: 75 })),
      ...(ageCtx?.insights || []).map(i => ({ category: 'token_age_pattern', insight: i, confidence: 70 })),
    ];

    const evolutionSummary = this.getEvolutionSummary();
    const blacklisted = Object.keys(this.data.tokenBlacklist);
    return { recentLessons, pendingDiscoveries, operatorKnowledge: enrichedKnowledge, evolutionSummary, blacklistedTokens: blacklisted };
  }

  getSummaryStats() {
    return {
      lessons: this.data.tradeLessons.length,
      discoveries: this.data.strategyDiscoveries.length,
      blacklisted: Object.keys(this.data.tokenBlacklist).length,
      boosted: Object.keys(this.data.tokenPreferences).length,
      evolutionOutcomes: this.data.evolutionOutcomes.length,
      knowledge: this.data.knowledgeBase.length,
    };
  }

  getState() {
    return {
      lessons: this.data.tradeLessons.length,
      discoveries: this.data.strategyDiscoveries.length,
      blacklistedTokens: this.data.tokenBlacklist,
      recentLessons: this.data.tradeLessons.slice(0, 20).map((lesson) => ({
        id: lesson.id || `${lesson.symbol}:${lesson.ts}`,
        symbol: lesson.symbol,
        reason: lesson.reason,
        severity: lesson.severity || 'medium',
        timestamp: lesson.ts,
        expiresAt: lesson.expiresAt,
        rsiContext: lesson.rsiMin && lesson.rsiMax ? `${lesson.rsiMin}-${lesson.rsiMax}` : null,
        volumeContext: lesson.volumeMin ? `>${lesson.volumeMin}x` : null,
      })),
    };
  }
}

module.exports = AgentMemory;
