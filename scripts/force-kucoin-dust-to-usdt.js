'use strict';

require('dotenv').config();

const ccxt = require('ccxt');
const crypto = require('crypto');
const config = require('../config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isExecuteMode() {
  return process.argv.includes('--execute');
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactError(error) {
  const raw = String(error?.message || error || 'unknown_error');
  return raw.replace(/\s+/g, ' ').slice(0, 500);
}

function clientOrderId(asset) {
  return `dust-${asset.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

async function main() {
  const execute = isExecuteMode();
  const exchange = new ccxt.kucoin({
    apiKey: config.kucoin.apiKey,
    secret: config.kucoin.apiSecret,
    password: config.kucoin.apiPassphrase,
    sandbox: config.kucoin.sandbox,
    enableRateLimit: true,
  });

  await exchange.loadMarkets();
  await exchange.loadTimeDifference();

  const balance = await exchange.fetchBalance();
  const totals = balance.total || {};
  const free = balance.free || {};

  const openPositionSymbols = new Set(
    String(process.env.DUST_CLEANUP_EXCLUDE_SYMBOLS || 'STAR')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  const maxDustUsd = Math.max(
    parseNumber(config.risk?.reconciliationDustUsd, 0),
    parseNumber(process.env.RECONCILE_ADOPT_MIN_VALUE_USD, 0),
    parseNumber(process.env.DUST_CLEANUP_MAX_USD, 5)
  );

  const candidates = [];
  for (const [assetRaw, totalRaw] of Object.entries(totals)) {
    const asset = String(assetRaw || '').toUpperCase();
    if (!asset || asset === 'USDT' || openPositionSymbols.has(asset)) continue;
    const qty = parseNumber(free[asset] ?? totalRaw, 0);
    if (qty <= 0) continue;

    const symbol = `${asset}/USDT`;
    const market = exchange.markets[symbol] || null;
    if (!market) continue;

    let price = 0;
    try {
      const ticker = await exchange.fetchTicker(symbol);
      price = parseNumber(ticker?.bid || ticker?.last || ticker?.close, 0);
    } catch (_) {}
    const valueUsd = price > 0 ? qty * price : 0;
    const minBaseSize = parseNumber(market?.limits?.amount?.min, 0);
    const minFunds = parseNumber(market?.limits?.cost?.min, 0);
    const belowBaseMin = minBaseSize > 0 && qty < minBaseSize;
    const belowQuoteMin = minFunds > 0 && valueUsd > 0 && valueUsd < minFunds;
    if (valueUsd <= maxDustUsd || belowBaseMin || belowQuoteMin) {
      candidates.push({ asset, symbol, qty, price, valueUsd, minBaseSize, minFunds, belowBaseMin, belowQuoteMin });
    }
    await sleep(250);
  }

  const results = [];
  for (const candidate of candidates) {
    const result = { ...candidate, execute, converted: false, sold: false, blocked: false, attempts: [] };

    try {
      const quote = await exchange.privateGetConvertQuote({
        fromCurrency: candidate.asset,
        toCurrency: 'USDT',
        fromCurrencySize: String(candidate.qty),
      });
      result.attempts.push({ method: 'convert_quote', ok: true, quote: quote?.data || quote });

      if (execute) {
        const order = await exchange.privatePostConvertOrder({
          clientOrderId: clientOrderId(candidate.asset),
          quoteId: quote?.data?.quoteId,
          accountType: 'BOTH',
        });
        result.converted = true;
        result.attempts.push({ method: 'convert_order', ok: true, order: order?.data || order });
      }
    } catch (error) {
      result.attempts.push({ method: 'convert', ok: false, error: compactError(error) });
    }

    if (!result.converted) {
      try {
        const amount = parseNumber(exchange.amountToPrecision(candidate.symbol, candidate.qty), 0);
        if (amount <= 0) throw new Error('rounded amount is zero');
        const order = execute
          ? await exchange.createOrder(candidate.symbol, 'market', 'sell', amount, undefined, { clientOid: clientOrderId(candidate.asset) })
          : { dryRun: true, amount };
        result.sold = execute;
        result.attempts.push({ method: 'spot_market_sell', ok: true, order });
      } catch (error) {
        result.attempts.push({ method: 'spot_market_sell', ok: false, error: compactError(error) });
      }
    }

    result.blocked = !result.converted && !result.sold;
    results.push(result);
    await sleep(900);
  }

  const after = await exchange.fetchBalance();
  const remainingDust = {};
  for (const row of candidates) {
    remainingDust[row.asset] = parseNumber(after.total?.[row.asset], 0);
  }

  console.log(JSON.stringify({
    execute,
    maxDustUsd,
    excludedSymbols: [...openPositionSymbols],
    candidates,
    results,
    remainingDust,
    usdtAfter: parseNumber(after.total?.USDT, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(compactError(error));
  process.exit(1);
});
