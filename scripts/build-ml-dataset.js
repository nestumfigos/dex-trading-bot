'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/utils/sqlServer');

const FEATURE_ORDER = [
  'priceChange24hPct',
  'return1Pct',
  'return3Pct',
  'return12Pct',
  'volumeSpike',
  'buyRatioRecentPct',
  'netBuyFlowUsd10m',
  'sentimentScore',
  'realizedVolPct',
  'rsi',
];

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return fallback;
  }
}

async function main() {
  const outPath = path.resolve(process.cwd(), process.argv[2] || 'artifacts/models/ml_dataset.json');
  const horizon = Math.max(1, Number(process.argv[3] || 6));
  const minMovePct = Number(process.argv[4] || 1.0);
  const pool = await getPool(console);
  if (!pool) throw new Error('SQL pool unavailable');

  const result = await pool.request().query(`
    SELECT TOP 12000 bot_profile, ts, chain_key, symbol, address, strategy, features_json
    FROM dbo.model_feature_store
    WHERE symbol IS NOT NULL AND chain_key IS NOT NULL
    ORDER BY chain_key, symbol, ts ASC
  `);
  const rows = result.recordset || [];
  const grouped = new Map();
  for (const row of rows) {
    const key = `${String(row.chain_key).toLowerCase()}:${String(row.symbol).toUpperCase()}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      ...row,
      features: parseJson(row.features_json, {}),
    });
  }

  const dataset = [];
  for (const entries of grouped.values()) {
    entries.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    for (let i = 0; i < entries.length - horizon; i += 1) {
      const current = entries[i];
      const future = entries[Math.min(entries.length - 1, i + horizon)];
      const currentPrice = Number(current.features.price || 0);
      const futurePrice = Number(future.features.price || 0);
      if (!(currentPrice > 0 && futurePrice > 0)) continue;
      const futureReturnPct = ((futurePrice - currentPrice) / currentPrice) * 100;
      const features = {};
      for (const key of FEATURE_ORDER) {
        features[key] = Number(current.features[key] || 0);
      }
      dataset.push({
        botProfile: current.bot_profile,
        chainKey: current.chain_key,
        symbol: current.symbol,
        ts: current.ts,
        features,
        futureReturnPct,
        label: futureReturnPct >= minMovePct ? 1 : 0,
      });
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    featureOrder: FEATURE_ORDER,
    rows: dataset,
    metadata: {
      source: 'dbo.model_feature_store',
      horizonSnapshots: horizon,
      minMovePct,
      rowCount: dataset.length,
    },
  }, null, 2));
  console.log(JSON.stringify({ outPath, rows: dataset.length, featureOrder: FEATURE_ORDER.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
