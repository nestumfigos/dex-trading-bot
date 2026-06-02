'use strict';

const { aggregateDailyToWeekly, getMacroRegime, getMacroSizeMultiplier } = require('./backes-macro');
const { detect21wSupport } = require('./backes-setups/21w-support');
const { detect56dRetest } = require('./backes-setups/56d-retest');
const { detectCaixote } = require('./backes-setups/caixote');
const { detectMegaphone } = require('./backes-setups/megaphone');
const { volumeRatio } = require('./backes-setups/common');

const BACKES_SETUP_TYPE = 'backes';
const BACKES_MODE = 'backes_htf_swing';

function normalizeChain(value) {
  return String(value || '').trim().toLowerCase();
}

function holdResult(reasons, extra = {}) {
  return {
    signal: 'HOLD',
    details: {
      setupType: BACKES_SETUP_TYPE,
      strategyMode: BACKES_MODE,
      technicalSignal: 'HOLD',
      scannerReasons: Array.isArray(reasons) ? reasons : [String(reasons || 'hold')],
      reasons: Array.isArray(reasons) ? reasons : [String(reasons || 'hold')],
      ...extra,
    },
  };
}

function runSetupDetectors(dailyCandles, fourHourCandles, macroRegime, config = {}) {
  const weeklyCandles = aggregateDailyToWeekly(dailyCandles);
  const setupOptions = config.setupOptions || {};
  const commonOptions = {
    maDailyPeriod: Number(config.maDailyPeriod || 56),
    maWeeklyFast: Number(config.maWeeklyFast || 8),
    maWeeklySupport: Number(config.maWeeklySupport || 21),
    rangeLookbackDays: Number(config.rangeLookbackDays || 60),
    maxEntryDistanceFromSupportAtr: Number(config.maxEntryDistanceFromSupportAtr || 0.75),
    dailyVolumeSpikeMultiplier: Number(config.dailyVolumeSpikeMultiplier || 1.5),
    fourHourVolumeSpikeMultiplier: Number(config.fourHourVolumeSpikeMultiplier || 1.3),
    volumeConfirmation: {
      dailyRatio: volumeRatio(dailyCandles, 20),
      fourHourRatio: volumeRatio(fourHourCandles, 20),
      dailyThreshold: Number(config.dailyVolumeSpikeMultiplier || 1.5),
      fourHourThreshold: Number(config.fourHourVolumeSpikeMultiplier || 1.3),
    },
  };
  const detectors = [
    { name: '21w_support', priority: macroRegime === 'bull_pullback' ? 100 : 70, run: () => detect21wSupport({ dailyCandles, weeklyCandles }, { ...commonOptions, ...(setupOptions.support21w || {}) }) },
    { name: '56d_retest', priority: macroRegime === 'reversal_pending' ? 95 : 80, run: () => detect56dRetest(dailyCandles, { ...commonOptions, ...(setupOptions.retest56d || {}) }) },
    { name: 'caixote_floor', priority: macroRegime === 'capitulation' ? 90 : 65, run: () => detectCaixote(dailyCandles, { ...commonOptions, ...(setupOptions.caixote || {}) }) },
    { name: 'megaphone_reclaim', priority: macroRegime === 'capitulation' ? 85 : 60, run: () => detectMegaphone(dailyCandles, { ...commonOptions, ...(setupOptions.megaphone || {}) }) },
  ];

  const results = detectors.map((detector) => ({ detector: detector.name, priority: detector.priority, ...detector.run() }));
  const qualifying = results
    .filter((result) => result.qualifies)
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  return { results, best: qualifying[0] || null };
}

