'use strict';

async function executeBuyViaVenue({
  chainName,
  exchange,
  tokenData,
  sizeUsd,
  strategyName,
  execTimeoutMs,
  withTimeout,
  shouldSplitSolanaTrade,
  generateSplitTradeSchedule,
  sleep,
  getNativeQuote,
}) {
  if (chainName === 'solana') {
    if (shouldSplitSolanaTrade(sizeUsd, 2000)) {
      const schedule = generateSplitTradeSchedule(sizeUsd);
      const results = [];
      for (const split of schedule) {
        await sleep(split.delayBeforeMs);
        const splitResult = await withTimeout(
          exchange.executeBuy(tokenData.address, split.usdcAmount, { strategyName, splitIndex: split.splitIndex, splitTotal: split.splitTotal }),
          execTimeoutMs,
          `Solana buy timed out for ${tokenData.symbol} split ${split.splitIndex}/${split.splitTotal}`
        );
        results.push(splitResult);
      }
      return {
        txid: results[0]?.txid || `split_${Date.now()}`,
        filledBaseQty: results.reduce((sum, row) => sum + Number(row?.filledBaseQty || 0), 0),
        filledQuoteUsd: results.reduce((sum, row) => sum + Number(row?.filledQuoteUsd || 0), 0),
        splits: results,
        splitCount: results.length,
        hasExchangeFilledData: results.some((row) => row?.hasExchangeFilledData),
      };
    }

    return withTimeout(
      exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
      execTimeoutMs,
      `Solana buy timed out for ${tokenData.symbol}`
    );
  }

  if (chainName === 'kucoin') {
    return withTimeout(
      exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
      execTimeoutMs,
      `KuCoin buy timed out for ${tokenData.symbol}`
    );
  }

  // B3.exec.10 (deferred): Phase A audit 02-execution.md #10 wants a quote
  // freshness check (reject if >30s old). Current `getNativeQuote` returns a
  // bare number with no fetchedAt timestamp; tracking that requires plumbing
  // through every native-quote consumer. Tracking issue: introduce
  //   getNativeQuoteWithMeta(chain, tokenData) → { price, fetchedAt }
  // then refuse sizing when Date.now() - fetchedAt > config.execution.maxQuoteAgeMs.
  // Until then, the caller's `withTimeout` wraps execution so a stale upstream
  // quote can't hang the loop, but the order may still mispriced 1-3%.
  const nativeQuote = await getNativeQuote(chainName, tokenData);
  if (!Number.isFinite(nativeQuote) || nativeQuote <= 0) {
    throw new Error(`Native quote unavailable for ${chainName}:${tokenData?.symbol || tokenData?.address} — cannot size order (got ${nativeQuote})`);
  }
  const nativeAmount = sizeUsd / nativeQuote;
  const maxSlippageBps = Number.isFinite(Number(tokenData.maxSlippageBps))
    ? Number(tokenData.maxSlippageBps)
    : (Number.isFinite(Number(tokenData._strategyMaxSlippagePct)) ? Math.round(Number(tokenData._strategyMaxSlippagePct) * 100) : undefined);
  return withTimeout(
    exchange.executeBuy(tokenData.address, nativeAmount, {
      strategyName,
      maxSlippageBps,
      useMevJitter: tokenData.useMevJitter === true,
    }),
    execTimeoutMs,
    `${chainName} buy timed out for ${tokenData.symbol}`
  );
}

async function executeSellViaVenue({
  exchange,
  tokenData,
  quantityToSell,
  execTimeoutMs,
  withTimeout,
}) {
  return withTimeout(
    exchange.executeSell(tokenData.address, quantityToSell),
    execTimeoutMs,
    `Sell execution timed out for ${tokenData.symbol} after ${execTimeoutMs}ms`
  );
}

const VENUE_PROFILES = {
  kucoin: {
    venueKind: 'cex',
    requiresNativeQuote: false,
    supportsSplitBuys: false,
    quoteAsset: 'USDT',
  },
  solana: {
    venueKind: 'dex',
    requiresNativeQuote: false,
    supportsSplitBuys: true,
    quoteAsset: 'USDC',
  },
  bsc: {
    venueKind: 'dex',
    requiresNativeQuote: true,
    supportsSplitBuys: false,
    quoteAsset: 'BNB',
  },
  ethereum: {
    venueKind: 'dex',
    requiresNativeQuote: true,
    supportsSplitBuys: false,
    quoteAsset: 'ETH',
  },
  polygon: {
    venueKind: 'dex',
    requiresNativeQuote: true,
    supportsSplitBuys: false,
    quoteAsset: 'MATIC',
  },
};

function getVenueExecutionProfile(chainName) {
  const key = String(chainName || '').toLowerCase();
  const profile = VENUE_PROFILES[key];
  if (profile) return { ...profile, chain: key };
  return {
    chain: key,
    venueKind: 'dex',
    requiresNativeQuote: true,
    supportsSplitBuys: false,
    quoteAsset: 'NATIVE',
  };
}

module.exports = {
  executeBuyViaVenue,
  executeSellViaVenue,
  getVenueExecutionProfile,
};
