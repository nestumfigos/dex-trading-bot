'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate, getCachedPrompt, _internal } = require('../src/ai/prompt-loader');

test('renderTemplate substitutes {{placeholders}} from vars map', () => {
  const out = renderTemplate('Hello {{name}}, you are {{role}}.', { name: 'BOB', role: 'reviewer' });
  assert.equal(out, 'Hello BOB, you are reviewer.');
});

test('renderTemplate JSON-stringifies non-string values', () => {
  const out = renderTemplate('ctx={{ctx}}', { ctx: { a: 1, b: [2, 3] } });
  assert.equal(out, 'ctx={"a":1,"b":[2,3]}');
});

test('renderTemplate leaves unknown placeholders intact', () => {
  const out = renderTemplate('{{a}} {{b}}', { a: 'X' });
  assert.equal(out, 'X {{b}}');
});

test('renderTemplate handles null/undefined as empty string', () => {
  const out = renderTemplate('[{{x}}] [{{y}}]', { x: null, y: undefined });
  assert.equal(out, '[] []');
});

test('renderTemplate returns empty string for non-string template', () => {
  assert.equal(renderTemplate(null, {}), '');
  assert.equal(renderTemplate(123, {}), '');
});

test('getCachedPrompt returns undefined when never fetched', () => {
  _internal._flushCache();
  assert.equal(getCachedPrompt('never_fetched_xyz', { scope: 'global' }), undefined);
});

test('_key normalizes case', () => {
  assert.equal(_internal._key('Foo', 'GLOBAL'), 'foo|global');
  assert.equal(_internal._key('FOO', 'global'), 'foo|global');
});
