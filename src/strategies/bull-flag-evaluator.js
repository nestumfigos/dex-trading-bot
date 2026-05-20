'use strict';

// Bull-flag strategy evaluator (Week 12 B.3).
// Returns evaluation contract { signal, details } matching strategy.evaluateForStrategy shape.
// Wraps the pure detector with scanner gates (24h volume, liquidity, net edge) and
// chain enablement / per-chain overrides.
//
// Factory-injected for testability:
//   - fetchOhlcv({ chainKey, address, pairAddress, interval, limit }) → Promise<{ candles, ... } | null>
//
// Returns:
//   { signal: 'BUY'|'HOLD', details: { ...detectorOutput, scannerReasons, setupType, ... } }

function createBullFlagEvaluator({ logger, fetchOhlcv, detectBullFlag }) {
  if (typeof fetchOhlcv !== 'function') throw new Error('bull-flag evaluator: fetchOhlcv required');
  if (typeof detectBullFlag !== 'function') throw new Error('bull-flag evaluator: detectBullFlag required');
  const log = logger || { info() {}, warn() {}, debug() {}, error() {} };

  function resolveChainCfg(cfg, chainKey) {
    const base = { ...cfg };
    const override = cfg?.perChainOverrides?.[chainKey] || null;
    if (override) Object.assign(base, override);
    return base;
  }

  function holdResult(reasons, extra = {}) {
    return {
      signal: 'HOLD',
      details: {
        setupType: 'spot_day_bull_flag',
        technicalSignal: 'HOLD',
        scannerReasons: reasons,
        ...extra,
      },
    };
  }

  async function evaluate(tokenData = {}, options = {}) {
    const cfgRaw = options.config || {};
    const chainKey = String(options.chainKey || tokenData.chainKey || tokenData.chain || '').toLowerCase();
    const cfg = resolveChainCfg(cfgRaw, chainKey);

    if (!cfg.enabled) return holdResult(['strategy_disabled']);

    if (Array.isArray(cfg.enabledChains) && cfg.enabledChains.length && !cfg.enabledChains.includes(chainKey)) {
      return holdResult([`chain_not_enabled:${chainKey}`]);
    }

    const volume24hUsd = Number(tokenData.volume24hUsd || tokenData.volume24h || 0);
    const liquidityUsd = Number(tokenData.liquidityUsd || 0);
    const minVol = Number(cfg.min24hVolumeUsd || 0);
    const minLiq = Number(cfg.minLiquidityUsd || 0);

    if (volume24hUsd < minVol) {
      return holdResult([`volume_below_min:${volume24hUsd.toFixed(0)}<${minVol}`], { volume24hUsd });
    }
    if (liquidityUsd < minLiq) {
      return holdResult([`liquidity_below_min:${liquidityUsd.toFixed(0)}<${minLiq}`], { liquidityUsd });
    }

    if (cfg.minTokenAgeDays > 0) {
      const ageDays = Number(tokenData.ageDays || tokenData.tokenAgeDays || 0);
      if (ageDays > 0 && ageDays < cfg.minTokenAgeDays) {
        return holdResult([`token_age_below_min:${ageDays}<${cfg.minTokenAgeDays}d`], { ageDays });
      }
    }

    let ohlcv;
    try {
      ohlcv = await fetchOhlcv({
        chainKey,
        address: tokenData.address,
        pairAddress: tokenData.pairAddress || tokenData.poolAddress,
        interval: '15m',
        limit: Math.max(30, Number(cfg.flagMaxCandles || 8) + Number(cfg.poleMaxCandles || 4) + 16),
      });
    } catch (error) {
      log.debug(`[bull-flag] OHLCV fetch failed for ${tokenData.symbol}: ${error.message}`);
      return holdResult(['ohlcv_fetch_error']);
    }

    if (!ohlcv || !Array.isArray(ohlcv.candles) || !ohlcv.candles.length) {
      return holdResult(['ohlcv_unavailable']);
    }

    const detection = detectBullFlag(ohlcv.candles, {
      polePctMin: cfg.polePctMin,
      poleMaxCandles: cfg.poleMaxCandles,
      flagMinCandles: cfg.flagMinCandles,
      flagMaxCandles: cfg.flagMaxCandles,
      flagDepthMaxPct: cfg.flagDepthMaxPct,
      flagVolContractMaxRatio: cfg.flagVolContractMaxRatio,
      breakoutVolMinRatio: cfg.breakoutVolMinRatio,
    });

    if (!detection.qualifies) {
      return holdResult([`detector:${detection.reason || 'no_qualify'}`], { detection });
    }

    // Stop-distance hard cap: skip if stop is too far from entry
    const stopDistanceAbsPct = Math.abs(Number(detection.stopDistancePct || 0));
    if (cfg.maxStopDistancePct && stopDistanceAbsPct > Number(cfg.maxStopDistancePct)) {
      return holdResult([`stop_distance_too_wide:${stopDistanceAbsPct.toFixed(2)}>${cfg.maxStopDistancePct}`], { detection });
    }

    // Net-edge gate: measured move must exceed estimated fees+slippage by minNetEdgePct
    const expectedFeesBps = Number(tokenData.expectedFeesBps || 30); // ~0.3% round-trip default
    const expectedSlippageBps = Number(tokenData.expectedSlippageBps || 20);
    const totalCostPct = (expectedFeesBps + expectedSlippageBps) / 100;
    const netEdgePct = Number(detection.measuredMovePct || 0) - totalCostPct;
    if (cfg.minNetEdgePct && netEdgePct < Number(cfg.minNetEdgePct)) {
      return holdResult([`net_edge_too_thin:${netEdgePct.toFixed(2)}<${cfg.minNetEdgePct}`], { detection, netEdgePct, totalCostPct });
    }

    // Determine A+ grade
    const isAPlus = (Number(detection.volumeExpansion) >= Number(cfg.aPlusVolumeExpansionMin || Infinity)) &&
                    (Number(detection.flagDepthPct) <= Number(cfg.aPlusFlagDepthMaxPct || -Infinity));

    return {
      signal: 'BUY',
      details: {
        setupType: 'spot_day_bull_flag',
        technicalSignal: 'BUY',
        triggerTimeframe: '15m',
        confidence: Math.min(1, Math.max(0.55, 0.55 + Math.min(0.35, (Number(detection.rr) || 0) / 10))),
        detection,
        netEdgePct,
        totalCostPct,
        isAPlus,
        riskPct: isAPlus ? Number(cfg.riskPctAPlus || 0.50) : Number(cfg.riskPctBase || 0.35),
        stopPrice: detection.stopPrice,
        targetPrice: detection.targetPrice,
        breakoutClose: detection.breakoutClose,
        poleHeightPct: detection.poleHeightPct,
        flagDepthPct: detection.flagDepthPct,
        volumeExpansion: detection.volumeExpansion,
        volumeContraction: detection.volumeContraction,
        rr: detection.rr,
        scannerReasons: [],
      },
    };
  }

  return { evaluate };
}

module.exports = { createBullFlagEvaluator };
