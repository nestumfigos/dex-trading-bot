'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

function toFinite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const datasetPath = path.resolve(process.cwd(), process.argv[2] || 'artifacts/models/ml_dataset.json');
  const outDir = path.resolve(process.cwd(), process.argv[3] || 'artifacts/finrlx');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
  if (!rows.length) {
    throw new Error(`No rows found in ${datasetPath}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const jsonlPath = path.join(outDir, 'finrlx_observations.jsonl');
  const manifestPath = path.join(outDir, 'finrlx_manifest.json');

  const jsonl = rows.map((row, index) => JSON.stringify({
    id: `${row.chainKey || 'unknown'}:${row.symbol || 'unknown'}:${index}`,
    ts: row.ts,
    asset: row.symbol,
    venue: row.chainKey,
    strategy: row.strategy || 'momentum',
    label: Number(row.label || 0),
    reward: toFinite(row.futureReturnPct, 0) / 100,
    featureCoverage: toFinite(row.featureCoverage, 0),
    features: row.features || {},
  })).join('\n');

  fs.writeFileSync(jsonlPath, jsonl);
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceDataset: datasetPath,
    rowCount: rows.length,
    featureOrder: dataset.featureOrder || [],
    featureSchemaVersion: dataset.featureSchemaVersion || dataset.metadata?.featureSchemaVersion || null,
    featureSchemaHash: dataset.featureSchemaHash || dataset.metadata?.featureSchemaHash || null,
    notes: [
      'Exported for FinRL-X style offline research and strategy composition.',
      'Use paper/research first; do not promote directly to live without walk-forward and discrepancy checks.',
    ],
  }, null, 2));

  console.log(JSON.stringify({ outDir, jsonlPath, manifestPath, rows: rows.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
