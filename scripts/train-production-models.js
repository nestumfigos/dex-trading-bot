'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');
const { resolveArtifactPath } = require('../src/utils/model-registry');

async function main() {
  const datasetPath = process.argv[2];
  const framework = String(process.argv[3] || 'sklearn_random_forest').trim().toLowerCase();
  if (!datasetPath) {
    throw new Error('Usage: node scripts/train-production-models.js <dataset.json> [framework]');
  }
  const raw = fs.readFileSync(path.resolve(process.cwd(), datasetPath), 'utf8');
  const dataset = JSON.parse(raw);
  const artifactMap = {
    xgboost: resolveArtifactPath('artifacts/models/xgboost_production-v1.pkl'),
    sklearn_random_forest: resolveArtifactPath('artifacts/models/random_forest_production-v1.pkl'),
    sklearn: resolveArtifactPath('artifacts/models/random_forest_production-v1.pkl'),
    torch_lstm: resolveArtifactPath('artifacts/models/lstm_sequence_production-v1.pt'),
    lstm: resolveArtifactPath('artifacts/models/lstm_sequence_production-v1.pt'),
    pytorch: resolveArtifactPath('artifacts/models/lstm_sequence_production-v1.pt'),
  };
  const artifactPath = artifactMap[framework] || resolveArtifactPath(`artifacts/models/${framework}-artifact.bin`);
  const result = await runPythonSidecar('train_model', {
    framework,
    artifactPath,
    rows: dataset.rows || [],
    featureOrder: dataset.featureOrder || [],
  }, logger);
  logger.info(`[ProductionML] trained ${framework} artifact at ${result.artifactPath} using ${result.trainedRows} rows`);
}

main().catch((error) => {
  logger.error(`[ProductionML] training failed: ${error.message}`);
  process.exit(1);
});
