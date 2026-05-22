'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create } = require('../../src/cycle/reconciliation');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

const normalizeChainKey = (k) => String(k || '').toLowerCase();

function deps(over = {}) {
  return {
    portfolio: { executionJournal: {} },
    exchanges: { bsc: { provider: null }, base: { provider: null } },
    logger: silentLogger(),
    normalizeChainKey,
    setExecutionJournalState: () => {},
    ...over,
  };
}

// ── Defensive guards ───────────────────────────────────────────────────────

test('create: throws on missing portfolio', () => {
  assert.throws(() => create({ exchanges: {}, logger: silentLogger(), normalizeChainKey, setExecutionJournalState: () => {} }), /portfolio required/);
});

test('create: throws on missing exchanges', () => {
  assert.throws(() => create({ portfolio: {}, logger: silentLogger(), normalizeChainKey, setExecutionJournalState: () => {} }), /exchanges required/);
});

test('create: throws on missing normalizeChainKey', () => {
  assert.throws(() => create({ portfolio: {}, exchanges: {}, logger: silentLogger(), setExecutionJournalState: () => {} }), /normalizeChainKey required/);
});

test('create: throws on missing setExecutionJournalState', () => {
  assert.throws(() => create({ portfolio: {}, exchanges: {}, logger: silentLogger(), normalizeChainKey }), /setExecutionJournalState required/);
});

// ── reconcileExecutionJournal ──────────────────────────────────────────────

test('reconcileExecutionJournal: no entries -> no-op', async () => {
  const recon = create(deps());
  await recon.reconcileExecutionJournal(); // should not throw
});

test('reconcileExecutionJournal: non-confirmed entries skipped', async () => {
  const recon = create(deps({
    portfolio: {
      executionJournal: {
        tx1: { txid: 'tx1', chain: 'bsc', status: 'pending' },
      },
    },
  }));
  await recon.reconcileExecutionJournal();
});

test('reconcileExecutionJournal: non-EVM chains skipped (solana, kucoin)', async () => {
  let providerCalled = false;
  const recon = create(deps({
    portfolio: {
      executionJournal: {
        tx1: { txid: 'tx1', chain: 'solana', status: 'confirmed' },
        tx2: { txid: 'tx2', chain: 'kucoin', status: 'confirmed' },
      },
    },
    exchanges: {
      solana: { provider: { getTransactionReceipt: () => { providerCalled = true; } } },
      kucoin: { provider: { getTransactionReceipt: () => { providerCalled = true; } } },
    },
  }));
  await recon.reconcileExecutionJournal();
  assert.equal(providerCalled, false);
});

test('reconcileExecutionJournal: receipt finalized when confirmations >= required', async () => {
  const stateUpdates = [];
  const recon = create(deps({
    portfolio: {
      executionJournal: {
        tx1: { txid: 'tx1', chain: 'bsc', status: 'confirmed', requiredConfirmations: 2 },
      },
    },
    exchanges: {
      bsc: {
        provider: {
          getTransactionReceipt: async () => ({ blockNumber: 100 }),
          getBlockNumber: async () => 102, // 3 confirmations
        },
      },
    },
    setExecutionJournalState: (txid, patch) => stateUpdates.push({ txid, patch }),
  }));
  await recon.reconcileExecutionJournal();
  // Should record blockNumber+confirmations, then status=finalized
  assert.ok(stateUpdates.some((u) => u.patch.status === 'finalized'));
  assert.ok(stateUpdates.some((u) => u.patch.confirmations === 3));
});

test('reconcileExecutionJournal: missing receipt > 10min flags reorg + sets balanceDriftHalt', async () => {
  const portfolio = {
    executionJournal: {
      tx1: {
        txid: 'tx1',
        chain: 'bsc',
        status: 'confirmed',
        updatedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      },
    },
  };
  const stateUpdates = [];
  const recon = create(deps({
    portfolio,
    exchanges: {
      bsc: {
        provider: {
          getTransactionReceipt: async () => null,
          getBlockNumber: async () => 0,
        },
      },
    },
    setExecutionJournalState: (txid, patch) => stateUpdates.push({ txid, patch }),
  }));
  await recon.reconcileExecutionJournal();
  assert.ok(stateUpdates.some((u) => u.patch.status === 'reorg_or_dropped'));
  assert.equal(portfolio.balanceDriftHalt, true);
});

