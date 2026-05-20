'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getPool, sql } = require('./sqlServer');
const { runPythonSidecar } = require('./python-sidecar');

const MIN_TRAINING_ROWS = 150;
const TRAINING_LABEL_WINDOW_MINUTES = 240;
const TRAINABLE_EXTERNAL_MODELS = ['xgboost_production', 'random_forest_production'];

function safeJson(value, maxLen = 20000) {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return null;
    return encoded.length > maxLen ? encoded.slice(0, maxLen) : encoded;
  } catch {
    return null;
  }
}

function stableId(...parts) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part || '')).join('|')).digest('hex');
}

const MODEL_SCHEMA_DDL = `
IF OBJECT_ID('dbo.model_registry', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.model_registry (
    model_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    model_family NVARCHAR(40) NOT NULL,
    task_class NVARCHAR(40) NOT NULL,
    provider NVARCHAR(40) NOT NULL,
    display_name NVARCHAR(120) NOT NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_model_registry_created_at DEFAULT (SYSUTCDATETIME()),
    metadata_json NVARCHAR(MAX) NULL
  );
END;

IF OBJECT_ID('dbo.model_versions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.model_versions (
    version_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    model_id NVARCHAR(80) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    stage NVARCHAR(30) NOT NULL,
    status NVARCHAR(30) NOT NULL,
    regime_family NVARCHAR(40) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_model_versions_created_at DEFAULT (SYSUTCDATETIME()),
    activated_at DATETIME2(3) NULL,
    feature_schema_json NVARCHAR(MAX) NULL,
    params_json NVARCHAR(MAX) NULL,
    metrics_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_model_versions_model_stage' AND object_id = OBJECT_ID('dbo.model_versions'))
BEGIN
  CREATE INDEX IX_model_versions_model_stage ON dbo.model_versions(model_id, stage, status, created_at DESC);
END;

IF OBJECT_ID('dbo.model_feature_store', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.model_feature_store (
    feature_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    strategy NVARCHAR(30) NULL,
    regime_label NVARCHAR(40) NULL,
    source NVARCHAR(40) NULL,
    features_json NVARCHAR(MAX) NOT NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_model_feature_store_profile_ts' AND object_id = OBJECT_ID('dbo.model_feature_store'))
BEGIN
  CREATE INDEX IX_model_feature_store_profile_ts ON dbo.model_feature_store(bot_profile, ts DESC);
END;

IF OBJECT_ID('dbo.sentiment_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.sentiment_snapshots (
    snapshot_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    aggregate_score FLOAT NULL,
    signal NVARCHAR(16) NULL,
    confidence FLOAT NULL,
    news_count INT NULL,
    reddit_count INT NULL,
    feature_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_sentiment_snapshots_profile_ts' AND object_id = OBJECT_ID('dbo.sentiment_snapshots'))
BEGIN
  CREATE INDEX IX_sentiment_snapshots_profile_ts ON dbo.sentiment_snapshots(bot_profile, ts DESC);
END;

IF OBJECT_ID('dbo.model_predictions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.model_predictions (
    prediction_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    version_id NVARCHAR(80) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    task_class NVARCHAR(40) NULL,
    signal NVARCHAR(16) NULL,
    confidence FLOAT NULL,
    score FLOAT NULL,
    explanation_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_model_predictions_version_ts' AND object_id = OBJECT_ID('dbo.model_predictions'))
BEGIN
  CREATE INDEX IX_model_predictions_version_ts ON dbo.model_predictions(version_id, ts DESC);
END;

IF OBJECT_ID('dbo.rl_policy_registry', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.rl_policy_registry (
    policy_id NVARCHAR(80) NOT NULL PRIMARY KEY,
    policy_name NVARCHAR(80) NOT NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    stage NVARCHAR(30) NOT NULL,
    status NVARCHAR(30) NOT NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_rl_policy_registry_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_rl_policy_registry_updated_at DEFAULT (SYSUTCDATETIME()),
    policy_json NVARCHAR(MAX) NOT NULL,
    metrics_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_rl_policy_registry_name_stage' AND object_id = OBJECT_ID('dbo.rl_policy_registry'))
BEGIN
  CREATE INDEX IX_rl_policy_registry_name_stage ON dbo.rl_policy_registry(policy_name, bot_profile, stage, status, updated_at DESC);
END;

IF OBJECT_ID('dbo.multi_agent_decisions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.multi_agent_decisions (
    decision_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    ts DATETIME2(3) NOT NULL,
    chain_key NVARCHAR(30) NULL,
    symbol NVARCHAR(40) NULL,
    address NVARCHAR(120) NULL,
    task_class NVARCHAR(40) NULL,
    regime_family NVARCHAR(40) NULL,
    final_signal NVARCHAR(16) NULL,
    confidence FLOAT NULL,
    route_json NVARCHAR(MAX) NULL,
    context_json NVARCHAR(MAX) NULL
  );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_multi_agent_decisions_profile_ts' AND object_id = OBJECT_ID('dbo.multi_agent_decisions'))
BEGIN
  CREATE INDEX IX_multi_agent_decisions_profile_ts ON dbo.multi_agent_decisions(bot_profile, ts DESC);
END;
`;

