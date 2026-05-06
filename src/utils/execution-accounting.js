function createExecutionAccounting(deps = {}) {
  const {
    portfolio,
    logger,
    getRequiredConfirmations,
    extractExecutionPriceUsd,
    extractFilledBaseQty,
    extractFilledQuoteUsd,
  } = deps;

  function setExecutionJournalState(txid, patch = {}) {
    if (!txid) return;
    portfolio.executionJournal = portfolio.executionJournal || {};
    const key = String(txid);
    const current = portfolio.executionJournal[key] || {};
    portfolio.executionJournal[key] = {
      ...current,
      ...patch,
      txid: key,
      updatedAt: new Date().toISOString(),
    };
  }

  function markExecutionConfirmed(txResult, chainName, type, tokenData) {
    if (!txResult?.txid) {
      return;
    }
    setExecutionJournalState(txResult.txid, {
      status: 'confirmed',
      type,
      chain: chainName,
      chainKey: chainName,
      symbol: tokenData.symbol,
      address: tokenData.address,
      blockNumber: Number(txResult?.blockNumber || 0) || null,
      confirmations: Number(txResult?.confirmations || 0) || null,
      requiredConfirmations: getRequiredConfirmations(chainName),
      createdAt: new Date().toISOString(),
    });
  }

  function resolveBuyFillMetrics(txResult, expectedEntryPrice, requestedQuoteUsd) {
    const realizedEntryPrice = extractExecutionPriceUsd(txResult, expectedEntryPrice);
    const inferredHasExchangeFilledData = [
      txResult?.filledBaseQty,
      txResult?.filledQuantity,
      txResult?.filledQty,
      txResult?.executedBaseQty,
      txResult?.filledQuoteUsd,
      txResult?.filledQuoteQty,
      txResult?.executedQuoteUsd,
      txResult?.cost,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    const hasExchangeFilledData = typeof txResult?.hasExchangeFilledData === 'boolean'
      ? txResult.hasExchangeFilledData
      : inferredHasExchangeFilledData;
    let filledQuoteUsd = extractFilledQuoteUsd(txResult, requestedQuoteUsd);
    let filledBaseQty = extractFilledBaseQty(txResult, 0);

    if (filledBaseQty <= 0 && filledQuoteUsd > 0 && realizedEntryPrice > 0) {
      filledBaseQty = filledQuoteUsd / realizedEntryPrice;
    }
    if (filledQuoteUsd <= 0 && filledBaseQty > 0 && realizedEntryPrice > 0) {
      filledQuoteUsd = filledBaseQty * realizedEntryPrice;
    }
    if (filledBaseQty <= 0 && realizedEntryPrice > 0) {
      filledBaseQty = requestedQuoteUsd / realizedEntryPrice;
    }
    if (!hasExchangeFilledData && filledBaseQty > 0 && realizedEntryPrice > 0) {
      filledQuoteUsd = filledBaseQty * realizedEntryPrice;
    }

    return {
      realizedEntryPrice,
      hasExchangeFilledData,
      filledQuoteUsd,
      filledBaseQty,
    };
  }

  function resolveSellFillMetrics(txResult, expectedExitPrice, requestedQty, positionQuantityBefore, requestedFraction, tokenData, chainName) {
    const realizedExitPrice = extractExecutionPriceUsd(txResult, expectedExitPrice);
    const inferredHasExchangeFilledData = [
      txResult?.filledBaseQty,
      txResult?.filledQuantity,
      txResult?.filledQty,
      txResult?.executedBaseQty,
      txResult?.filledQuoteUsd,
      txResult?.filledQuoteQty,
      txResult?.executedQuoteUsd,
      txResult?.cost,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    const hasExchangeFilledData = typeof txResult?.hasExchangeFilledData === 'boolean'
      ? txResult.hasExchangeFilledData
      : inferredHasExchangeFilledData;
    let filledBaseQty = extractFilledBaseQty(txResult, requestedQty);
    if (filledBaseQty > positionQuantityBefore && positionQuantityBefore > 0) {
      filledBaseQty = positionQuantityBefore;
    }
    let filledQuoteUsd = extractFilledQuoteUsd(txResult, 0);
    if (!Number.isFinite(filledQuoteUsd) || filledQuoteUsd <= 0) {
      filledQuoteUsd = filledBaseQty * realizedExitPrice;
    }
    if (!hasExchangeFilledData) {
      logger.warn(`SELL fill reconciliation fallback used for ${tokenData.symbol} on ${chainName} (exchange did not provide confirmed fill amounts)`);
    }
    const filledFraction = positionQuantityBefore > 0
      ? Math.max(0, Math.min(1, filledBaseQty / positionQuantityBefore))
      : requestedFraction;

    return {
      realizedExitPrice,
      hasExchangeFilledData,
      filledBaseQty,
      filledQuoteUsd,
      filledFraction,
    };
  }

  return {
    setExecutionJournalState,
    markExecutionConfirmed,
    resolveBuyFillMetrics,
    resolveSellFillMetrics,
  };
}

module.exports = { createExecutionAccounting };
