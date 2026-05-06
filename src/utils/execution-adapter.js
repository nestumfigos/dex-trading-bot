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

  const nativeQuote = await getNativeQuote(chainName, tokenData);
  const nativeAmount = sizeUsd / nativeQuote;
  return withTimeout(
    exchange.executeBuy(tokenData.address, nativeAmount, { strategyName }),
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

module.exports = {
  executeBuyViaVenue,
  executeSellViaVenue,
};