const DEFAULT_MODELS = [
  {
    model_id: 'xgboost_surrogate',
    version_id: 'xgboost_surrogate-v1',
    model_family: 'xgboost',
    task_class: 'trade_inference',
    provider: 'native_js',
    display_name: 'Gradient Boost Surrogate',
    stage: 'production',
    status: 'active',
    regime_family: 'any',
    params: { thresholdBuy: 0.67, thresholdSell: 0.33 },
  },
  {
    model_id: 'random_forest_surrogate',
    version_id: 'random_forest_surrogate-v1',
    model_family: 'random_forest',
    task_class: 'trade_inference',
    provider: 'native_js',
    display_name: 'Random Forest Vote Surrogate',
    stage: 'production',
    status: 'active',
    regime_family: 'any',
    params: { thresholdBuy: 0.64, thresholdSell: 0.36 },
  },
  {
    model_id: 'lstm_sequence_surrogate',
    version_id: 'lstm_sequence_surrogate-v1',
    model_family: 'lstm',
    task_class: 'trade_inference',
    provider: 'native_js',
    display_name: 'Sequence Momentum Surrogate',
    stage: 'production',
    status: 'active',
    regime_family: 'any',
    params: { thresholdBuy: 0.66, thresholdSell: 0.34 },
  },
  {
    model_id: 'custom_sentiment_engine',
    version_id: 'custom_sentiment_engine-v1',
    model_family: 'sentiment',
    task_class: 'sentiment',
    provider: 'native_js',
    display_name: 'Custom Crypto Sentiment Engine',
    stage: 'production',
    status: 'active',
    regime_family: 'any',
    params: { bullishThreshold: 0.58, bearishThreshold: 0.42 },
  },
];

const DEFAULT_EXTERNAL_MODELS = [
  {
    model_id: 'xgboost_production',
    version_id: 'xgboost_production-v1',
    model_family: 'xgboost',
    task_class: 'trade_inference',
    provider: 'python_sidecar',
    display_name: 'Production XGBoost Model',
    stage: 'production',
    status: 'pending_artifact',
    regime_family: 'any',
    metadata: {
      framework: 'xgboost',
      artifactPath: 'artifacts/models/xgboost_production-v1.pkl',
      featureOrder: [
        'priceChange24hPct', 'return1Pct', 'return3Pct', 'return12Pct', 'volumeSpike',
        'buyRatioRecentPct', 'netBuyFlowUsd10m', 'sentimentScore', 'realizedVolPct', 'rsi',
      ],
    },
  },
  {
    model_id: 'random_forest_production',
    version_id: 'random_forest_production-v1',
    model_family: 'random_forest',
    task_class: 'trade_inference',
    provider: 'python_sidecar',
    display_name: 'Production Random Forest Model',
    stage: 'production',
    status: 'pending_artifact',
    regime_family: 'any',
    metadata: {
      framework: 'sklearn_random_forest',
      artifactPath: 'artifacts/models/random_forest_production-v1.pkl',
      featureOrder: [
        'priceChange24hPct', 'return1Pct', 'return3Pct', 'return12Pct', 'volumeSpike',
        'buyRatioRecentPct', 'netBuyFlowUsd10m', 'sentimentScore', 'realizedVolPct', 'rsi',
      ],
    },
  },
  {
    model_id: 'lstm_sequence_production',
    version_id: 'lstm_sequence_production-v1',
    model_family: 'lstm',
    task_class: 'trade_inference',
    provider: 'python_sidecar',
    display_name: 'Production LSTM Sequence Model',
    stage: 'production',
    status: 'pending_artifact',
    regime_family: 'any',
    metadata: {
      framework: 'torch_lstm',
      artifactPath: 'artifacts/models/lstm_sequence_production-v1.pt',
    },
  },
  {
    model_id: 'finbert_sentiment',
    version_id: 'finbert_sentiment-v1',
    model_family: 'sentiment',
    task_class: 'sentiment',
    provider: 'python_sidecar',
    display_name: 'FinBERT Sentiment Model',
    stage: 'production',
    status: 'pending_artifact',
    regime_family: 'any',
    metadata: {
      framework: 'finbert',
      artifactPath: 'artifacts/sentiment/finbert_sentiment-v1',
    },
  },
  {
    model_id: 'vader_sentiment',
    version_id: 'vader_sentiment-v1',
    model_family: 'sentiment',
    task_class: 'sentiment',
    provider: 'python_sidecar',
    display_name: 'VADER Sentiment Model',
    stage: 'production',
    status: 'pending_artifact',
    regime_family: 'any',
    metadata: {
      framework: 'vader',
      artifactPath: 'artifacts/sentiment/vader_sentiment-v1',
    },
  },
];

