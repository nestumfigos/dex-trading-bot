'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');
const { resolveArtifactPath } = require('../src/utils/model-registry');

const REGIME_FEATURES = [
  'return1Pct',
  'return3Pct',
  'return12Pct',
  'return24Pct',
  'realizedVolPct',
  'garchVolatilityPct',
  'volumeSpike',
  'sentimentScore',
  'onchainMacroScore',
  'binanceMomentumConfirm',
];

function parseFeatures(row) {
  const features = row.features || {};
  const out = {};
  for (const key of REGIME_FEATURES) out[key] = Number(features[key] || 0);
  return out;
}

async function main() {
  const datasetPath = path.resolve(process.cwd(), process.argv[2] || 'artifacts/models/ml_dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const rows = (dataset.rows || []).map((row) => ({ features: parseFeatures(row) })).filter((row) => Object.keys(row.features).length);
  if (rows.length < 50) throw new Error(`Need at least 50 rows for regime training, got ${rows.length}`);
  const frameworks = ['kmeans', 'gmm', 'hmm'];
  const results = [];
  for (const framework of frameworks) {
    const artifactPath = resolveArtifactPath(`artifacts/models/regime_${framework}-v1.pkl`);
    const result = await runPythonSidecar('train_regime_model', {
      framework,
      artifactPath,
      rows,
      featureOrder: REGIME_FEATURES,
      nClusters: 4,
    }, logger);
    results.push(result);
  }
  console.log(JSON.stringify({ trained: results.length, results }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
