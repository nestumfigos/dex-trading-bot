'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('V2 Docker Compose keeps safe service boundaries and host routing', () => {
  const compose = fs.readFileSync(path.resolve(__dirname, '..', 'docker-compose.v2.yml'), 'utf8');
  const docs = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'V2_DOCKER_COMPOSE.md'), 'utf8');

  ['live-spot:', 'paper-spot:', 'paper-perps:'].forEach((service) => {
    assert.match(compose, new RegExp(service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  assert.match(compose, /DASHBOARD_BIND_HOST:\s+"0\.0\.0\.0"/);
  assert.match(compose, /PERPS_BIND_HOST:\s+"0\.0\.0\.0"/);
  assert.match(compose, /LIVE_PERPS_EXECUTION_ENABLED:\s+"false"/);
  assert.match(compose, /\.\.\/dex-trading-bot-perps\/logs:\/app\/logs/);

  const hostGatewayCount = (compose.match(/host\.docker\.internal:host-gateway/g) || []).length;
  assert.equal(hostGatewayCount, 3);

  assert.match(docs, /host\.docker\.internal/);
  assert.match(docs, /Do not use `127\.0\.0\.1` inside container SQL connection strings/);
});
