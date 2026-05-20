'use strict';

function getVenueExecutionProfile(chainName = '') {
  const normalized = String(chainName || '').toLowerCase();
  if (normalized === 'kucoin') {
    return {
      venueKind: 'cex',
      routeKind: 'quote_usd',
      supportsOrderbook: true,
      supportsSplitBuys: false,
      requiresNativeQuote: false,
    };
  }
  if (normalized === 'solana') {
    return {
      venueKind: 'dex',
      routeKind: 'quote_usd',
      supportsOrderbook: false,
      supportsSplitBuys: true,
      requiresNativeQuote: false,
    };
  }
  if (normalized === 'bsc' || normalized === 'base') {
    return {
      venueKind: 'dex',
      routeKind: 'native_amount',
      supportsOrderbook: false,
      supportsSplitBuys: false,
      requiresNativeQuote: true,
    };
  }
  return {
    venueKind: 'unknown',
    routeKind: 'quote_usd',
    supportsOrderbook: false,
    supportsSplitBuys: false,
    requiresNativeQuote: false,
  };
}

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
  const profile = getVenueExecutionProfile(chainName);
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
        executionProfile: profile,
      };
    }

    const result = await withTimeout(
      exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
      execTimeoutMs,
      `Solana buy timed out for ${tokenData.symbol}`
    );
    return { ...result, executionProfile: profile };
  }

  if (chainName === 'kucoin') {
    const result = await withTimeout(
      exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
      execTimeoutMs,
      `KuCoin buy timed out for ${tokenData.symbol}`
    );
    return { ...result, executionProfile: profile };
  }

  const nativeQuote = await getNativeQuote(chainName, tokenData);
  const nativeAmount = sizeUsd / nativeQuote;
  const result = await withTimeout(
    exchange.executeBuy(tokenData.address, nativeAmount, { strategyName }),
    execTimeoutMs,
    `${chainName} buy timed out for ${tokenData.symbol}`
  );
  return { ...result, executionProfile: profile };
}

async function executeSellViaVenue({
  exchange,
  tokenData,
  quantityToSell,
  execTimeoutMs,
  withTimeout,
}) {
  const result = await withTimeout(
    exchange.executeSell(tokenData.address, quantityToSell),
    execTimeoutMs,
    `Sell execution timed out for ${tokenData.symbol} after ${execTimeoutMs}ms`
  );
  return { ...result, executionProfile: getVenueExecutionProfile(tokenData?.chainKey || tokenData?.chain) };
}

module.exports = {
  getVenueExecutionProfile,
  executeBuyViaVenue,
  executeSellViaVenue,
};