function resolveArtifactPath(rawPath = '') {
  const input = String(rawPath || '').trim();
  if (!input) return '';
  if (path.isAbsolute(input)) return input;
  const root = path.resolve(process.cwd(), String(config.externalModels?.artifactRoot || 'artifacts'));
  if (input.startsWith('artifacts\\') || input.startsWith('artifacts/')) {
    return path.resolve(process.cwd(), input);
  }
  return path.resolve(root, input);
}

class ModelRegistry {
  constructor({ logger, botProfile } = {}) {
    this.logger = logger || console;
    this.botProfile = String(botProfile || process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase();
    this._schemaReady = false;
    this._defaultsEnsured = false;
  }

  async ensureReady() {
    const pool = await getPool(this.logger);
    if (!pool) return null;
    if (!this._schemaReady) {
      await pool.request().batch(MODEL_SCHEMA_DDL);
      this._schemaReady = true;
    }
    if (!this._defaultsEnsured) {
      await this.ensureDefaultModels();
      await this.ensureExternalModelRegistryEntries();
      this._defaultsEnsured = true;
    }
    return pool;
  }

  async ensureDefaultModels() {
    const pool = await getPool(this.logger);
    if (!pool) return;
    await pool.request().batch(MODEL_SCHEMA_DDL);
    for (const def of DEFAULT_MODELS) {
      const req = pool.request();
      req.input('model_id', sql.NVarChar(80), def.model_id);
      req.input('model_family', sql.NVarChar(40), def.model_family);
      req.input('task_class', sql.NVarChar(40), def.task_class);
      req.input('provider', sql.NVarChar(40), def.provider);
      req.input('display_name', sql.NVarChar(120), def.display_name);
      req.input('metadata_json', sql.NVarChar(sql.MAX), safeJson({ default: true }));
      await req.query(`
MERGE dbo.model_registry AS t
USING (SELECT @model_id AS model_id) AS s
ON t.model_id = s.model_id
WHEN NOT MATCHED THEN
  INSERT(model_id, model_family, task_class, provider, display_name, metadata_json)
  VALUES(@model_id, @model_family, @task_class, @provider, @display_name, @metadata_json);
`);

      const versionReq = pool.request();
      versionReq.input('version_id', sql.NVarChar(80), def.version_id);
      versionReq.input('model_id', sql.NVarChar(80), def.model_id);
      versionReq.input('bot_profile', sql.NVarChar(20), this.botProfile);
      versionReq.input('stage', sql.NVarChar(30), def.stage);
      versionReq.input('status', sql.NVarChar(30), def.status);
      versionReq.input('regime_family', sql.NVarChar(40), def.regime_family);
      versionReq.input('feature_schema_json', sql.NVarChar(sql.MAX), safeJson({ version: 1 }));
      versionReq.input('params_json', sql.NVarChar(sql.MAX), safeJson(def.params || {}));
      versionReq.input('metrics_json', sql.NVarChar(sql.MAX), safeJson({ bootstrap: true }));
      await versionReq.query(`
MERGE dbo.model_versions AS t
USING (SELECT @version_id AS version_id) AS s
ON t.version_id = s.version_id
WHEN NOT MATCHED THEN
  INSERT(version_id, model_id, bot_profile, stage, status, regime_family, activated_at, feature_schema_json, params_json, metrics_json)
  VALUES(@version_id, @model_id, @bot_profile, @stage, @status, @regime_family, SYSUTCDATETIME(), @feature_schema_json, @params_json, @metrics_json);
`);
    }
  }

  async ensureExternalModelRegistryEntries() {
    const pool = await getPool(this.logger);
    if (!pool) return;
    await pool.request().batch(MODEL_SCHEMA_DDL);
    for (const def of DEFAULT_EXTERNAL_MODELS) {
      const artifactPath = resolveArtifactPath(def.metadata?.artifactPath || '');
      const artifactExists = artifactPath ? fs.existsSync(artifactPath) : false;
      const status = artifactExists ? 'active' : (def.status || 'pending_artifact');

      const req = pool.request();
      req.input('model_id', sql.NVarChar(80), def.model_id);
      req.input('model_family', sql.NVarChar(40), def.model_family);
      req.input('task_class', sql.NVarChar(40), def.task_class);
      req.input('provider', sql.NVarChar(40), def.provider);
      req.input('display_name', sql.NVarChar(120), def.display_name);
      req.input('metadata_json', sql.NVarChar(sql.MAX), safeJson({
        ...(def.metadata || {}),
        artifactPath,
        artifactExists,
      }));
      await req.query(`
MERGE dbo.model_registry AS t
USING (SELECT @model_id AS model_id) AS s
ON t.model_id = s.model_id
WHEN MATCHED THEN
  UPDATE SET model_family=@model_family, task_class=@task_class, provider=@provider, display_name=@display_name, metadata_json=@metadata_json
WHEN NOT MATCHED THEN
  INSERT(model_id, model_family, task_class, provider, display_name, metadata_json)
  VALUES(@model_id, @model_family, @task_class, @provider, @display_name, @metadata_json);
`);

      const versionReq = pool.request();
      versionReq.input('version_id', sql.NVarChar(80), def.version_id);
      versionReq.input('model_id', sql.NVarChar(80), def.model_id);
      versionReq.input('bot_profile', sql.NVarChar(20), this.botProfile);
      versionReq.input('stage', sql.NVarChar(30), def.stage);
      versionReq.input('status', sql.NVarChar(30), status);
      versionReq.input('regime_family', sql.NVarChar(40), def.regime_family);
      versionReq.input('feature_schema_json', sql.NVarChar(sql.MAX), safeJson({ version: 1 }));
      versionReq.input('params_json', sql.NVarChar(sql.MAX), safeJson({
        artifactPath,
        framework: def.metadata?.framework,
        featureOrder: def.metadata?.featureOrder || null,
      }));
      versionReq.input('metrics_json', sql.NVarChar(sql.MAX), safeJson({ artifactExists }));
      await versionReq.query(`
MERGE dbo.model_versions AS t
USING (SELECT @version_id AS version_id) AS s
ON t.version_id = s.version_id
WHEN MATCHED THEN
  UPDATE SET status=@status, params_json=@params_json, metrics_json=@metrics_json
WHEN NOT MATCHED THEN
  INSERT(version_id, model_id, bot_profile, stage, status, regime_family, activated_at, feature_schema_json, params_json, metrics_json)
  VALUES(@version_id, @model_id, @bot_profile, @stage, @status, @regime_family, CASE WHEN @status='active' THEN SYSUTCDATETIME() ELSE NULL END, @feature_schema_json, @params_json, @metrics_json);
`);
    }
  }

  async getActiveModelVersions(taskClass = 'trade_inference', regimeFamily = 'any') {
    const pool = await this.ensureReady();
    if (!pool) return [];
    const req = pool.request();
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('task_class', sql.NVarChar(40), String(taskClass || '').slice(0, 40));
    req.input('regime_family', sql.NVarChar(40), String(regimeFamily || 'any').slice(0, 40));
    const res = await req.query(`
SELECT v.version_id, v.model_id, r.model_family, r.task_class, r.provider, r.display_name,
       v.stage, v.status, v.regime_family, v.params_json, v.metrics_json, r.metadata_json
FROM dbo.model_versions v
JOIN dbo.model_registry r ON r.model_id = v.model_id
WHERE v.bot_profile = @bot_profile
  AND r.task_class = @task_class
  AND v.status = 'active'
  AND (v.regime_family IS NULL OR v.regime_family = 'any' OR v.regime_family = @regime_family)
ORDER BY v.activated_at DESC, v.created_at DESC
`);
    return (res.recordset || []).map((row) => ({
      versionId: row.version_id,
      modelId: row.model_id,
      family: row.model_family,
      taskClass: row.task_class,
      provider: row.provider,
      displayName: row.display_name,
      stage: row.stage,
      status: row.status,
      regimeFamily: row.regime_family || 'any',
      params: (() => {
        try { return JSON.parse(row.params_json || '{}'); } catch { return {}; }
      })(),
      metrics: (() => {
        try { return JSON.parse(row.metrics_json || '{}'); } catch { return {}; }
      })(),
      metadata: (() => {
        try { return JSON.parse(row.metadata_json || '{}'); } catch { return {}; }
      })(),
    }));
  }

  async recordFeatureSnapshot(snapshot = {}) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const req = pool.request();
    req.input('feature_id', sql.UniqueIdentifier, crypto.randomUUID());
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('ts', sql.DateTime2(3), new Date(snapshot.ts || Date.now()));
    req.input('chain_key', sql.NVarChar(30), snapshot.chainKey ? String(snapshot.chainKey).slice(0, 30) : null);
    req.input('symbol', sql.NVarChar(40), snapshot.symbol ? String(snapshot.symbol).slice(0, 40) : null);
    req.input('address', sql.NVarChar(120), snapshot.address ? String(snapshot.address).slice(0, 120) : null);
    req.input('strategy', sql.NVarChar(30), snapshot.strategy ? String(snapshot.strategy).slice(0, 30) : null);
    req.input('regime_label', sql.NVarChar(40), snapshot.regimeLabel ? String(snapshot.regimeLabel).slice(0, 40) : null);
    req.input('source', sql.NVarChar(40), snapshot.source ? String(snapshot.source).slice(0, 40) : 'feature_pipeline');
    req.input('features_json', sql.NVarChar(sql.MAX), safeJson(snapshot.features || snapshot));
    await req.query(`
INSERT INTO dbo.model_feature_store(feature_id, bot_profile, ts, chain_key, symbol, address, strategy, regime_label, source, features_json)
VALUES(@feature_id, @bot_profile, @ts, @chain_key, @symbol, @address, @strategy, @regime_label, @source, @features_json)
`);
    return true;
  }

