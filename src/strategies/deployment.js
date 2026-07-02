'use strict';

const IMPLEMENTED_STRATEGIES = [
  'spot_day_bull_flag',
  'solana_bull_flag_v2',
  'bsc_flow_breakout',
  'base_dex_momentum_reclaim',
  'backes',
  'momentum',
];

const STRATEGY_DEPLOYMENTS = Object.freeze({
  spot_day_bull_flag: Object.freeze({
    label: 'KuCoin spot-day bull flag',
    stage: 'live_canary',
    implemented: true,
    priority: 10,
    live: { defaultEnabled: false, defaultChains: ['kucoin'] },
    paper: { defaultEnabled: false, defaultChains: ['kucoin'] },
  }),
  momentum: Object.freeze({
    label: 'Momentum chain',
    stage: 'production',
    implemented: true,
    priority: 50,
    live: { defaultEnabled: true, defaultChains: ['kucoin'] },
    paper: { defaultEnabled: true, defaultChains: ['solana', 'bsc', 'kucoin'] },
  }),
  backes: Object.freeze({
    label: 'Backes HTF paper',
    stage: 'paper_runtime_canary',
    implemented: true,
    paperOnly: true,
    priority: 40,
    live: { defaultEnabled: false, defaultChains: [] },
    paper: { defaultEnabled: true, defaultChains: ['kucoin'] },
  }),
  bsc_flow_breakout: Object.freeze({
    label: 'Plan F BSC liquidity-flow breakout scan-only',
    stage: 'paper_scan_only',
    implemented: true,
    paperOnly: true,
    priority: 30,
    live: { defaultEnabled: false, defaultChains: [] },
    paper: { defaultEnabled: true, defaultChains: ['bsc'] },
  }),
  base_dex_momentum_reclaim: Object.freeze({
    label: 'Plan G Base DEX momentum reclaim scan-only',
    stage: 'paper_scan_only',
    implemented: true,
    paperOnly: true,
    priority: 35,
    live: { defaultEnabled: false, defaultChains: [] },
    paper: { defaultEnabled: true, defaultChains: ['base'] },
  }),
  solana_bull_flag_v2: Object.freeze({
    label: 'Plan B v2 Solana bull-flag variant paper',
    stage: 'paper_runtime_canary',
    implemented: true,
    paperOnly: true,
    priority: 20,
    live: { defaultEnabled: false, defaultChains: [] },
    paper: { defaultEnabled: true, defaultChains: ['solana'] },
  }),
});

function normalizeStrategyName(strategyName) {
  const value = String(strategyName || 'momentum').trim().toLowerCase();
  return value === 'swing' || value === 'backes_swing' ? 'backes' : value;
}

function normalizeChainName(chainName) {
  return String(chainName || '').trim().toLowerCase();
}

function normalizeChains(chains) {
  if (Array.isArray(chains)) {
    return chains.map(normalizeChainName).filter(Boolean);
  }
  return String(chains || '')
    .split(',')
    .map(normalizeChainName)
    .filter(Boolean);
}

function getDeployment(strategyName) {
  return STRATEGY_DEPLOYMENTS[normalizeStrategyName(strategyName)] || null;
}

function getImplementedStrategyNames() {
  return IMPLEMENTED_STRATEGIES.slice();
}

function getProfileName(paperTrading) {
  return paperTrading ? 'paper' : 'live';
}

function getStrategyConfig(config, strategyName) {
  const strategy = normalizeStrategyName(strategyName);
  const strategies = config?.strategies || {};
  return strategies[strategy]
    || (strategy === 'backes' ? strategies.backes_swing || strategies.swing : null)
    || {};
}

function isStrategyConfiguredEnabled(config, strategyName, profileName) {
  const deployment = getDeployment(strategyName);
  if (!deployment || deployment.implemented !== true) return false;
  if (deployment.paperOnly && profileName !== 'paper') return false;

  const profile = deployment[profileName] || {};
  const cfg = getStrategyConfig(config, strategyName);
  if (typeof cfg.enabled === 'boolean') {
    return cfg.enabled;
  }
  return Boolean(profile.defaultEnabled);
}

function getConfiguredChains(config, strategyName, profileName) {
  const deployment = getDeployment(strategyName);
  if (!deployment) return [];

  const cfg = getStrategyConfig(config, strategyName);
  const configured = normalizeChains(cfg.enabledChains);
  if (configured.length) return configured;

  return normalizeChains(deployment[profileName]?.defaultChains || []);
}

function isStrategyEnabledForChain({ config, chainName, strategyName, paperTrading }) {
  const strategy = normalizeStrategyName(strategyName);
  const chain = normalizeChainName(chainName);
  const profileName = getProfileName(Boolean(paperTrading));

  if (!chain || !isStrategyConfiguredEnabled(config, strategy, profileName)) {
    return false;
  }

  return getConfiguredChains(config, strategy, profileName).includes(chain);
}

function getStrategyOrderForChain({ config, chainName, paperTrading }) {
  return getImplementedStrategyNames()
    .filter((strategyName) => isStrategyEnabledForChain({ config, chainName, strategyName, paperTrading }))
    .sort((a, b) => {
      const da = getDeployment(a);
      const db = getDeployment(b);
      return Number(da?.priority || 100) - Number(db?.priority || 100);
    });
}

function getDeploymentSummary(config, paperTrading) {
  const profileName = getProfileName(Boolean(paperTrading));
  return Object.entries(STRATEGY_DEPLOYMENTS).map(([strategyName, deployment]) => ({
    strategy: strategyName,
    label: deployment.label,
    stage: deployment.stage,
    implemented: Boolean(deployment.implemented),
    paperOnly: Boolean(deployment.paperOnly),
    enabled: isStrategyConfiguredEnabled(config, strategyName, profileName),
    chains: getConfiguredChains(config, strategyName, profileName),
  }));
}

module.exports = {
  STRATEGY_DEPLOYMENTS,
  getDeployment,
  getImplementedStrategyNames,
  getStrategyOrderForChain,
  getDeploymentSummary,
  isStrategyEnabledForChain,
  normalizeChains,
  normalizeStrategyName,
};
