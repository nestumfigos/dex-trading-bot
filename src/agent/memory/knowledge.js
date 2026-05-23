'use strict';

/**
 * Memory — knowledge base + evolution outcomes (pure functions).
 *
 * Extracts addKnowledge / getKnowledge / recordEvolutionOutcome /
 * getEvolutionSummary / shouldPauseEvolution from AgentMemory. All ops
 * mutate `data` directly; class wrappers set `_dirty = true`.
 *
 * Week 16.2 extraction (2026-05-23). Behavior identical to prior inline impl.
 */

const DEFAULT_MAX_KNOWLEDGE = 200;
const DEFAULT_MAX_EVOLUTION_LOG = 50;

function addKnowledgeInto(data, fields, { maxKnowledge = DEFAULT_MAX_KNOWLEDGE, stableKnowledgeId } = {}) {
  const insight = String(fields.insight || '').slice(0, 400);
  const category = String(fields.category || 'general');
  const source = String(fields.source || '');
  data.knowledgeBase = Array.isArray(data.knowledgeBase) ? data.knowledgeBase : [];

  const isDuplicate = data.knowledgeBase.some(
    (k) => k.insight === insight && (Date.now() - k.ts) < 12 * 3_600_000,
  );
  if (isDuplicate) return null;

  const entry = {
    id: typeof stableKnowledgeId === 'function'
      ? stableKnowledgeId({ category, insight, source })
      : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    category,
    insight,
    source,
    confidence: Math.min(100, Math.max(0, Number(fields.confidence || 50))),
  };
  data.knowledgeBase.unshift(entry);
  if (data.knowledgeBase.length > maxKnowledge) {
    data.knowledgeBase = data.knowledgeBase.slice(0, maxKnowledge);
  }
  return entry;
}

function getKnowledgeFrom(data, { category = null, limit = 10 } = {}) {
  const all = Array.isArray(data.knowledgeBase) ? data.knowledgeBase : [];
  const items = category ? all.filter((k) => k.category === category) : all;
  return items.slice(0, limit);
}

function recordEvolutionOutcomeInto(data, fields, { maxLog = DEFAULT_MAX_EVOLUTION_LOG } = {}) {
  const pfBefore = Number(fields.pfBefore || 0);
  const pfAfter = Number(fields.pfAfter || 0);
  const wrBefore = Number(fields.wrBefore || 0);
  const wrAfter = Number(fields.wrAfter || 0);
  const pfDelta = pfAfter - pfBefore;
  const wrDelta = wrAfter - wrBefore;

  const minSampleForCausal = 10;
  const postSample = Number(fields.sampleSizeAfter || 0);
  let causalConfidence = 0;
  if (postSample >= minSampleForCausal) {
    causalConfidence = Math.min(1, (postSample - minSampleForCausal) / 30 + 0.4);
  } else if (postSample >= 5) {
    causalConfidence = 0.25;
  }

  let derivedVerdict = String(fields.verdict || 'unknown');
  if (causalConfidence < 0.3) {
    derivedVerdict = 'inconclusive';
  } else if (pfDelta >= 0.05 && wrDelta >= 2) {
    derivedVerdict = 'improved';
  } else if (pfDelta <= -0.05 || wrDelta <= -3) {
    derivedVerdict = 'regressed';
  } else if (Math.abs(pfDelta) < 0.05 && Math.abs(wrDelta) < 2) {
    derivedVerdict = 'neutral';
  }

  const entry = {
    ts: Date.now(),
    patchId: String(fields.patchId || ''),
    patchType: String(fields.patchType || ''),
    paramsChanged: fields.paramsChanged || null,
    patchSummary: String(fields.patchSummary || '').slice(0, 200),
    pfBefore,
    pfAfter,
    pfDelta,
    wrBefore,
    wrAfter,
    wrDelta,
    sampleSizeBefore: Number(fields.sampleSizeBefore || 0),
    sampleSizeAfter: postSample,
    holdoutWindowHours: Number(fields.holdoutWindowHours || 0),
    regimeFamily: String(fields.regimeFamily || 'unknown'),
    causalConfidence: Number(causalConfidence.toFixed(2)),
    callerVerdict: String(fields.verdict || 'unknown'),
    verdict: derivedVerdict,
  };
  data.evolutionOutcomes = Array.isArray(data.evolutionOutcomes) ? data.evolutionOutcomes : [];
  data.evolutionOutcomes.unshift(entry);
  if (data.evolutionOutcomes.length > maxLog) {
    data.evolutionOutcomes = data.evolutionOutcomes.slice(0, maxLog);
  }
  return entry;
}

function getEvolutionSummary(data) {
  const recent = (Array.isArray(data.evolutionOutcomes) ? data.evolutionOutcomes : []).slice(0, 10);
  const improved = recent.filter((r) => r.verdict === 'improved').length;
  const regressed = recent.filter((r) => r.verdict === 'regressed').length;
  const inconclusive = recent.filter((r) => r.verdict === 'inconclusive').length;
  const neutral = recent.filter((r) => r.verdict === 'neutral').length;
  const avgCausalConfidence = recent.length > 0
    ? recent.reduce((sum, r) => sum + Number(r.causalConfidence || 0), 0) / recent.length
    : 0;
  return {
    total: recent.length,
    improved,
    regressed,
    inconclusive,
    neutral,
    avgCausalConfidence: Number(avgCausalConfidence.toFixed(2)),
  };
}

function shouldPauseEvolution(data) {
  const recent = (Array.isArray(data.evolutionOutcomes) ? data.evolutionOutcomes : []).slice(0, 8);
  if (recent.length < 4) return { paused: false, reason: 'insufficient_history' };
  const regressed = recent.filter((r) => r.verdict === 'regressed').length;
  const inconclusive = recent.filter((r) => r.verdict === 'inconclusive').length;
  const avgCausal = recent.reduce((s, r) => s + Number(r.causalConfidence || 0), 0) / recent.length;
  if (regressed >= 3) return { paused: true, reason: `${regressed} of last ${recent.length} patches regressed` };
  if (avgCausal < 0.3 && inconclusive >= 4) return { paused: true, reason: `${inconclusive} inconclusive (samples too small)` };
  return { paused: false, reason: 'ok' };
}

module.exports = {
  addKnowledgeInto,
  getKnowledgeFrom,
  recordEvolutionOutcomeInto,
  getEvolutionSummary,
  shouldPauseEvolution,
  DEFAULT_MAX_KNOWLEDGE,
  DEFAULT_MAX_EVOLUTION_LOG,
};
