'use strict';

const { classifySlope, simpleMA, simpleMASeries } = require('../backes-indicators');
const { dailyContext, fail, pass, resolveVolumeConfirmation, riskTargets, weeklyFrom } = require('./common');

function detect21wSupport({ dailyCandles = [], weeklyCandles = [] } = {}, options = {}) {
  const structureType = '21w_support';
  const ctx = dailyContext(dailyCandles, options);
  const weekly = weeklyFrom(ctx.daily, weeklyCandles);
  const weeklyCloses = weekly.map((row) => row.close);
  const maWeeklyFast = Math.max(2, Number(options.maWeeklyFast || 8));
  const maWeeklySupport = Math.max(2, Number(options.maWeeklySupport || 21));
  const ma8w = simpleMA(weeklyCloses, maWeeklyFast);
  const ma21w = simpleMA(weeklyCloses, maWeeklySupport);
  const ma21wSeries = simpleMASeries(weeklyCloses, maWeeklySupport);
  const latest = ctx.latest;
  const previous = ctx.previous;
  if (ctx.daily.length < 80 || weekly.length < 24) return fail(structureType, 'insufficient_htf_candles');
  if (!(ma21w > 0) || !(ctx.atr14 > 0) || !latest || !previous) return fail(structureType, 'missing_indicator_context');

  const recent = ctx.daily.slice(-12);
  const recentLow = Math.min(...recent.map((row) => row.low));
  const tolerance = Number(options.supportTolerancePct || 0.025);
  const tagged21w = recentLow <= ma21w * (1 + tolerance) && recentLow >= ma21w * 0.92;
  const uptrend = latest.close > ma21w
    && ma8w > 0
    && ma8w >= ma21w * 0.98
    && classifySlope(ma21wSeries, { lookback: 5, flatThresholdPct: 0.002 }) !== 'falling';
  const reversalConfirm = latest.close > latest.open && latest.close > previous.high;
  const volume = resolveVolumeConfirmation(ctx, options);
  const volumeOk = volume.volumeOk;

  const reasons = [];
  if (!uptrend) reasons.push('weekly_uptrend_missing');
  if (!tagged21w) reasons.push('price_did_not_tag_21w_support');
  if (!reversalConfirm) reasons.push('daily_reversal_confirmation_missing');
  if (!volumeOk) reasons.push('volume_confirmation_missing');
  if (reasons.length) return fail(structureType, reasons[0], { reasons, volumeOk, ...volume });

  const entryPrice = latest.close;
  const stopPrice = recentLow - ctx.atr14 * 0.3;
  return pass({
    structureType,
    entryPrice,
    stopPrice,
    targetPrices: riskTargets(entryPrice, stopPrice, [2, 3]),
    volumeOk,
    reasons: ['weekly_uptrend', '21w_tag', 'daily_reversal_confirm'],
    extra: { ma8w, ma21w, atr14: ctx.atr14, volumeRatio: ctx.volRatio, ...volume },
  });
}

module.exports = { detect21wSupport };
