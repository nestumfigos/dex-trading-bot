'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  getFeatureSchemaHash,
} = require('../src/utils/feature-schema');

function summarizeDataset(dataset = {}) {
  const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
  const positives = rows.filter((row) => Number(row?.label) === 1).length;
  const avgFutureReturnPct = rows.length
    ? rows.reduce((sum, row) => sum + Number(row?.futureReturnPct || 0), 0) / rows.length
    : 0;
  const avgCoverage = rows.length
    ? rows.reduce((sum, row) => sum + Number(row?.featureCoverage || 0), 0) / rows.length
    : 0;
  return {
    rowCount: rows.length,
    positiveRate: rows.length ? positives / rows.length : 0,
    avgFutureReturnPct,
    avgFeatureCoverage: avgCoverage,
  };
}

function main() {
  const datasetPath = path.resolve(process.cwd(), process.argv[2] || 'artifacts/models/ml_dataset.json');
  const outPath = path.resolve(process.cwd(), process.argv[3] || 'artifacts/models/validation_suite.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const expectedHash = getFeatureSchemaHash(FEATURE_ORDER, FEATURE_SCHEMA_VERSION);
  const datasetHash = String(dataset.featureSchemaHash || dataset.metadata?.featureSchemaHash || '');
  const report = {
    generatedAt: new Date().toISOString(),
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    expectedFeatureSchemaHash: expectedHash,
    datasetFeatureSchemaHash: datasetHash || null,
    featureSchemaMatch: !datasetHash || datasetHash === expectedHash,
    datasetSummary: summarizeDataset(dataset),
    validation: {
      walkForwardReady: Array.isArray(dataset.rows) && dataset.rows.length >= 300,
      leaderboardReady: Array.isArray(dataset.rows) && dataset.rows.length >= 500,
      rlResearchReady: Array.isArray(dataset.rows) && dataset.rows.length >= 1000,
    },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ outPath, featureSchemaMatch: report.featureSchemaMatch, rowCount: report.datasetSummary.rowCount })}\n`);
}

main();
