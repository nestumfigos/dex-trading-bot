'use strict';

const { dailyContext, fail, pass } = require('./common');

function detectCaixote(candles = [], options = {}) {
  const structureType = 'caixote';
  const ctx = dailyContext(candles);
  const rangeDays = Math.max(20, Math.min(60, Number(options.rangeDays || 40)));
  if (ctx.daily.length < rangeDays + 5) return fail(structureType, 'insufficient_range_candles');
  if (!ctx.latest || !(ctx.atr14 > 0)) return fail(structureType, 'missing_indicator_context');

  const box = ctx.daily.slice(-rangeDays);
  const boxHigh = Math.max(...box.map((row) => row.high));
  const boxLow = Math.min(...box.map((row) => row.low));
  const boxHeight = boxHigh - boxLow;
  const boxHeightPct = boxLow > 0 ? boxHeight / boxLow : Infinity;
  const maxBoxHeightPct = Number(options.maxBoxHeightPct || 0.35);
  const bottomZone = boxLow + boxHeight * 0.20;
  const latest = ctx.latest;
  const prior = ctx.previous || box[box.length - 2];
  const bottomReclaim = latest.low <= bottomZone && latest.close <= bottomZone && latest.close > latest.open && latest.close >= prior.close;
  const volumeOk = ctx.volRatio === null || ctx.volRatio >= Number(options.minVolumeRatio || 0.75);

  const reasons = [];
  if (!(boxHeight > 0) || boxHeightPct > maxBoxHeightPct) reasons.push('range_box_too_wide');
  if (!bottomReclaim) reasons.push('not_in_bottom_20pct_reclaim');
  if (!volumeOk) reasons.push('volume_below_baseline');
  if (reasons.length) return fail(structureType, reasons[0], { reasons, volumeOk, boxHigh, boxLow });

  const entryPrice = latest.close;
  const stopPrice = boxLow - ctx.atr14 * 0.25;
  return pass({
    structureType,
    entryPrice,
    stopPrice,
    targetPrices: [boxLow + boxHeight * 0.5, boxHigh],
    volumeOk,
    reasons: ['20_60d_range_box', 'bottom_20pct_buy_zone', 'green_reclaim'],
    extra: {
      boxHigh,
      boxLow,
      boxMidpoint: boxLow + boxHeight * 0.5,
      boxHeightPct,
      atr14: ctx.atr14,
      volumeRatio: ctx.volRatio,
    },
  });
}

module.exports = { detectCaixote };