test('reconcileExecutionJournal: missing receipt < 10min does NOT flag reorg', async () => {
  const portfolio = {
    executionJournal: {
      tx1: {
        txid: 'tx1',
        chain: 'bsc',
        status: 'confirmed',
        updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    },
  };
  const stateUpdates = [];
  const recon = create(deps({
    portfolio,
    exchanges: { bsc: { provider: { getTransactionReceipt: async () => null, getBlockNumber: async () => 0 } } },
    setExecutionJournalState: (txid, patch) => stateUpdates.push({ txid, patch }),
  }));
  await recon.reconcileExecutionJournal();
  assert.equal(stateUpdates.length, 0);
  assert.notEqual(portfolio.balanceDriftHalt, true);
});

test('reconcileExecutionJournal: provider throws -> caught + logged (no crash)', async () => {
  const errors = [];
  const recon = create(deps({
    portfolio: {
      executionJournal: { tx1: { txid: 'tx1', chain: 'bsc', status: 'confirmed' } },
    },
    exchanges: {
      bsc: { provider: { getTransactionReceipt: async () => { throw new Error('rpc down'); } } },
    },
    logger: { ...silentLogger(), debug: (msg) => errors.push(msg) },
  }));
  await recon.reconcileExecutionJournal(); // should not throw
});

test('reconcileExecutionJournal: confirmations < required -> records confirmations only, no finalization', async () => {
  const stateUpdates = [];
  const recon = create(deps({
    portfolio: {
      executionJournal: { tx1: { txid: 'tx1', chain: 'bsc', status: 'confirmed', requiredConfirmations: 5 } },
    },
    exchanges: {
      bsc: {
        provider: {
          getTransactionReceipt: async () => ({ blockNumber: 100 }),
          getBlockNumber: async () => 102, // 3 confs, need 5
        },
      },
    },
    setExecutionJournalState: (txid, patch) => stateUpdates.push({ txid, patch }),
  }));
  await recon.reconcileExecutionJournal();
  assert.ok(stateUpdates.some((u) => u.patch.confirmations === 3));
  assert.ok(!stateUpdates.some((u) => u.patch.status === 'finalized'));
});

// ── reconcileWalletPositions (Week 9.2) ────────────────────────────────────

const buildTokenKey = (chain, addr) => `${chain}:${(addr || '').toLowerCase()}`;

function walletDeps(over = {}) {
  return {
    portfolio: { positions: {}, strategies: {}, stuckPositions: {} },
    exchanges: {},
    marketState: { trackedTokens: {} },
    config: { risk: { reconciliationDustUsd: 5, stopLossPct: 8 } },
    logger: silentLogger(),
    normalizeChainKey,
    buildTokenKey,
    setExecutionJournalState: () => {},
    ensureStatsShape: () => {},
    refreshPerformanceMetrics: () => {},
    recordPortfolioSnapshot: () => {},
    releaseLiquiditySentinel: () => {},
    strategy: { clearHistory: () => {} },
    ...over,
  };
}

test('reconcileWalletPositions: throws on missing config', async () => {
  const recon = create({ ...walletDeps(), config: null });
  await assert.rejects(() => recon.reconcileWalletPositions(), /config required/);
});

test('reconcileWalletPositions: empty exchanges -> no-op, writes empty stateReconciliation', async () => {
  const d = walletDeps();
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.deepEqual(d.portfolio.stateReconciliation.discrepancies, []);
  assert.deepEqual(d.portfolio.untrackedWalletPositions, []);
  assert.equal(d.portfolio.untrackedWalletPositionValueUsd, 0);
});

test('reconcileWalletPositions: exchange.getWalletPositions throws -> recorded as fetch_failed', async () => {
  const d = walletDeps({
    exchanges: {
      kucoin: { getWalletPositions: async () => { throw new Error('rpc down'); } },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  const fail = d.portfolio.stateReconciliation.discrepancies.find((x) => x.type === 'wallet_position_fetch_failed');
  assert.ok(fail);
  assert.equal(fail.chain, 'kucoin');
  assert.match(fail.details, /rpc down/);
});

test('reconcileWalletPositions: tracked position with currentPrice=0 -> repaired from wallet lastPrice', async () => {
  const d = walletDeps({
    portfolio: {
      positions: {
        'kucoin:btc': {
          chainKey: 'kucoin',
          chain: 'kucoin',
          symbol: 'BTC',
          entryPrice: 0,
          currentPrice: 0,
          stopLoss: 0,
        },
      },
      strategies: {},
      stuckPositions: {},
    },
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{
          address: 'BTC', symbol: 'BTC', lastPrice: 100, quantity: 1, valueUsd: 100,
        }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  const pos = d.portfolio.positions['kucoin:btc'];
  assert.equal(pos.currentPrice, 100);
  assert.equal(pos.entryPrice, 100);
  assert.equal(pos.stopLoss, 100 * 0.92); // 8% stop loss
});

test('reconcileWalletPositions: KuCoin untracked position auto-adopted', async () => {
  const d = walletDeps({
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{
          address: 'ETH', symbol: 'ETH', lastPrice: 2500, quantity: 0.01, valueUsd: 25,
        }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  const adopted = d.portfolio.positions['kucoin:eth'];
  assert.ok(adopted, 'position should be adopted');
  assert.equal(adopted.symbol, 'ETH');
  assert.equal(adopted.adoptedFromWallet, true);
  assert.equal(adopted.strategy, 'momentum');
  assert.equal(adopted.entryPrice, 2500);
  assert.equal(adopted.quantity, 0.01);
  assert.equal(adopted.signalSource, 'wallet_adoption');
  // Discrepancy logged but marked adopted (not in untrackedWalletPositions)
  assert.equal(d.portfolio.untrackedWalletPositions.length, 0);
});

test('reconcileWalletPositions: adoption skipped when valueUsd < min threshold', async () => {
  const d = walletDeps({
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{
          address: 'DUST', symbol: 'DUST', lastPrice: 0.01, quantity: 100, valueUsd: 1,
        }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.positions['kucoin:dust'], undefined);
  assert.equal(d.portfolio.untrackedWalletPositions.length, 1);
  assert.equal(d.portfolio.untrackedWalletPositions[0].symbol, 'DUST');
});

test('reconcileWalletPositions: untracked position with no price skipped (no adopt)', async () => {
  const d = walletDeps({
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{
          address: 'NOPRICE', symbol: 'NOPRICE', lastPrice: 0, quantity: 0, valueUsd: 0,
        }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.positions['kucoin:noprice'], undefined);
});

test('reconcileWalletPositions: state-only KuCoin position pruned (user sold outside bot)', async () => {
  const d = walletDeps({
    portfolio: {
      positions: {
        'kucoin:sold': { chainKey: 'kucoin', chain: 'kucoin', symbol: 'SOLD', strategy: 'momentum', currentPrice: 50, quantity: 1, initialSizeUsd: 50 },
      },
      strategies: { momentum: { positions: { 'kucoin:sold': {} }, stats: {}, trades: [] } },
      stuckPositions: {},
    },
    exchanges: {
      kucoin: { getWalletPositions: async () => [] }, // empty wallet
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.positions['kucoin:sold'], undefined, 'pruned from portfolio');
  assert.equal(d.portfolio.strategies.momentum.positions['kucoin:sold'], undefined, 'pruned from strategy mirror');
});

test('reconcileWalletPositions: dust state-only position pruned regardless of chain', async () => {
  const d = walletDeps({
    portfolio: {
      positions: {
        'bsc:dust': { chainKey: 'bsc', chain: 'bsc', symbol: 'DUST', strategy: 'momentum', currentPrice: 0.01, quantity: 10, initialSizeUsd: 0.1 },
      },
      strategies: { momentum: { positions: {}, stats: {}, trades: [] } },
      stuckPositions: {},
    },
    exchanges: {
      bsc: { getWalletPositions: async () => [] },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  // Value $0.10 < $5 dust threshold -> pruned even for non-KuCoin chain
  assert.equal(d.portfolio.positions['bsc:dust'], undefined);
});

test('reconcileWalletPositions: stuckPositions cleared when not in wallet and not in state', async () => {
  const d = walletDeps({
    portfolio: {
      positions: {},
      strategies: {},
      stuckPositions: {
        'kucoin:ghost': { chainKey: 'kucoin', symbol: 'GHOST', address: 'GHOST' },
      },
    },
    exchanges: {
      kucoin: { getWalletPositions: async () => [] },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.stuckPositions['kucoin:ghost'], undefined);
});

test('reconcileWalletPositions: marketState.trackedTokens.hasOpenPosition updated', async () => {
  const d = walletDeps({
    portfolio: {
      positions: { 'kucoin:btc': { chainKey: 'kucoin', chain: 'kucoin', symbol: 'BTC' } },
      strategies: {},
      stuckPositions: {},
    },
    exchanges: {
      kucoin: { getWalletPositions: async () => [{ address: 'BTC', symbol: 'BTC', lastPrice: 100, quantity: 1, valueUsd: 100 }] },
    },
    marketState: {
      trackedTokens: {
        'kucoin:btc': { chainKey: 'kucoin', address: 'BTC' },
        'kucoin:eth': { chainKey: 'kucoin', address: 'ETH' },
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.marketState.trackedTokens['kucoin:btc'].hasOpenPosition, true);
  assert.equal(d.marketState.trackedTokens['kucoin:eth'].hasOpenPosition, false);
});

test('reconcileWalletPositions: RECONCILE_ADOPT_UNMANAGED=false disables adoption', async () => {
  process.env.RECONCILE_ADOPT_UNMANAGED = 'false';
  const d = walletDeps({
    exchanges: {
      kucoin: { getWalletPositions: async () => [{ address: 'ETH', symbol: 'ETH', lastPrice: 2500, quantity: 0.01, valueUsd: 25 }] },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.positions['kucoin:eth'], undefined);
  assert.equal(d.portfolio.untrackedWalletPositions.length, 1);
  delete process.env.RECONCILE_ADOPT_UNMANAGED;
});

test('reconcileWalletPositions: BSC DEX positions NOT adopted by default', async () => {
  delete process.env.RECONCILE_ADOPT_UNMANAGED_DEX; // ensure default
  const d = walletDeps({
    exchanges: {
      bsc: { getWalletPositions: async () => [{ address: 'CAKE', symbol: 'CAKE', lastPrice: 2, quantity: 50, valueUsd: 100 }] },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(d.portfolio.positions['bsc:cake'], undefined);
  assert.equal(d.portfolio.untrackedWalletPositions.length, 1);
});

test('reconcileWalletPositions: KuCoin findRecoverableKucoinBuyFill recovery path', async () => {
  let recovered = false;
  const d = walletDeps({
    exchanges: {
      kucoin: { getWalletPositions: async () => [{ address: 'XRP', symbol: 'XRP', lastPrice: 0.5, quantity: 100, valueUsd: 50 }] },
    },
    findRecoverableKucoinBuyFill: async () => ({ fill: 'mocked' }),
    restoreKucoinRecoveredBuy: () => { recovered = true; return true; },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.equal(recovered, true);
  // Recovered means not adopted as new
  assert.equal(d.portfolio.positions['kucoin:xrp'], undefined);
});

test('reconcileWalletPositions: adopted position uses wider stopLoss (PENGU pattern fix)', async () => {
  // Default: adoptedStopLossPct=18 vs base 8 -> adopted stop at -18%
  const d = walletDeps({
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{ address: 'ETH', symbol: 'ETH', lastPrice: 100, quantity: 1, valueUsd: 100 }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  const adopted = d.portfolio.positions['kucoin:eth'];
  // 100 * (1 - 0.18) = 82 (not 92 which would be 8%)
  assert.equal(adopted.stopLoss, 82, 'adopted position should use 18% wider stop, not 8%');
});

test('reconcileWalletPositions: RECONCILE_ADOPT_STOP_LOSS_PCT env override applied', async () => {
  process.env.RECONCILE_ADOPT_STOP_LOSS_PCT = '25';
  const d = walletDeps({
    exchanges: {
      kucoin: {
        getWalletPositions: async () => [{ address: 'ETH', symbol: 'ETH', lastPrice: 100, quantity: 1, valueUsd: 100 }],
      },
    },
  });
  const recon = create(d);
  await recon.reconcileWalletPositions();
  const adopted = d.portfolio.positions['kucoin:eth'];
  assert.equal(adopted.stopLoss, 75, '25% override applied');
  delete process.env.RECONCILE_ADOPT_STOP_LOSS_PCT;
});

test('reconcileWalletPositions: writes stateReconciliation.lastRunAt timestamp', async () => {
  const d = walletDeps();
  const recon = create(d);
  await recon.reconcileWalletPositions();
  assert.ok(d.portfolio.stateReconciliation.lastRunAt);
  assert.ok(!isNaN(Date.parse(d.portfolio.stateReconciliation.lastRunAt)));
});
