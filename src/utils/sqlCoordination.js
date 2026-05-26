 'use strict';
 
 const { getPool, ensureSchema, sql } = require('./sqlServer');
const config = require('../../config');
 
 function nowUtcPlusMs(ms) {
   return new Date(Date.now() + Math.max(0, Number(ms || 0)));
 }
 
 class SqlCoordination {
   constructor({ logger, botId } = {}) {
     this.logger = logger || console;
     this.botId = String(botId || process.env.BOT_PROFILE || process.pid);
   }
 
   async init() {
     const ok = await ensureSchema(this.logger);
     return ok;
   }
 
   async acquireLock(resource, { ttlMs = 30000, waitMs = 0 } = {}) {
     const pool = await getPool(this.logger);
     if (!pool) return { ok: true, noop: true, release: async () => {} };
 
     await this.init();
     const res = String(resource || '').slice(0, 200);
     if (!res) return { ok: false, reason: 'invalid_resource' };
 
     const deadline = Date.now() + Math.max(0, Number(waitMs || 0));
     const owner = this.botId.slice(0, 80);
 
     while (true) {
       const attempt = await this._tryAcquireOnce(pool, res, owner, ttlMs);
       if (attempt.ok) {
         return {
           ok: true,
           release: async () => this.releaseLock(res, owner).catch(() => {}),
         };
       }
       if (Date.now() >= deadline) return attempt;
       await new Promise((r) => setTimeout(r, 120));
     }
   }
 
   async _tryAcquireOnce(pool, resource, owner, ttlMs) {
     const tx = new sql.Transaction(pool);
     await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
     try {
       const req = new sql.Request(tx);
       req.input('resource', sql.NVarChar(200), resource);
       req.input('owner', sql.NVarChar(80), owner);
       req.input('expiresAt', sql.DateTime2(3), nowUtcPlusMs(ttlMs));
 
       // Lock row (or key-range) and acquire if missing/expired/owned.
       const select = await req.query(`
 SELECT resource, owner, expires_at
 FROM dbo.bot_locks WITH (UPDLOCK, HOLDLOCK)
 WHERE resource = @resource
 `);
 
       const row = select.recordset && select.recordset[0];
       const now = new Date();
       const expired = !row || (row.expires_at && new Date(row.expires_at) <= now);
       const owned = row && String(row.owner) === owner;
 
       if (!row) {
         await req.query(`
 INSERT INTO dbo.bot_locks(resource, owner, expires_at)
 VALUES (@resource, @owner, @expiresAt)
 `);
         await tx.commit();
         return { ok: true };
       }
 
       if (expired || owned) {
         await req.query(`
 UPDATE dbo.bot_locks
 SET owner = @owner,
     expires_at = @expiresAt,
     updated_at = SYSUTCDATETIME()
 WHERE resource = @resource
 `);
         await tx.commit();
         return { ok: true };
       }
 
       await tx.rollback();
       return { ok: false, reason: 'locked', owner: row.owner, expiresAt: row.expires_at };
     } catch (err) {
       try { await tx.rollback(); } catch {}
       return { ok: false, reason: `sql_error:${err.message}` };
     }
   }
 
   async releaseLock(resource, owner) {
     const pool = await getPool(this.logger);
     if (!pool) return true;
     await ensureSchema(this.logger);
 
     const req = pool.request();
     req.input('resource', sql.NVarChar(200), String(resource).slice(0, 200));
     req.input('owner', sql.NVarChar(80), String(owner).slice(0, 80));
     await req.query(`
 DELETE FROM dbo.bot_locks
 WHERE resource = @resource AND owner = @owner
 `);
     return true;
   }
 
   async kvGet(key) {
     const pool = await getPool(this.logger);
     if (!pool) return { ok: false, reason: 'sql_disabled' };
     await ensureSchema(this.logger);
 
     const req = pool.request();
     req.input('k', sql.NVarChar(200), String(key).slice(0, 200));
     const res = await req.query(`SELECT k, v, updated_at, ver FROM dbo.bot_kv WHERE k=@k`);
     const row = res.recordset && res.recordset[0];
     if (!row) return { ok: true, found: false };
     return { ok: true, found: true, value: row.v, updatedAt: row.updated_at, ver: row.ver };
   }
 
   async kvPut(key, value, { expectedVer = null, allowUnversioned = null } = {}) {
    const pool = await getPool(this.logger);
    if (!pool) return { ok: false, reason: 'sql_disabled' };
    await ensureSchema(this.logger);

    const k = String(key).slice(0, 200);
    const v = value === undefined ? null : String(value);

    // If expectedVer is provided, do an optimistic update (no lost updates).
    if (expectedVer) {
      const req = pool.request();
      req.input('k', sql.NVarChar(200), k);
      req.input('v', sql.NVarChar(sql.MAX), v);
      req.input('ver', sql.VarBinary(8), expectedVer);
      const result = await req.query(`
UPDATE dbo.bot_kv
SET v=@v, updated_at=SYSUTCDATETIME()
WHERE k=@k AND ver=@ver;
SELECT @@ROWCOUNT AS affected;
`);
      const affected = result.recordset?.[0]?.affected || 0;
      return affected === 1 ? { ok: true } : { ok: false, reason: 'version_conflict' };
    }

    // B1.9: unversioned path. Old code used MERGE + HOLDLOCK under READ_COMMITTED;
    // two concurrent writers same key could both succeed and lose an update. Now
    // wrap the MERGE in SERIALIZABLE isolation + explicit transaction so the
    // exchange-locks block the second writer until the first commits.
    //
    // The audit's stricter recommendation was: require expectedVer in prod paths.
    // Keeping the unversioned path callable for callsites that genuinely don't
    // have a prior version (first write), but logging a warn so they can be
    // migrated incrementally. Set strictVersionedKv=true to convert the warn
    // into a hard error.
    const strict = config?.sql?.strictVersionedKv === true;
    const allow = allowUnversioned === true || allowUnversioned === null;
    if (!allow || strict) {
      const msg = `[kvPut] unversioned write on k="${k}" rejected (strictVersionedKv=${strict})`;
      this.logger?.warn?.(msg);
      return { ok: false, reason: 'unversioned_write_rejected' };
    }
    this.logger?.debug?.(`[kvPut] unversioned write on k="${k}" — consider passing expectedVer to avoid lost-update risk`);

    const req = pool.request();
    req.input('k', sql.NVarChar(200), k);
    req.input('v', sql.NVarChar(sql.MAX), v);
    await req.query(`
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRANSACTION;
MERGE dbo.bot_kv WITH (HOLDLOCK) AS t
USING (SELECT @k AS k, @v AS v) AS s
ON t.k = s.k
WHEN MATCHED THEN
  UPDATE SET v=s.v, updated_at=SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (k, v) VALUES (s.k, s.v);
COMMIT TRANSACTION;
`);
    return { ok: true };
  }
 }
 
 module.exports = SqlCoordination;
