 'use strict';
 
 // One-time SQL init + import script.
 // Does NOT require SQL_ENABLED=true (safe to keep bots disabled).
 
 const path = require('path');
 const fs = require('fs').promises;
 const sql = require('mssql');
 
 const ROOT_MAIN = path.resolve(__dirname, '..');
 const ROOT_PAPER_DEFAULT = path.resolve(ROOT_MAIN, '..', 'dex-trading-bot-paper');
 
 function getArg(flag) {
   const idx = process.argv.indexOf(flag);
   if (idx === -1) return null;
   return process.argv[idx + 1] || null;
 }
 
 function boolArg(flag) {
   return process.argv.includes(flag);
 }
 
 function required(value, name) {
   if (!value) throw new Error(`Missing ${name}. Provide it via ${name} or CLI arg.`);
   return value;
 }
 
 async function readJsonIfExists(p) {
   try {
     const raw = await fs.readFile(p, 'utf8');
     return JSON.parse(raw);
   } catch (e) {
     if (e.code === 'ENOENT') return null;
     throw e;
   }
 }
 
 function mergeMemories(mainMem, paperMem) {
   const base = {
     version: 2,
     tradeLessons: [],
     strategyDiscoveries: [],
     tokenBlacklist: {},
     tokenPreferences: {},
     evolutionOutcomes: [],
     knowledgeBase: [],
   };
 
   const a = mainMem && typeof mainMem === 'object' ? mainMem : {};
   const b = paperMem && typeof paperMem === 'object' ? paperMem : {};
 
   const mergeArrayById = (x = [], y = [], cap = 300) => {
     const map = new Map();
     [...x, ...y].forEach((item) => {
       if (!item) return;
       const id = String(item.id || '');
       if (!id) return;
       const prev = map.get(id);
       if (!prev) { map.set(id, item); return; }
       const prevTs = Number(prev.ts || 0);
       const nextTs = Number(item.ts || 0);
       map.set(id, nextTs >= prevTs ? item : prev);
     });
     const arr = Array.from(map.values());
     arr.sort((p, q) => Number(q.ts || 0) - Number(p.ts || 0));
     return arr.slice(0, cap);
   };
 
   const mergeMap = (x = {}, y = {}) => {
     const out = { ...(x || {}) };
     for (const [k, v] of Object.entries(y || {})) {
       const prev = out[k];
       if (!prev) { out[k] = v; continue; }
       const prevTs = Number(prev.addedAt || 0);
       const nextTs = Number(v.addedAt || 0);
       const prevExp = Number(prev.expiresAt || 0);
       const nextExp = Number(v.expiresAt || 0);
       out[k] = (nextTs > prevTs || nextExp > prevExp) ? v : prev;
     }
     return out;
   };
 
   return {
     ...base,
     tradeLessons: mergeArrayById(a.tradeLessons, b.tradeLessons, 300),
     strategyDiscoveries: mergeArrayById(a.strategyDiscoveries, b.strategyDiscoveries, 120),
     evolutionOutcomes: ([]).concat(a.evolutionOutcomes || [], b.evolutionOutcomes || []).slice(0, 60),
     knowledgeBase: mergeArrayById(a.knowledgeBase, b.knowledgeBase, 240),
     tokenBlacklist: mergeMap(a.tokenBlacklist, b.tokenBlacklist),
     tokenPreferences: mergeMap(a.tokenPreferences, b.tokenPreferences),
   };
 }
 
 async function ensureSchema(pool) {
   const ddl = `
 IF OBJECT_ID('dbo.bot_kv', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.bot_kv (
     [k] NVARCHAR(200) NOT NULL PRIMARY KEY,
     [v] NVARCHAR(MAX) NULL,
     [updated_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_kv_updated_at DEFAULT (SYSUTCDATETIME()),
     [ver] ROWVERSION NOT NULL
   );
 END
 
 IF OBJECT_ID('dbo.bot_locks', 'U') IS NULL
 BEGIN
   CREATE TABLE dbo.bot_locks (
     [resource] NVARCHAR(200) NOT NULL PRIMARY KEY,
     [owner] NVARCHAR(80) NOT NULL,
     [acquired_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_locks_acquired_at DEFAULT (SYSUTCDATETIME()),
     [expires_at] DATETIME2(3) NOT NULL,
     [updated_at] DATETIME2(3) NOT NULL CONSTRAINT DF_bot_locks_updated_at DEFAULT (SYSUTCDATETIME())
   );
   CREATE INDEX IX_bot_locks_expires_at ON dbo.bot_locks(expires_at);
 END
 `;
   await pool.request().batch(ddl);
 }
 
 async function putKv(pool, k, v) {
   const req = pool.request();
   req.input('k', sql.NVarChar(200), String(k).slice(0, 200));
   req.input('v', sql.NVarChar(sql.MAX), v === undefined ? null : String(v));
   await req.query(`
 MERGE dbo.bot_kv WITH (HOLDLOCK) AS t
 USING (SELECT @k AS k, @v AS v) AS s
 ON t.k = s.k
 WHEN MATCHED THEN
   UPDATE SET v=s.v, updated_at=SYSUTCDATETIME()
 WHEN NOT MATCHED THEN
   INSERT (k, v) VALUES (s.k, s.v);
 `);
 }
 
 async function main() {
   const conn = getArg('--conn') || process.env.SQL_CONNECTION_STRING || process.env.SQL_INIT_CONNECTION_STRING;
   required(conn, 'SQL_CONNECTION_STRING (or --conn)');
 
   const paperRoot = getArg('--paperRoot') || process.env.PAPER_WORKTREE_PATH || ROOT_PAPER_DEFAULT;
   const importPaper = !boolArg('--no-paper');
 
   const memMainPath = path.join(ROOT_MAIN, 'data', 'agent-memory.json');
   const memPaperPath = path.join(paperRoot, 'data', 'agent-memory.json');
 
   const mainMem = await readJsonIfExists(memMainPath);
   const paperMem = importPaper ? await readJsonIfExists(memPaperPath) : null;
   const merged = mergeMemories(mainMem, paperMem);
 
   const pool = await sql.connect(conn);
   await ensureSchema(pool);
 
   await putKv(pool, 'agent-memory:shared', JSON.stringify(merged));
 
   const meta = {
     importedAt: new Date().toISOString(),
     sources: {
       main: { path: memMainPath, found: Boolean(mainMem) },
       paper: { path: memPaperPath, found: Boolean(paperMem), enabled: importPaper },
     },
     counts: {
       tradeLessons: merged.tradeLessons.length,
       strategyDiscoveries: merged.strategyDiscoveries.length,
       blacklisted: Object.keys(merged.tokenBlacklist || {}).length,
       boosted: Object.keys(merged.tokenPreferences || {}).length,
       knowledge: merged.knowledgeBase.length,
     },
   };
   await putKv(pool, 'agent-memory:import-meta', JSON.stringify(meta));
 
   await pool.close();
   // eslint-disable-next-line no-console
   console.log('[init-agent-sql] OK:', meta);
 }
 
 main().catch((e) => {
   // eslint-disable-next-line no-console
   console.error('[init-agent-sql] FAILED:', e.message);
   process.exit(1);
 });
