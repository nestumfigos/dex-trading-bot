const test = require('node:test');
const assert = require('node:assert/strict');

const { createTokenDecisionPipeline } = require('../src/utils/token-decision-pipeline');

function createPipeline(overrides = {}) {
  const config = {
    anthropic: { enabled: true, apiKey: 'test-key' },
    bot: { aiFailureThreshold: 4, aiFailureCooldownSeconds: 60 },
    execution: {
      aiNonBlocking: true,
      momentumAiNonBlocking: true,
      kucoinPendingAiAdvisory: true,
      kucoinPendingAiMinConfirmations: 2,
      allowTechnicalFallbackOnAiFailure: false,
      ...(overrides.execution || {}),
    },
    risk: {
      requireSignalCascade: true,
      signalCascadeMinConfirmations: 2,
      signalCascadeMinBookImbalanceRatio: 1.1,
      signalCascadeMinVolume24hUsd: 75000,
      aiUnavailableMinConfirmations: 3,
      ...(overrides.risk || {}),
    },
    strategies: { momentum: { aiConfidenceFloor: 70 } },
  };
  const rejects = [];
  const pipeline = createTokenDecisionPipeline({
    config,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    aiCircuit: overrides.aiCircuit || { failures: 0, cooldownUntil: 0 },
    operationalDiagnostics: {},
    agentMemory: { getContextForAI: () => null, getSymbolContext: () => ({ penaltyPct: 0, insights: [] }) },
    risk: {},
    strategy: {},
    AITradeBrain: { evaluateToken: async () => overrides.aiDecision || null },
    getStrategyScanStatus: () => ({}),
    syncChainScanStatus() {},
    removeAiDecisionQueueCandidate() {},
    getHourlyWinRateAdjustment: () => ({ adjustmentPct: 0 }),
    getDynamicAiFloorAdjustment: () => 0,
    cacheAiDecisionCandidate() {},
    queueAiDecisionRefresh() {},
    getCachedAiDecision: () => overrides.cachedDecision || null,
    recordBrainSuccess() {},
    recordBrainFailure() {},
    getAiDecisionCacheStatus: () => ({ status: 'test' }),
    refreshBrainAvailability() {},
    incrementRejectReason: (_cycle, reason) => rejects.push(reason),
    tryRotateForStrongerMomentum: async () => null,
    approvePortfolioDecision: () => ({ approved: true, action: 'BUY' }),
    queueDecisionTelemetry: () => 'decision-id',
    recordTradeBlockState() {},
    classifyRejectReason: (reason) => reason,
    executeBuy: async () => {},
    enterSafeMode: async () => {},
    sendErrorAlert: async () => {},
  });
  return { pipeline, config, rejects };
}

function buyEvaluation(extra = {}) {
  return {
    signal: 'BUY',
    details: {
      triggerTimeframe: 'kucoin_early_breakout',
      sentimentSnapshot: { aggregateScore: 0.7, signal: 'BUY' },
      bookImbalance: { ratio: 1.4 },
      ...extra,
    },
  };
}

test('KuCoin pending AI can stay advisory only when fallback confirmations are strong', async () => {
  const { pipeline } = createPipeline();
  const result = await pipeline.applyAiReviewToEvaluation({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', volume24h: 500000, quoteVolume: 500000 },
    strategyName: 'momentum',
    evaluation: buyEvaluation(),
    cycleStats: { aiBlocked: 0 },
    isBscRelaxedContinuation: false,
  });

  assert.equal(result.finalSignal, 'BUY');
  assert.equal(result.signalSource, 'technical_ai_pending');
});

test('provider-exhausted AI blocks when technical fallback is disabled', async () => {
  const { pipeline } = createPipeline({
    aiCircuit: { failures: 4, cooldownUntil: Date.now() + 60_000 },
    execution: { kucoinPendingAiAdvisory: false, allowTechnicalFallbackOnAiFailure: false },
  });
  const result = await pipeline.applyAiReviewToEvaluation({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', volume24h: 500000 },
    strategyName: 'momentum',
    evaluation: buyEvaluation(),
    cycleStats: { aiBlocked: 0 },
    isBscRelaxedContinuation: false,
  });

  assert.equal(result.finalSignal, 'HOLD');
  assert.equal(result.signalSource, 'ai_cooldown_block');
});

test('successful AI BUY must pass confidence floor', async () => {
  const { pipeline } = createPipeline({
    cachedDecision: { signal: 'BUY', confidence: 82, reason: 'ok', riskFlags: [] },
  });
  const result = await pipeline.applyAiReviewToEvaluation({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', volume24h: 500000 },
    strategyName: 'momentum',
    evaluation: buyEvaluation(),
    cycleStats: { aiBlocked: 0 },
    isBscRelaxedContinuation: false,
  });

  assert.equal(result.finalSignal, 'BUY');
  assert.equal(result.signalSource, 'AI');
});
