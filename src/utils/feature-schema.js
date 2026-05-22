'use strict';

const crypto = require('crypto');

const FEATURE_SCHEMA_VERSION = 3;

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
  'garchVolatilityPct',
  'rsi',
  'liquidityUsd',
  'onchainMacroScore',
  'activeAddresses',
  'exchangeFlowScore',
  'whaleAccumulationScore',
  'stablecoinSupplyUsd',
  'mvrvRiskScore',
  'binanceMomentumConfirm',
  'coinMarketCapMomentumConfirm',
  'coinPaprikaMomentumConfirm',
  'hrpTargetWeight',
  'atrProxyPct',
];

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFeatureSchemaHash(featureOrder = FEATURE_ORDER, version = FEATURE_SCHEMA_VERSION) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ version, featureOrder }))
    .digest('hex');
}

function buildFeatureVector(features = {}, featureOrder = FEATURE_ORDER) {
  return featureOrder.map((key) => toFiniteNumber(features?.[key], 0));
}

function summarizeFeatureParity(features = {}, featureOrder = FEATURE_ORDER) {
  const keysPresent = Object.keys(features || {});
  const required = [...featureOrder];
  const missing = required.filter((key) => !Number.isFinite(Number(features?.[key])));
  const extras = keysPresent.filter((key) => !required.includes(key));
  const present = required.length - missing.length;
  const coverage = required.length > 0 ? present / required.length : 1;
  return {
    version: FEATURE_SCHEMA_VERSION,
    featureCount: required.length,
    featureOrder: required,
    schemaHash: getFeatureSchemaHash(required, FEATURE_SCHEMA_VERSION),
    presentCount: present,
    missingCount: missing.length,
    coverage,
    missing,
    extras,
  };
}

module.exports = {
  FEATURE_SCHEMA_VERSION,
  FEATURE_ORDER,
  getFeatureSchemaHash,
  buildFeatureVector,
  summarizeFeatureParity,
};
