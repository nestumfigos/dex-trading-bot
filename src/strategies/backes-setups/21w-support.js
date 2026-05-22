'use strict';

const { classifySlope, simpleMA, simpleMASeries } = require('../backes-indicators');
const { dailyContext, fail, pass, riskTargets, weeklyFrom } = require('./common');

function detect21wSupport({ dailyCandles = [], weeklyCandles = [] } = {}, options = {}) {
  const structureType = '21w_support';
  const ctx = dailyContext(dailyCandles);
  const weekly = weeklyFrom(ctx.daily, weeklyCandles);
  const weeklyCloses = weekly.map((row) => row.close);
  const ma21w = simpleMA(weeklyCloses, 21);
  const ma21wSeries = simpleMASeries(weeklyCloses, 21);
  const latest = ctx.latest;
  const previous = ctx.previous;
  if (ctx.daily.length < 80 || weekly.length < 24) return fail(structureType, 'insufficient_htf_candles');
  if (!(ma21w > 0) || !(ctx.atr14 > 0) || !latest || !previous) return fail(structureType, 'missing_indicator_context');

  const recent = ctx.daily.slice(-12);
  const recentLow = Math.min(...recent.map((row) => row.low));
  const tolerance = Number(options.supportTolerancePct || 0.025);
  const tagged21w = recentLow <= ma21w * (1 + tolerance) && recentLow >= ma21w * 0.92;
  const uptrend = latest.close > ma21w && classifySlope(ma21wSeries, { lookback: 5, flatThresholdPct: 0.002 }) !== 'falling';
  const reversalConfirm = latest.close > latest.open && latest.close > previous.high;
  const volumeOk = ctx.volRatio === null || ctx.volRatio >= Number(options.minVolumeRatio || 0.8);

  const reasons = [];
  if (!uptrend) reasons.push('weekly_uptrend_missing');
  if (!tagged21w) reasons.push('price_did_not_tag_21w_support');
  if (!reversalConfirm) reasons.push('daily_reversal_confirmation_missing');
  if (!volumeOk) reasons.push('volume_below_baseline');
  if (reasons.length) return fail(structureType, reasons[0], { reasons, volumeOk });

  const entryPrice = latest.close;
  const stopPrice = recentLow - ctx.atr14 * 0.3;
  return pass({
    structureType,
    entryPrice,
    stopPrice,
    targetPrices: riskTargets(entryPrice, stopPrice, [2, 3]),
    volumeOk,
    reasons: ['weekly_uptrend', '21w_tag', 'daily_reversal_confirm'],
    extra: { ma21w, atr14: ctx.atr14, volumeRatio: ctx.volRatio },
  });
}

module.exports = { detect21wSupport };
