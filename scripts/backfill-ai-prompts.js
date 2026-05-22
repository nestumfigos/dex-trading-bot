#!/usr/bin/env node
'use strict';

// Seed dbo.ai_prompts with hardcoded prompt templates from src/brain/anthropic.js
// and src/ai/ensemble.js. Each prompt registered as version=1, active=1.
// Idempotent (UPSERT). Re-run after editing a prompt: bump version, mark new active.
//
// Usage:
//   node scripts/backfill-ai-prompts.js --dry-run
//   node scripts/backfill-ai-prompts.js              # apply for live + paper + global

require('dotenv').config();

const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const SCOPE_ARG = (args.find((a) => a.startsWith('--scope=')) || '').split('=')[1] || null;

// Prompt catalog. Templates use {{placeholder}} syntax for runtime substitution.
// For now, the templates are descriptive shells — actual prompt body still
// lives in src/brain/anthropic.js buildPrompt(). When loader.js is wired
// (deferred from Week 4), these will become the source of truth.
const PROMPTS = [
  {
    name: 'anthropic_trade_signal',
    provider: 'anthropic',
    description: 'Per-token BUY/HOLD/SELL signal from Claude. Returns {signal, confidence, reason, riskFlags}.',
    template: '<<<see src/brain/anthropic.js buildPrompt() — placeholder until loader wired>>>',
    system_msg: null,
  },
  {
    name: 'groq_lesson',
    provider: 'groq',
    description: 'Post-trade lesson extraction from closed position outcome. Returns {lesson, avoidPattern, confidence}.',
    template: '<<<see src/agent/agentMemory.js generateLessonWithAI()>>>',
    system_msg: null,
  },
  {
    name: 'nvidia_ensemble',
    provider: 'nvidia',
    description: 'Ensemble signal voter (NVIDIA NIM). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithNvidia()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'cerebras_ensemble',
    provider: 'cerebras',
    description: 'Ensemble signal voter (Cerebras). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithCerebras()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'groq_ensemble',
    provider: 'groq',
    description: 'Ensemble signal voter (Groq). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithGroq()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'gemini_ensemble',
    provider: 'gemini',
    description: 'Ensemble signal voter (Gemini). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithGemini()>>>',
    system_msg: null,
  },
  {
    name: 'openrouter_ensemble',
    provider: 'openrouter',
    description: 'Ensemble signal voter (OpenRouter). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithOpenRouter()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'sambanova_ensemble',
    provider: 'sambanova',
    description: 'Ensemble signal voter (SambaNova). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithSambanova()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'together_ensemble',
    provider: 'together',
    description: 'Ensemble signal voter (Together AI). Same I/O schema as anthropic_trade_signal.',
    template: '<<<see src/ai/ensemble.js evaluateWithTogether()>>>',
    system_msg: 'Return only JSON.',
  },
  {
    name: 'sentiment_classifier',
    provider: 'groq',
    description: 'Token-level sentiment classifier from news + social headlines.',
    template: '<<<see src/utils/sentiment-engine.js>>>',
    system_msg: null,
  },
  {
    name: 'exit_classifier',
    provider: 'groq',
    description: 'Post-exit classification (TAKE_PROFIT / STOP_LOSS / TIME_STOP / etc).',
    template: '<<<see src/utils/exit-classifier.js>>>',
    system_msg: null,
  },
];

async function upsertPrompt(pool, scope, p) {
  const req = pool.request();
  req.input('name',        sql.NVarChar(64),  p.name);
  req.input('scope',       sql.NVarChar(32),  scope);
  req.input('provider',    sql.NVarChar(32),  p.provider);
  req.input('template',    sql.NVarChar(sql.MAX), p.template);
  req.input('system_msg',  sql.NVarChar(sql.MAX), p.system_msg);
  req.input('description', sql.NVarChar(512), p.description);
  req.input('source',      sql.NVarChar(64),  'seed');

  // If active row exists for (name, scope), no-op (preserve any human edits).
  // Else, INSERT version=1, active=1.
  await req.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.ai_prompts WHERE name = @name AND scope = @scope AND active = 1)
    BEGIN
      INSERT INTO dbo.ai_prompts (name, version, scope, provider, template, system_msg, description, active, source)
      VALUES (@name, 1, @scope, @provider, @template, @system_msg, @description, 1, @source);
    END
  `);
}

async function seedScope(pool, scope) {
  console.log(`[backfill-ai-prompts] ${scope}: ${PROMPTS.length} prompts → ai_prompts`);
  for (const p of PROMPTS) {
    if (DRY) {
      console.log(`  [DRY] ${p.name} (provider=${p.provider})`);
      continue;
    }
    try {
      await upsertPrompt(pool, scope, p);
      console.log(`  ✓ ${p.name}`);
    } catch (e) {
      console.error(`  ✗ ${p.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  if (!isSqlEnabled()) {
    console.error('[backfill-ai-prompts] SQL not configured. Aborting.');
    process.exit(2);
  }
  const pool = await getPool();
  const scopes = SCOPE_ARG ? [SCOPE_ARG] : ['live', 'paper', 'global'];
  for (const scope of scopes) {
    try { await seedScope(pool, scope); }
    catch (e) { console.error(`[backfill-ai-prompts] ${scope}: ${e.message}`); process.exitCode = 1; }
  }
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(`[backfill-ai-prompts] fatal: ${e?.stack || e}`); process.exit(1); });
