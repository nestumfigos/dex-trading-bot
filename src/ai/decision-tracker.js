'use strict';

/**
 * AI Decision Tracker — Week 4 / Track C wire-up.
 *
 * Wraps any AI inference call to capture provider/latency/cost/signal into
 * dbo.ai_decisions. Best-effort, never throws upward. Battery-safe defaults:
 * if SQL is down, the record is silently dropped (no retry buffer).
 *
 * Usage pattern (wrap any axios.post-style AI call):
 *
 *   const decision = await trackAi(
 *     { provider: 'anthropic', model: 'claude-3-5-sonnet', purpose: 'trade_signal',
 *       symbol: 'KCS', chain: 'kucoin', scope: 'live', strategy: 'momentum',
 *       promptName: 'anthropic_trade_signal', promptVersion: 1 },
 *     async () => {
 *       const res = await axios.post(url, body);
 *       return {
 *         response: res.data,
 *         signal: parsed.signal,
 *         confidence: parsed.confidence,
 *         requestTokens: res.data.usage.input_tokens,
 *         responseTokens: res.data.usage.output_tokens,
 *         responseExcerpt: text.slice(0, 2000),
 *       };
 *     }
 *   );
 *
 * `decision` is the inner function's return value verbatim, so this is a
 * drop-in wrapper. Tracking failures never propagate.
 */

// Rough provider cost per 1K tokens (USD). Conservative; for accurate billing,
// override per-call via `costUsd` from response headers.
const TOKEN_COST_PER_1K = Object.freeze({
  anthropic:  { input: 0.003,   output: 0.015 },   // claude sonnet 3.5
  groq:       { input: 0.00005, output: 0.0001 },  // llama 3.1 8b
  nvidia:     { input: 0.001,   output: 0.003 },   // nemotron
  cerebras:   { input: 0.0001,  output: 0.0001 },
  openrouter: { input: 0.001,   output: 0.003 },
  sambanova:  { input: 0.0001,  output: 0.0001 },
  together:   { input: 0.0002,  output: 0.0002 },
  openai:     { input: 0.005,   output: 0.015 },
});

function estimateCost(provider, requestTokens, responseTokens) {
  const rate = TOKEN_COST_PER_1K[String(provider).toLowerCase()] || { input: 0, output: 0 };
  const req = Math.max(0, Number(requestTokens) || 0);
  const res = Math.max(0, Number(responseTokens) || 0);
  return ((req / 1000) * rate.input) + ((res / 1000) * rate.output);
}

function classifyError(err) {
  const message = String(err?.message || err || '');
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'TIMEOUT';
  if (/rate limit|429|too many requests/i.test(message)) return 'RATE_LIMIT';
  if (/401|403|unauthorized|forbidden|invalid api key/i.test(message)) return 'AUTH';
  if (/parse|JSON/i.test(message)) return 'PARSE';
  return 'UNKNOWN';
}

/**
 * Best-effort INSERT to dbo.ai_decisions. Never throws.
 */
async function persistDecision({ sql, logger, row }) {
  if (!sql || typeof sql.request !== 'function') return;
  try {
    const req = sql.request();
    req.input('scope',            row.scope || 'global');
    req.input('strategy',         row.strategy || null);
    req.input('provider',         row.provider);
    req.input('model',            row.model || null);
    req.input('purpose',          row.purpose || null);
    req.input('symbol',           row.symbol || null);
    req.input('chain',            row.chain || null);
    req.input('prompt_name',      row.promptName || null);
    req.input('prompt_version',   row.promptVersion || null);
    req.input('request_tokens',   Number.isFinite(row.requestTokens) ? row.requestTokens : null);
    req.input('response_tokens',  Number.isFinite(row.responseTokens) ? row.responseTokens : null);
    req.input('cost_usd',         Number.isFinite(row.costUsd) ? row.costUsd : null);
    req.input('latency_ms',       Number.isFinite(row.latencyMs) ? row.latencyMs : null);
    req.input('success',          row.success ? 1 : 0);
    req.input('error_code',       row.errorCode || null);
    req.input('error_message',    row.errorMessage ? String(row.errorMessage).slice(0, 1024) : null);
    req.input('signal',           row.signal || null);
    req.input('confidence',       Number.isFinite(row.confidence) ? row.confidence : null);
    req.input('response_excerpt', row.responseExcerpt ? String(row.responseExcerpt).slice(0, 2000) : null);
    req.input('metadata',         row.metadata ? JSON.stringify(row.metadata).slice(0, 4000) : null);
    req.input('bot_version',      row.botVersion || null);

    await req.query(`
      INSERT INTO dbo.ai_decisions
        (scope, strategy, provider, model, purpose, symbol, chain, prompt_name, prompt_version,
         request_tokens, response_tokens, cost_usd, latency_ms, success, error_code, error_message,
         signal, confidence, response_excerpt, metadata, bot_version)
      VALUES
        (@scope, @strategy, @provider, @model, @purpose, @symbol, @chain, @prompt_name, @prompt_version,
         @request_tokens, @response_tokens, @cost_usd, @latency_ms, @success, @error_code, @error_message,
         @signal, @confidence, @response_excerpt, @metadata, @bot_version);
    `);
  } catch (err) {
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`[ai-decision-tracker] insert failed: ${err?.message || err}`);
    }
  }
}

/**
 * Wraps an async AI call. Captures latency + outcome. Writes one ai_decisions row.
 * Re-throws the underlying error after recording the failure row.
 *
 * @param {Object}   meta      provider/model/purpose/symbol/chain/scope/strategy/...
 * @param {Function} fn        async () => ({ response, signal?, confidence?, requestTokens?, responseTokens?, responseExcerpt? })
 * @param {Object}   [opts]    { sql, logger, getPool }
 * @returns whatever `fn` returned
 */
async function trackAi(meta, fn, opts = {}) {
  const t0 = Date.now();
  const { sql, logger, getPool } = opts;

  // Lazy SQL pool resolution if a getter was passed.
  const pool = sql || (typeof getPool === 'function' ? await getPool().catch(() => null) : null);

  try {
    const result = await fn();
    const latencyMs = Date.now() - t0;
    const requestTokens = Number(result?.requestTokens) || null;
    const responseTokens = Number(result?.responseTokens) || null;
    const costUsd = Number.isFinite(result?.costUsd)
      ? result.costUsd
      : (requestTokens || responseTokens ? estimateCost(meta.provider, requestTokens, responseTokens) : null);

    // Fire-and-forget INSERT
    persistDecision({
      sql: pool,
      logger,
      row: {
        ...meta,
        requestTokens,
        responseTokens,
        costUsd,
        latencyMs,
        success: true,
        signal: result?.signal,
        confidence: result?.confidence,
        responseExcerpt: result?.responseExcerpt,
      },
    }).catch(() => {});

    return result;
  } catch (err) {
    const latencyMs = Date.now() - t0;
    persistDecision({
      sql: pool,
      logger,
      row: {
        ...meta,
        latencyMs,
        success: false,
        errorCode: classifyError(err),
        errorMessage: err?.message || String(err),
      },
    }).catch(() => {});
    throw err;
  }
}

module.exports = {
  trackAi,
  persistDecision,
  estimateCost,
  classifyError,
  TOKEN_COST_PER_1K,
};
