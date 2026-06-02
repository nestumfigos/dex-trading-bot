'use strict';

const { dailyContext, fail, pass, resolveVolumeConfirmation, riskTargets } = require('./common');

function detectMegaphone(candles = [], options = {}) {
  const structureType = 'megaphone_reclaim';
  const ctx = dailyContext(candles, options);
  if (ctx.daily.length < 35) return fail(structureType, 'insufficient_daily_candles');
  if (!ctx.latest || !ctx.previous || !(ctx.atr14 > 0)) return fail(structureType, 'missing_indicator_context');

  const window = ctx.daily.slice(-30);
  const firstHalf = window.slice(0, 15);
  const secondHalf = window.slice(15);
  const firstRange = Math.max(...firstHalf.map((row) => row.high)) - Math.min(...firstHalf.map((row) => row.low));
  const secondHigh = Math.max(...secondHalf.map((row) => row.high));
  const secondLow = Math.min(...secondHalf.slice(0, -1).map((row) => row.low));
  const secondRange = secondHigh - secondLow;
  const expanding = secondRange > firstRange * Number(options.minExpansionRatio || 1.15);
  const latest = ctx.latest;
  const sweptLowerBound = latest.low < secondLow * 0.995;
  const reclaimed = latest.close > secondLow && latest.close > latest.open;
  const volume = resolveVolumeConfirmation(ctx, options);
  const volumeOk = volume.volumeOk;

  const reasons = [];
  if (!expanding) reasons.push('range_not_broadening');
  if (!sweptLowerBound) reasons.push('no_lower_bound_sweep');
  if (!reclaimed) reasons.push('no_reclaim_after_sweep');
  if (!volumeOk) reasons.push('buy_volume_spike_missing');
  if (reasons.length) return fail(structureType, reasons[0], { reasons, volumeOk, volumeRatio: ctx.volRatio, ...volume });

  const entryPrice = latest.close;
  const stopPrice = latest.low - ctx.atr14 * 0.25;
  const midpoint = secondLow + secondRange * 0.5;
  const targets = riskTargets(entryPrice, stopPrice, [1.5, 2.5]);
  return pass({
    structureType,
    entryPrice,
    stopPrice,
    targetPrices: [midpoint, secondHigh, ...targets].filter((price) => price > entryPrice),
    volumeOk,
    reasons: ['broadening_range', 'lower_bound_sweep', 'close_reclaim', 'buy_volume_spike'],
    extra: {
      rangeHigh: secondHigh,
      sweptLow: latest.low,
      lowerBound: secondLow,
      volumeRatio: ctx.volRatio,
      atr14: ctx.atr14,
      ...volume,
    },
  });
}

module.exports = { detectMegaphone };
