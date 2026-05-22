'use strict';

/**
 * Persistent SQL-backed job queue.
 *
 * Day 7 follow-up: provides crash-recoverable async coordination so
 * in-flight intents survive bot restart. Complements the in-process
 * AsyncMutex (ordering) + file-lock positionMutex (cross-process safety).
 *
 * Usage:
 *   const jq = require('./utils/job-queue');
 *   await jq.enqueue(pool, { jobType: 'evolution-outcome', payload: {patchId, ...}, scope: 'live' });
 *   const job = await jq.claim(pool, { jobType: 'evolution-outcome', workerId: 'live:1234' });
 *   if (job) { try { ... ; await jq.complete(pool, job.jobId, { ok: true }); } catch (e) { await jq.fail(pool, job.jobId, e.message); } }
 *
 * Recovery sweep: periodically call jq.recoverStaleClaims(pool, { staleSec: 300 }) to
 * re-queue jobs whose claiming worker died.
 */

const STALE_CLAIM_DEFAULT_SEC = 300; // 5 min — workers MUST finish or extend within this

async function enqueue(pool, { jobType, payload = null, scope = 'global', visibleAfter = null, maxAttempts = 5 } = {}) {
  if (!pool || typeof pool.request !== 'function') throw new Error('job-queue.enqueue: SQL pool required');
  if (!jobType) throw new Error('job-queue.enqueue: jobType required');
  const req = pool.request();
  req.input('job_type', jobType);
  req.input('scope', scope);
  req.input('payload', payload == null ? null : JSON.stringify(payload));
  req.input('visible_after', visibleAfter || new Date());
  req.input('max_attempts', maxAttempts);
  const r = await req.query(`
    INSERT INTO dbo.job_queue (job_type, scope, payload, visible_after, max_attempts)
    OUTPUT inserted.job_id
    VALUES (@job_type, @scope, @payload, @visible_after, @max_attempts)
  `);
  return r.recordset?.[0]?.job_id || null;
}

/**
 * Atomically claim the next ready job for a worker.
 * Uses UPDATE ... WITH (READPAST, ROWLOCK) ... OUTPUT to avoid contention between workers.
 * Returns null if no job available.
 */
async function claim(pool, { jobType, workerId, scope = null } = {}) {
  if (!pool || typeof pool.request !== 'function') throw new Error('job-queue.claim: SQL pool required');
  if (!jobType) throw new Error('job-queue.claim: jobType required');
  if (!workerId) throw new Error('job-queue.claim: workerId required');
  const req = pool.request();
  req.input('job_type', jobType);
  req.input('worker_id', workerId);
  req.input('scope', scope);
  const r = await req.query(`
    UPDATE TOP (1) dbo.job_queue WITH (READPAST, ROWLOCK)
      SET status = 'claimed',
          claimed_by = @worker_id,
          claimed_at = SYSUTCDATETIME(),
          attempts = attempts + 1,
          updated_at = SYSUTCDATETIME()
      OUTPUT inserted.job_id, inserted.job_type, inserted.scope, inserted.payload, inserted.attempts, inserted.max_attempts
      WHERE status = 'pending'
        AND visible_after <= SYSUTCDATETIME()
        AND job_type = @job_type
        AND (@scope IS NULL OR scope = @scope)
  `);
  const row = r.recordset?.[0];
  if (!row) return null;
  let payload = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch (_) { payload = row.payload; }
  }
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    scope: row.scope,
    payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

async function complete(pool, jobId, result = null) {
  if (!pool || typeof pool.request !== 'function') throw new Error('job-queue.complete: SQL pool required');
  const req = pool.request();
  req.input('job_id', jobId);
  req.input('result', result == null ? null : JSON.stringify(result));
  await req.query(`
    UPDATE dbo.job_queue
      SET status = 'done', result = @result, updated_at = SYSUTCDATETIME(),
          claimed_by = NULL, claimed_at = NULL
      WHERE job_id = @job_id
  `);
}

/**
 * Mark job failed. If attempts < max_attempts, requeue with exponential backoff.
 * Else mark dead.
 */
async function fail(pool, jobId, errorMsg = '') {
  if (!pool || typeof pool.request !== 'function') throw new Error('job-queue.fail: SQL pool required');
  const req = pool.request();
  req.input('job_id', jobId);
  req.input('last_error', String(errorMsg || '').slice(0, 1024));
  await req.query(`
    UPDATE dbo.job_queue
      SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
          last_error = @last_error,
          visible_after = DATEADD(SECOND, POWER(2, LEAST(attempts, 8)), SYSUTCDATETIME()),
          claimed_by = NULL,
          claimed_at = NULL,
          updated_at = SYSUTCDATETIME()
      WHERE job_id = @job_id
  `);
}

/**
 * Reset claims older than `staleSec` seconds back to pending so a different worker can pick them up.
 * Returns the count of jobs recovered. Run periodically (e.g. every 60s) as a janitor.
 */
async function recoverStaleClaims(pool, { staleSec = STALE_CLAIM_DEFAULT_SEC } = {}) {
  if (!pool || typeof pool.request !== 'function') return 0;
  const req = pool.request();
  req.input('stale_sec', staleSec);
  const r = await req.query(`
    UPDATE dbo.job_queue
      SET status = 'pending',
          claimed_by = NULL,
          claimed_at = NULL,
          updated_at = SYSUTCDATETIME()
      WHERE status = 'claimed'
        AND claimed_at < DATEADD(SECOND, -@stale_sec, SYSUTCDATETIME())
  `);
  return r.rowsAffected?.[0] || 0;
}

async function stats(pool, { jobType = null } = {}) {
  if (!pool || typeof pool.request !== 'function') return null;
  const req = pool.request();
  req.input('job_type', jobType);
  const r = await req.query(`
    SELECT status, COUNT(*) AS cnt
      FROM dbo.job_queue
      WHERE (@job_type IS NULL OR job_type = @job_type)
      GROUP BY status
  `);
  const out = { pending: 0, claimed: 0, done: 0, failed: 0, dead: 0 };
  for (const row of r.recordset || []) out[row.status] = row.cnt;
  return out;
}

module.exports = {
  enqueue,
  claim,
  complete,
  fail,
  recoverStaleClaims,
  stats,
  STALE_CLAIM_DEFAULT_SEC,
};
