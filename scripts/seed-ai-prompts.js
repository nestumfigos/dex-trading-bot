#!/usr/bin/env node
'use strict';

/**
 * Seed dbo.ai_prompts with the current inline 'ensemble_signal' template.
 * Mirrors live. See live scripts/seed-ai-prompts.js for usage.
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const { getPool } = require('../src/utils/sqlServer');

const ENSEMBLE_TEMPLATE = [
  'You are a crypto market reviewer. Respond in minified JSON only.',
  'Schema: {"signal":"BUY|HOLD|SELL","confidence":0-100,"narrativeStrength":0-100,"reason":"<=180 chars","riskFlags":["..."]}',
  'Strategy profile: {{strategy}} ({{longer_term}})',
  'Use the headlines for narrative strength scoring. Be conservative when uncertain.',
  'When higher-timeframe pattern context is present, prefer 4H/1D pattern confirmation only for established liquid tokens and never overrule clear bearish reversal evidence without strong support.',
  'Context: {{context_json}}',
  'Headlines: {{headlines_json}}',
].join('\n');

const PROMPTS = [
  {
    name: 'ensemble_signal',
    template: ENSEMBLE_TEMPLATE,
    provider: null,
    description: 'Ensemble BUY/HOLD/SELL signal prompt — used by all AI providers in evaluateToken',
  },
];

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const scopeArg = argv.find((a) => a.startsWith('--scope='));
  const scope = (scopeArg ? scopeArg.split('=')[1] : 'global').toLowerCase();

  if (String(process.env.SQL_ENABLED || '').toLowerCase() !== 'true') {
    console.error('SQL_ENABLED=true required.');
    process.exit(2);
  }

  const pool = await getPool(logger);
  if (!pool) {
    console.error('No SQL pool — check SQL_CONNECTION_STRING.');
    process.exit(2);
  }

  for (const p of PROMPTS) {
    console.log(`\n=== ${p.name} (scope=${scope}) ===`);
    if (dryRun) {
      console.log('[dry-run] would upsert:', { ...p, scope, template_len: p.template.length });
      continue;
    }
    const r = pool.request();
    r.input('name', p.name);
    r.input('scope', scope);
    r.input('provider', p.provider);
    r.input('template', p.template);
    r.input('description', p.description);
    r.input('source', 'seed');
    await r.query(`
      DECLARE @nextVer INT = 1;
      SELECT @nextVer = ISNULL(MAX(version), 0) + 1
        FROM dbo.ai_prompts WHERE name = @name AND scope = @scope;

      UPDATE dbo.ai_prompts SET active = 0
       WHERE name = @name AND scope = @scope AND active = 1;

      INSERT INTO dbo.ai_prompts
        (name, version, scope, provider, template, description, active, source, updated_by)
      VALUES
        (@name, @nextVer, @scope, @provider, @template, @description, 1, @source, 'seed-script');
    `);
    console.log(`  upserted active row.`);
  }

  console.log('\nDone. Prompt loader cache TTL = AI_PROMPT_CACHE_TTL_MS (default 5min).');
  process.exit(0);
}

main().catch((err) => {
  console.error('seed-ai-prompts failed:', err.message);
  process.exit(1);
});
