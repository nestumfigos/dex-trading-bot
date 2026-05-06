function createTradeRepairHelpers(deps = {}) {
  const {
    portfolio,
    logger,
    exchanges,
    config,
    normalizeChainKey,
    buildTokenKey,
    ensureStatsShape,
    extractFilledBaseQty,
    extractFilledQuoteUsd,
    extractExecutionPriceUsd,
    calcSlippageBps,
    calcDiscrepancyPct,
    round,
    setExecutionJournalState,
    refreshPerformanceMetrics,
    recordPortfolioSnapshot,
    saveState,
  } = deps;

  function getTradePositionKey(trade = {}) {
    const chainKey = normalizeChainKey(trade.chainKey || trade.chain);
    const address = String(trade.address || '').trim().toLowerCase();
    const strategyName = String(trade.strategy || 'momentum').toLowerCase();
    if (!chainKey || !address) return '';
    return `${chainKey}:${address}:${strategyName}`;
  }

  function getTradeRepairSignature(trade = {}) {
    return [
      String(trade.timestamp || ''),
      String(trade.type || ''),
      normalizeChainKey(trade.chainKey || trade.chain),
      String(trade.address || '').trim().toLowerCase(),
      String(trade.strategy || 'momentum').toLowerCase(),
      String(trade.reason || ''),
    ].join('|');
  }

  function patchTradeCopiesBySignature(signature, mutator) {
    const targets = [
      portfolio.trades,
      ...Object.values(portfolio.strategies || {}).map((bucket) => bucket?.trades),
    ];

    for (const list of targets) {
      if (!Array.isArray(list)) continue;
      for (const trade of list) {
        if (!trade || getTradeRepairSignature(trade) !== signature) continue;
        mutator(trade);
      }
    }
  }

  function getLotStateBeforeTrade(targetTrade) {
    const chronological = [...(portfolio.trades || [])]
      .filter((trade) => trade && typeof trade === 'object')
      .sort((left, right) => {
        const l = Date.parse(left.timestamp || '') || 0;
        const r = Date.parse(right.timestamp || '') || 0;
        return l - r;
      });
    const lotStates = new Map();

    for (const trade of chronological) {
      if (trade === targetTrade) {
        const current = lotStates.get(getTradePositionKey(trade)) || { qty: 0, cost: 0 };
        return {
          openQtyBefore: Number(current.qty || 0),
          openCostBefore: Number(current.cost || 0),
        };
      }

      const key = getTradePositionKey(trade);
      if (!key) continue;

      const current = lotStates.get(key) || { qty: 0, cost: 0 };
      if (trade.type === 'BUY') {
        current.qty += extractFilledBaseQty(trade, Number(trade.quantity || 0));
        current.cost += extractFilledQuoteUsd(trade, Number(trade.valueUsd || 0));
      } else if (trade.type === 'SELL') {
        const soldQty = Math.min(extractFilledBaseQty(trade, Number(trade.quantity || 0)), current.qty);
        const soldFraction = current.qty > 0 ? Math.max(0, Math.min(1, soldQty / current.qty)) : 0;
        current.cost = Math.max(0, current.cost - (current.cost * soldFraction));
        current.qty = Math.max(0, current.qty - soldQty);
      }

      lotStates.set(key, current);
    }

    return { openQtyBefore: 0, openCostBefore: 0 };
  }

  function applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd = 0, options = {}) {
    ensureStatsShape();
    const strategyStats = portfolio.strategies?.[strategyName]?.stats;
    if (!strategyStats) return;

    if (options.applyCashLedger !== false && Number.isFinite(Number(proceedsUsd)) && Number(proceedsUsd) > 0) {
      portfolio.balance += Number(proceedsUsd);
    }

    portfolio.stats.totalPnl += pnl;
    strategyStats.totalPnl += pnl;
    if (pnl >= 0) {
      portfolio.stats.grossProfit += pnl;
      strategyStats.grossProfit += pnl;
    } else {
      portfolio.stats.grossLoss += Math.abs(pnl);
      strategyStats.grossLoss += Math.abs(pnl);
    }

    portfolio.stats.closedTrades += 1;
    strategyStats.closedTrades += 1;
    portfolio.stats.executions += 1;
    strategyStats.executions += 1;

    if (pnl >= 0) {
      portfolio.stats.wins += 1;
      strategyStats.wins += 1;
      portfolio.stats.consecutiveLosses = 0;
      strategyStats.consecutiveLosses = 0;
      portfolio.stats.consecutiveWins = Number(portfolio.stats.consecutiveWins || 0) + 1;
      strategyStats.consecutiveWins = Number(strategyStats.consecutiveWins || 0) + 1;
    } else {
      portfolio.stats.losses += 1;
      strategyStats.losses += 1;
      portfolio.stats.consecutiveWins = 0;
      strategyStats.consecutiveWins = 0;
      portfolio.stats.consecutiveLosses = Number(portfolio.stats.consecutiveLosses || 0) + 1;
      portfolio.stats.maxConsecutiveLosses = Math.max(
        Number(portfolio.stats.maxConsecutiveLosses || 0),
        Number(portfolio.stats.consecutiveLosses || 0)
      );
      strategyStats.consecutiveLosses = Number(strategyStats.consecutiveLosses || 0) + 1;
      strategyStats.maxConsecutiveLosses = Math.max(
        Number(strategyStats.maxConsecutiveLosses || 0),
        Number(strategyStats.consecutiveLosses || 0)
      );
    }
  }

  function recoverSellFailureTrade(failedTrade, recoveredTxResult, options = {}) {
    if (!failedTrade || failedTrade.type !== 'SELL_FAILED') return false;

    const strategyName = String(failedTrade.strategy || 'momentum').toLowerCase();
    const requestedQty = Number(failedTrade.requestedQuantity || failedTrade.quantity || 0);
    let recoveredQty = extractFilledBaseQty(recoveredTxResult, requestedQty);
    if (!Number.isFinite(recoveredQty) || recoveredQty <= 0) {
      return false;
    }

    const { openQtyBefore, openCostBefore } = getLotStateBeforeTrade(failedTrade);
    if (!Number.isFinite(openQtyBefore) || openQtyBefore <= 0 || !Number.isFinite(openCostBefore) || openCostBefore <= 0) {
      logger.warn(`Skipping SELL_FAILED repair for ${failedTrade.symbol}: could not reconstruct pre-sell cost basis`);
      return false;
    }

    recoveredQty = Math.min(recoveredQty, openQtyBefore);
    const realizedPrice = extractExecutionPriceUsd(recoveredTxResult, Number(failedTrade.expectedPrice || failedTrade.price || 0));
    let proceedsUsd = extractFilledQuoteUsd(recoveredTxResult, 0);
    if (!Number.isFinite(proceedsUsd) || proceedsUsd <= 0) {
      proceedsUsd = recoveredQty * realizedPrice;
    }
    if (!Number.isFinite(proceedsUsd) || proceedsUsd <= 0) {
      logger.warn(`Skipping SELL_FAILED repair for ${failedTrade.symbol}: missing recovered proceeds`);
      return false;
    }

    const filledFraction = openQtyBefore > 0 ? Math.max(0, Math.min(1, recoveredQty / openQtyBefore)) : 0;
    const costBasisPortion = openCostBefore * filledFraction;
    const pnl = proceedsUsd - costBasisPortion;
    const expectedPrice = Number(failedTrade.expectedPrice || failedTrade.price || realizedPrice || 0);
    const slippageBps = calcSlippageBps(expectedPrice, realizedPrice);
    const fillDiscrepancyPct = calcDiscrepancyPct(requestedQty || recoveredQty, recoveredQty);
    const signature = getTradeRepairSignature(failedTrade);
    const recoveredTimestamp = recoveredTxResult.timestamp || failedTrade.timestamp || new Date().toISOString();

    patchTradeCopiesBySignature(signature, (trade) => {
      trade.type = 'SELL';
      trade.txid = recoveredTxResult.txid || trade.txid || null;
      trade.timestamp = recoveredTimestamp;
      trade.price = realizedPrice > 0 ? round(realizedPrice, 8) : trade.price;
      trade.pnl = round(pnl);
      trade.quantity = round(recoveredQty, 6);
      trade.valueUsd = round(proceedsUsd);
      trade.expectedPrice = expectedPrice > 0 ? round(expectedPrice, 8) : null;
      trade.realizedPrice = realizedPrice > 0 ? round(realizedPrice, 8) : null;
      trade.slippageBps = slippageBps === null ? null : round(slippageBps, 2);
      trade.requestedQuantity = requestedQty > 0 ? round(requestedQty, 8) : trade.requestedQuantity || null;
      trade.filledQuantity = round(recoveredQty, 8);
      trade.requestedValueUsd = Number.isFinite(Number(trade.requestedValueUsd))
        ? trade.requestedValueUsd
        : (requestedQty > 0 && expectedPrice > 0 ? round(requestedQty * expectedPrice) : null);
      trade.filledValueUsd = round(proceedsUsd);
      trade.fillDiscrepancyPct = fillDiscrepancyPct === null ? null : round(fillDiscrepancyPct, 4);
      trade.executionStatus = 'confirmed';
      trade.recoveredFromFailure = true;
      trade.recoverySource = 'exchange_trade_history';
      if (Number.isFinite(Number(recoveredTxResult.blockNumber))) {
        trade.blockNumber = Number(recoveredTxResult.blockNumber);
      }
      if (Number.isFinite(Number(recoveredTxResult.confirmations))) {
        trade.confirmations = Number(recoveredTxResult.confirmations);
      }
    });

    if (recoveredTxResult?.txid) {
      setExecutionJournalState(recoveredTxResult.txid, {
        status: 'confirmed',
        type: 'SELL',
        chain: normalizeChainKey(failedTrade.chainKey || failedTrade.chain),
        chainKey: normalizeChainKey(failedTrade.chainKey || failedTrade.chain),
        symbol: failedTrade.symbol,
        address: failedTrade.address,
        blockNumber: Number(recoveredTxResult?.blockNumber || 0) || null,
        confirmations: Number(recoveredTxResult?.confirmations || 0) || null,
        createdAt: recoveredTimestamp,
      });
    }

    applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd, options);
    logger.warn(`Recovered historical SELL for ${failedTrade.symbol}: PnL ${pnl >= 0 ? '+' : ''}$${round(pnl).toFixed(2)}`);
    return true;
  }

  async function repairAmbiguousKucoinSellFailures(options = {}) {
    const kucoinExchange = exchanges?.kucoin;
    if (!kucoinExchange || typeof kucoinExchange.findRecentTradeFill !== 'function') {
      return 0;
    }

    const candidates = [...(portfolio.trades || [])]
      .filter((trade) => {
        if (!trade || trade.type !== 'SELL_FAILED') return false;
        if (normalizeChainKey(trade.chainKey || trade.chain) !== 'kucoin') return false;
        if (!trade.address) return false;
        const positionKey = buildTokenKey('kucoin', trade.address);
        if (portfolio.positions?.[positionKey]) return false;
        const failedAtMs = Date.parse(trade.timestamp || '') || 0;
        return !portfolio.trades.some((other) => {
          if (!other || other === trade || other.type !== 'SELL') return false;
          if (String(other.address || '').toLowerCase() !== String(trade.address || '').toLowerCase()) return false;
          if (String(other.strategy || 'momentum').toLowerCase() !== String(trade.strategy || 'momentum').toLowerCase()) return false;
          const otherAtMs = Date.parse(other.timestamp || '') || 0;
          return otherAtMs >= failedAtMs - 60_000;
        });
      })
      .sort((left, right) => (Date.parse(left.timestamp || '') || 0) - (Date.parse(right.timestamp || '') || 0));

    let repaired = 0;
    const consumedTxids = new Set();

    for (const trade of candidates) {
      const tradeTimestampMs = Date.parse(trade.timestamp || '') || Date.now();
      const expectedQty = Number(trade.requestedQuantity || trade.quantity || 0);
      const recoveredTxResult = await kucoinExchange.findRecentTradeFill(trade.address, 'sell', expectedQty, {
        sinceMs: Math.max(0, tradeTimestampMs - 60_000),
        lookbackMs: 20 * 60 * 1000,
        targetTimestampMs: tradeTimestampMs,
      });
      if (!recoveredTxResult?.txid || consumedTxids.has(String(recoveredTxResult.txid))) continue;
      if (!recoverSellFailureTrade(trade, recoveredTxResult, options)) continue;
      consumedTxids.add(String(recoveredTxResult.txid));
      repaired += 1;
    }

    if (repaired > 0) {
      refreshPerformanceMetrics();
      recordPortfolioSnapshot('repair_sell_failure');
      await saveState();
    }

    return repaired;
  }

  return {
    getTradePositionKey,
    getTradeRepairSignature,
    patchTradeCopiesBySignature,
    getLotStateBeforeTrade,
    applyRecoveredClosedTradeStats,
    recoverSellFailureTrade,
    repairAmbiguousKucoinSellFailures,
  };
}

module.exports = { createTradeRepairHelpers };
