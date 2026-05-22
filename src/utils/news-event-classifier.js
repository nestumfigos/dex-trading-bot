'use strict';

const EVENT_RULES = [
  { label: 'exploit', bearish: true, terms: ['hack', 'exploit', 'stolen', 'drain', 'bridge attack', 'vulnerability'] },
  { label: 'listing', bullish: true, terms: ['listed on', 'listing', 'binance lists', 'coinbase lists', 'kucoin lists'] },
  { label: 'partnership', bullish: true, terms: ['partnership', 'integrates with', 'collaboration', 'strategic alliance'] },
  { label: 'unlock', bearish: true, terms: ['unlock', 'vesting', 'token release', 'cliff unlock'] },
  { label: 'lawsuit', bearish: true, terms: ['lawsuit', 'sec charges', 'investigation', 'settlement', 'regulator'] },
  { label: 'etf_macro', bullish: true, terms: ['etf', 'rate cut', 'fed easing', 'institutional inflow'] },
  { label: 'scam_warning', bearish: true, terms: ['scam', 'rug', 'phishing', 'fake airdrop', 'honeypot'] },
  { label: 'hype_only', terms: ['to the moon', '100x', 'gem', 'alpha call', 'pump'] },
];

function classifyNewsEvent(text = '') {
  const lower = String(text || '').toLowerCase();
  const hits = EVENT_RULES.map((rule) => ({
    label: rule.label,
    score: rule.terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0),
    bullish: Boolean(rule.bullish),
    bearish: Boolean(rule.bearish),
  })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
  const top = hits[0] || { label: 'unknown', score: 0, bullish: false, bearish: false };
  return {
    label: top.label,
    confidence: Math.min(1, top.score / 3),
    bullish: top.bullish,
    bearish: top.bearish,
    matches: hits,
  };
}

module.exports = {
  classifyNewsEvent,
};
