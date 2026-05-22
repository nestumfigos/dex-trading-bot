'use strict';

/**
 * Wallet-balance refresh scheduler — pure module, dep-injected.
 *
 * Periodically fetches per-exchange balances (Solana, BSC, Base, KuCoin),
 * updates portfolio.walletBalanceUsd + per-exchange map, and detects cash-
 * ledger drift (with a 25% halt floor).
 *
 * Also schedules native-coin (BNB) price refresh used by BSC pricing math.
 *
 * Skipped entirely when config.paperTrading=true.
 *
 * Usage:
 *   const { register } = require('./cycle/wallet-balance-refresh');
 *   const dispose = register({ logger, ctx: {
 *     exchanges, portfolio, config, loopLastCompletedAt, round,
 *   }});
 *   // dispose() clears intervals (tests)
 */

let _registered = false;

function register({ logger, ctx }) {
  if (_registered) return () => {};
  _registered = true;

  const walletMs = Math.max(30_000, Number(ctx.config?.bot?.walletBalanceRefreshSeconds || 60) * 1000);
  const bscMs    = Math.max(15_000, Number(ctx.config?.risk?.nativePriceRefreshSeconds || 45) * 1000);

  const fireWallet = async () => {
    try { await updateWalletBalance(ctx, logger); }
    catch (err) { logger.error(`Wallet balance refresh loop error: ${err?.message || err}`); }
  };

  const fireBsc = async () => {
    try { await refreshBscNativePrice(ctx); }
    catch (err) { logger.warn(`BSC native price refresh loop error: ${err?.message || err}`); }
  };

  // Initial BSC native price (matches prior bootstrap)
  fireBsc().catch(() => {});

  const walletHandle = setInterval(fireWallet, walletMs);
  const bscHandle    = setInterval(fireBsc, bscMs);
  logger.info(`[wallet-balance-refresh] scheduler registered (wallet=${walletMs}ms, bscNative=${bscMs}ms)`);

  return function dispose() {
    clearInterval(walletHandle);
    clearInterval(bscHandle);
    _registered = false;
  };
}

async function refreshBscNativePrice(ctx) {
  if (!ctx.exchanges?.bsc || typeof ctx.exchanges.bsc.getBnbPrice !== 'function') {
    return null;
  }
  const price = await ctx.exchanges.bsc.getBnbPrice();
  if (ctx.loopLastCompletedAt) ctx.loopLastCompletedAt.bscNativePriceRefresh = Date.now();
  return price;
}

