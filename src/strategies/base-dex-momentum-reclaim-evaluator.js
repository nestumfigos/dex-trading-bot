'use strict';

const { detectBaseDexMomentumReclaim } = require('./base-dex-momentum-reclaim-detector');

function createBaseDexMomentumReclaimEvaluator({ fetchOhlcv } = {}) {
  async function evaluate(tokenData = {}, options = {}) {
    const cfg = options.config || {};
    if (!cfg.enabled) return { signal: 'HOLD', details: { setupType: 'base_dex_momentum_reclaim', scannerReasons: ['strategy_disabled'] } };
    let candles = [];
    if (typeof fetchOhlcv === 'function') {
      const ohlcv = await fetchOhlcv({
        chainKey: 'base',
        address: tokenData.address,
        pairAddress: tokenData.pairAddress || tokenData.poolAddress,
        interval: '15m',
        limit: 80,
      }).catch(() => null);
      candles = Array.isArray(ohlcv?.candles) ? ohlcv.candles : [];
    }
    const result = detectBaseDexMomentumReclaim({ tokenData, candles, config: cfg });
    return {
      signal: result.signal,
      details: {
        setupType: 'base_dex_momentum_reclaim',
        technicalSignal: result.signal,
        triggerTimeframe: result.structureType === 'base_bull_flag' ? '15m_flag' : 'support_reclaim',
        structureType: result.structureType || null,
        scannerReasons: result.qualifies ? [] : result.reasons,
        reasons: result.reasons,
        stopPrice: result.stopPrice,
        targetPrice: result.targetPrice,
        volumeExpansion: result.volumeExpansion,
      },
    };
  }
  return { evaluate };
}

module.exports = { createBaseDexMomentumReclaimEvaluator };
