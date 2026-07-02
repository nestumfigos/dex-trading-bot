const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readWorkflow() {
  return fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'v2-smoke.yml'), 'utf8');
}

test('v2 ci workflow is constrained and runs the paper smoke suite', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /^permissions:\s*\r?\n\s+contents: read/m);
  assert.match(workflow, /^concurrency:\s*\r?\n\s+group:/m);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /timeout-minutes:\s*20/);
  assert.match(workflow, /CI:\s*"true"/);
  assert.match(workflow, /SQL_ENABLED:\s*"false"/);
  assert.match(workflow, /SQL_STATE_RESTORE_ENABLED:\s*"false"/);
  assert.match(workflow, /PAPER_TRADING:\s*"true"/);
  assert.match(workflow, /BOT_PROFILE:\s*paper/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm run test:v2-smoke/);
});