function createBackesEvaluator({ logger, fetchOhlcv } = {}) {
  if (typeof fetchOhlcv !== 'function') throw new Error('backes evaluator: fetchOhlcv required');
  const log = logger || { info() {}, warn() {}, debug() {}, error() {} };

  async function evaluate(tokenData = {}, options = {}) {
    const cfg = options.config || {};
    const chainKey = normalizeChain(options.chainKey || tokenData.chainKey || tokenData.chain);

    if (!cfg.enabled) return holdResult(['strategy_disabled']);
    if (Array.isArray(cfg.enabledChains) && cfg.enabledChains.length && !cfg.enabledChains.map(normalizeChain).includes(chainKey)) {
      return holdResult([`chain_not_enabled:${chainKey}`]);
    }

    const liquidityUsd = Number(tokenData.liquidityUsd || 0);
    const volume24hUsd = Number(tokenData.volume24hUsd || tokenData.volume24h || 0);
    if (liquidityUsd < Number(cfg.minLiquidityUsd || 0)) {
      return holdResult([`liquidity_below_min:${liquidityUsd.toFixed(0)}<${cfg.minLiquidityUsd}`], { liquidityUsd });
    }
    if (volume24hUsd < Number(cfg.min24hVolumeUsd || 0)) {
      return holdResult([`volume_below_min:${volume24hUsd.toFixed(0)}<${cfg.min24hVolumeUsd}`], { volume24hUsd });
    }

    let series;
    try {
      series = await fetchOhlcv({
        chainKey,
        symbol: tokenData.symbol,
        address: tokenData.address || tokenData.symbol,
        pairAddress: tokenData.pairAddress || tokenData.poolAddress,
        interval: '1d',
        limit: Math.max(120, Number(cfg.dailyLookback || 220)),
      });
    } catch (error) {
      log.debug(`[backes] daily OHLCV fetch failed for ${tokenData.symbol}: ${error.message}`);
      return holdResult(['ohlcv_fetch_error']);
    }

    const dailyCandles = Array.isArray(series?.candles) ? series.candles : [];
    if (dailyCandles.length < 80) return holdResult(['ohlcv_unavailable_or_short'], { candleCount: dailyCandles.length });

    let fourHourCandles = [];
    try {
      const fourHourSeries = await fetchOhlcv({
        chainKey,
        symbol: tokenData.symbol,
        address: tokenData.address || tokenData.symbol,
        pairAddress: tokenData.pairAddress || tokenData.poolAddress,
        interval: '4h',
        limit: Math.max(80, Number(cfg.fourHourLookback || 120)),
      });
      fourHourCandles = Array.isArray(fourHourSeries?.candles) ? fourHourSeries.candles : [];
    } catch (error) {
      log.debug(`[backes] optional 4h OHLCV fetch failed for ${tokenData.symbol}: ${error.message}`);
    }

    const macro = await getMacroRegime({
      fetchOhlcv,
      chainKey: 'kucoin',
      cacheKey: cfg.macroCacheKey || 'backes',
      cacheTtlMs: Number(cfg.macroCacheTtlMs || 4 * 60 * 60 * 1000),
      config: cfg,
    }).catch((error) => {
      log.debug(`[backes] macro regime unavailable: ${error.message}`);
      return { regime: 'unknown', reasons: ['macro_fetch_error'], scores: { trend: 0, momentum: 0, volatility: 0 } };
    });
    const macroRegime = String(macro.regime || 'unknown');
    const macroSizeMultiplier = getMacroSizeMultiplier(macroRegime);

    if (macroRegime === 'risk_off' && cfg.allowRiskOffEntries !== true) {
      return holdResult(['macro_risk_off'], {
        macroRegime,
        macroReasons: macro.reasons,
        macroScores: macro.scores,
        macroSizeMultiplier,
        sizeMultiplier: macroSizeMultiplier,
      });
    }

    const { results, best } = runSetupDetectors(dailyCandles, fourHourCandles, macroRegime, cfg);
    if (!best) {
      return holdResult(['no_backes_setup_qualified'], {
        macroRegime,
        macroReasons: macro.reasons,
        macroScores: macro.scores,
        setupResults: results.map((result) => ({
          structureType: result.structureType,
          qualifies: result.qualifies,
          reasons: result.reasons,
        })),
        macroSizeMultiplier,
        sizeMultiplier: macroSizeMultiplier,
      });
    }

    const riskPct = macroRegime === 'capitulation'
      ? Number(cfg.capitulationRiskPct || 0.2)
      : Number(cfg.riskPct || 0.5);
    const latestClose = Number(best.entryPrice || dailyCandles[dailyCandles.length - 1]?.close || tokenData.price || 0);
    const stopDistancePct = latestClose > 0 && Number(best.stopPrice) > 0
      ? Math.abs((latestClose - Number(best.stopPrice)) / latestClose) * 100
      : null;

    return {
      signal: 'BUY',
      details: {
        setupType: BACKES_SETUP_TYPE,
        strategyMode: BACKES_MODE,
        technicalSignal: 'BUY',
        triggerTimeframe: '1d',
        macroRegime,
        macroReasons: macro.reasons || [],
        macroScores: macro.scores || {},
        structureType: best.structureType,
        invalidationPrice: best.stopPrice,
        stopPrice: best.stopPrice,
        targetPrice: best.targetPrices?.[0] || null,
        targetPrices: best.targetPrices || [],
        entryPrice: best.entryPrice,
        stopDistancePct,
        riskPct,
        sizeMultiplier: macroSizeMultiplier,
        macroSizeMultiplier,
        volumeSpike: Math.max(Number(best.dailyVolumeRatio || 0), Number(best.fourHourVolumeRatio || 0)),
        dailyVolumeRatio: Number(best.dailyVolumeRatio || 0),
        fourHourVolumeRatio: Number(best.fourHourVolumeRatio || 0),
        volumeSource: best.volumeSource || null,
        confidence: Math.min(0.92, 0.58 + Math.min(0.2, (Number(best.targetPrices?.length || 0) * 0.04)) + (best.volumeOk ? 0.08 : 0)),
        reasons: [...(macro.reasons || []), ...(best.reasons || [])],
        scannerReasons: [],
        setupResults: results.map((result) => ({
          structureType: result.structureType,
          qualifies: result.qualifies,
          reasons: result.reasons,
        })),
        volumeOk: best.volumeOk,
      },
    };
  }

  return { evaluate };
}

module.exports = { createBackesEvaluator, runSetupDetectors };
