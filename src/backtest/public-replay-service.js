'use strict';

const { runHistoricalReplay } = require('./traderxo-replay');
const { resolveStrategyVariant, listStrategyVariants } = require('../strategies/traderxo-research-variants');

const DAY_MS = 24 * 60 * 60 * 1000;
const WARMUP_DAYS = 40;

function aggregateResults(results) {
  const summaries = results.map((result) => result.summary);
  const completedTrades = summaries.reduce((sum, summary) => sum + summary.completedTrades, 0);
  const pnlUsd = summaries.reduce((sum, summary) => sum + summary.pnlUsd, 0);
  const grossProfit = results.flatMap((result) => result.trades).reduce((sum, trade) => sum + Math.max(0, trade.pnlUsd), 0);
  const grossLoss = results.flatMap((result) => result.trades).reduce((sum, trade) => sum + Math.min(0, trade.pnlUsd), 0);
  const stressedPnlUsd = summaries.reduce((sum, summary) => sum + summary.stressedPnlUsd, 0);
  const regimes = new Set();
  summaries.forEach((summary) => Object.entries(summary.byRegime || {}).forEach(([regime, row]) => {
    if (Number(row.trades) > 0) regimes.add(regime);
  }));
  return {
    completedTrades,
    pnlUsd,
    expectancyUsd: completedTrades ? pnlUsd / completedTrades : 0,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    stressedPnlUsd,
    stressedExpectancyUsd: completedTrades ? stressedPnlUsd / completedTrades : 0,
    maxDrawdownPct: Math.max(0, ...summaries.map((summary) => summary.maxDrawdownPct)),
    positiveSymbols: summaries.filter((summary) => summary.expectancyUsd > 0).length,
    regimes: Array.from(regimes),
    liquidationNearMisses: summaries.reduce((sum, summary) => sum + summary.liquidationNearMisses, 0),
  };
}

function evaluateEvidenceGate(summary) {
  const reasons = [];
  if (summary.completedTrades < 30) reasons.push('validation_trade_count_below_30');
  if (summary.positiveSymbols < 2) reasons.push('positive_contracts_below_2');
  if (summary.regimes.length < 2) reasons.push('validated_regimes_below_2');
  if (summary.expectancyUsd <= 0) reasons.push('validation_expectancy_not_positive');
  if (summary.stressedPnlUsd <= 0) reasons.push('validation_stressed_pnl_not_positive');
  if (summary.maxDrawdownPct > 6) reasons.push('validation_drawdown_above_6_pct');
  if (summary.liquidationNearMisses > 0) reasons.push('validation_liquidation_near_misses_present');
  return reasons;
}

function evaluateWalkForwardGate(summary) {
  const reasons = [];
  if (summary.completedTrades < 10) reasons.push('validation_trade_count_below_10');
  if (summary.expectancyUsd <= 0) reasons.push('validation_expectancy_not_positive');
  if (summary.stressedPnlUsd <= 0) reasons.push('validation_stressed_pnl_not_positive');
  if (summary.maxDrawdownPct > 6) reasons.push('validation_drawdown_above_6_pct');
  if (summary.liquidationNearMisses > 0) reasons.push('validation_liquidation_near_misses_present');
  return reasons;
}