  async recordSentimentSnapshot(snapshot = {}) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const req = pool.request();
    req.input('snapshot_id', sql.UniqueIdentifier, crypto.randomUUID());
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('ts', sql.DateTime2(3), new Date(snapshot.ts || Date.now()));
    req.input('chain_key', sql.NVarChar(30), snapshot.chainKey ? String(snapshot.chainKey).slice(0, 30) : null);
    req.input('symbol', sql.NVarChar(40), snapshot.symbol ? String(snapshot.symbol).slice(0, 40) : null);
    req.input('address', sql.NVarChar(120), snapshot.address ? String(snapshot.address).slice(0, 120) : null);
    req.input('aggregate_score', sql.Float, Number.isFinite(Number(snapshot.aggregateScore)) ? Number(snapshot.aggregateScore) : null);
    req.input('signal', sql.NVarChar(16), snapshot.signal ? String(snapshot.signal).slice(0, 16) : null);
    req.input('confidence', sql.Float, Number.isFinite(Number(snapshot.confidence)) ? Number(snapshot.confidence) : null);
    req.input('news_count', sql.Int, Number.isFinite(Number(snapshot.newsCount)) ? Number(snapshot.newsCount) : null);
    req.input('reddit_count', sql.Int, Number.isFinite(Number(snapshot.redditCount)) ? Number(snapshot.redditCount) : null);
    req.input('feature_json', sql.NVarChar(sql.MAX), safeJson(snapshot));
    await req.query(`
INSERT INTO dbo.sentiment_snapshots(snapshot_id, bot_profile, ts, chain_key, symbol, address, aggregate_score, signal, confidence, news_count, reddit_count, feature_json)
VALUES(@snapshot_id, @bot_profile, @ts, @chain_key, @symbol, @address, @aggregate_score, @signal, @confidence, @news_count, @reddit_count, @feature_json)
`);
    return true;
  }

  async recordPrediction(prediction = {}) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const req = pool.request();
    req.input('prediction_id', sql.UniqueIdentifier, crypto.randomUUID());
    req.input('version_id', sql.NVarChar(80), String(prediction.versionId || '').slice(0, 80));
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('ts', sql.DateTime2(3), new Date(prediction.ts || Date.now()));
    req.input('chain_key', sql.NVarChar(30), prediction.chainKey ? String(prediction.chainKey).slice(0, 30) : null);
    req.input('symbol', sql.NVarChar(40), prediction.symbol ? String(prediction.symbol).slice(0, 40) : null);
    req.input('address', sql.NVarChar(120), prediction.address ? String(prediction.address).slice(0, 120) : null);
    req.input('task_class', sql.NVarChar(40), prediction.taskClass ? String(prediction.taskClass).slice(0, 40) : null);
    req.input('signal', sql.NVarChar(16), prediction.signal ? String(prediction.signal).slice(0, 16) : null);
    req.input('confidence', sql.Float, Number.isFinite(Number(prediction.confidence)) ? Number(prediction.confidence) : null);
    req.input('score', sql.Float, Number.isFinite(Number(prediction.score)) ? Number(prediction.score) : null);
    req.input('explanation_json', sql.NVarChar(sql.MAX), safeJson(prediction.explanation || prediction));
    await req.query(`
INSERT INTO dbo.model_predictions(prediction_id, version_id, bot_profile, ts, chain_key, symbol, address, task_class, signal, confidence, score, explanation_json)
VALUES(@prediction_id, @version_id, @bot_profile, @ts, @chain_key, @symbol, @address, @task_class, @signal, @confidence, @score, @explanation_json)
`);
    return true;
  }

  async upsertRlPolicy(policy = {}) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const policyId = String(policy.policyId || stableId(policy.policyName || 'paper_rl_default', this.botProfile)).slice(0, 80);
    const req = pool.request();
    req.input('policy_id', sql.NVarChar(80), policyId);
    req.input('policy_name', sql.NVarChar(80), String(policy.policyName || 'paper_rl_default').slice(0, 80));
    req.input('bot_profile', sql.NVarChar(20), String(policy.botProfile || this.botProfile).slice(0, 20));
    req.input('stage', sql.NVarChar(30), String(policy.stage || 'paper_training').slice(0, 30));
    req.input('status', sql.NVarChar(30), String(policy.status || 'active').slice(0, 30));
    req.input('policy_json', sql.NVarChar(sql.MAX), safeJson(policy.policy || policy));
    req.input('metrics_json', sql.NVarChar(sql.MAX), safeJson(policy.metrics || {}));
    await req.query(`
MERGE dbo.rl_policy_registry AS t
USING (SELECT @policy_id AS policy_id) AS s
ON t.policy_id = s.policy_id
WHEN MATCHED THEN
  UPDATE SET policy_name=@policy_name, bot_profile=@bot_profile, stage=@stage, status=@status, updated_at=SYSUTCDATETIME(), policy_json=@policy_json, metrics_json=@metrics_json
WHEN NOT MATCHED THEN
  INSERT(policy_id, policy_name, bot_profile, stage, status, policy_json, metrics_json)
  VALUES(@policy_id, @policy_name, @bot_profile, @stage, @status, @policy_json, @metrics_json);
`);
    return policyId;
  }

  async getLatestRlPolicy(policyName = 'paper_rl_default', botProfile = this.botProfile) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const req = pool.request();
    req.input('policy_name', sql.NVarChar(80), String(policyName).slice(0, 80));
    req.input('bot_profile', sql.NVarChar(20), String(botProfile).slice(0, 20));
    const res = await req.query(`
SELECT TOP 1 policy_id, policy_name, bot_profile, stage, status, updated_at, policy_json, metrics_json
FROM dbo.rl_policy_registry
WHERE policy_name = @policy_name AND bot_profile = @bot_profile AND status = 'active'
ORDER BY updated_at DESC
`);
    const row = res.recordset?.[0];
    if (!row) return null;
    return {
      policyId: row.policy_id,
      policyName: row.policy_name,
      botProfile: row.bot_profile,
      stage: row.stage,
      status: row.status,
      updatedAt: row.updated_at,
      policy: (() => {
        try { return JSON.parse(row.policy_json || '{}'); } catch { return {}; }
      })(),
      metrics: (() => {
        try { return JSON.parse(row.metrics_json || '{}'); } catch { return {}; }
      })(),
    };
  }

  async getTrainingCandidates(limit = 500) {
    const pool = await this.ensureReady();
    if (!pool) return [];
    const req = pool.request();
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('limit', sql.Int, Math.max(50, Math.min(5000, Number(limit || 500))));
    const res = await req.query(`
SELECT TOP (@limit)
  fs.features_json,
  CASE WHEN outcome.pnl_usd > 0 THEN 1 ELSE 0 END AS label
FROM dbo.model_feature_store fs
CROSS APPLY (
  SELECT TOP 1 tl.pnl_usd
  FROM dbo.bot_trade_ledger tl
  WHERE tl.symbol = fs.symbol
    AND tl.chain_key = fs.chain_key
    AND UPPER(COALESCE(tl.trade_type, '')) = 'SELL'
    AND tl.pnl_usd IS NOT NULL
    AND tl.ts > fs.ts
    AND tl.ts <= DATEADD(minute, ${TRAINING_LABEL_WINDOW_MINUTES}, fs.ts)
  ORDER BY tl.ts ASC
) AS outcome
WHERE fs.bot_profile = @bot_profile
ORDER BY fs.ts DESC
`);
    return (res.recordset || []).map((row) => {
      let features = {};
      try { features = JSON.parse(row.features_json || '{}'); } catch { /* ignore */ }
      return { features, label: Number(row.label) === 1 };
    });
  }

  async trainAndRegisterModel({ framework, artifactPath, featureOrder, modelId, versionIdBase }) {
    const rows = await this.getTrainingCandidates(500);
    if (rows.length < MIN_TRAINING_ROWS) {
      this.logger.info?.(`[ModelRegistry] skipping training for ${modelId}: only ${rows.length}/${MIN_TRAINING_ROWS} labeled rows`);
      return { skipped: true, reason: 'insufficient_data', rowCount: rows.length };
    }

    const absArtifactPath = resolveArtifactPath(artifactPath);
    let result;
    try {
      result = await runPythonSidecar('train_model', {
        framework,
        artifactPath: absArtifactPath,
        featureOrder,
        rows,
      }, this.logger);
    } catch (err) {
      this.logger.warn?.(`[ModelRegistry] train_model failed for ${modelId}: ${err.message}`);
      return { skipped: false, error: err.message };
    }

    if (!result?.ok) {
      this.logger.warn?.(`[ModelRegistry] train_model returned not-ok for ${modelId}: ${result?.error}`);
      return { skipped: false, error: result?.error || 'unknown' };
    }

    const newVersionId = `${versionIdBase || modelId}-${Date.now()}`.slice(0, 80);
    const pool = await getPool(this.logger);
    if (pool) {
      const req = pool.request();
      req.input('version_id', sql.NVarChar(80), newVersionId);
      req.input('model_id', sql.NVarChar(80), String(modelId).slice(0, 80));
      req.input('bot_profile', sql.NVarChar(20), this.botProfile);
      req.input('params_json', sql.NVarChar(sql.MAX), safeJson({ artifactPath: absArtifactPath, framework, featureOrder }));
      req.input('metrics_json', sql.NVarChar(sql.MAX), safeJson({ trainedRows: rows.length, trainedAt: new Date().toISOString() }));
      await req.query(`
MERGE dbo.model_versions AS t
USING (SELECT @version_id AS version_id) AS s
ON t.version_id = s.version_id
WHEN NOT MATCHED THEN
  INSERT(version_id, model_id, bot_profile, stage, status, regime_family, activated_at, feature_schema_json, params_json, metrics_json)
  VALUES(@version_id, @model_id, @bot_profile, 'production', 'active', 'any', SYSUTCDATETIME(), '{"version":2}', @params_json, @metrics_json);
`);
    }

    this.logger.info?.(`[ModelRegistry] trained ${modelId} (${framework}) on ${rows.length} rows → ${newVersionId}`);
    return { versionId: newVersionId, trainedRows: rows.length, artifactPath: absArtifactPath };
  }

  async runAutoTraining() {
    const pool = await this.ensureReady();
    if (!pool) return;

    for (const def of DEFAULT_EXTERNAL_MODELS) {
      if (!TRAINABLE_EXTERNAL_MODELS.includes(def.model_id)) continue;
      const artifactPath = resolveArtifactPath(def.metadata?.artifactPath || '');
      await this.trainAndRegisterModel({
        framework: def.metadata?.framework,
        artifactPath: def.metadata?.artifactPath,
        featureOrder: def.metadata?.featureOrder || [],
        modelId: def.model_id,
        versionIdBase: def.version_id,
      });
      if (artifactPath && fs.existsSync(artifactPath)) {
        await this.ensureExternalModelRegistryEntries();
      }
    }
  }

  async recordMultiAgentDecision(decision = {}) {
    const pool = await this.ensureReady();
    if (!pool) return null;
    const req = pool.request();
    req.input('decision_id', sql.UniqueIdentifier, crypto.randomUUID());
    req.input('bot_profile', sql.NVarChar(20), this.botProfile);
    req.input('ts', sql.DateTime2(3), new Date(decision.ts || Date.now()));
    req.input('chain_key', sql.NVarChar(30), decision.chainKey ? String(decision.chainKey).slice(0, 30) : null);
    req.input('symbol', sql.NVarChar(40), decision.symbol ? String(decision.symbol).slice(0, 40) : null);
    req.input('address', sql.NVarChar(120), decision.address ? String(decision.address).slice(0, 120) : null);
    req.input('task_class', sql.NVarChar(40), decision.taskClass ? String(decision.taskClass).slice(0, 40) : null);
    req.input('regime_family', sql.NVarChar(40), decision.regimeFamily ? String(decision.regimeFamily).slice(0, 40) : null);
    req.input('final_signal', sql.NVarChar(16), decision.finalSignal ? String(decision.finalSignal).slice(0, 16) : null);
    req.input('confidence', sql.Float, Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : null);
    req.input('route_json', sql.NVarChar(sql.MAX), safeJson(decision.route));
    req.input('context_json', sql.NVarChar(sql.MAX), safeJson(decision.context));
    await req.query(`
INSERT INTO dbo.multi_agent_decisions(decision_id, bot_profile, ts, chain_key, symbol, address, task_class, regime_family, final_signal, confidence, route_json, context_json)
VALUES(@decision_id, @bot_profile, @ts, @chain_key, @symbol, @address, @task_class, @regime_family, @final_signal, @confidence, @route_json, @context_json)
`);
    return true;
  }
}

