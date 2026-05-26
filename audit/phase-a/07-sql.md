# Phase A — SQL Persistence Audit

## Critical

### 1. regime_patterns Schema Drop/Revive Race
- Files: `db/migrations/0021_drop_dead_tables.sql` → `db/migrations/0024_regime_patterns_revived.sql`
- M0021 dropped on bad "unused" analysis; M0024 recreates. Live/paper DBs may be in different states. No idempotent DDL.
- **Impact:** `src/index.js:1679` sizing chain expects table; missing table = runtime 500.
- **Fix:** `CREATE TABLE IF NOT EXISTS`; migration sequence validation in `init-sql.js`.

### 2. Destructive Backfill Deletes Without Cascade Audit
- File: `scripts/backfill-sql-history.js:105-127` (`clearProfileTables`)
- Deletes within same txn as inserts; FK lookup under concurrency may leave orphaned snapshots. No audit trail.
- **Fix:** Archive table before bulk delete; soft-delete flag with tombstone records.

### 3. Backfill Commits Before Memory Sync
- File: `scripts/backfill-sql-history.js:269-277, 282`
- MERGE on `bot_runs` HOLDLOCK can deadlock with live bot writes. Commits even if `syncQueryableState` fails downstream.
- **Fix:** Move memory sync inside txn or rollback on sync failure.

### 4. kvPut MERGE Without Serializable
- File: `src/utils/sqlCoordination.js:150-157`
- MERGE on `bot_kv` uses default READ_COMMITTED. Two writers same key → both succeed with stale version reads. Version CAS bypassed when no `expectedVer`.
- **Impact:** Lost updates on portfolio snapshots, evolution history.
- **Fix:** SERIALIZABLE for MERGE; require version CAS in prod paths.

## High

### 5. FK Added Post-Population Without Orphan Audit
- File: `db/migrations/0019_signals_ai_decision_fk.sql`
- ON DELETE SET NULL after `ai_decision_id` rows possibly existed pre-FK. No pre-check.
- **Impact:** Signals lose AI traceability when `ai_decisions` pruned (7-day retention).
- **Fix:** Audit orphans pre-migration; soft-delete `ai_decisions` instead of prune.

### 6. ALTER DATABASE String Interpolation
- File: `scripts/fix-sql-filegroup.js:55,62`
- `NAME = N'${dataFile.name}'` interpolates filename. Sourced from `sys.database_files` (currently safe) but violates defense-in-depth.
- **Fix:** Whitelist filenames; reject unexpected.

### 7. Regime Patterns Index Missing WHERE
- File: `db/migrations/0024_regime_patterns_revived.sql:47-53`
- `IX_regime_patterns_lookup` indexes all rows but query filters `active=1`.
- **Fix:** `WHERE active = 1` filtered index.

## Medium

### 8. Position Snapshot Inserts Unordered
- File: `scripts/backfill-sql-history.js:201-237`
- JSON.parse iteration order → time-ordered queries return wrong "latest".
- **Fix:** Sort by `lastSeenAt DESC` before insert loop.

### 9. tokens (symbol, chain) UNIQUE Allows Multiple NULLs
- File: `db/migrations/0013_tokens.sql:50`
- UNIQUE INDEX allows multiple NULL `address`; lookup hits wrong row.
- **Fix:** `address NOT NULL` if it's the lookup key; document NULL semantics.

### 10. SQL Pool Never Reconnects on Transient Failure
- File: `src/utils/sqlServer.js:42-95`
- `poolPromise` set once; on failure set null but no retry loop. Bot halts on brief SQL outage.
- **Fix:** Exponential backoff + retry counter in `getPool`.

## Live ↔ Paper Drift
- Schema-version mismatch potential between live/paper depending on migration order during W16 window.
- No `_schema_version.txt` pinning.
- **Fix:** Create version file; enforce parity before trading on either side.

## Suggested Priorities
1. **#1** — schema-existence guard before next live trade.
2. **#3 + #4** — kv/txn integrity; lost updates corrupt state.
3. **#2** — backfill data-loss path.
4. **#10** — SQL outage = trading halt.
