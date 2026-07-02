'use strict';

const BOT_PROFILES = Object.freeze({
  LIVE_SPOT: 'live_spot',
  PAPER_SPOT: 'paper_spot',
  PAPER_PERPS: 'paper_perps',
  LIVE_PERPS: 'live_perps',
});

const LEGACY_PROFILE_MAP = Object.freeze({
  live: BOT_PROFILES.LIVE_SPOT,
  paper: BOT_PROFILES.PAPER_SPOT,
  perps: BOT_PROFILES.PAPER_PERPS,
  'perps-paper': BOT_PROFILES.PAPER_PERPS,
});

function normalizeBotProfile(profile) {
  const raw = String(profile || '').trim().toLowerCase();
  return LEGACY_PROFILE_MAP[raw] || raw;
}

function validateRuntimeProfile({
  botProfile,
  paperTrading,
  liveExecutionEnabled = false,
  marketType = 'spot',
} = {}) {
  const normalized = normalizeBotProfile(botProfile);
  const errors = [];
  if (!Object.values(BOT_PROFILES).includes(normalized)) errors.push(`unknown_bot_profile:${botProfile}`);
  if (normalized === BOT_PROFILES.LIVE_SPOT && paperTrading === true) errors.push('live_spot_cannot_have_paper_trading_true');
  if (normalized === BOT_PROFILES.PAPER_SPOT && paperTrading !== true) errors.push('paper_spot_requires_paper_trading_true');
  if (normalized === BOT_PROFILES.PAPER_PERPS && liveExecutionEnabled === true) errors.push('paper_perps_cannot_enable_live_execution');
  if (normalized === BOT_PROFILES.LIVE_PERPS && marketType !== 'perp') errors.push('live_perps_requires_perp_market_type');
  return {
    ok: errors.length === 0,
    botProfile: normalized,
    errors,
  };
}

module.exports = {
  BOT_PROFILES,
  normalizeBotProfile,
  validateRuntimeProfile,
};
