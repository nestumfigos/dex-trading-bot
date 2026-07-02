'use strict';

const DEFAULT_BAD_EXIT_REASONS = Object.freeze([
  'FAST_STOP_LOSS',
  'ORACLE_STOP_LOSS',
  'STOP_LOSS',
  'MIN_HOLD_NO_GAIN',
]);

const DEFAULT_STOP_THROTTLE_REASONS = Object.freeze([
  'FAST_STOP_LOSS',
  'ORACLE_STOP_LOSS',
  'STOP_LOSS',
]);

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolEnv(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function parseNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback.slice();
  return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  const base = raw.includes('/') ? raw.split('/')[0] : raw;
  return base
    .replace(/[-_:]?USDT$/, '')
    .replace(/[-_:]?USDC$/, '')
    .trim();
}

function normalizeChain(value) {
  const chain = String(value || '').trim().toLowerCase();
  if (chain === 'kucoin' || chain === 'ku coin') return 'kucoin';
  if (chain === 'bsc' || chain === 'bnb' || chain === 'binance smart chain') return 'bsc';
  return chain;
}

function normalizeStrategy(value) {
  const strategy = String(value || '').trim().toLowerCase();
  if (strategy === 'swing' || strategy === 'backes_swing') return 'backes';
  return strategy;
}