async function updateWalletBalance(ctx, logger) {
  const { exchanges, portfolio, config, loopLastCompletedAt, round } = ctx;

  if (config.paperTrading) {
    logger.info('Paper trading active, skipping live wallet balance fetch.');
    return;
  }

  logger.info('Fetching wallet balances...');
  try {
    const balanceResults = await Promise.allSettled([
      exchanges.solana.getBalance(),
      exchanges.bsc.getBalance(),
      exchanges.base.getBalance(),
      exchanges.kucoin.getBalance(),
    ]);
    const exchangeNames = ['Solana', 'BSC', 'Base', 'KuCoin'];
    let total = 0;
    let balanceCoverageCount = 0;
    const perExchangeBalances = {};
    balanceResults.forEach((result, i) => {
      const name = exchangeNames[i];
      if (result.status === 'fulfilled' && Number.isFinite(result.value) && result.value >= 0) {
        total += result.value;
        balanceCoverageCount += 1;
        perExchangeBalances[name] = result.value;
      } else {
        const reason = result.status === 'rejected'
          ? (result.reason?.message || String(result.reason))
          : 'returned non-finite value';
        logger.warn(`${name} balance fetch failed: ${reason}`);
        perExchangeBalances[name] = null;
      }
    });
    portfolio.walletBalanceUsd = round(total);
    portfolio.walletBalancesUsd = {
      solana: Number.isFinite(perExchangeBalances.Solana) ? round(perExchangeBalances.Solana) : null,
      bsc:    Number.isFinite(perExchangeBalances.BSC)    ? round(perExchangeBalances.BSC)    : null,
      base:   Number.isFinite(perExchangeBalances.Base)   ? round(perExchangeBalances.Base)   : null,
      kucoin: Number.isFinite(perExchangeBalances.KuCoin) ? round(perExchangeBalances.KuCoin) : null,
    };
    portfolio.balanceCoverageCount = balanceCoverageCount;

    const balanceCoverageRequired = Math.max(1, Number(config.risk?.minBalanceCoverage || 2));
    if (balanceCoverageCount < balanceCoverageRequired) {
      logger.warn('insufficient exchange coverage for drift check — skipping', {
        reason: 'insufficient exchange coverage for drift check — skipping',
        balanceCoverageCount,
        balanceCoverageRequired,
        perExchangeBalances,
      });
      logger.info(`Updated wallet balance (partial coverage ${balanceCoverageCount}/${balanceCoverageRequired}): ${Object.entries(perExchangeBalances).map(([k, v]) => `${k} $${v ?? 'fail'}`).join(', ')}, Total $${portfolio.walletBalanceUsd}`);
      if (loopLastCompletedAt) loopLastCompletedAt.walletBalanceRefresh = Date.now();
      return;
    }

    const solBalance    = balanceResults[0].status === 'fulfilled' ? (balanceResults[0].value || 0) : 0;
    const bscBalance    = balanceResults[1].status === 'fulfilled' ? (balanceResults[1].value || 0) : 0;
    const baseBalance   = balanceResults[2].status === 'fulfilled' ? (balanceResults[2].value || 0) : 0;
    const kucoinBalance = balanceResults[3].status === 'fulfilled' ? (balanceResults[3].value || 0) : 0;
    const deployedCapitalUsd = Object.values(portfolio.positions || {})
      .reduce((sum, position) => sum + Number(position?.costBasisUsd || position?.initialSizeUsd || 0), 0);
    const ledgerCash = Number(portfolio.balance || 0);
    const driftAmountUsd = Math.abs(Number(portfolio.walletBalanceUsd || 0) - ledgerCash);
    const driftDenominator = Math.max(1, Math.abs(ledgerCash || Number(portfolio.walletBalanceUsd || 0)));
    const driftPct = (driftAmountUsd / driftDenominator) * 100;
    portfolio.balanceDrift = {
      amountUsd: round(driftAmountUsd),
      pct: round(driftPct, 2),
      walletBalanceUsd: round(portfolio.walletBalanceUsd || 0),
      deployedCapitalUsd: round(deployedCapitalUsd),
      cashLedgerUsd: round(ledgerCash),
    };

    const maxBalanceDriftPct = Math.max(0, Number(config.risk?.maxBalanceDriftPct || 10));
    if (driftPct > maxBalanceDriftPct) {
      logger.warn('Wallet/cash ledger drift above threshold', {
        reason: 'cash ledger drift detected',
        walletBalanceUsd: Number(portfolio.walletBalanceUsd || 0),
        deployedCapitalUsd: round(deployedCapitalUsd),
        cashLedgerUsd: ledgerCash,
        driftAmountUsd: round(driftAmountUsd),
        driftPct: round(driftPct, 2),
        thresholdPct: maxBalanceDriftPct,
      });
    }
    const driftHaltThresholdPct = 25;
    if (driftPct > driftHaltThresholdPct) {
      portfolio.balanceDriftHalt = true;
    } else if (portfolio.balanceDriftHalt && driftPct <= maxBalanceDriftPct) {
      portfolio.balanceDriftHalt = false;
      logger.info('Wallet/cash ledger drift back within threshold - clearing drift halt', {
        driftPct: round(driftPct, 2),
        thresholdPct: maxBalanceDriftPct,
        haltThresholdPct: driftHaltThresholdPct,
      });
    }

    logger.info(`Updated wallet balance: Solana $${solBalance}, BSC $${bscBalance}, Base $${baseBalance}, KuCoin $${kucoinBalance}, Total $${portfolio.walletBalanceUsd}`);
    if (loopLastCompletedAt) loopLastCompletedAt.walletBalanceRefresh = Date.now();
  } catch (error) {
    logger.error(`Failed to update wallet balance: ${error.message}`);
  }
}

module.exports = { register, updateWalletBalance, refreshBscNativePrice };
