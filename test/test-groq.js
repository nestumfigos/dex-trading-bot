const axios = require('axios');
require('dotenv').config({ path: '.env' });
const key = process.env.GROQ_API_KEY || '';
const model = process.env.GROQ_INTELLIGENCE_MODEL || 'llama-3.1-8b-instant';
if (!key) { console.log('No GROQ key found'); process.exit(1); }

console.log('Model:', model);

const fakeHeadlines = Array.from({ length: 20 }, (_, i) => `[${i+1}] "BTC rallies to 98k" (CoinDesk)`).join('\n');
const prompt = `You are a crypto analyst. Analyze headlines and return JSON.

HEADLINES:
${fakeHeadlines}

TRENDING: BTC, ETH, SOL

Return ONLY valid JSON (no markdown, no code fences):
{"macroSentiment":"bullish","sentimentScore":70,"hotSectors":["DeFi"],"coldSectors":[],"narrativeThemes":["BTC_rally"],"watchlistTokens":[],"avoidTokens":[],"strategyRecommendation":{"preferredType":"momentum","aggressiveness":"normal","reason":"strong market"},"riskWarnings":[],"selfImprovementInsights":[],"summary":"Market is bullish"}

IMPORTANT: Respond with ONLY a valid JSON object. No markdown, no code fences.`;

console.log('Prompt length:', prompt.length, 'chars ~', Math.round(prompt.length/4), 'tokens');

axios.post('https://api.groq.com/openai/v1/chat/completions', {
  model,
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 600,
  temperature: 0.3,
}, {
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  timeout: 20000,
}).then((r) => {
  console.log('SUCCESS:', r.data.choices[0].message.content.slice(0, 200));
}).catch((e) => {
  console.log('ERROR status:', e.response?.status);
  console.log('ERROR detail:', JSON.stringify(e.response?.data));
});
