'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _testInternals } = require('../src/telegram');

test('Telegram sender posts outbound messages without bot SDK polling surface', async () => {
  const requests = [];
  const sendMessage = _testInternals.createTelegramSender({
    token: 'unit-token',
    chatId: 'chat-1',
    httpPost: async (...args) => { requests.push(args); },
    log: { warn() {}, error() {} },
  });
  await sendMessage('<b>health</b>');
  assert.equal(requests.length, 1);
  assert.match(requests[0][0], /api\.telegram\.org\/botunit-token\/sendMessage$/);
  assert.equal(requests[0][1].parse_mode, 'HTML');
  assert.equal(requests[0][2].timeout, 10000);
});

test('Telegram sender retries transient failures with bounded delays', async () => {
  let attempts = 0;
  const delays = [];
  const sendMessage = _testInternals.createTelegramSender({
    token: 'unit-token',
    chatId: 'chat-1',
    httpPost: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary network failure');
    },
    log: { warn() {}, error() {} },
    sleep: async (ms) => { delays.push(ms); },
  });
  await sendMessage('retriable', 3);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test('Telegram HTML messages escape runtime-provided markup', () => {
  assert.equal(
    _testInternals.escapeHtml('<script data-x="1">& go</script>'),
    '&lt;script data-x=&quot;1&quot;&gt;&amp; go&lt;/script&gt;',
  );
});
