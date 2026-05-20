'use strict';

// Extracted from src/index.js (Week 12 A.7).
// Builds the dashboard state payload + agent action feed.
// Heavy dep surface — reads from market state, portfolio, scan status, brain,
// filter stats, agent memory, intelligence agent, catalyst pairs.

function createDashboardState(deps) {
  const {
    config,
    portfolio,
    marketState,
    risk,
    round,
    CHAIN_LABELS,
    buildDashboardStatePayload,
    getRuntimeSnapshot,
    getScanCounterMismatchState,
    getTrackedTokens,
    toCompactSignal,
    getHealthStatus,
    getPortfolioSnapshot,
    getPrioritizedKucoinCatalystPairs,
    supportsSwingOnChain,
    getScanStatus,
    getBrainState,
    getFilterStatsState,
    getAgentMemory,
    getIntelligenceAgent,
  } = deps;

  function getAgentActionFeed(limit = 24) {
    const actions = [];
    const now = Date.now();
    const filterStatsState = getFilterStatsState();
    const agentMemory = getAgentMemory();
    const intelligenceAgent = getIntelligenceAgent();

    const pushAction = (type, text, ts = now) => {
      const phrase = String(text || '').trim();
      if (!phrase) return;
      actions.push({ type: String(type || 'agent'), phrase: phrase.slice(0, 180), ts: Number(ts || now) });
    };

    const memoryContext = typeof agentMemory?.getContextForAI === 'function'
      ? (agentMemory.getContextForAI() || {})
      : {};
    const intelligenceContext = typeof intelligenceAgent?.getContextForEvolution === 'function'
      ? (intelligenceAgent.getContextForEvolution() || null)
      : null;

    (memoryContext.pendingDiscoveries || []).slice(0, 8).forEach((d) => {
      pushAction('discovery', `Discovery: ${d.theme || 'market'} - ${String(d.insight || '').slice(0, 100)}`);
    });

    (memoryContext.recentLessons || []).slice(0, 6).forEach((lesson) => {
      const outcome = String(lesson.outcome || '').toLowerCase() === 'loss' ? 'loss' : 'win';
      const pnl = Number(lesson.pnl || 0);
      pushAction('lesson', `Lesson (${outcome}): ${lesson.symbol || 'token'} ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`);
    });

    (memoryContext.blacklistedTokens || []).slice(0, 6).forEach((symbol) => {
      pushAction('blacklist', `Blacklist active: ${symbol}`);
    });

    if (intelligenceContext) {
      if (intelligenceContext.strategyRecommendation?.preferredType) {
        pushAction(
          'intelligence',
          `Intelligence bias: ${intelligenceContext.strategyRecommendation.preferredType}/${intelligenceContext.strategyRecommendation.aggressiveness || 'normal'}`,
        );
      }
      (intelligenceContext.riskWarnings || []).slice(0, 5).forEach((riskText) => {
        pushAction('risk', `Risk: ${String(riskText || '').slice(0, 120)}`);
      });
      (intelligenceContext.selfImprovementInsights || []).slice(0, 5).forEach((insight) => {
        pushAction('improve', `Improve: ${String(insight?.suggestedAction || insight?.observation || '').slice(0, 120)}`);
      });
    }

    const latestCycles = [
      ...((filterStatsState.recentCycles?.momentum || []).slice(0, 2)),
      ...((filterStatsState.recentCycles?.swing || []).slice(0, 2)),
    ];
    latestCycles.forEach((cycle) => {
      const evaluated = Number(cycle?.evaluated || 0);
      const technicalBlocked = Number(cycle?.technicalBlocked || 0);
      if (evaluated > 0 && technicalBlocked > 0) {
        const blockedPct = ((technicalBlocked / evaluated) * 100).toFixed(1);
        pushAction('gate', `Gate ${cycle.strategy || 'unknown'}: technical blocked ${technicalBlocked}/${evaluated} (${blockedPct}%)`);
      }
    });

    return actions
      .sort((left, right) => Number(right.ts || 0) - Number(left.ts || 0))
      .slice(0, Math.max(4, Number(limit || 24)));
  }

  function buildDashboardState(options = {}) {
    const compact = options.compact === true;
    const runtime = getRuntimeSnapshot();
    const trackedTokens = getTrackedTokens({ compact });
    const activeScanCounterMismatches = getScanCounterMismatchState();
    const recentSignals = compact
      ? marketState.signals.map(toCompactSignal)
      : marketState.signals;
    const performanceGate = risk.checkPerformanceGate(portfolio.stats || {});
    const brainState = getBrainState();
    const filterStatsState = getFilterStatsState();
    return buildDashboardStatePayload({
      compact,
      runtime,
      mode: config.paperTrading ? 'paper' : 'live',
      health: getHealthStatus(),
      portfolio: getPortfolioSnapshot({ compact }),
      performanceGate,
      configSnapshot: {
        paperTrading: config.paperTrading,
        paperBalance: config.paperBalance,
        strategy: config.strategy,
        strategies: config.strategies,
        risk: config.risk,
        bot: config.bot,
        anthropic: {
          enabled: config.anthropic.enabled,
          model: config.anthropic.model,
          temperature: config.anthropic.temperature,
          hasApiKey: Boolean(config.anthropic.apiKey),
        },
      },
      scanStatus: getScanStatus(),
      brainState: {
        ...brainState,
        enabled: config.anthropic.enabled,
        hasApiKey: Boolean(config.anthropic.apiKey),
      },
      round,
      filterStatsState,
      diagnostics: {
        scanCounterMismatchCount: activeScanCounterMismatches.length,
        scanCounterMismatches: compact ? undefined : activeScanCounterMismatches,
      },
      agentActions: compact ? getAgentActionFeed(12) : getAgentActionFeed(28),
      evolutionState: {
        activeExperiment: marketState.evolution?.activeExperiment
          ? {
            id: marketState.evolution.activeExperiment.id,
            status: marketState.evolution.activeExperiment.status,
            startedAt: marketState.evolution.activeExperiment.startedAt,
            changedFiles: marketState.evolution.activeExperiment.changedFiles || [],
            lastEvaluatedAt: marketState.evolution.activeExperiment.lastEvaluatedAt || null,
            lastEvaluation: compact ? undefined : marketState.evolution.activeExperiment.lastEvaluation,
          }
          : null,
        lastPromotion: marketState.evolution?.lastPromotion || null,
        lastRollback: marketState.evolution?.lastRollback || null,
        liveRollout: marketState.evolution?.liveRollout || null,
        recentHistory: compact
          ? (marketState.evolution?.history || []).slice(0, 3)
          : (marketState.evolution?.history || []).slice(0, 12),
      },
      trackedTokens,
      catalystPairs: getPrioritizedKucoinCatalystPairs().slice(0, 20),
      recentSignals,
      backtests: compact ? [] : marketState.backtests.slice(0, 5),
      simulations: compact ? [] : marketState.simulations.slice(0, 5),
      chainLabels: CHAIN_LABELS,
      supportsSwingOnChain,
    });
  }

  return { buildDashboardState, getAgentActionFeed };
}

module.exports = { createDashboardState };
