'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDeploymentSummary,
  getStrategyOrderForChain,
  isStrategyEnabledForChain,
} = require('../../src/strategies/deployment');

test('live deployment: only KuCoin momentum enabled by default', () => {
  const config = { strategies: { momentum: {}, swing: {}, spot_day_bull_flag: {} } };

  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'momentum', paperTrading: false }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'bsc', strategyName: 'momentum', paperTrading: false }), false);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'swing', paperTrading: false }), false);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'bsc', strategyName: 'bsc_flow_breakout', paperTrading: false }), false);
  assert.deepEqual(getStrategyOrderForChain({ config, chainName: 'kucoin', paperTrading: false }), ['momentum']);
});

test('live deployment: bull-flag enables only configured KuCoin chain', () => {
  const config = {
    strategies: {
      momentum: {},
      swing: {},
      spot_day_bull_flag: { enabled: true, enabledChains: ['kucoin'] },
    },
  };

  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'spot_day_bull_flag', paperTrading: false }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'base', strategyName: 'spot_day_bull_flag', paperTrading: false }), false);
  assert.deepEqual(getStrategyOrderForChain({ config, chainName: 'kucoin', paperTrading: false }), ['spot_day_bull_flag', 'momentum']);
});

test('paper deployment: new strategies are active and paper-only', () => {
  const config = {
    strategies: {
      swing: { enabled: true, enabledChains: ['kucoin'] },
      bsc_flow_breakout: { enabled: true, enabledChains: ['bsc'] },
      base_dex_momentum_reclaim: { enabled: true, enabledChains: ['base'] },
      solana_bull_flag_v2: { enabled: true, enabledChains: ['solana'] },
    },
  };

  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'swing', paperTrading: false }), false);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'swing', paperTrading: true }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'kucoin', strategyName: 'backes_swing', paperTrading: true }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'bsc', strategyName: 'bsc_flow_breakout', paperTrading: true }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'base', strategyName: 'base_dex_momentum_reclaim', paperTrading: true }), true);
  assert.equal(isStrategyEnabledForChain({ config, chainName: 'solana', strategyName: 'solana_bull_flag_v2', paperTrading: true }), true);

  const summary = getDeploymentSummary(config, true);
  const paperRuntime = summary.filter((row) => row.stage === 'paper_runtime_canary');
  assert.equal(paperRuntime.length, 4);
  assert.ok(paperRuntime.every((row) => row.implemented === true && row.paperOnly === true && row.enabled === true));
});
