function buildChainSummary({
  trackedTokens = [],
  chainLabels = {},
  scanStatus = {},
}) {
  return Object.keys(chainLabels).map((chainKey) => {
    const chainTokens = trackedTokens.filter((token) => token.chainKey === chainKey);
    const actionableTokens = chainTokens.filter((token) => token.finalSignal !== 'INSUFFICIENT DATA');
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
      strategies: scanStatus[chainKey]?.strategies || {},
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
}) {
  const filterStrategyNames = new Set(['momentum']);
  Object.values(scanStatus || {}).forEach((chainState) => {
    Object.keys(chainState?.strategies || {}).forEach((name) => filterStrategyNames.add(name));
  });
  Object.keys(filterStatsState.signalDrought || {})
    .filter((name) => name !== 'global')
    .forEach((name) => filterStrategyNames.add(name));
  Object.keys(filterStatsState.consecutiveZeroSignalCycles || {})
    .forEach((name) => filterStrategyNames.add(name));

  const visibleTrackedTokens = trackedTokens
    .filter((token) => String(token?.strategy || '').toLowerCase() !== 'swing');
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
        ...Object.fromEntries([...filterStrategyNames]
          .map((name) => [name, Boolean(filterStatsState.signalDrought?.[name])])),
        global: Boolean(filterStatsState.signalDrought?.global),
      },
      consecutiveZeroSignalCycles: Object.fromEntries([...filterStrategyNames]
        .map((name) => [name, Number(filterStatsState.consecutiveZeroSignalCycles?.[name] || 0)])),
      currentCycle: compact ? undefined : filterStatsState.currentCycle,
      recentCycles: compact ? undefined : filterStatsState.recentCycles,
    },
    diagnostics,
    agent: {
      actions: agentActions,
    },
    evolution: evolutionState,
    market: {
      trackedTokens: visibleTrackedTokens,
      catalystPairs,
      recentSignals,
      backtests,
      simulations,
      chainSummary: buildChainSummary({
        trackedTokens: visibleTrackedTokens,
        chainLabels,
        scanStatus,
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
