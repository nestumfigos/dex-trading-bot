const test = require('node:test');
const assert = require('node:assert/strict');

const { SqlTelemetry, safeJson, parseSqlJson } = require('../src/utils/sqlTelemetry');

test('SQL snapshot JSON is never stored as invalid truncated JSON', () => {
  assert.throws(
    () => safeJson({ payload: 'x'.repeat(100) }, 50, { strict: true }),
    /exceeds SQL limit/
  );

  const nonStrict = safeJson({ payload: 'x'.repeat(100) }, 50);
  const parsed = JSON.parse(nonStrict);
  assert.equal(parsed._truncated, true);
  assert.equal(parseSqlJson(nonStrict, 'state_json', { warn() {} }).ok, false);
});

test('SQL telemetry flush requeues an unwritten batch after write failure', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'live' });
  telemetry.isEnabled = () => true;
  telemetry.maxBatch = 3;
  telemetry.enqueue('order', { order_id: '1' });
  telemetry.enqueue('fill', { order_id: '1' });
  telemetry.enqueue('ops', { name: 'after_failure' });

  let writes = 0;
  telemetry._writeOne = async () => {
    writes += 1;
    if (writes === 2) throw new Error('simulated sql failure');
  };

  await telemetry.flushWithPool({});

  assert.equal(writes, 2);
  assert.equal(telemetry._queue.length, 3);
  assert.deepEqual(telemetry._queue.map((item) => item.kind), ['order', 'fill', 'ops']);
});

test('trade ledger telemetry writes first-class setup_type', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'trade_ledger',
    payload: {
      type: 'BUY',
      symbol: 'FLAG',
      chainKey: 'kucoin',
      strategy: 'spot_day_bull_flag',
      setupType: 'spot_day_bull_flag',
      valueUsd: 12.34,
    },
  });

  assert.equal(inputs.setup_type, 'spot_day_bull_flag');
  assert.match(queryText, /setup_type/);
  assert.match(queryText, /@setup_type/);
});

test('trading event telemetry writes normalized V2 event rows', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'trading_event',
    payload: {
      eventName: 'risk.approved',
      botProfile: 'paper_spot',
      strategy: 'spot_day_bull_flag',
      symbol: 'flagusdt',
      severity: 'info',
      occurredAt: '2026-06-06T12:00:00.000Z',
      correlationId: 'intent-1',
      payload: { side: 'BUY', sizeUsd: 10 },
    },
  });

  assert.equal(inputs.event_name, 'risk.approved');
  assert.equal(inputs.bot_profile, 'paper_spot');
  assert.equal(inputs.strategy, 'spot_day_bull_flag');
  assert.equal(inputs.symbol, 'flagusdt');
  assert.equal(inputs.correlation_id, 'intent-1');
  assert.match(inputs.payload_json, /"sizeUsd":10/);
  assert.match(queryText, /dbo\.trading_events/);
});

test('portfolio exposure telemetry writes V2 risk snapshot rows', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'portfolio_exposure_snapshot',
    payload: {
      botProfile: 'paper',
      timestamp: '2026-06-06T12:30:00.000Z',
      marketType: 'spot',
      symbol: 'ABC',
      strategy: 'spot_day_bull_flag',
      exposureUsd: 120,
      notionalUsd: 100,
      riskUsd: 10,
      correlationBucket: 'kucoin',
      details: { reason: 'scan_spot_day_bull_flag' },
    },
  });

  assert.equal(inputs.bot_profile, 'paper_spot');
  assert.equal(inputs.market_type, 'spot');
  assert.equal(inputs.symbol, 'ABC');
  assert.equal(inputs.strategy, 'spot_day_bull_flag');
  assert.equal(inputs.exposure_usd, 120);
  assert.equal(inputs.notional_usd, 100);
  assert.equal(inputs.risk_usd, 10);
  assert.equal(inputs.correlation_bucket, 'kucoin');
  assert.match(inputs.details_json, /scan_spot_day_bull_flag/);
  assert.match(queryText, /dbo\.portfolio_exposure_snapshots/);
});

test('correlation telemetry writes V2 correlation snapshot rows', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'correlation_snapshot',
    payload: {
      botProfile: 'paper',
      timestamp: '2026-06-06T12:31:00.000Z',
      assetA: 'AAA',
      assetB: 'BBB',
      correlation: 0.82,
      source: 'strategy.priceHistory',
      details: { samples: 30 },
    },
  });

  assert.equal(inputs.bot_profile, 'paper_spot');
  assert.equal(inputs.asset_a, 'AAA');
  assert.equal(inputs.asset_b, 'BBB');
  assert.equal(inputs.correlation, 0.82);
  assert.equal(inputs.source, 'strategy.priceHistory');
  assert.match(inputs.details_json, /"samples":30/);
  assert.match(queryText, /dbo\.correlation_snapshots/);
});

test('mutation proposal telemetry writes to V2 governance table', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'mutation_proposal',
    payload: {
      proposalId: '11111111-1111-4111-8111-111111111111',
      botProfile: 'paper_spot',
      targetProfile: 'live_spot',
      strategy: 'spot_day_bull_flag',
      proposalType: 'self_evolution_patch',
      patch: { changes: [{ type: 'env_set', key: 'BULL_FLAG_MIN_RR', value: '1.1' }] },
      patchHash: 'abc123',
      status: 'proposed',
    },
  });

  assert.equal(inputs.proposal_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(inputs.bot_profile, 'paper_spot');
  assert.equal(inputs.target_profile, 'live_spot');
  assert.equal(inputs.strategy, 'spot_day_bull_flag');
  assert.match(queryText, /dbo\.mutation_proposals/);
  assert.match(queryText, /MERGE/);
});

test('promotion gate telemetry writes normalized evidence fields', async () => {
  const telemetry = new SqlTelemetry({ logger: { warn() {}, info() {}, error() {} }, botProfile: 'paper' });
  const inputs = {};
  let queryText = '';
  const pool = {
    request() {
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(sqlText) {
          queryText = sqlText;
          return { recordset: [] };
        },
      };
    },
  };

  await telemetry._writeOne(pool, {
    kind: 'promotion_gate_evaluation',
    payload: {
      botProfile: 'paper_spot',
      targetProfile: 'live_spot',
      strategy: 'momentum',
      strategyVersion: 'paper-abc',
      strategyClass: 'day_trade',
      passed: false,
      score: 55,
      reasons: ['sample_size_below_min'],
      metrics: {
        sampleSize: 12,
        expectancyUsd: -1,
        stressedExpectancyUsd: -2,
        profitFactor: 0.9,
        maxDrawdownPct: 7,
        symbolConcentrationPct: 40,
        regimeCoverageCount: 1,
        executionDiscrepancyPct: 18,
      },
      thresholds: { minSampleSize: 100 },
    },
  });

  assert.equal(inputs.bot_profile, 'paper_spot');
  assert.equal(inputs.strategy, 'momentum');
  assert.equal(inputs.sample_size, 12);
  assert.equal(inputs.expectancy_usd, -1);
  assert.equal(inputs.passed, false);
  assert.match(inputs.failure_reasons_json, /sample_size_below_min/);
  assert.match(queryText, /dbo\.promotion_gate_evaluations/);
});