function createPublicReplayService({
  feed,
  allowedSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  now = () => Date.now(),
  admission = null,
} = {}) {
  if (!feed || typeof feed.getHistoricalCandles !== 'function') throw new Error('historical public feed is required');
  const symbols = new Set(allowedSymbols.map((symbol) => String(symbol).toUpperCase()));
  let lastResult = null;
  let lastStudy = null;
  let lastWalkForward = null;
  let lastBenchmark = null;

  const normalizeSymbol = (symbol) => {
    const normalizedSymbol = String(symbol || 'BTCUSDT').toUpperCase();
    if (!symbols.has(normalizedSymbol)) throw new Error('symbol_not_enabled_for_paper_replay');
    return normalizedSymbol;
  };
  const normalizeDays = (days, fallback = 30) => Math.max(1, Math.min(180, Number(days) || fallback));
  const normalizeSymbols = (requestedSymbols) => (
    Array.isArray(requestedSymbols) && requestedSymbols.length
      ? [...new Set(requestedSymbols.map(normalizeSymbol))]
      : Array.from(symbols)
  );

  async function loadWindow({ symbol, days, endTime }) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const replayDays = normalizeDays(days);
    const startTime = endTime - (replayDays * DAY_MS);
    const warmupStart = startTime - (WARMUP_DAYS * DAY_MS);
    const [candles5m, candles15m, candles1h, dailyCandles] = await Promise.all([
      feed.getHistoricalCandles(normalizedSymbol, '5m', { startTime, endTime, maxPages: 40 }),
      feed.getHistoricalCandles(normalizedSymbol, '15m', { startTime, endTime, maxPages: 20 }),
      feed.getHistoricalCandles(normalizedSymbol, '1h', { startTime: warmupStart, endTime, maxPages: 10 }),
      feed.getHistoricalCandles(normalizedSymbol, '1d', { startTime: warmupStart, endTime, maxPages: 2 }),
    ]);
    return {
      symbol: normalizedSymbol,
      requestedAt: new Date(endTime).toISOString(),
      days: replayDays,
      dataWindow: {
        from: new Date(startTime).toISOString(),
        to: new Date(endTime).toISOString(),
        completedCandles: {
          '5m': candles5m.length,
          '15m': candles15m.length,
          '1h': candles1h.length,
          '1d': dailyCandles.length,
        },
      },
      candles5m,
      candles15m,
      candles1h,
      dailyCandles,
    };
  }

  function evaluateWindow(dataset, {
    startingEquityUsd = 10000,
    leverage = 3,
    riskPct = 0.5,
    feeBps = 5,
    slippageBps = 2,
    fundingBpsPerEightHours = 1,
    variantId = 'baseline',
  } = {}) {
    const result = runHistoricalReplay({
      symbol: dataset.symbol,
      candles5m: dataset.candles5m,
      candles15m: dataset.candles15m,
      candles1h: dataset.candles1h,
      dailyCandles: dataset.dailyCandles,
      startingEquityUsd,
      leverage,
      riskPct,
      feeBps,
      slippageBps,
      fundingBpsPerEightHours,
      variantId: resolveStrategyVariant(variantId).id,
    });
    return {
      requestedAt: dataset.requestedAt,
      days: dataset.days,
      dataWindow: dataset.dataWindow,
      ...result,
    };
  }

  async function runWindow(options = {}) {
    const dataset = await loadWindow({
      symbol: normalizeSymbol(options.symbol),
      days: normalizeDays(options.days),
      endTime: Number(options.endTime ?? now()),
    });
    return evaluateWindow(dataset, options);
  }

  async function run(options = {}) {
    lastResult = await runWindow(options);
    return lastResult;
  }

  async function runStudy({ symbols: requestedSymbols, ...options } = {}) {
    const selected = normalizeSymbols(requestedSymbols);
    const endTime = Number(now());
    const results = [];
    for (const symbol of selected) {
      results.push(await runWindow({ ...options, symbol, endTime }));
    }
    lastStudy = {
      mode: 'historical-replay-study',
      requestedAt: new Date(endTime).toISOString(),
      days: normalizeDays(options.days),
      variant: resolveStrategyVariant(options.variantId),
      symbols: selected,
      persistsPaperTrades: false,
      aggregate: aggregateResults(results),
      comparison: results.map((result) => ({
        symbol: result.symbol,
        completedTrades: result.summary.completedTrades,
        pnlUsd: result.summary.pnlUsd,
        expectancyUsd: result.summary.expectancyUsd,
        profitFactor: result.summary.profitFactor,
        maxDrawdownPct: result.summary.maxDrawdownPct,
        stressedPnlUsd: result.summary.stressedPnlUsd,
        byRegime: result.summary.byRegime,
      })),
      results,
    };
    return lastStudy;
  }

  async function runWalkForward({
    symbol = 'BTCUSDT',
    trainingDays = 30,
    validationDays = 30,
    ...options
  } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedTrainingDays = normalizeDays(trainingDays);
    const normalizedValidationDays = normalizeDays(validationDays);
    const validationEnd = Number(now());
    const trainingEnd = validationEnd - (normalizedValidationDays * DAY_MS);
    const training = await runWindow({ ...options, symbol: normalizedSymbol, days: normalizedTrainingDays, endTime: trainingEnd });
    const validation = await runWindow({ ...options, symbol: normalizedSymbol, days: normalizedValidationDays, endTime: validationEnd });
    const summary = aggregateResults([validation]);
    const reasons = evaluateWalkForwardGate(summary);
    lastWalkForward = {
      mode: 'walk-forward',
      requestedAt: new Date(validationEnd).toISOString(),
      symbol: normalizedSymbol,
      variant: resolveStrategyVariant(options.variantId),
      trainingDays: normalizedTrainingDays,
      validationDays: normalizedValidationDays,
      parametersFrozen: true,
      persistsPaperTrades: false,
      passed: reasons.length === 0,
      reasons,
      training,
      validation,
    };
    return lastWalkForward;
  }

  async function runBenchmark({
    symbols: requestedSymbols,
    trainingDays = 90,
    validationDays = 30,
    ...options
  } = {}) {
    const selectedSymbols = normalizeSymbols(requestedSymbols);
    const normalizedTrainingDays = normalizeDays(trainingDays);
    const normalizedValidationDays = normalizeDays(validationDays);
    const validationEnd = Number(now());
    const trainingEnd = validationEnd - (normalizedValidationDays * DAY_MS);
    const datasets = [];
    for (const symbol of selectedSymbols) {
      datasets.push({
        symbol,
        training: await loadWindow({ symbol, days: normalizedTrainingDays, endTime: trainingEnd }),
        validation: await loadWindow({ symbol, days: normalizedValidationDays, endTime: validationEnd }),
      });
    }
    const candidates = listStrategyVariants().map((variant) => {
      const results = datasets.map((dataset) => evaluateWindow(dataset.training, { ...options, variantId: variant.id }));
      const summary = aggregateResults(results);
      return {
        variant,
        training: summary,
        trainingResults: results,
        score: summary.completedTrades >= 10 ? summary.stressedExpectancyUsd : -1000000000,
      };
    }).sort((left, right) => right.score - left.score);
    const selectedCandidate = candidates[0];
    const validationResults = datasets.map((dataset) => evaluateWindow(dataset.validation, {
      ...options,
      variantId: selectedCandidate.variant.id,
    }));
    const validation = aggregateResults(validationResults);
    const reasons = evaluateEvidenceGate(validation);
    lastBenchmark = {
      mode: 'historical-admission-benchmark',
      requestedAt: new Date(validationEnd).toISOString(),
      symbols: selectedSymbols,
      trainingDays: normalizedTrainingDays,
      validationDays: normalizedValidationDays,
      selectionRule: 'highest_training_stressed_expectancy_with_at_least_10_training_trades',
      parametersFrozenForValidation: true,
      persistsPaperTrades: false,
      selectedVariant: selectedCandidate.variant,
      candidateTraining: candidates.map((candidate) => ({
        variant: candidate.variant,
        score: candidate.score,
        summary: candidate.training,
      })),
      selectedTraining: selectedCandidate.training,
      validation,
      validationResults,
      passed: reasons.length === 0,
      reasons,
    };
    if (admission?.recordBenchmark) lastBenchmark.admission = admission.recordBenchmark(lastBenchmark);
    return lastBenchmark;
  }

  return {
    run,
    runStudy,
    runWalkForward,
    runBenchmark,
    getLastResult: () => lastResult,
    getLastStudy: () => lastStudy,
    getLastWalkForward: () => lastWalkForward,
    getLastBenchmark: () => lastBenchmark,
  };
}

module.exports = { createPublicReplayService, aggregateResults, evaluateEvidenceGate, evaluateWalkForwardGate };
