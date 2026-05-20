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
