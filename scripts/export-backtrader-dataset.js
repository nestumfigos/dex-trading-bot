'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const config = require('../config');
const { getOhlcvSeries } = require('../src/utils/candles');

function parseArgs() {
  const chainKey = String(process.argv[2] || '').trim().toLowerCase();
  const tokenRef = String(process.argv[3] || '').trim();
  const interval = String(process.argv[4] || '15m').trim();
  const limit = Math.max(60, Math.min(500, Number(process.argv[5] || 240)));
  const outPath = path.resolve(process.cwd(), process.argv[6] || `artifacts/backtrader/${chainKey || 'unknown'}-${tokenRef || 'dataset'}.json`);
  if (!chainKey || !tokenRef) {
    throw new Error('Usage: node scripts/export-backtrader-dataset.js <chain> <tokenAddressOrSymbol> [interval] [limit] [outPath]');
  }
  return { chainKey, tokenRef, interval, limit, outPath };
}

function loadTrackedToken(chainKey, tokenRef) {
  const candidates = [
    path.resolve(process.cwd(), 'data/marketState.json'),
    path.resolve(process.cwd(), 'data/paper/marketState.json'),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const tracked = parsed?.trackedTokens || parsed?.market?.trackedTokens || {};
      const rows = Array.isArray(tracked) ? tracked : Object.values(tracked);
      const match = rows.find((token) => String(token.chainKey || '').toLowerCase() === chainKey
        && [token.address, token.symbol, token.pairAddress]
          .map((value) => String(value || '').toLowerCase())
          .includes(tokenRef.toLowerCase()));
      if (match) return match;
    } catch {
      // ignore malformed state snapshots
    }
  }
  return null;
}

function intervalToCcxt(interval = '15m') {
  const normalized = String(interval || '15m').trim().toLowerCase();
  return /^[1-9]\d*(m|h|d)$/.test(normalized) ? normalized : '15m';
}

async function fetchKucoinOhlcv(symbol, interval, limit) {
  const exchange = new ccxt.kucoin({
    apiKey: config.kucoin.apiKey,
    secret: config.kucoin.apiSecret,
    password: config.kucoin.apiPassphrase,
    sandbox: config.kucoin.sandbox,
    enableRateLimit: true,
    options: { adjustForTimeDifference: true },
  });
  await exchange.loadMarkets();
  const rows = await exchange.fetchOHLCV(symbol, intervalToCcxt(interval), undefined, limit);
  return (rows || []).map((row) => ({
    timestamp: Number(row?.[0] || 0),
    open: Number(row?.[1] || 0),
    high: Number(row?.[2] || 0),
    low: Number(row?.[3] || 0),
    close: Number(row?.[4] || 0),
    volume: Number(row?.[5] || 0),
  })).filter((row) => row.timestamp > 0 && row.close > 0);
}

function toCsv(rows = []) {
  const header = 'datetime,open,high,low,close,volume';
  const lines = rows.map((row) => ([
    new Date(Number(row.timestamp || 0)).toISOString(),
    Number(row.open || 0),
    Number(row.high || 0),
    Number(row.low || 0),
    Number(row.close || 0),
    Number(row.volume || 0),
  ].join(',')));
  return [header, ...lines].join('\n');
}

async function main() {
  const { chainKey, tokenRef, interval, limit, outPath } = parseArgs();
  const tracked = loadTrackedToken(chainKey, tokenRef);
  let candles = [];

  if (chainKey === 'kucoin') {
    const symbol = tracked?.address || tracked?.symbol || tokenRef;
    candles = await fetchKucoinOhlcv(symbol, interval, limit);
  } else {
    const ohlcv = await getOhlcvSeries({
      chainKey,
      address: tracked?.address || tokenRef,
      pairAddress: tracked?.pairAddress || '',
      interval,
      limit,
    });
    candles = Array.isArray(ohlcv?.candles) ? ohlcv.candles : [];
  }

  if (!candles.length) {
    throw new Error(`No OHLCV rows available for ${chainKey}:${tokenRef}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    chainKey,
    tokenRef,
    symbol: tracked?.symbol || null,
    interval,
    source: chainKey === 'kucoin' ? 'ccxt_kucoin' : 'geckoterminal',
    rows: candles,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const csvPath = outPath.replace(/\.json$/i, '.csv');
  fs.writeFileSync(csvPath, toCsv(candles));
  console.log(JSON.stringify({ outPath, csvPath, rows: candles.length, chainKey, tokenRef }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
