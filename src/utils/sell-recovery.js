'use strict';

// Extracted from src/index.js (Week 12 A.2).
// Detects + recovers ambiguous KuCoin SELL failures by querying recent fills.

function isAmbiguousSellFailure(errorText = '') {
  return /balance insufficient|\b200004\b|not filled|timed out|timeout/i.test(String(errorText || ''));
}

function createSellRecovery({ logger }) {
  async function recoverFailedSellExecutionFromExchange({
    chainName,
    exchange,
    tokenData,
    quantityToSell,
    sellStartedAtMs,
    errorText,
  }) {
    if (!exchange || typeof exchange.findRecentTradeFill !== 'function') {
      return null;
    }
    if (!isAmbiguousSellFailure(errorText)) {
      return null;
    }

    try {
      const recoveredFill = await exchange.findRecentTradeFill(tokenData.address, 'sell', quantityToSell, {
        sinceMs: Math.max(0, Number(sellStartedAtMs || Date.now()) - 15_000),
        lookbackMs: 5 * 60 * 1000,
        targetTimestampMs: sellStartedAtMs || Date.now(),
      });
      if (!recoveredFill || !Number.isFinite(Number(recoveredFill.filledBaseQty)) || Number(recoveredFill.filledBaseQty) <= 0) {
        return null;
      }
      logger.warn(`Recovered SELL fill from exchange history for ${tokenData.symbol} on ${chainName} after error: ${errorText}`);
      return recoveredFill;
    } catch (recoveryError) {
      logger.warn(`SELL recovery lookup failed for ${tokenData.symbol} on ${chainName}: ${recoveryError.message}`);
      return null;
    }
  }

  return { isAmbiguousSellFailure, recoverFailedSellExecutionFromExchange };
}

module.exports = { isAmbiguousSellFailure, createSellRecovery };
