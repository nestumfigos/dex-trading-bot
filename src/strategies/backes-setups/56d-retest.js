'use strict';

const { classifySlope } = require('../backes-indicators');
const { dailyContext, fail, pass, resolveVolumeConfirmation, riskTargets } = require('./common');

function detect56dRetest(candles = [], options = {}) {
  const ctx = dailyContext(candles, options);
  const structureType = '56d_retest';
  if (ctx.daily.length < 70) return fail(structureType, 'insufficient_daily_candles');
  if (!(ctx.ma56 > 0) || !(ctx.atr14 > 0) || !ctx.latest || !ctx.previous) {
    return fail(structureType, 'missing_indicator_context');
  }

  const latest = ctx.latest;
  const recent = ctx.daily.slice(-10);
  const recentLow = Math.min(...recent.map((row) => row.low));
  const pullbackDistance = Math.abs(recentLow - ctx.ma56);
  const pullbackWithinAtr = pullbackDistance <= ctx.atr14 * Number(options.maxAtrDistance || options.maxEntryDistanceFromSupportAtr || 0.75);
  const reclaim = latest.close > ctx.ma56 && latest.close > latest.open && latest.close >= ctx.previous.close;
  const brokeAbove = recent.some((row, idx) => {
    if (idx === 0) return false;
    const prior = recent[idx - 1];
    return prior.close <= ctx.ma56 && row.close > ctx.ma56;
  }) || latest.close > ctx.ma56 * 1.01;
  const maSlope = classifySlope(ctx.ma56Series, { lookback: 8, flatThresholdPct: 0.002 });
  const volume = resolveVolumeConfirmation(ctx, options);
  const volumeOk = volume.volumeOk;

  const reasons = [];
  if (!pullbackWithinAtr) reasons.push('pullback_not_within_0_75_atr');
  if (!reclaim) reasons.push('no_green_reclaim_above_56d');
  if (!brokeAbove) reasons.push('no_recent_break_above_56d');
  if (maSlope === 'falling') reasons.push('ma56_falling');
  if (!volumeOk) reasons.push('volume_confirmation_missing');
  if (reasons.length) return fail(structureType, reasons[0], { reasons, volumeOk, ...volume });

  const entryPrice = latest.close;
  const stopPrice = Math.min(recentLow, ctx.ma56) - ctx.atr14 * 0.25;
  return pass({
    structureType,
    entryPrice,
    stopPrice,
    targetPrices: riskTargets(entryPrice, stopPrice, [1.5, 2.5, 3.5]),
    volumeOk,
    reasons: ['break_above_56d_ma', 'pullback_within_0_75_atr', 'green_reclaim'],
    extra: {
      atr14: ctx.atr14,
      ma56: ctx.ma56,
      ma56Slope: maSlope,
      volumeRatio: ctx.volRatio,
      ...volume,
    },
  });
}

module.exports = { detect56dRetest };
