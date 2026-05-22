'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { runPythonSidecar } = require('../src/utils/python-sidecar');
const { ModelRegistry, resolveArtifactPath } = require('../src/utils/model-registry');
const {
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  getFeatureSchemaHash,
} = require('../src/utils/feature-schema');

async function main() {
  const engine = String(process.argv[2] || process.env.RL_PRODUCTION_POLICY_ENGINE || 'sb3').trim().toLowerCase();
  const datasetPath = path.resolve(process.cwd(), process.argv[3] || 'artifacts/models/ml_dataset.json');
  const artifactPath = resolveArtifactPath(
    engine === 'rllib'
      ? 'artifacts/rl/rllib_policy_production-v1'
      : 'artifacts/rl/sb3_policy_production-v1'
  );
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`RL dataset not found: ${datasetPath}`);
  }
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const expectedHash = getFeatureSchemaHash(FEATURE_ORDER, FEATURE_SCHEMA_VERSION);
  const datasetHash = String(dataset.featureSchemaHash || dataset.metadata?.featureSchemaHash || '');
  const featureOrder = Array.isArray(dataset.featureOrder) && dataset.featureOrder.length
    ? dataset.featureOrder
    : FEATURE_ORDER;
  if (datasetHash && datasetHash !== expectedHash) {
    throw new Error(`RL dataset feature schema mismatch: dataset=${datasetHash} runtime=${expectedHash}`);
  }
  const result = await runPythonSidecar('train_rl', {
    engine,
    algorithm: engine === 'rllib' ? (process.env.RL_RLLIB_ALGORITHM || 'PPO') : (process.env.RL_SB3_ALGORITHM || 'PPO'),
    artifactPath,
    featureOrder,
    rows: dataset.rows || [],
    episodes: Number(process.env.RL_PRODUCTION_TRAINING_EPISODES || 2000),
  }, logger);
  const registry = new ModelRegistry({
    logger,
    botProfile: String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase(),
  });
  await registry.ensureReady();
  await registry.upsertRlPolicy({
    policyName: engine === 'rllib' ? 'rllib_production_default' : 'sb3_production_default',
    stage: String(process.env.RL_POLICY_STAGE || 'research_sandbox'),
    status: 'active',
    policy: {
      framework: engine,
      engine,
      artifactPath: result.artifactPath || artifactPath,
      featureOrder,
      algorithm: engine === 'rllib' ? (process.env.RL_RLLIB_ALGORITHM || 'PPO') : (process.env.RL_SB3_ALGORITHM || 'PPO'),
      featureSchemaHash: expectedHash,
    },
    metrics: {
      ...(result.metrics || {}),
      artifactPath: result.artifactPath || artifactPath,
      featureOrder,
      featureSchemaHash: expectedHash,
      framework: engine,
      trainedRows: Number(result.trainedRows || (dataset.rows || []).length || 0),
    },
  });
  logger.info(`[ProductionRL] ${engine} trainer result: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  logger.error(`[ProductionRL] training failed: ${error.message}`);
  process.exit(1);
});
