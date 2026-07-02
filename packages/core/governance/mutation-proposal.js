'use strict';

const { createHash, randomUUID } = require('crypto');

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashPayload(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeMutationProposal({
  proposalId = randomUUID(),
  botProfile,
  targetProfile = null,
  strategy,
  strategyVersion = null,
  proposalType = 'config_patch',
  proposer = 'system',
  patch,
  rationale = {},
  expectedImpact = {},
  riskNotes = {},
  evidenceRefs = [],
  createdAt = new Date().toISOString(),
  status = 'proposed',
  stage = 'proposal',
} = {}) {
  if (!botProfile) throw new Error('botProfile is required');
  if (!strategy) throw new Error('strategy is required');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new Error('non-empty patch object is required');
  }
  return {
    proposalId: String(proposalId),
    botProfile: String(botProfile),
    targetProfile: targetProfile == null ? null : String(targetProfile),
    strategy: String(strategy),
    strategyVersion: strategyVersion == null ? null : String(strategyVersion),
    proposalType: String(proposalType || 'config_patch'),
    proposer: String(proposer || 'system'),
    status: String(status || 'proposed'),
    stage: String(stage || 'proposal'),
    createdAt: new Date(createdAt).toISOString(),
    patch: { ...patch },
    patchHash: hashPayload(patch),
    rationale: rationale && typeof rationale === 'object' ? { ...rationale } : {},
    expectedImpact: expectedImpact && typeof expectedImpact === 'object' ? { ...expectedImpact } : {},
    riskNotes: riskNotes && typeof riskNotes === 'object' ? { ...riskNotes } : {},
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.slice() : [],
  };
}

module.exports = {
  stableStringify,
  hashPayload,
  normalizeMutationProposal,
};
