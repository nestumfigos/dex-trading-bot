#!/usr/bin/env node
'use strict';

// K3: pull all KuCoin Futures USDT-margined active contracts, filter, and
// emit canonical symbols (Binance-style BTCUSDT) into a JSON snapshot the
// perps service reads at boot. Replaces the static BTC/ETH/SOL default.
//
// Usage:
//   node scripts/refresh-kucoin-perps-universe.js                 # writes config/kucoin-perps-universe.json
//   node scripts/refresh-kucoin-perps-universe.js --print         # stdout only
//   node scripts/refresh-kucoin-perps-universe.js --min-vol 1e6   # filter by 24h quote volume floor (USDT)
//   node scripts/refresh-kucoin-perps-universe.js --top 50        # keep top N by maxRiskLimit (deep-book proxy)
//
// The snapshot also stores per-symbol contract specs (multiplier, maintainMargin,
// initialMargin, lotSize, tickSize, maxRiskLimit) so the runtime can size and
// calculate liquidation buffers without re-fetching during scans.

const fs = require('fs');
const path = require('path');
const { fromKucoinSymbol, isKucoinUsdtmPerp } = require('../src/utils/perps-symbols');

const BASE_URL = 'https://api-futures.kucoin.com';
const DEFAULT_OUTPUT = path.resolve(__dirname, '..', 'config', 'kucoin-perps-universe.json');

function parseArgs(argv) {
  const args = { print: false, minVol: 0, top: null, out: DEFAULT_OUTPUT };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--print') args.print = true;
    else if (flag === '--min-vol') args.minVol = Number(argv[++i] || 0);
    else if (flag === '--top') args.top = Number(argv[++i] || 0);
    else if (flag === '--out') args.out = path.resolve(argv[++i] || DEFAULT_OUTPUT);
  }
  return args;
}

async function fetchActiveContracts() {
  const fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') throw new Error('global fetch unavailable (need Node 18+)');
  const response = await fetchFn(`${BASE_URL}/api/v1/contracts/active`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`KuCoin contracts/active HTTP ${response.status}`);
  const body = await response.json();
  if (!body || body.code !== '200000' || !Array.isArray(body.data)) {
    throw new Error(`KuCoin contracts/active invalid response (code=${body?.code})`);
  }
  return body.data;
}

function toSnapshotEntry(contract) {
  return {
    canonical: fromKucoinSymbol(contract.symbol),
    kucoin: contract.symbol,
    base: contract.baseCurrency,
    quote: contract.quoteCurrency,
    settle: contract.settleCurrency,
    multiplier: Number(contract.multiplier),
    lotSize: Number(contract.lotSize),
    tickSize: Number(contract.tickSize),
    initialMargin: Number(contract.initialMargin),
    maintainMargin: Number(contract.maintainMargin),
    maxRiskLimit: Number(contract.maxRiskLimit),
    minRiskLimit: Number(contract.minRiskLimit),
    riskStep: Number(contract.riskStep),
    makerFeeRate: Number(contract.makerFeeRate),
    takerFeeRate: Number(contract.takerFeeRate),
    // turnoverOf24h is on the contract specs when KuCoin exposes it;
    // null if absent, downstream filters guard for null.
    turnoverOf24h: contract.turnoverOf24h != null ? Number(contract.turnoverOf24h) : null,
    volumeOf24h: contract.volumeOf24h != null ? Number(contract.volumeOf24h) : null,
    priceChgPct: contract.priceChgPct != null ? Number(contract.priceChgPct) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const contracts = await fetchActiveContracts();

  // Filter: USDT-margined active perps only.
  const usdtMargined = contracts.filter((c) => (
    c.settleCurrency === 'USDT'
    && c.status !== 'Closed'
    && isKucoinUsdtmPerp(c.symbol)
  ));

  let entries = usdtMargined.map(toSnapshotEntry);

  if (args.minVol > 0) {
    entries = entries.filter((e) => Number.isFinite(e.turnoverOf24h) && e.turnoverOf24h >= args.minVol);
  }
  if (Number.isFinite(args.top) && args.top > 0) {
    // Rank by turnoverOf24h when available (true liquidity proxy), else
    // maxRiskLimit (exchange's own depth tier estimate).
    entries = entries
      .slice()
      .sort((a, b) => {
        const va = Number.isFinite(a.turnoverOf24h) ? a.turnoverOf24h : a.maxRiskLimit;
        const vb = Number.isFinite(b.turnoverOf24h) ? b.turnoverOf24h : b.maxRiskLimit;
        return vb - va;
      })
      .slice(0, args.top);
  }

  const snapshot = {
    source: 'kucoin-futures',
    refreshedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    filters: { minVol: args.minVol, top: args.top },
    count: entries.length,
    canonicalSymbols: entries.map((e) => e.canonical),
    contracts: entries,
  };

  if (args.print) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(snapshot, null, 2));
  console.log(`[refresh-kucoin-perps-universe] wrote ${entries.length} symbols -> ${args.out}`);
  console.log(`[refresh-kucoin-perps-universe] sample: ${entries.slice(0, 8).map((e) => e.canonical).join(', ')}${entries.length > 8 ? ', ...' : ''}`);
}

main().catch((err) => {
  console.error(`[refresh-kucoin-perps-universe] FAILED: ${err.message}`);
  process.exit(1);
});
