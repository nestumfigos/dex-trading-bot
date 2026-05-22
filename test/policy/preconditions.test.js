'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canPromoteEvolutionPatch,
  canEnableLiveTrading,
  canIncreasePositionSize,
  canRotatePosition,
  canAcceptAiOverride,
  loadThresholds,
  RULES_CATALOG,
  DEFAULTS,
} = require('../../src/policy/preconditions');

// ─── catalog sanity ────────────────────────────────────────────────────────

test('RULES_CATALOG lists 5 rules', () => {
  assert.equal(RULES_CATALOG.length, 5);
  assert.deepEqual(
    RULES_CATALOG.map((r) => r.name),
    ['evo_promote', 'live_enable', 'size_increase', 'rotate_position', 'ai_override_accept'],
  );
});

// ─── canPromoteEvolutionPatch — regression for 2026-05-16 auto-promote-on-loss bug

test('evo_promote: WR>40, PnL>0, samples>20 → ALLOW', () => {
  const r = canPromoteEvolutionPatch({ winRate: 55, pnlUsd: 10, samples: 30, causalDeltaWinRate: 3 });
  assert.equal(r.allow, true);
});

test('evo_promote: losing PnL → DENY (regression for 2026-05-16)', () => {
  const r = canPromoteEvolutionPatch({ winRate: 60, pnlUsd: -5, samples: 30 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /pnlUsd/);
});

test('evo_promote: low samples → DENY', () => {
  const r = canPromoteEvolutionPatch({ winRate: 80, pnlUsd: 100, samples: 5 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /samples/);
});

test('evo_promote: low win rate → DENY', () => {
  const r = canPromoteEvolutionPatch({ winRate: 30, pnlUsd: 10, samples: 30 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /winRate/);
});

test('evo_promote: causal delta negative → DENY (regression in WR)', () => {
  const r = canPromoteEvolutionPatch({ winRate: 55, pnlUsd: 10, samples: 30, causalDeltaWinRate: -5 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /causal delta/);
});

test('evo_promote: thresholds map override (DB knob)', () => {
  const thresholds = new Map([['EVO_MIN_WIN_RATE', 70]]);  // stricter
  const r = canPromoteEvolutionPatch({ winRate: 60, pnlUsd: 10, samples: 30 }, thresholds);
  assert.equal(r.allow, false);
  assert.match(r.reason, /winRate 60% < 70%/);
});

// ─── canEnableLiveTrading ──────────────────────────────────────────────────

test('live_enable: clean 24h paper → ALLOW', () => {
  const r = canEnableLiveTrading({ paperValidationHours: 25, crashesLastHour: 0, paperTradesCount: 20 });
  assert.equal(r.allow, true);
});

test('live_enable: < 24h paper → DENY', () => {
  const r = canEnableLiveTrading({ paperValidationHours: 12, crashesLastHour: 0, paperTradesCount: 20 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /paper validated/);
});

test('live_enable: crash loop → DENY', () => {
  const r = canEnableLiveTrading({ paperValidationHours: 25, crashesLastHour: 5, paperTradesCount: 20 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /crashes/);
});

test('live_enable: too few paper trades → DENY (insufficient sample)', () => {
  const r = canEnableLiveTrading({ paperValidationHours: 25, crashesLastHour: 0, paperTradesCount: 3 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /paper trades/);
});

// ─── canIncreasePositionSize ───────────────────────────────────────────────

test('size_increase: no loss streak + WR≥30 → ALLOW', () => {
  const r = canIncreasePositionSize({ consecutiveLosses: 1, winRate: 45 });
  assert.equal(r.allow, true);
});

test('size_increase: loss streak hit cap → DENY', () => {
  const r = canIncreasePositionSize({ consecutiveLosses: 3, winRate: 45 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /losses/);
});

test('size_increase: WR below floor → DENY', () => {
  const r = canIncreasePositionSize({ consecutiveLosses: 0, winRate: 20 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /winRate/);
});

// ─── canRotatePosition ─────────────────────────────────────────────────────

test('rotate_position: edge>threshold + persistence met → ALLOW', () => {
  const r = canRotatePosition({ edgePct: 8, persistenceMinutes: 15 });
  assert.equal(r.allow, true);
});

test('rotate_position: edge below threshold → DENY', () => {
  const r = canRotatePosition({ edgePct: 2, persistenceMinutes: 15 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /edge/);
});

test('rotate_position: persistence not met → DENY', () => {
  const r = canRotatePosition({ edgePct: 10, persistenceMinutes: 5 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /persistence/);
});

// ─── canAcceptAiOverride ───────────────────────────────────────────────────

test('ai_override: circuit closed + samples sufficient → ALLOW', () => {
  const r = canAcceptAiOverride({ aiCircuitOpen: false, aiSamples: 60 });
  assert.equal(r.allow, true);
});

test('ai_override: circuit open → DENY', () => {
  const r = canAcceptAiOverride({ aiCircuitOpen: true, aiSamples: 60 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /circuit/);
});

test('ai_override: insufficient samples → DENY', () => {
  const r = canAcceptAiOverride({ aiCircuitOpen: false, aiSamples: 10 });
  assert.equal(r.allow, false);
  assert.match(r.reason, /ai samples/);
});

// ─── loadThresholds ────────────────────────────────────────────────────────

test('loadThresholds: SQL down → only defaults', async () => {
  const map = await loadThresholds({ sql: null });
  assert.equal(map.get('EVO_MIN_WIN_RATE'), DEFAULTS.EVO_MIN_WIN_RATE);
});

test('loadThresholds: env override beats defaults but not DB', async () => {
  process.env.EVO_MIN_WIN_RATE = '60';
  const map = await loadThresholds({ sql: null });
  assert.equal(map.get('EVO_MIN_WIN_RATE'), 60);
  delete process.env.EVO_MIN_WIN_RATE;
});

test('loadThresholds: DB rows override env + defaults', async () => {
  const sql = {
    request() {
      return {
        input() { return this; },
        async query() {
          return { recordset: [{ knob: 'EVO_MIN_WIN_RATE', value: '75' }, { knob: 'SIZE_MIN_WIN_RATE', value: '40' }] };
        },
      };
    },
  };
  process.env.EVO_MIN_WIN_RATE = '50';
  const map = await loadThresholds({ sql, scope: 'live' });
  assert.equal(map.get('EVO_MIN_WIN_RATE'), 75, 'DB beats env');
  assert.equal(map.get('SIZE_MIN_WIN_RATE'), 40, 'DB beats default');
  assert.equal(map.get('LIVE_REQUIRED_PAPER_HOURS'), DEFAULTS.LIVE_REQUIRED_PAPER_HOURS, 'default preserved for unset knobs');
  delete process.env.EVO_MIN_WIN_RATE;
});

test('loadThresholds: SQL throws → graceful degrade to env + defaults', async () => {
  const sql = { request() { return { input() { return this; }, async query() { throw new Error('boom'); } }; } };
  const map = await loadThresholds({ sql });
  assert.equal(map.get('EVO_MIN_WIN_RATE'), DEFAULTS.EVO_MIN_WIN_RATE);
});