function tradeTimestampMs(trade = {}) {
  const parsed = Date.parse(trade.timestamp || trade.closedAt || trade.soldAt || trade.processedAt || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function tradePnlUsd(trade = {}) {
  return asNumber(trade.pnlUsd ?? trade.pnl ?? trade.realizedPnl, 0);
}

function matchesScope({ trade, symbol, chain, strategyName, scope }) {
  if (normalizeSymbol(trade.symbol || trade.address) !== symbol) return false;
  const tradeChain = normalizeChain(trade.chainKey || trade.chain);
  if (chain && tradeChain && tradeChain !== chain) return false;

  const normalizedScope = String(scope || 'chain_strategy').trim().toLowerCase();
  if (normalizedScope.includes('strategy')) {
    const tradeStrategy = normalizeStrategy(trade.strategy || trade.setupType);
    if (strategyName && tradeStrategy && tradeStrategy !== strategyName) return false;
  }
  return true;
}

function matchesContext({ trade, chain, strategyName, scope }) {
  const tradeChain = normalizeChain(trade.chainKey || trade.chain);
  const normalizedScope = String(scope || 'chain_strategy').trim().toLowerCase();

  if (normalizedScope.includes('chain') && chain && tradeChain && tradeChain !== chain) {
    return false;
  }

  if (normalizedScope.includes('strategy')) {
    const tradeStrategy = normalizeStrategy(trade.strategy || trade.setupType);
    if (strategyName && tradeStrategy && tradeStrategy !== strategyName) return false;
  }

  return true;
}

function evaluateSpotSymbolQuality({
  tokenData = {},
  symbol = tokenData.symbol || tokenData.address,
  chain = tokenData.chainKey || tokenData.chain,
  strategyName = tokenData.strategy || tokenData.setupType,
  trades = [],
  nowMs = Date.now(),
  enabled = parseBoolEnv('SPOT_SYMBOL_QUALITY_GATE_ENABLED', true),
  lookbackHours = parseNumberEnv('SPOT_SYMBOL_QUALITY_LOOKBACK_HOURS', 168),
  maxRecentLosses = parseNumberEnv('SPOT_SYMBOL_QUALITY_MAX_RECENT_LOSSES', 1),
  minLossUsd = parseNumberEnv('SPOT_SYMBOL_QUALITY_MIN_LOSS_USD', 1),
  scope = process.env.SPOT_SYMBOL_QUALITY_SCOPE || 'chain_strategy',
  badExitReasons = parseListEnv('SPOT_SYMBOL_QUALITY_BAD_EXIT_REASONS', DEFAULT_BAD_EXIT_REASONS),
} = {}) {
  if (!enabled) return { allow: true, disabled: true };
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return { allow: true, reason: 'symbol_unavailable' };

  const normalizedChain = normalizeChain(chain);
  const normalizedStrategy = normalizeStrategy(strategyName);
  const cutoff = Number(nowMs) - (Math.max(0, Number(lookbackHours)) * 3600000);
  const badReasonSet = new Set(badExitReasons.map((reason) => String(reason).trim().toUpperCase()).filter(Boolean));
  const minLoss = Math.abs(Number(minLossUsd));

  const recentBadLosses = (Array.isArray(trades) ? trades : [])
    .filter((trade) => trade && typeof trade === 'object')
    .filter((trade) => String(trade.type || '').toUpperCase() === 'SELL')
    .filter((trade) => matchesScope({
      trade,
      symbol: normalizedSymbol,
      chain: normalizedChain,
      strategyName: normalizedStrategy,
      scope,
    }))
    .filter((trade) => {
      const ts = tradeTimestampMs(trade);
      if (!Number.isFinite(ts) || ts < cutoff) return false;
      if (tradePnlUsd(trade) > -minLoss) return false;
      return badReasonSet.has(String(trade.reason || '').trim().toUpperCase());
    })
    .sort((a, b) => tradeTimestampMs(b) - tradeTimestampMs(a));

  if (recentBadLosses.length >= Math.max(1, Number(maxRecentLosses))) {
    return {
      allow: false,
      reason: 'spot_symbol_quality_blacklist_recent_loss',
      details: {
        symbol: normalizedSymbol,
        chain: normalizedChain || null,
        strategy: normalizedStrategy || null,
        scope,
        recentLosses: recentBadLosses.length,
        lookbackHours: Number(lookbackHours),
        lastReason: recentBadLosses[0]?.reason || null,
        lastPnlUsd: tradePnlUsd(recentBadLosses[0]),
        lastTimestamp: recentBadLosses[0]?.timestamp || recentBadLosses[0]?.closedAt || null,
      },
    };
  }

  return { allow: true };
}

function calculateMomentumStopLossThrottle({
  chain,
  strategyName = 'momentum',
  trades = [],
  nowMs = Date.now(),
  enabled = parseBoolEnv('MOMENTUM_STOP_LOSS_THROTTLE_ENABLED', true),
  lookbackHours = parseNumberEnv('MOMENTUM_STOP_LOSS_THROTTLE_LOOKBACK_HOURS', 24),
  baseMultiplier = parseNumberEnv('MOMENTUM_STOP_LOSS_THROTTLE_BASE_MULTIPLIER', 0.75),
  floorMultiplier = parseNumberEnv('MOMENTUM_STOP_LOSS_THROTTLE_FLOOR_MULTIPLIER', 0.35),
  minLossUsd = parseNumberEnv('MOMENTUM_STOP_LOSS_THROTTLE_MIN_LOSS_USD', 20),
  scope = process.env.MOMENTUM_STOP_LOSS_THROTTLE_SCOPE || 'chain_strategy',
  badExitReasons = parseListEnv('MOMENTUM_STOP_LOSS_THROTTLE_BAD_EXIT_REASONS', DEFAULT_STOP_THROTTLE_REASONS),
} = {}) {
  if (!enabled) return { multiplier: 1, disabled: true, recentStopLosses: 0 };

  const normalizedStrategy = normalizeStrategy(strategyName);
  if (normalizedStrategy !== 'momentum') return { multiplier: 1, recentStopLosses: 0 };

  const normalizedChain = normalizeChain(chain);
  const cutoff = Number(nowMs) - (Math.max(0, Number(lookbackHours)) * 3600000);
  const reasonSet = new Set(badExitReasons.map((reason) => String(reason).trim().toUpperCase()).filter(Boolean));
  const minLoss = Math.abs(Number(minLossUsd));

  const recentStopLosses = (Array.isArray(trades) ? trades : [])
    .filter((trade) => trade && typeof trade === 'object')
    .filter((trade) => String(trade.type || '').toUpperCase() === 'SELL')
    .filter((trade) => matchesContext({
      trade,
      chain: normalizedChain,
      strategyName: normalizedStrategy,
      scope,
    }))
    .filter((trade) => {
      const ts = tradeTimestampMs(trade);
      if (!Number.isFinite(ts) || ts < cutoff) return false;
      if (tradePnlUsd(trade) > -minLoss) return false;
      return reasonSet.has(String(trade.reason || '').trim().toUpperCase());
    })
    .sort((a, b) => tradeTimestampMs(b) - tradeTimestampMs(a));

  const lossCount = recentStopLosses.length;
  if (lossCount <= 0) return { multiplier: 1, recentStopLosses: 0 };

  const base = Math.max(0.01, Math.min(1, Number(baseMultiplier)));
  const floor = Math.max(0.01, Math.min(1, Number(floorMultiplier)));
  const multiplier = Math.max(floor, Math.pow(base, lossCount));

  return {
    multiplier,
    recentStopLosses: lossCount,
    details: {
      chain: normalizedChain || null,
      strategy: normalizedStrategy,
      scope,
      lookbackHours: Number(lookbackHours),
      baseMultiplier: base,
      floorMultiplier: floor,
      minLossUsd: minLoss,
      lastReason: recentStopLosses[0]?.reason || null,
      lastPnlUsd: tradePnlUsd(recentStopLosses[0]),
      lastTimestamp: recentStopLosses[0]?.timestamp || recentStopLosses[0]?.closedAt || null,
    },
  };
}

module.exports = {
  DEFAULT_BAD_EXIT_REASONS,
  DEFAULT_STOP_THROTTLE_REASONS,
  calculateMomentumStopLossThrottle,
  evaluateSpotSymbolQuality,
  normalizeSymbol,
};