// Week 11.8b — persist ML model version to dbo.ml_model_versions table.
// Mirrors scripts/backfill-model-versions.js INSERT shape so backfill + runtime
// writes share storage. Idempotent on (name, scope, sha256).
async function persistModelVersion({
  name, scope, framework, artifactPath, sha256, metrics, configSnapshot,
  featureColumns, active = false, activateExclusive = true, logger,
} = {}) {
  const log = logger || console;
  if (!name || !artifactPath) {
    log.warn?.('[ml_model_versions] persistModelVersion: name + artifactPath required');
    return null;
  }
  try {
    const { getPool, isSqlEnabled } = require('./sqlServer');
    if (!isSqlEnabled || !isSqlEnabled()) return null;
    const pool = await getPool().catch(() => null);
    if (!pool) return null;
    const sql = require('mssql');

    // Optionally deactivate prior active row for same (name, scope) before inserting fresh active row
    if (active && activateExclusive) {
      const reqDeact = pool.request();
      reqDeact.input('name', sql.NVarChar(120), name);
      reqDeact.input('scope', sql.NVarChar(20), scope || 'global');
      await reqDeact.query(`
        UPDATE dbo.ml_model_versions
           SET active = 0, retired_at = SYSUTCDATETIME()
         WHERE name = @name AND scope = @scope AND active = 1
      `);
    }

    const req = pool.request();
    req.input('name', sql.NVarChar(120), name);
    req.input('scope', sql.NVarChar(20), scope || 'global');
    req.input('framework', sql.NVarChar(40), framework || null);
    req.input('artifact_path', sql.NVarChar(500), artifactPath);
    req.input('sha256', sql.NVarChar(64), sha256 || null);
    req.input('metrics_json', sql.NVarChar(sql.MAX), metrics ? safeJson(metrics, 10000) : null);
    req.input('config_json', sql.NVarChar(sql.MAX), configSnapshot ? safeJson(configSnapshot, 10000) : null);
    req.input('feature_columns_json', sql.NVarChar(sql.MAX), featureColumns ? safeJson(featureColumns, 10000) : null);
    req.input('active', sql.Bit, Boolean(active));
    await req.query(`
      INSERT INTO dbo.ml_model_versions
        (name, scope, framework, artifact_path, sha256, metrics_json, config_json, feature_columns_json, active, created_at)
      VALUES
        (@name, @scope, @framework, @artifact_path, @sha256, @metrics_json, @config_json, @feature_columns_json, @active, SYSUTCDATETIME());
    `);
    return { ok: true };
  } catch (e) {
    log.warn?.(`[ml_model_versions] persist failed: ${e?.message || e}`);
    return null;
  }
}

module.exports = {
  ModelRegistry,
  DEFAULT_MODELS,
  DEFAULT_EXTERNAL_MODELS,
  stableId,
  resolveArtifactPath,
  persistModelVersion,
};
