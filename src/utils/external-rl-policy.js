'use strict';

const { runPythonSidecar } = require('./python-sidecar');

async function inferExternalRlAction(policyRecord, featureSnapshot = {}) {
  const framework = String(
    policyRecord?.metrics?.framework
    || policyRecord?.policy?.framework
    || policyRecord?.policy?.engine
    || ''
  ).toLowerCase();

  const response = await runPythonSidecar('infer_rl', {
    framework,
    metadata: {
      framework,
      artifactPath: policyRecord?.policy?.artifactPath || policyRecord?.metrics?.artifactPath || '',
      featureOrder: policyRecord?.policy?.featureOrder || policyRecord?.metrics?.featureOrder || [],
    },
    features: featureSnapshot?.features || featureSnapshot || {},
  });

  return {
    signal: String(response.signal || 'HOLD').toUpperCase(),
    confidence: Number(response.confidence || 0),
    score: Number(response.score || 0.5),
    provider: response.provider || framework || 'python_sidecar',
  };
}

module.exports = {
  inferExternalRlAction,
};
