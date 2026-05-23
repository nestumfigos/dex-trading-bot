'use strict';

/**
 * Memory — trade lessons (pure functions on the data shape).
 *
 * Extracts recordLesson + checkLessons from AgentMemory. Operates on the
 * `tradeLessons` array within the data shape. Pure: caller passes `data` +
 * options, functions mutate `data.tradeLessons` directly. The agentMemory.js
 * methods become thin wrappers that also set `_dirty = true` and call into
 * stats module for counter updates.
 *
 * Week 16.2 extraction (2026-05-23). Behavior identical to prior inline impl.
 */

const DEFAULT_MAX_LESSONS = 300;

function recordLessonInto(data, fields, { maxLessons = DEFAULT_MAX_LESSONS } = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    botProfile: process.env.BOT_PROFILE || 'unknown',
    symbol: String(fields.symbol || '').toUpperCase(),
    chain: String(fields.chain || 'unknown'),
    strategy: String(fields.strategy || 'momentum'),
    entryConditions: fields.entryConditions || {},
    outcome: fields.outcome === 'win' ? 'win' : 'loss',
    pnlUsd: Number(fields.pnlUsd || 0),
    pnlPct: Number(fields.pnlPct || 0),
    reason: String(fields.reason || ''),
    lesson: String(fields.lesson || ''),
    hitCount: 0,
    entryRegime: String(fields.entryRegime || 'unknown'),
    holdMinutes: Number(fields.holdMinutes || 0),
  };

  data.tradeLessons = Array.isArray(data.tradeLessons) ? data.tradeLessons : [];
  data.tradeLessons.unshift(entry);
  if (data.tradeLessons.length > maxLessons) {
    data.tradeLessons = data.tradeLessons.slice(0, maxLessons);
  }
  return entry;
}

/**
 * Score current conditions against past loss lessons. Returns
 *   { blocked, warned?, reason, matchedLessons }
 * Mutates `lesson.hitCount` on matched lessons (intentional — caller
 * marks the data dirty if blockScore >= warnThreshold).
 */
function checkLessonsFor(data, symbol, conditions = {}, { blockThreshold = 60, warnThreshold = 35 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const lessons = Array.isArray(data.tradeLessons) ? data.tradeLessons : [];
  const matched = [];
  let blockScore = 0;

  for (const lesson of lessons) {
    if (lesson.outcome !== 'loss') continue;

    let score = 0;
    if (lesson.symbol === sym) score += 40;

    const ec = lesson.entryConditions || {};
    if (conditions.rsi && ec.rsi && Math.abs(Number(conditions.rsi) - Number(ec.rsi)) < 10) score += 15;
    if (conditions.strategy && lesson.strategy === conditions.strategy) score += 10;
    if (conditions.chain && lesson.chain === conditions.chain) score += 5;

    if (conditions.volumeSpike && ec.volumeSpike) {
      const diff = Math.abs(Number(conditions.volumeSpike) - Number(ec.volumeSpike));
      if (diff < 1.0) score += 10;
    }

    const ageHours = (Date.now() - lesson.ts) / 3_600_000;
    const decayFactor = Math.max(0.2, 1 - (ageHours / (7 * 24)));
    score = Math.round(score * decayFactor);

    const currentRegime = conditions.regime || 'unknown';
    if (currentRegime !== 'unknown' && lesson.entryRegime && lesson.entryRegime !== 'unknown') {
      if (lesson.entryRegime === currentRegime) score += 20;
      else score = Math.round(score * 0.4);
    }

    if (score >= 30) {
      lesson.hitCount = (lesson.hitCount || 0) + 1;
      matched.push({ lesson, score });
      blockScore = Math.max(blockScore, score);
    }
  }

  matched.sort((a, b) => b.score - a.score);

  if (blockScore >= blockThreshold) {
    const top = matched[0].lesson;
    return {
      blocked: true,
      reason: `Memory block: similar setup lost $${Math.abs(top.pnlUsd).toFixed(2)} — ${top.lesson.slice(0, 120)}`,
      matchedLessons: matched.slice(0, 3),
    };
  }

  if (blockScore >= warnThreshold) {
    return {
      blocked: false,
      warned: true,
      reason: `Memory warning: similar conditions led to loss — ${matched[0]?.lesson?.lesson?.slice(0, 80) || ''}`,
      matchedLessons: matched.slice(0, 3),
    };
  }

  return { blocked: false, warned: false, matchedLessons: [] };
}

module.exports = {
  recordLessonInto,
  checkLessonsFor,
  DEFAULT_MAX_LESSONS,
};
