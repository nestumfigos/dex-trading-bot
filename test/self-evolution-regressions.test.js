'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SelfEvolutionEngine = require('../src/self-evolution');

function makeEngine(portfolio = null) {
  const logs = { warnings: [], errors: [] };
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-evolution-'));
  const engine = new SelfEvolutionEngine({
    config: { paperTrading: true, selfEvolution: {} },
    logger: {
      info() {},
      warn(message) { logs.warnings.push(message); },
      error(message) { logs.errors.push(message); },
      debug() {},
    },
    projectRoot,
    portfolio,
  });
  return { engine, logs, projectRoot };
}

test('performance snapshot carries realized PnL into promotion validation deltas', () => {
  const { engine } = makeEngine({
    stats: { wins: 3, losses: 2, profitFactor: 1.4, totalPnl: 27.5 },
  });
  const snapshot = engine.capturePerformanceSnapshot();
  assert.equal(snapshot.profitFactor, 1.4);
  assert.equal(snapshot.winRate, 60);
  assert.equal(snapshot.pnlUsd, 27.5);
  assert.equal(snapshot.sampleSize, 5);
});

test('unreadable or corrupt pending validation state fails closed through configured logger', async () => {
  const { engine, logs, projectRoot } = makeEngine();
  engine.pendingValidationsPath = projectRoot;
  assert.deepEqual(await engine.loadPendingValidations(), []);
  assert.equal(logs.warnings.length, 1);

  engine.pendingValidationsPath = path.join(projectRoot, 'pending.json');
  fs.writeFileSync(engine.pendingValidationsPath, '{bad json', 'utf8');
  assert.deepEqual(await engine.loadPendingValidations(), []);
  assert.equal(logs.errors.length, 1);
});

test('a denied later mutation rolls back earlier approved-plan file writes', async () => {
  const { engine, projectRoot } = makeEngine();
  const configDir = path.join(projectRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const target = path.join(configDir, 'index.js');
  fs.writeFileSync(target, "module.exports = { risk: 'old' };\n", 'utf8');
  const result = await engine.applyPlan({
    validation: { preApplyPassed: true },
    approval: { approved: true },
    changes: [
      { type: 'regex_replace_once', file: 'config/index.js', pattern: "module\\.exports = \\{ risk: 'old' \\};", replacement: "module.exports = { risk: 'new' };" },
      { type: 'regex_replace_once', file: '../outside.js', pattern: 'a', replacement: 'b' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Blocked unsafe target/);
  assert.equal(fs.readFileSync(target, 'utf8'), "module.exports = { risk: 'old' };\n");
});

test('daily loss blocks never create a proposal to widen loss limits', async () => {
  const { engine } = makeEngine();
  const plan = await engine.buildRuleBasedPlan({
    operationalDiagnostics: {
      dailyLossBlockCount: 8,
      maxDailyLossPctByChain: { bsc: 10 },
    },
  });
  assert.equal(plan.changes.length, 0);
  assert.match(plan.summary, /preserve the protective halt/);
});

test('exposure and stale-price blocks never loosen their protections', async () => {
  const { engine } = makeEngine();
  const capacityPlan = await engine.buildRuleBasedPlan({ operationalDiagnostics: { slotBlockedCount: 10 } });
  assert.equal(capacityPlan.changes.length, 0);
  assert.match(capacityPlan.summary, /preserve exposure protection/);

  const freshnessPlan = await engine.buildRuleBasedPlan({ operationalDiagnostics: { nativePriceAbortCount: 5 } });
  assert.equal(freshnessPlan.changes.length, 0);
  assert.match(freshnessPlan.summary, /preserve quote-age protection/);
});

test('paper-live comparison reads normalized V2 profile names', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'self-evolution-orchestration.js'), 'utf8');
  assert.match(source, /paper_spot/);
  assert.match(source, /live_spot/);
  assert.doesNotMatch(source, /IN \('paper','live'\)/);
});
