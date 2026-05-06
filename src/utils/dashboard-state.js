function buildChainSummary({
  trackedTokens = [],
  chainLabels = {},
  scanStatus = {},
  supportsSwingOnChain,
}) {
  return Object.keys(chainLabels).map((chainKey) => {
    const chainTokens = trackedTokens.filter((token) => token.chainKey === chainKey);
    const actionableTokens = chainTokens.filter((token) => token.finalSignal !== 'INSUFFICIENT DATA');
    const chainStrategies = supportsSwingOnChain(chainKey)
      ? scanStatus[chainKey]?.strategies
      : { momentum: scanStatus[chainKey]?.strategies?.momentum || {} };
    return {
      chainKey,
      name: scanStatus[chainKey]?.name,
      tracked: actionableTokens.length,
      seenTokens: chainTokens.length,
      discoveredTokens: Number(scanStatus[chainKey]?.discoveredTokens || 0),
      evaluatedTokens: Number(scanStatus[chainKey]?.evaluatedTokens || 0),
      buySignals: chainTokens.filter((token) => token.finalSignal === 'BUY').length,
      openPositions: chainTokens.filter((token) => token.hasOpenPosition).length,
      status: scanStatus[chainKey]?.status,
      currentToken: scanStatus[chainKey]?.currentToken,
      tokensScanned: scanStatus[chainKey]?.tokensScanned,
      lastUpdate: scanStatus[chainKey]?.lastUpdate,
      suppressedTokenErrors: scanStatus[chainKey]?.suppressedTokenErrors || 0,
      strategies: chainStrategies,
    };
  });
}

function buildDashboardStatePayload({
  compact = false,
  runtime,
  mode,
  health,
  portfolio,
  performanceGate,
  configSnapshot,
  scanStatus,
  brainState,
  round,
  filterStatsState,
  diagnostics,
  agentActions,
  evolutionState,
  trackedTokens,
  catalystPairs,
  recentSignals,
  backtests,
  simulations,
  chainLabels,
  supportsSwingOnChain,
}) {
  const state = {
    timestamp: new Date().toISOString(),
    uptimeSeconds: runtime.uptimeSeconds,
    totalRuntimeSeconds: runtime.totalRuntimeSeconds,
    mode,
    health,
    portfolio,
    performanceGate,
    config: configSnapshot,
    scanStatus,
    brain: {
      ...brainState,
      successRate: brainState.callCount > 0
        ? round((brainState.successCount / brainState.callCount) * 100, 1)
        : null,
    },
    filterStats: {
      signalDrought: {
        momentum: Boolean(filterStatsState.signalDrought?.momentum),
        swing: Boolean(filterStatsState.signalDrought?.swing),
        global: Boolean(filterStatsState.signalDrought?.global),
      },
      consecutiveZeroSignalCycles: {
        momentum: Number(filterStatsState.consecutiveZeroSignalCycles?.momentum || 0),
        swing: Number(filterStatsState.consecutiveZeroSignalCycles?.swing || 0),
      },
      currentCycle: compact ? undefined : filterStatsState.currentCycle,
      recentCycles: compact ? undefined : filterStatsState.recentCycles,
    },
    diagnostics,
    agent: {
      actions: agentActions,
    },
    evolution: evolutionState,
    market: {
      trackedTokens,
      catalystPairs,
      recentSignals,
      backtests,
      simulations,
      chainSummary: buildChainSummary({
        trackedTokens,
        chainLabels,
        scanStatus,
        supportsSwingOnChain,
      }),
    },
  };

  if (compact) {
    delete state.config;
    delete state.scanStatus;
  }

  return state;
}

module.exports = {
  buildChainSummary,
  buildDashboardStatePayload,
};
