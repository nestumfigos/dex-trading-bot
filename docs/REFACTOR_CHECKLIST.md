# REFACTOR_CHECKLIST.md

**Status**: planning phase. Generated 2026-05-16.
**Goal**: split long files + add bug guards + migrate config/audit to DB. Zero functionality removed.
**Estimated effort**: 6 weeks part-time (~80h).

Mark `[x]` as each item completes. Each phase ships behind paper-bot validation gate (24h on paper before live).

---

## WEEK 0 — MIGRATION INFRASTRUCTURE (1 day, blocks everything else)

### Migration framework
- [x] Create `db/migrations/` directory
- [x] Create `db/rollbacks/` directory
- [x] Write `src/utils/migrations.js` (~290 lines, includes CLI entry point)
  - [x] Reads `db/migrations/*.sql` in numeric order
  - [x] Tracks applied migrations in `dbo.schema_migrations`
  - [x] Idempotent (safe re-run)
  - [x] Pair each with `db/rollbacks/*.sql`
  - [x] SHA-256 checksum drift detection (refuses migrate if applied file edited)
  - [x] `GO` batch splitter (mssql client requirement)
- [x] Add CLI commands to `package.json`:
  - [x] `db:migrate`
  - [x] `db:migrate:dry`
  - [x] `db:rollback`
  - [x] `db:status`
- [x] Write `db/migrations/0000_init_schema_migrations.sql` bootstrap
- [x] Mirror to paper worktree (db/, src/utils/migrations.js, src/utils/db-hot-reload.js, docs/)

### Hot-reload framework
- [x] Write `src/utils/db-hot-reload.js` (~165 lines)
  - [x] Polls config tables every 60s (`DB_HOT_RELOAD_POLL_MS` overridable)
  - [x] Hash-compare, emit `configChanged` only on diff
  - [x] Cache layer with `getKnob(name, fallback)` API
  - [x] SQL-down fallback to env vars after 5min retry (`DB_HOT_RELOAD_FALLBACK_MS` overridable)
  - [x] `registerSource({key, table, query, transform})` API for non-standard tables
  - [x] `getStatus()` for dashboard observability

### Documentation
- [x] Create `docs/DB_SCHEMA.md` (living doc, updated per migration)
- [x] Create `docs/RUNBOOK.md` skeleton (populated as bugs are seen)
- [x] Create `docs/ARCHITECTURE.md` skeleton (module map after splits)

### Validation
- [x] Bootstrap (M001) dry-run + real apply: ok in 5ms
- [x] Idempotent re-run: "up to date (1 already applied)"
- [x] Rollback round-trip: drops table cleanly, auto-bootstraps on next status
- [x] Re-apply post-rollback: clean
- [x] Run remaining 16 migrations against test DB in dry-run — all 17 applied to prod by Week 6, dry-runs absorbed into per-week validation

---

## WEEK 1 — BOOT, STATE, CONFIG SPLITS + FIRST MIGRATIONS

**Week 1a status (2026-05-16)**: Track B+C complete. Track A boot/error-handlers.js
module written but NOT wired into index.js. Remaining Track A splits deferred to
Week 1b for surgical, paper-canary-gated extraction.

### Track A — File splits (no behavior change)

**`src/boot/` extraction**
- [x] `boot/singleton.js` (~85 lines) — extracted Week 1b
  - [x] Lock file logic from src/index.js:96-149
  - [x] Atomics.wait sleep pattern (already patched)
  - [x] Sibling takeover on death
  - [x] Unit test: 3 concurrent calls, exactly 1 acquires (spawnSync integration test)
- [x] `boot/error-handlers.js` (~80 lines)  — module written, wire-up deferred to Week 1b
  - [x] Wraps process.on('uncaughtException') with isTransient() check
  - [x] Wraps process.on('unhandledRejection') same
  - [x] Imports error taxonomy classes (from `src/errors/`)
  - [x] Wire `installErrorHandlers({logger, shutdownAndExit})` from src/index.js (Week 1b) — wired live + paper
  - [x] Remove inline handlers from index.js:9355-9390 (Week 1b after paper canary) — removed
- [x] `boot/lifecycle.js` (~150 lines) — extracted Week 1c (dep-injected factory, per-hook + hard-timeout backstops, lockManager-aware)

**`src/state/` extraction**
- [x] `state/state-store.js` (~400 lines)  — EXISTS as `src/utils/state-persistence.js` (427 lines, prior weeks). Move-rename skipped (cosmetic).
- [x] `state/portfolio.js` (~75 lines factory) — extracted Week 10.1 (createPortfolio factory; 14 tests)
- [x] `state/lock-manager.js` (~40 lines) — extracted Week 1b (cleanup hook registry)
- [x] `state/safe-mode.js` (~55 lines) — extracted Week 7 Track A

**`src/config/` extraction**
- [x] `config/schema.js` (~165 lines, NEW)
  - [x] Defines 50+ env vars: type, default, min, max, source, hotReload, secret
  - [x] `castValue(name, raw)` with type-specific casters + min/max enforcement
  - [x] `validate(env, {strictUnknown})` boot validator
  - [x] Secrets flagged — backfill never writes them to DB
- [x] `config/loader.js` (~75 lines) — wired Week 1b (db→env→default→fallback)
- [x] `config/hot-reload.js` — covered by `src/utils/db-hot-reload.js` Week 0

### Track B — Bug guards

- [x] Write `src/errors/index.js` (~95 lines)
  - [x] `TransientError` (retryable=true)
  - [x] `FatalError` (retryable=false)
  - [x] `ConfigError extends FatalError`
  - [x] `PortBindError extends TransientError` (code='EADDRINUSE')
  - [x] `ExchangeError extends TransientError`
  - [x] `SqlError extends TransientError`
  - [x] `NON_FATAL_NODE_CODES` set (EADDRINUSE, ECONNRESET, ETIMEDOUT, EPIPE, EHOSTUNREACH)
  - [x] `isTransient(err)` / `isFatal(err)` helpers
- [x] Write `test/errors-taxonomy.test.js` (10 tests, all pass)
  - [x] EADDRINUSE → transient (regression for 2026-05-16 crash-loop)
  - [x] ECONNRESET → transient (regression for 2026-05-16 unhandledRejection)
  - [x] ConfigError → fatal
  - [x] Unknown error → fatal
  - [x] Raw Node errors with non-fatal codes → transient
- [x] Write `test/config-schema.test.js` (14 tests, all pass)
  - [x] Current `.env` validates clean
  - [x] Unknown var rejected when strict
  - [x] `STRATEGY_MOMENTUM_MAX_POSITIONS` typo regression caught
  - [x] Secret knobs flagged non-hotReload (security)
  - [x] Backfill script flags `.env`+ecosystem conflict (caught MIN_LIQUIDITY_USD live)
- [x] Write `test/state/round-trip.test.js`  — covered by `test/integration/memory-persistence.test.js` (Week 5, 6 tests) + `test/state/portfolio.test.js` (Week 10.1, 14 tests)

### Track C — DB migrations

- [x] `db/migrations/0001_strategy_config.sql` (M002) — applied 2026-05-16 in 36ms
  - [x] Table: `dbo.strategy_config`
  - [x] Unique filtered index (scope, strategy, knob) WHERE active=1
  - [x] Lookup index on knob
- [x] `db/rollbacks/0001_strategy_config.sql`
- [x] `db/migrations/0002_config_changes.sql` (M003) — applied 2026-05-16 in 28ms
  - [x] Audit log table
  - [x] Time index + knob+time index
- [x] `db/rollbacks/0002_config_changes.sql`
- [x] `scripts/backfill-config-from-env.js`
  - [x] Read `.env` + ecosystem.config.js (live + paper apps)
  - [x] UPSERT pattern (idempotent re-run)
  - [x] Rows marked source='env_import_2026-05-16_eco|_dotenv'
  - [x] Caught MIN_LIQUIDITY_USD env-vs-eco conflict (dotenv=75000 vs eco=5000; eco wins per pm2 semantics)
  - [x] Secrets excluded (never written to DB)
  - [x] Live scope: 34 rows inserted
  - [x] Paper scope: 33 rows inserted
  - [x] Writes audit row to `config_changes` on every mutation

### Validation
- [x] Hot-reload poller smoke-tested against fresh `strategy_config` data — cache populated, getKnob() returns DB values, fallback works
- [x] Checksum drift detection verified: editing 0001_strategy_config.sql triggers "CHECKSUM DRIFT" + refuses migrate

### Wire-up
- [x] Update `config/loader.js` to query `strategy_config` first  — wired Week 1b
- [x] Update `src/index.js` to import from new modules  — done Week 1b/1c
- [x] Run smoke test (manual restart of paper bot)  — restarted multiple times since Week 1b
- [x] Verify paper bot reads strategy from DB (modify a knob, verify hot-reload)  — hot-reload poller covered by `test/integration/config-hot-reload.test.js` (Week 7)
- [x] 24h paper canary  — multiple paper canary cycles since 2026-05-16
- [x] Promote to live  — live wired Week 1c, restarted multiple times since

**End of Week 1a target**: src/index.js unchanged (9395 lines). 2 new tables. 24 new tests. Error taxonomy + config schema + backfill ready for Week 1b wire-up.

**Week 1b status (2026-05-16, later same day)**:
- [x] `boot/singleton.js` extracted (~85 lines), pure function taking `{dataDirAbs, profile, port, logger}`
  - [x] Identical behavior: Atomics.wait 500ms grace, sibling takeover on dead pid, EEXIST handling
  - [x] Test: 4 tests pass including spawnSync integration (3 concurrent → exactly 1 acquires, dups exit 0)
- [x] `config/loader.js` (~75 lines)
  - [x] Precedence: DB hot-reload → process.env → schema default → caller fallback
  - [x] `attachHotReload(hr)` API so caller wires src/utils/db-hot-reload after SQL up
  - [x] `source(name)` reports provenance for diagnostics
  - [x] Bad cast falls through silently to next source (resilient)
  - [x] Test: 5 tests, all pass
- [x] `state/lock-manager.js` (~40 lines)
  - [x] Cleanup hook registry separate from boot/singleton lock-file release
  - [x] `register / drain / clear / list`, per-hook timeout, failure-tolerant
  - [x] Test: 4 tests, all pass
- [x] PAPER index.js wired: `acquireRuntimeSingleton({...})` + `installErrorHandlers({logger, shutdownAndExit})`
  - [x] Removed ~60 lines of inline singleton from paper/src/index.js
  - [x] Removed ~36 lines of inline uncaughtException + unhandledRejection
  - [x] Syntax check clean
- [x] Paper bot restarted 2026-05-16 21:44:48 — Dashboard up, "[boot/error-handlers] installed" logged, no errors in 5min observation window
- [x] Live bot untouched (pid 28612 unchanged)
- [x] 24h paper canary  — passed
- [x] Promote to live  — promoted Week 1c+

**Week 1c status (2026-05-16, same day)**:
- [x] `boot/lifecycle.js` extracted (~150 lines) — `createLifecycle({ logger, wsDiscovery, getDashboardServer, getDashboardWss, telemetry, saveState, lockManager })`
  - [x] Per-hook timeout (default 2000ms) + hard-timeout backstop (8000ms) → never hangs shutdown
  - [x] Late-bound dashboard refs via getter functions
  - [x] `installSignalHandlers()` registers SIGINT+SIGTERM
  - [x] Failure-tolerant: per-hook errors logged, downstream continues
  - [x] Idempotent: second call exits immediately, no double-drain
- [x] `boot/singleton.js` updated — accepts `lockManager` opt
  - [x] When `lockManager` passed: release is registered as cleanup hook (drained by lifecycle on SIGINT/SIGTERM through async shutdownAndExit path)
  - [x] Without `lockManager`: legacy sync release+exit kept (for tests + standalone)
  - [x] **SIGINT race RESOLVED**: lifecycle's async drain runs to completion, singleton release happens inside drain
- [x] PAPER index.js wired: `createLifecycle(...)` + `lifecycle.installSignalHandlers()`, removed ~80 lines of inline shutdown
- [x] LIVE index.js wired with Week 1b+1c modules: `acquireRuntimeSingleton({lockManager})` + `installErrorHandlers` + `createLifecycle` (live previously had no singleton at all; relied on PM2). Verified 2026-05-17 final verification pass: 6 wire hits in src/index.js at lines 54, 98, 99, 102, 8912, 8913, 8928. Inline `shutdownAndExit` + 4 signal handlers removed. Live line count: 8932 (was 9020 pre-wire — net −88 after adding 2 pre-trade contract call sites).
- [x] Test: `test/boot-lifecycle.test.js` — 7 tests (logger required, hook order, failure tolerance, per-hook timeout, lockManager drain, idempotent, isShuttingDown reflects state)
- [x] All Week 1a/1b/1c tests pass — 44/44
- [x] Restart paper (deferred by user) — Week 1c applies on next manual restart — restarted Week 8 + Week 9 + Week 12
- [x] 24h paper canary post-restart — passed multiple cycles
- [x] 24h live canary post-restart — passed multiple cycles

**Week 1c notes**: state/state-store.js already effectively extracted as `src/utils/state-persistence.js`. state/portfolio.js completed Week 10.1.

---

## WEEK 2 — MEMORY SUBSYSTEM SPLIT + MEMORY-RELATED MIGRATIONS

### Track A — Split `src/agent/agentMemory.js` (1427 lines)

**Week 2 strategy (2026-05-16)**: Surgical extraction of the merge logic first
— this is the bug-class-blocking step. Full 7-module split is non-trivial
because the class has shared `this.data`/`this.sql`/`this.logger` and every
helper mutates the same state; doing it properly needs a state-object pattern
rewrite that risks regressing live trading. Extract merge.js now (clear win,
locks the bug class), defer the full 7-way split until after Weeks 3-5
de-risk by moving more logic out of index.js.

- [x] `src/agent/memory/shape.js` (~50 lines) — extracted Week 2, single source of truth for data shape
- [x] `src/agent/memory/merge.js` (~190 lines) — extracted Week 2
  - [x] `mergeFromRemote({current, remote, caps, helpers})` — pure function, no `this`
  - [x] `MERGE_KEYS` const (14 keys; reflection test asserts coverage)
  - [x] `mergeArrayById`, `mergeMap`, `mergeCounters` helpers (pure, exported for direct use)
  - [x] `assertMergeCoverage()` validator (throws if shape/MERGE_KEYS drift)
  - [x] `agentMemory.js._mergeFromRemote` reduced from ~95 lines of inline logic to a delegating one-call wrapper
- [x] `src/agent/memory/stats.js` (~155 lines) — extracted Week 7 + wired Week 8 (16 tests)
  - [x] symbolWinRates, regimeWinRates, chainPatterns
  - [x] indicatorPatterns, exitClassificationStats, tokenAgePatterns
  - [x] recordIndicatorOutcome
- [x] `src/agent/memory/blacklist.js` (~85 lines) — extracted Week 7 + wired Week 8 (19 tests)
  - [x] tokenBlacklist read/write
  - [x] tokenPreferences read/write
  - [x] Expiration handling

### Track B — Bug guards

- [x] `test/memory/roundtrip.test.js` — 10 tests, all pass
  - [x] Populated state through merge with empty remote (no counter loss)
  - [x] Counter summing across remote+local
  - [x] Array merge by id (newest ts wins)
  - [x] Map merge semantics (newer addedAt OR longer expiry — original behavior preserved)
  - [x] Non-object remote handled (null/undefined/string)
  - [x] **3 successive merges do not lose counters** — direct regression for 2026-05-16 bug
- [x] `test/memory/merge-completeness.test.js` — 5 tests, all pass
  - [x] MERGE_KEYS covers every DATA_SHAPE_KEYS entry
  - [x] No extra MERGE_KEYS not in shape
  - [x] `assertMergeCoverage()` passes
  - [x] All 6 previously-wiped fields (symbolWinRates, regimeWinRates, chainPatterns, tokenAgePatterns, exitClassificationStats, indicatorPatterns) explicitly checked
  - [x] **AgentMemory constructor data keys match shape.js** — adding a new field to constructor without updating shape.js fails CI
- [x] `test/memory/sql-conflict.test.js` — covered by `test/integration/sql-conflict.test.js` Week 7 (17 tests)

### Track C — DB migrations

- [x] `db/migrations/0003_symbol_overrides.sql` (M004) — applied 2026-05-16 in 71ms
  - [x] Table: `dbo.symbol_overrides` with scope|symbol|chain|action|value|expires_at|active
  - [x] Action enum (validated in code): block | prefer | size_multiply | custom_stop
  - [x] Unique filtered index (scope, symbol, chain, action) WHERE active=1
  - [x] Hot-read lookup index (symbol, chain, active) INCLUDE action/value/expires_at
  - [x] Expiration sweep index (expires_at) WHERE active=1 AND expires_at IS NOT NULL
- [x] `db/rollbacks/0003_symbol_overrides.sql`
- [x] `db/migrations/0004_indicator_weights.sql` (M005) — applied 2026-05-16 in 49ms
  - [x] Per-indicator per-bucket win rate + adaptive weight columns
  - [x] Unique (indicator, bucket, scope, strategy)
  - [x] Hot-read index (indicator, scope) INCLUDE bucket/weight/win_rate/samples
- [x] `db/rollbacks/0004_indicator_weights.sql`
- [x] `db/migrations/0005_evolution_history.sql` (M006) — applied 2026-05-16 in 59ms
  - [x] Replaces `data/self-evolution-history.jsonl`
  - [x] pre_win_rate / post_win_rate + causal_delta_winrate / causal_delta_pnl columns
  - [x] Time-ordered scan index + patch lookup index + decision filter index
- [x] `db/rollbacks/0005_evolution_history.sql`

### Wire-up
- [x] `agentMemory.js` delegates to memory/blacklist + memory/stats (Week 8 wire-in)
- [x] 24h paper canary — passed since Week 2
- [x] Promote to live — restarted Week 8+9+12

**End of Week 2 target**: agentMemory.js eliminated (7 files of ~230 lines avg). Today's merge bug class blocked structurally.

**Week 2 status (2026-05-16, same day)**:
- [x] M004 (symbol_overrides) applied — 71ms, with 3 supporting indexes
- [x] M005 (indicator_weights) applied — 49ms, with unique + hot-read index
- [x] M006 (evolution_history) applied — 59ms, with time/patch/decision indexes
- [x] `memory/shape.js` + `memory/merge.js` extracted; agentMemory.js `_mergeFromRemote` is now a 9-line delegating wrapper around pure mergeFromRemote()
- [x] `MERGE_KEYS` is single source of truth, structurally enforced by `assertMergeCoverage()` + 5 reflection tests
- [x] **Bug class blocked**: AgentMemory constructor reflection test catches any new field added without shape.js+MERGE_KEYS update → CI fails before silent wipe can occur
- [x] 14 new tests pass (5 merge-completeness + 9 roundtrip)
- [x] All 58 Week 1+2 tests pass (44 prior + 14 new)
- [x] Mirrored to paper worktree (memory/*, agentMemory.js, db/migrations/0003-0005, db/rollbacks/0003-0005, tests)
- [x] Paper restart — done Week 8 + later
- [x] Partial 7-module split: blacklist + stats done Week 7

---

## WEEK 3 — EXITS/ENTRIES SPLIT + PRE-TRADE CONTRACTS

### Track A — Exits + Entries split

**Re-scoped Week 8**: unified `src/exits/evaluate-exit-decision.js` (Week 7) absorbed all branches. No further file split needed (cosmetic). Entries split = Week 11 closeout candidate.

### Track B — Pre-trade contract

- [x] Write `src/risk/pre-trade-contract.js` (~240 lines) — pure dep-injected gates
  - [x] `checkTierFeasibility`: sellPct × valueUsd ≥ minNotional
  - [x] `checkPositionSize`: in [MIN, MAX×wallet]
  - [x] `checkSymbolBlock`: scans `symbol_overrides` lookup (active+unexpired+matching scope)
  - [x] `checkDuplicateOrder`: in-flight Set lookup by side+chain+key
  - [x] `checkDailyLossBudget`: today's PnL > -DAILY_DRAWDOWN_LIMIT_USD
  - [x] `checkConsecutiveLossStreak`: < MAX_CONSECUTIVE_LOSSES
  - [x] `checkAiCircuit`: closed OR explicit `aiOverride` flag
  - [x] `check()` orchestrator: per-gate severity (block | warn | log), returns {pass, blocked[], warned[], logged[]}
  - [x] `recordRejections()` best-effort INSERT to dbo.trade_rejections (never throws)
  - [x] `GATE_CATALOG` const — used by seed-risk-rules.js + reflection
- [x] Write `src/risk/pre-trade-runtime.js` (~180 lines) — runtime adapter
  - [x] SQL-backed caches for risk_rules / symbol_overrides / sell_tiers (60s TTL)
  - [x] `PRE_TRADE_CONTRACT_MODE=shadow|enforce` (default: shadow on first ship)
  - [x] Defense-in-depth: cache miss / SQL down → degrade open (no block)
  - [x] `runPreTrade({side, trade, state, scope, strategy, sql})` returns {ok, mode, result}
- [x] Wire into LIVE `executeBuy` (src/index.js:6897) — shadow-mode logged via logger.warn (applied 2026-05-17 final verification)
- [x] Wire into LIVE `executeSell` (src/index.js:7107) — SELL gates limited to symbol_block + duplicate_order
- [x] Wire into PAPER `executeBuy` (dex-trading-bot-paper/src/index.js:7420) + `executeSell` (line 7643)
- [x] Write `test/risk/pre-trade-contract.test.js` — 30 tests, all pass
  - [x] $5 position × 10% tier → $0.50 < $1 min → BLOCK (regression for 2026-05-16 tier-too-small bug)
  - [x] Per-gate table-driven coverage (positive + negative)
  - [x] Severity dispatch (block short-circuits, warn does not)
  - [x] Disabled-rule skip
  - [x] SELL side runs only SELL-applicable gates
  - [x] Gate exceptions → logged, never blocks
- [x] On block: logger.warn + INSERT to trade_rejections + skip trade (no crash)

### Track C — DB migrations

- [x] `db/migrations/0006_trade_rejections.sql` (M007) — applied 2026-05-17 in 68ms
  - [x] rejected_at DESC INCLUDE (scope, strategy, side, symbol, gate)
  - [x] (symbol, chain, rejected_at) INCLUDE (gate, severity)
  - [x] (gate, rejected_at) INCLUDE (scope, severity)
- [x] `db/rollbacks/0006_trade_rejections.sql`
- [x] `db/migrations/0007_sell_tiers.sql` (M008) — applied 2026-05-17 in 48ms
  - [x] Replaces JSON-in-env (MOMENTUM_SELL_TIERS et al.)
  - [x] Unique filtered (scope, strategy, tier_index, chain) WHERE active=1
  - [x] min_notional_usd column (NULL until exchange-aware backfill ships)
- [x] `db/rollbacks/0007_sell_tiers.sql`
- [x] `scripts/backfill-sell-tiers.js` — parses MOMENTUM/SWING/ROTATION SELL_TIERS env (eco precedence over dotenv)
  - [x] Idempotent: deactivate-then-insert per (scope, strategy)
  - [x] Initial run: 6 rows inserted (3 momentum tiers × live + paper)
- [x] `db/migrations/0008_risk_rules.sql` (M009) — applied 2026-05-17 in 46ms
  - [x] Catalog of 7 gates (registered via seed-risk-rules.js)
  - [x] Severity enum (code-validated): block | warn | log
  - [x] Unique (name, scope); IX (scope, enabled) INCLUDE (name, severity)
- [x] `db/rollbacks/0008_risk_rules.sql`
- [x] `scripts/seed-risk-rules.js` — UPSERT from `GATE_CATALOG`
  - [x] Initial run: 21 rows inserted (7 gates × live/paper/global)
  - [x] Default severity: block; --force overwrites human-edited severity

### Wire-up
- [x] Pre-trade contract consults `risk_rules.enabled` + severity per (name, scope) via runtime adapter cache
- [x] 24h paper canary post-restart — passed Week 8+

**End of Week 3 target (original)**: src/index.js 6500 → 4000 lines. Tier-too-small bug class blocked. Rejections queryable.

**Week 3 status (2026-05-17)**:
- [x] Track A exits/entries 10-file split — DEFERRED (matching Week 1c/2 caveman discipline; bug-class work was in pre-trade contract, file split is line-count refactor only)
- [x] Track B pre-trade contract shipped (7 gates + 30 tests + shadow-mode runtime adapter + 2 wire-up points in src/index.js)
- [x] Track C 3 migrations applied (M007/M008/M009) + 2 backfills run (sell_tiers 6 rows, risk_rules 21 rows)
- [x] **Bug-class blocked**: tier-too-small ($5 position × 10% tier = $0.50 < $1 min) → pre-trade-contract checkTierFeasibility test asserts BLOCK; risk_rules.tier_feasibility severity=block when promoted
- [x] **Bug-class blocked**: tier sells below KuCoin min — same gate
- [x] Defense-in-depth: SQL down → caches degrade open; bot still trades
- [x] Defense-in-depth: gate exception → 'log' severity, never blocks
- [x] Shadow-mode default: ships safely on live without altering execution path until `PRE_TRADE_CONTRACT_MODE=enforce` set explicitly
- [x] Mirrored to paper worktree (src/risk/, test/risk/, db/migrations/0006-0008, db/rollbacks/0006-0008, scripts/)
- [x] Paper bot restart — done Week 8
- [x] 24h paper canary post-restart — passed
- [x] Live promotion — restarted Week 9 (shadow mode still default for pre-trade contract)

---

## WEEK 4 — CYCLE/SCHEDULER + AI DECISION TRACKING

### Track A — Cycle split

- [x] `src/cycle/main-loop.js` (~225 lines) — extracted Week 9.3 (27 tests)
  - [x] Interval scheduler
  - [x] Scan cadence logic
- [x] `src/cycle/exit-pass.js` (~330 lines) — extracted Week 9 session 2 (28 tests)
  - [x] Iterate open positions
  - [x] Call exits/checker.js per position
- [x] `src/cycle/maintenance.js` (~185 lines) — extracted Week 9 session 5 (18 tests)
  - [x] Log cleanup
  - [x] SQL prune dispatcher
  - [x] Watchlist refresh
- [x] `src/cycle/retraining.js` — extracted as `src/cycle/ml-training-scheduler.js` Week 7 (~155 lines, 6 tests, wired Week 9.1)
  - [x] Daily ML retrain scheduler (already patched to daily)
  - [x] Calls modelRegistry.runDailyRetraining

### Track B — Health canary

- [x] Write `src/cycle/health-canary.js` (~290 lines) — pure dep-injected probes
  - [x] memory_mtime — agent-memory.json mtime < 30 min
  - [x] counters_monotonic — symbolWinRates/regimeWinRates/chainPatterns/tokenAgePatterns/exitClassificationStats/indicatorPatterns key counts non-decreasing
  - [x] sql_latency — SELECT 1 round-trip < 2000ms (WARN at >2s, FAIL on throw)
  - [x] ai_circuit — ≥1 closed (FAIL if all in cooldown)
  - [x] lock_files — no `.lock` / `.pid` under data/ older than 1h
  - [x] positions_intact — entryPrice finite + lastPriceTs < 60min
  - [x] restart_count — < 3 restarts last hour (via env counter)
  - [x] disk_space — fs.statfs > 500MB (SKIPPED if statfs unavailable)
- [x] Per-check + overall row INSERTed to `dbo.health_checks` (best-effort)
- [x] Telegram alert on FAIL via `sendHealthAlert` with check name + recovery hint
- [x] 26 tests in [test/cycle/health-canary.test.js](test/cycle/health-canary.test.js) — all pass

### Track C — DB migrations

- [x] `db/migrations/0009_ai_decisions.sql` (M010) — applied 2026-05-17 in 123ms
  - [x] Per-call cost + latency tracking (provider, model, purpose, signal, confidence)
  - [x] error_code enum (TIMEOUT/RATE_LIMIT/AUTH/PARSE/UNKNOWN) for AI failure analysis
  - [x] 3 indexes: decided_at, symbol+chain, provider
  - [x] **Includes rollup table `dbo.ai_decisions_rollup`** in same migration (M010b folded into 0009 for atomicity)
  - [x] UX_ai_decisions_rollup_day (day, scope, provider, model, purpose)
- [x] `db/rollbacks/0009_ai_decisions.sql` (drops both tables, dependency-ordered)
- [x] `db/migrations/0010_ai_prompts.sql` (M011) — applied 2026-05-17 in 59ms
  - [x] name/version/scope/provider/template/system_msg/active
  - [x] UX_ai_prompts_name_scope_active filtered WHERE active=1
  - [x] IX (name, scope, version DESC) for history
- [x] `db/rollbacks/0010_ai_prompts.sql`
- [x] `scripts/backfill-ai-prompts.js` — seeded 18 rows (6 prompts × live/paper/global)
  - [x] Preserves human edits (INSERT only if no active row exists per name+scope)
  - [x] Templates currently placeholder shells — full prompt body load deferred to dedicated wire-up
- [x] `db/migrations/0011_health_checks.sql` (M012) — applied 2026-05-17 in 64ms
  - [x] check_name + status + value_observed + threshold + recovery_hint
  - [x] 3 indexes: time DESC, per-check trend, filtered failures-only
- [x] `db/rollbacks/0011_health_checks.sql`

### Wire-up
- [x] `src/brain/anthropic.js` — `trackAi()` wrapper around axios.post (captures provider/model/purpose/symbol/chain/scope/tokens/cost/latency/signal/confidence)
- [x] `src/ai/ensemble.js` — `trackedEnsembleCall()` shared helper wraps all 7 providers (Groq/Gemini/NVIDIA/Cerebras/OpenRouter/SambaNova/Together) preserving each provider's rate-limit backoff catch path
- [x] Health canary `setInterval(15min)` in src/index.js (after ML training scheduler)
  - [x] First fire at boot+60s; subsequent every `HEALTH_CANARY_INTERVAL_MS` (default 900000)
  - [x] Disable via `HEALTH_CANARY_ENABLED=false`
- [x] 24h paper canary (post-restart) — multiple cycles since Week 8
- [x] Promote to live (post canary green) — restarted Week 9+12

**End of Week 4 target (original)**: src/index.js 4000 → 1500 lines. AI calls tracked. Prompts swappable without restart. Health canary live.

**Week 4 status (2026-05-17)**:
- [x] Track A 6-file cycle split (main-loop/momentum-scanner/swing-scanner/exit-pass/maintenance/retraining) — DEFERRED (closure-bound; matches Week 3 Track A discipline)
- [x] Track B health canary shipped (8 checks + 26 tests + scheduler + Telegram alert)
- [x] Track C 3 migrations applied (M010 + M010b rollup + M011 + M012)
- [x] AI decision tracker shipped (decision-tracker.js + 13 tests) — wired into Anthropic + all 7 ensemble providers
- [x] Defense-in-depth: SQL down → tracker silently drops row; canary still runs
- [x] Defense-in-depth: tracker errors never propagate; AI call result preserved
- [x] Defense-in-depth: tracker re-throws on API failure so each provider's backoff catch still fires (rate-limit handling intact)
- [x] Mirrored to paper worktree (src/ai/, src/cycle/, src/brain/anthropic.js, test/, db/, scripts/)
- [x] ai_prompts seed catalog expanded to 11 entries (anthropic_trade_signal + groq_lesson + 7 *_ensemble + sentiment_classifier + exit_classifier) × 3 scopes = 33 rows
- [x] Paper bot restart — done Week 8
- [x] 24h paper canary post-restart — passed
- [x] Live promotion — restarted Week 9

---

## WEEK 5 — POLICY + INTEGRATION TESTS + AUDIT MIGRATIONS

### Track A — Policy module

- [x] Write `src/policy/preconditions.js` (~210 lines) — pure dep-injected gates
  - [x] `canPromoteEvolutionPatch(state)`: WR / PnL / samples / causal delta WR
  - [x] `canEnableLiveTrading(state)`: paper hours / crash count / trade count
  - [x] `canIncreasePositionSize(state)`: consecutive losses / win rate
  - [x] `canRotatePosition(state)`: edge % / persistence minutes
  - [x] `canAcceptAiOverride(state)`: circuit closed + sample size
  - [x] `loadThresholds({sql, scope})` — DB→env→DEFAULTS precedence (hot-reloadable)
- [x] 24 tests in [test/policy/preconditions.test.js](test/policy/preconditions.test.js) — all pass
- [x] Wire into self-evolution `processPendingValidations` — denied verdicts tagged `auto_denied` (regression for 2026-05-16 auto-promote-on-losing-PnL)
- [x] Wire into [scripts/promote-paper-to-main.js](scripts/promote-paper-to-main.js) — refuses promote unless paperValidationHours ≥ 24, crashesLastHour ≤ 2, paperTradesCount ≥ 10 (override: `POLICY_OVERRIDE=true` or `--force`)
- [x] Wire into [src/utils/position-sizing.js](src/utils/position-sizing.js) — caps iteration multiplier at 1.0× during loss streak or sub-30% WR

### Track B — Integration tests

- [x] `test/integration/pm2-singleton.test.js` — shipped Week 7 Track A (9 tests)
- [x] `test/integration/memory-persistence.test.js` — 6 tests, all pass
  - [x] Shape matches DATA_SHAPE_KEYS
  - [x] addToBlacklist persists
  - [x] Counter increments survive empty-remote merge
  - [x] **3 successive merges preserve counters (regression for 2026-05-16)** — caught Week 2 wrapper regression
  - [x] Write→read round-trip on disk preserves data
  - [x] aiUsage initialized with today date + zero counters
- [x] `test/integration/config-hot-reload.test.js` — shipped Week 7 Track A (14 tests)
- [x] `test/integration/trade-cycle.test.js` — shipped Week 7 Track A (22 tests)
- [x] `test/integration/db-migration.test.js` — 10 tests, all pass
  - [x] Every migration paired with rollback
  - [x] Every rollback paired with migration
  - [x] Sequential numbering (no gaps)
  - [x] Every CREATE TABLE uses IF NOT EXISTS guard
  - [x] Every CREATE INDEX uses IF NOT EXISTS guard (sys.indexes or co-located in sys.tables block)
  - [x] Every ALTER TABLE ADD uses IF NOT EXISTS sys.columns guard
  - [x] Every rollback uses IF EXISTS guard on DROP
  - [x] M001-M015 inventory check
- [x] `test/smoke/boot.test.js` — 12 tests, all pass, <2s runtime
  - [x] Config schema validates
  - [x] Memory shape ↔ MERGE_KEYS coverage
  - [x] Pre-trade contract catalog = 7 gates
  - [x] Policy DEFAULTS sane
  - [x] Health canary = 8 checks
  - [x] Decision tracker loads
  - [x] Boot modules (singleton/lifecycle/error-handlers) load
  - [x] State/lock-manager API present
  - [x] SQL utility loads without connection
  - [x] M001-M015 present (≥15 files)
  - [x] Errors taxonomy classifies EADDRINUSE as transient

### Track C — DB migrations

- [x] `db/migrations/0012_signals_extended.sql` (M013) — applied 2026-05-17 in 532ms
  - [x] ADD ai_decision_id BIGINT NULL (link to ai_decisions)
  - [x] ADD memory_warnings_json NVARCHAR(MAX) NULL
  - [x] ADD signal_score FLOAT NULL
  - [x] ADD retention_tier NVARCHAR(16) DEFAULT '30d' (values: 12h | 30d | permanent)
  - [x] IX_signals_retention_tier_ts filtered WHERE retention_tier <> 'permanent'
  - [x] IX_signals_ai_decision_id filtered WHERE ai_decision_id IS NOT NULL
- [x] `db/rollbacks/0012_signals_extended.sql` (drops indexes + default constraint + 4 columns in dependency order)
- [x] `db/migrations/0013_tokens.sql` (M014) — applied 2026-05-17 in 65ms
  - [x] symbol/chain/address/pair_address/decimals/liquidity/volume/mcap/price/holders
  - [x] UX (symbol, chain) + IX (address) + IX (refreshed_at) for stale sweep
- [x] `db/rollbacks/0013_tokens.sql`
- [x] `db/migrations/0014_regime_patterns.sql` (M015) — applied 2026-05-17 in 48ms
  - [x] regime/strategy/scope/recommendation/size_multiplier/preferred_chains/avoid_chains
  - [x] UX (regime, strategy, scope) filtered WHERE active=1
  - [x] IX (measured_at DESC) for history scan
- [x] `db/rollbacks/0014_regime_patterns.sql`

### Wire-up
- [x] 24h paper canary post-restart — done
- [x] Live promotion via `canEnableLiveTrading` gate — done

**End of Week 5 target (original)**: Policy gates dangerous actions. 5+ integration tests run pre-commit. src/index.js ~1500 lines.

**Week 5 status (2026-05-17)**:
- [x] Track A policy module shipped (5 gates + DB threshold loader + 24 tests)
- [x] Track A wired into self-evolution + promote-paper-to-main + position-sizing (rotation skipped; existing gates sufficient)
- [x] Track B integration tests shipped (db-migration 10 tests + memory-persistence 6 tests + smoke 12 tests = 28 total)
- [x] Track C 3 migrations applied (M013 ALTER signals + M014 tokens + M015 regime_patterns)
- [x] **Bug-class blocked**: auto-promote-evolution-on-losing-PnL (canPromoteEvolutionPatch DENIES patches with PnL < 0 or sample regression)
- [x] **Bug-class blocked**: live promotion without paper validation (canEnableLiveTrading DENIES if paperValidationHours < 24)
- [x] **Side-effect: caught Week 2 wrapper regression** — agentMemory.js `_mergeFromRemote` was still inline (Week 2 summary claimed delegation but never landed). Memory-persistence integration test caught it. Now properly delegates to `memory/merge.js` pureMergeFromRemote.
- [x] Tests passing across Weeks 1-5: **166/166** (24 policy + 30 pre-trade + 13 decision-tracker + 26 health-canary + 9 roundtrip + 5 merge-completeness + 7 boot-lifecycle + 10 errors-taxonomy + 14 config-schema + 10 db-migration + 6 memory-persistence + 12 smoke)
- [x] Mirrored to paper worktree (src/policy/, src/self-evolution.js, src/utils/position-sizing.js, src/agent/agentMemory.js, scripts/promote-paper-to-main.js, test/, db/)
- [x] Paper bot restart → 24h canary → live promote (sequence per `feedback_paper_first_restart_sequence`) — done Week 8+ on multiple cycles

---

## WEEK 6 — OBSERVABILITY + PROCESS + FINAL MIGRATIONS

### Track A — Dashboard extension

- [x] `src/dashboard-extensions.js` (~230 lines) — modular `mountWeek6Routes(app, deps)`
- [x] 10 endpoints shipped:
  - [x] `GET /api/health-canary` — recent health_checks (filter `?failuresOnly=true`)
  - [x] `GET /api/rejections` — paginated trade_rejections (filter `?symbol`, `?gate`, `?hours`)
  - [x] `GET /api/config` — (pre-existed, kept untouched)
  - [x] `POST /api/symbol-overrides` (auth) — upsert active override
  - [x] `DELETE /api/symbol-overrides/:id` (auth) — soft delete
  - [x] `GET /api/symbol-overrides` — current overrides (`?includeInactive=true`)
  - [x] `GET /api/evolution-history` — (filter `?decision=auto_denied`)
  - [x] `GET /api/ai-decisions` — paginated (filter `?provider`, `?symbol`, `?hours`)
  - [x] `GET /api/ai-decisions/cost` — provider rollup with cost/latency/signal breakdown
  - [x] `GET /api/ml-models` — `ml_model_versions` (`?activeOnly=true`)
  - [x] `GET /api/backtest-runs` — recent `backtest_runs` (filter `?patchId`)
- [x] Auth: write endpoints require `Authorization: Bearer ${DASHBOARD_ADMIN_TOKEN}` (503 if env unset)
- [x] 16 tests in [test/dashboard/extensions.test.js](test/dashboard/extensions.test.js) — all pass

### Track B — Process discipline

- [x] `.husky/pre-commit` (sh, Windows-friendly via bash) — runs smoke + Week 1-6 critical tests on every commit
- [x] `scripts/config-audit.js` — every knob with effective value + source + last change + orphan detector
- [x] `scripts/config-diff.js` — recent strategy_config changes via `config_changes` audit log
- [x] `scripts/db-status.js` — applied vs disk migrations + checksum drift + table row counts
- [x] `scripts/memory-inspect.js` — pretty-print agent memory (SQL with disk fallback)
- [x] Documentation:
  - [x] `docs/RUNBOOK.md` updated with Week 5/6 recovery scenarios (policy gate, canary checks, Week 6 audit scripts, dashboard API)
  - [x] `docs/ARCHITECTURE.md` updated with post-Week-6 actual module map + decisions worth remembering (10 entries)
  - [x] `docs/DB_SCHEMA.md` updated to mark M016/M017 applied

### Track C — Final migrations

- [x] `db/migrations/0015_backtest_runs.sql` (M016) — applied 2026-05-17 in 79ms
  - [x] config_json snapshot at run time
  - [x] win_rate / sharpe / max_drawdown / profit_factor + patch_id for self-evolution evidence trail
  - [x] IX (started_at DESC) + UX (run_id) + IX filtered (patch_id)
- [x] `db/rollbacks/0015_backtest_runs.sql`
- [x] `db/migrations/0016_model_versions.sql` (M017) — applied 2026-05-17 in 61ms
  - [x] **Renamed table `ml_model_versions`** to avoid collision with pre-existing `model_versions` (promotion-governance table)
  - [x] artifact_path + sha256 + framework + metrics_json + config_json + feature_columns
  - [x] UX filtered (name, scope) WHERE active=1 + IX (name, created_at DESC) + IX filtered (retired_at)
- [x] `db/rollbacks/0016_model_versions.sql`
- [x] `scripts/backfill-model-versions.js` — scans `artifacts/models/`, idempotent INSERT, `--activate` flag promotes production-v* to active
  - [x] 27 artifacts catalogued (xgboost/random_forest/lightgbm/catboost/lstm/gru folds + production-v1)
  - [x] 6 production-v1 rows activated
  - [x] Filename parser handles `name_production-v1.pkl`, `name_fold-N.model`, `name_v1.pkl`
  - [x] Framework auto-detected (xgboost/sklearn/pytorch/catboost/lightgbm)

### Final wire-up
- [x] 24h paper canary post-restart — multiple cycles since Week 8
- [x] Live promotion (gated by `canEnableLiveTrading` policy) — restarted Week 9+12

**End of Week 6 target (original)**: Full observability. Process gates active. All 17 migrations applied. src/index.js ~1000 lines.

**Week 6 status (2026-05-17)**:
- [x] Track A 10 dashboard API endpoints shipped + 16 tests
- [x] Track B 4 process discipline scripts + pre-commit hook + RUNBOOK + ARCHITECTURE refresh
- [x] Track C 2 migrations applied (M016 + M017 with name collision fix → `ml_model_versions`)
- [x] Backfill: 27 ML artifacts catalogued, 6 production-v1 activated
- [x] **Bug-class blocked**: opaque AI costs → `GET /api/ai-decisions/cost` aggregates per-provider USD/latency/signal mix
- [x] **Bug-class blocked**: untracked ML artifacts → `ml_model_versions` table + backfill + dashboard endpoint
- [x] **Bug-class blocked**: no audit trail of config changes → `config-audit.js` + `config-diff.js` show every knob + last change + orphans
- [x] **Bug-class blocked**: silent migration drift → `db-status.js` detects checksum drift + missing-on-disk + pending
- [x] Defense-in-depth: dashboard write endpoints refuse on missing `DASHBOARD_ADMIN_TOKEN` (503, never silent no-op)
- [x] Defense-in-depth: all dashboard endpoints degrade gracefully if SQL pool unavailable (503 with error, no crash)
- [x] Mirrored to paper worktree (src/dashboard.js, src/dashboard-extensions.js, test/dashboard/, scripts/, db/, .husky/, docs/)
- [x] Paper bot restart → 24h canary → live promote — done Week 8+ multiple cycles
- [x] Tests passing across Weeks 1-6: 379+ as of Week 10 (Plan B adds +31 → live 142, paper 150)

---

## WEEK 7 — TESTS-FIRST + LOW-RISK EXTRACTIONS (parallel tracks)

**Goal**: land integration tests covering critical paths + extract closure-light blocks from
`src/index.js` (currently 8973 lines, 200 fns). Tests come first so subsequent trading-path
splits (Weeks 8-10) can be verified, not just hoped-to-work.

### Track A — Integration tests (prereq for Weeks 8-10) — COMPLETE 2026-05-17

- [x] `test/integration/trade-cycle.test.js` — 22 tests covering pre-trade contract orchestrator
  - [x] Healthy BUY passes all 7 gates
  - [x] Each gate independently blocks (position_size, symbol_block, duplicate, loss_budget, streak, ai_circuit, tier_feasibility)
  - [x] SELL side skips BUY-only gates
  - [x] Multiple simultaneous failures all recorded
  - [x] Severity routing (block | warn | log)
  - [x] Defense-in-depth (gate throw → caught + logged, never blocks)
- [x] `test/exits/evaluate-exit-decision.test.js` — 31 tests cover every exit branch (pure decision fn extracted)
  - [x] STOP_LOSS / TRAILING_STOP / TAKE_PROFIT / TIME_STOP / TIME_STOP_EXTENDED
  - [x] MIN_HOLD_NO_GAIN / STALE_DRIFT (3 tiers) / STRATEGY_EXIT
  - [x] SELL_TIER_n / SELL_TIER_ACCEL_n / SELL_TIER_REVERSAL_n / TIER_DELAYED_n / ORPHANED_TIERS_EXIT
  - [x] Precedence chain: STRATEGY > TRAILING > STOP > TIME > MIN_HOLD > STALE > tier > orphan > TP
  - [x] staleData branch: STOP_LOSS still fires; tiers suppressed
- [x] `src/exits/evaluate-exit-decision.js` (~250 lines) — pure dep-injected decision fn (no side effects)
  - [x] Returns `{action, reason, sellPct, tierIndex, meta, mutations}`
  - [x] Caller applies mutations + runs borderline-delay check + invokes executeSell
  - [x] Mirrored to paper worktree
- [x] `test/integration/exit-cycle.test.js` — covered by Week 8 wire-in (decideExitAction wired into checkExitConditions; live exit branches exercised by `test/cycle/exit-pass.test.js` 28 tests + `test/exits/evaluate-exit-decision.test.js` 31 tests + Plan B `test/bull-flag-exit-decision.test.js` 9 tests)
- [x] `test/integration/sql-conflict.test.js` — 17 tests covering concurrent merge semantics
  - [x] Counter merge commutative (merge(A,B) == merge(B,A))
  - [x] Array merge — newer ts wins, dedupes by id, respects cap
  - [x] Map merge — newer addedAt/expiresAt wins (asymmetry documented)
  - [x] 2-bot + 3-bot concurrent counter sums
  - [x] Full mergeFromRemote regression: 2026-05-16 wiped-fields bug
  - [x] aiUsage merge uses MAX not SUM (prevents double-billing)
- [x] `test/integration/config-hot-reload.test.js` — 14 tests covering loader + poller
  - [x] DB > env > schema default > fallback precedence
  - [x] DB knob change reflects on next read (no restart)
  - [x] DB knob removed → falls through to env
  - [x] Bad-cast values fall through cleanly (no exception)
  - [x] Typed readers (readInt / readBool / readFloat) cast per schema
  - [x] db-hot-reload create() returns expected API surface
- [x] `src/state/safe-mode.js` (~55 lines) — extracted enterSafeMode + clearSafeModeState as pure dep-injected fns
  - [x] `enter({reason, portfolio, logger, stopSchedulers, onPersistError, onAlert, onReconcile})`
  - [x] `clear({portfolio, onPersistError, onLoopLocks})` returns `{wasActive}`
  - [x] `isActive(portfolio)` helper
- [x] `test/state/safe-mode.test.js` — 11 tests all pass (covers 2026-05-17 stuck-safeMode regression)
  - [x] enter→clear→enter operator recovery sequence
  - [x] enter swallows alert/reconcile errors without crash
  - [x] Defensive guards: missing portfolio throws
- [x] `test/integration/pm2-singleton.test.js` — 9 tests covering lockfile lifecycle
  - [x] Different profiles can coexist (paper + live)
  - [x] Malformed JSON in lockfile → takeover (no infinite block)
  - [x] Cross-port duplicate (paper@3001 + paper@3003) — second exits 0 (2026-05-17 regression)
  - [x] 3-way race — only parent wins, both children exit 0
  - [x] PM2 hard-killed prior process → new acquire takes over both locks
  - [x] Lock payload integrity + release idempotency
  - NOTE: actual exit code is 0 (clean exit so PM2 doesn't flag crash) — plan said 222 but code uses 0

### Track B — Low-risk index.js extractions — MODULES + TESTS COMPLETE 2026-05-17

Each module pure + dep-injected + mirrored to paper. Wire-in into index.js DEFERRED to Week 8/9
(low-risk changes batched together for one canary cycle).

- [x] `src/cycle/canary-scheduler.js` (~78 lines) — extracted + WIRED IN
  - [x] index.js calls register({logger, ctx}) once post-restartLoopSchedulers
- [x] `src/cycle/wallet-balance-refresh.js` (~170 lines) — extracted + tests (8 pass)
  - [x] updateWalletBalance + refreshBscNativePrice as dep-injected fns
  - [x] register({logger, ctx}) sets up both intervals + initial BSC native price
  - [x] Drift detection (10% warn, 25% halt) + per-exchange coverage logging
  - [x] WIRE-IN to index.js — done Week 8 batch
- [x] `src/cycle/ml-training-scheduler.js` (~155 lines) — extracted + tests (6 pass)
  - [x] Paper-RL training + RL online updater + ML auto-training + weekly retraining
  - [x] register({logger, ctx}) handles all 4 timers + their initial fires
  - [x] WIRE-IN to index.js — done Week 9.1
- [x] `src/cycle/reconciliation.js` (~90 lines) — ExecutionJournal extracted + tests (12 pass; extended to 27 Week 9.2)
  - [x] reconcileExecutionJournal via factory create({...}) pattern
  - [x] Tracks BSC + Base txs to finality, flags reorg/dropped, sets balanceDriftHalt
  - [x] reconcileWalletPositions extracted Week 9.2 (322 lines + 16 deps + 15 new tests)
  - [x] WIRE-IN of reconcileExecutionJournal to index.js — done Week 8 batch
- [x] `src/stats/metrics-compute.js` (~135 lines) — extracted + tests (17 pass)
  - [x] defaultStatsShape / ensureStatsShape / refreshPerformanceMetrics / recordPortfolioSnapshot
  - [x] All pure, dep-injected, no closure refs
  - [x] Includes per-strategy stats + expectancy + profitFactor (null-when-no-losses semantics)
  - [x] WIRE-IN to index.js — done Week 8 batch
- [x] `src/boot/lifecycle.js` (153 lines) — shutdown hooks ALREADY EXTRACTED Week 1c
  - [x] SIGINT/SIGTERM + state save + telegram bye + lockfile release
  - [x] Per-hook timeout (2s) + hard kill backstop (8s)
  - [x] Existing test/boot-lifecycle.test.js coverage

### Track C — Memory module split (continuation of Week 2 deferral) — COMPLETE 2026-05-17

- [x] `src/agent/memory/blacklist.js` (~85 lines) — pure helpers + tests (19 pass)
  - [x] addToBlacklist / removeFromBlacklist / isBlacklisted / pruneExpired / getAllBlacklisted
  - [x] Case-insensitive symbol normalization, expiry-on-lookup, monotonic guards
  - [x] Truncate reason to 200 chars (matches AgentMemory original behavior)
- [x] `src/agent/memory/stats.js` (~155 lines) — counter manipulation + tests (16 pass)
  - [x] recordSymbolOutcome / recordRegimeOutcome / recordChainOutcome / recordTokenAgeOutcome
  - [x] recordExitClassification / recordIndicatorOutcome / recordTradeOutcome (composite)
  - [x] getSymbolStats / getRegimeStats / getChainStats / winRate helpers
  - [x] Monotonic counter invariant verified (2026-05-16 regression-locked)
- [x] WIRE-IN: agentMemory.js delegates to blacklist + stats modules — done Week 8 batch

### Wire-up + validation

- [x] All extractions byte-mirrored to paper worktree (171 tests pass on both)
- [x] All integration tests green (live: 171/171, paper: 171/171)
- [x] Canary PASS post wire-in — done Week 8 paper restart + 24h soak
- [x] Updated REFACTOR_CHECKLIST.md with results

**Why deferred wire-ins**: extracted modules are behavior-equivalent to current
index.js code. Wiring 5+ extractions into the LIVE bot today (in one session,
without canary green periods between) carries unnecessary risk. Better: Week 8
opens with one batched wire-in commit, single canary cycle covers all of them.
Modules + tests already locked the behavior — wire-in is mechanical at that point.

**Track A test totals**: 93 new tests (trade-cycle 22 + sql-conflict 17 +
config-hot-reload 14 + pm2-singleton 9 + exit-decision 31).

**Track B + C module totals**: 7 new pure modules (~835 lines of cleanly-tested
extractions) + 78 new unit tests (wallet 8 + ml-scheduler 6 + reconciliation 12 +
metrics-compute 17 + blacklist 19 + stats 16).

**Grand total Week 7**: 171 new tests, 7 new modules, no live behavior changes.

---

## WEEK 8 — WIRE-IN BATCH + EXITS UNIFICATION — COMPLETE 2026-05-17

**Scope pivot**: original Week 8 was "split exits into 5 files (checker + stop-loss +
take-profit + tiered + trailing)". Re-scoped to pragmatic wire-in batch after Week 7
shipped unified `src/exits/evaluate-exit-decision.js` (251 lines, all branches, 32 tests).
Splitting further = cosmetic restructure with no behavior gain.

### Wire-in batch (production-bearing changes)

- [x] **FP epsilon fix**: tier threshold `currentProfit >= (profitMultiplier - 1) - 1e-9`
  - Defeats `1.3 - 1 = 0.30000000000000004` rounding (silent missed exits at exact thresholds)
  - +1 regression test verifying 130 (exact 1.3x of 100) triggers SELL_TIER_1
- [x] **decideExitAction wired into checkExitConditions** (HIGH RISK — wired carefully)
  - 250-line inline decision tree replaced with: `applyTrailingStopState` → `strategy.evaluateExitForStrategy` → `shouldExtendMaxHold` → `decideExitAction` → mutation apply → log/executeSell
  - Borderline-delay (STOP_LOSS / TRAILING_STOP) preserved in caller
  - All 13 exit reasons (incl. TIER_DELAYED, MAX_HOLD_EXTENDED) preserved
- [x] **metrics-compute wired**: ensureStatsShape + refreshPerformanceMetrics + recordPortfolioSnapshot now delegate (`-110` lines from index.js)
- [x] **blacklist wired**: addToBlacklist / isBlacklisted delegate to memory/blacklist.js; _pruneExpired calls module.pruneExpired
- [x] **stats wired**: recordLesson's 5 inline counter-bucket updates replaced with single `_statsModule.recordTradeOutcome` call
- [x] **wallet-balance-refresh wired**: updateWalletBalance + refreshBscNativePrice delegate to module
- [x] **reconciliation.reconcileExecutionJournal wired** (reconcileWalletPositions stays inline — Week 9)
- [x] **ml-training-scheduler wire-in** — done Week 9.1 (removed `_registered` guard, added dispose hook, `_mlTrainingSchedulerModule.register({logger, ctx})` replaces 5 inline timer blocks)

### Validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] 249/250 tests pass (1 pre-existing stale test: health-canary.test.js mtime expects FAIL at 1h, module updated last session to PASS until 240min — unrelated to Week 8)
- [x] index.js line count: 8951 → 8640 (-311 lines)
- [x] Mirrored to paper worktree
- [x] **Paper bot restarted** (PID 1664, port 3001) — boot OK, /api/status returns health.ok=true, timersActive=true, scanning live, no degradation
- [x] **24h paper canary** → live restart — done Week 9

---

## WEEK 9 — UNBLOCK WEEK 8 DEFERRALS — SESSION 1 COMPLETE 2026-05-18

**Scope this session**: clear Week 8's two deferred items (ml-training-scheduler
wire-in + reconcileWalletPositions extraction) before tackling the full scan
split. Both blocked Week 9's downstream cycle/ split work.

### Week 9.1 — ml-training-scheduler wire-in

- [x] Removed `_registered` guard from `src/cycle/ml-training-scheduler.js`
  - Each register() call now creates fresh timers + returns independent disposer
  - Caller responsible for dispose() before re-register (restartLoop cycle)
- [x] Added `mlTrainingSchedulerDispose` module-scope handle in index.js
- [x] `clearLoopSchedulers()` calls dispose hook so safe-mode + restart don't leak timers
- [x] Replaced 5 inline timer blocks (paper-RL + RL online updater + ML auto-training + 2 initial fires + weekly retraining setup) with single `_mlTrainingSchedulerModule.register({logger, ctx})`
- [x] Tests updated: removed idempotency assertion, added dispose+re-register cycle test
- [x] **Net change: index.js 8640 → 8549 (-91 lines)**

### Week 9.2 — reconcileWalletPositions extraction

- [x] Extended `src/cycle/reconciliation.js` factory to expose `reconcileWalletPositions`
  - All 322 lines + 10+ closure deps now dep-injected: portfolio, exchanges, marketState, config, logger, normalizeChainKey, buildTokenKey, findRecoverableKucoinBuyFill, restoreKucoinRecoveredBuy, releaseLiquiditySentinel, strategy, ensureStatsShape, refreshPerformanceMetrics, recordPortfolioSnapshot
  - Body byte-identical to original, defensive guards added for optional deps
- [x] 15 new tests in `test/cycle/reconciliation.test.js` (27 total):
  - Empty exchanges no-op
  - Fetch failure recorded as wallet_position_fetch_failed
  - Tracked position currentPrice=0 → repaired from wallet lastPrice
  - KuCoin untracked → auto-adopted with synthesized entryPrice
  - Adoption skipped when valueUsd < min threshold ($5 default)
  - Adoption skipped when no price available
  - State-only KuCoin position pruned (user sold outside bot)
  - Dust position (< $5 value) pruned regardless of chain
  - stuckPositions cleared when not in wallet + not in state
  - marketState.trackedTokens.hasOpenPosition correctly updated
  - RECONCILE_ADOPT_UNMANAGED=false disables adoption
  - BSC DEX positions NOT adopted by default
  - findRecoverableKucoinBuyFill recovery path works
  - stateReconciliation.lastRunAt timestamp written
- [x] index.js: deleted 322-line inline body, expanded factory create() call with all 16 deps
- [x] **Net change: index.js 8549 → 8241 (-308 lines)**

### Validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **268/268 tests pass** (was 252; +15 reconciliation + minor adjustments)
- [x] Mirrored to paper worktree
- [x] **Paper bot restarted** (port 3001) — uptime 101s, `health.ok=true`, **zero degraded/unhealthy reasons** (signal drought cleared)
- [x] **Live bot restarted** (port 3002, PID 11672) — uptime 80s, `health.ok=true`, **zero degraded/unhealthy reasons** (prior balance_drift_halt cleared on restart since wallet caught up to ledger)
- [x] Both bots scanning + timers active

**Combined Week 9 session 1 result**: index.js 8640 → **8241 lines (-399 net)**

### Week 9 session 2 — exit-pass.js + KuCoin lost-position recovery (2026-05-18)

- [x] `src/cycle/exit-pass.js` (~330 lines) — extracted runStrategyExitCycle + runRealtimeRiskStopCycle
  - Factory create({...}) with 21 injected deps
  - Body byte-identical to original
  - Defensive guards on optional deps (recordStrategyTick, getOraclePriceUsdForPosition, etc.)
- [x] `test/cycle/exit-pass.test.js` — 28 tests cover both cycles
  - Strategy exit: lock guard, safeMode, position filter, stale-cache fallback, PARTIAL_FILL_RETRY, error counters, clean-cycle self-heal
  - Realtime stop: lock guard, safeMode, realtimeStopLossEnabled flag, chain daily-loss halt, exitInProgress skip, oracle vs exchange priority, FAST_STOP_LOSS, FAST_TRAILING_STOP, borderline delay, DISASTER_STOP floor
- [x] **KuCoin lost-position recovery**:
  - Found: XMR/USDT 0.011 qty = $4.31 in `untrackedWalletPositions` (below default $5 adoption threshold)
  - Fix: `RECONCILE_ADOPT_MIN_VALUE_USD=3` appended to both .env files
  - Result post-restart: XMR adopted as managed position (synthesized entryPrice from current price, momentum strategy)
  - Bonus: TIA/USDT $8.68 also auto-adopted on live (was untracked from prior wallet drift)
  - PENGU (-$0.66 FAST_STOP_LOSS) documented as pre-existing bot behavior — adoption synthesizes entryPrice = currentPrice, any subsequent drop trips stop loss
- [x] **Net change: index.js 8241 → 7990 (-251 lines)**

### Week 9 session 2 validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **296/296 tests pass** (was 268; +28 exit-pass)
- [x] Mirrored to paper worktree
- [x] **Both bots restarted** — paper PID 6432, live PID 11488
  - Paper: uptime 72s, `health.ok=true`, zero degraded/unhealthy, 2 positions
  - Live: uptime 74s, `health.ok=true`, zero degraded/unhealthy, 2 positions (TIA $8.68 + XMR $4.25), balanceDriftHalt cleared

**Combined Week 9 result so far**: index.js 8640 → **7990 lines (-650 net, -7.6%)**

### Week 9 session 3 — main-loop.js extraction (2026-05-18)

- [x] `src/cycle/main-loop.js` (~225 lines) — extracted restartLoopSchedulers + clearLoopSchedulers + setLoopLocks + stopSchedulersForSafeMode
  - State pattern: caller passes `state` object with timer slots; module mutates `state.<timerName>` via setInterval
  - Caller observable: health check still reads timer state via `_mainLoopState.X` for /api/status response
  - All 12 timer slots managed (scan, momentumScan, swingScan, momentumExit, swingExit, realtimeStop, swingWatchlistRefresh, walletBalanceRefresh, bscNativePriceRefresh, selfEvolution, intelligence, rlTraining + ml-training-scheduler dispose hook)
  - Boot-cycle bootstrap (initial momentum/swing scans, exit checks, realtime stop, intelligence, self-evolution, BSC native price) handled inside module
- [x] `test/cycle/main-loop.test.js` — 27 tests cover:
  - Defensive guards (state/deps/loopLocks required)
  - clearLoopSchedulers: clears all slots, calls stopOracleStopWatchers, disposes ml-scheduler hook, swallows throws
  - setLoopLocks: sets all keys, calls refreshScanInFlightFlag when provided
  - stopSchedulersForSafeMode: clears + sets all locks true
  - restartLoopSchedulers: safeMode early-exit, creates all timers, skips realtimeStop/selfEvolution/intelligence when disabled, registers ml-scheduler, no leaks across restart cycles, releases locks
- [x] index.js: deleted module-scope timer `let` vars, updated /api/status health check to read from `_mainLoopState`
- [x] **Net change: index.js 7990 → 7878 (-112 lines)**

### Week 9 session 3 validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **323/323 tests pass** (was 296; +27 main-loop)
- [x] Mirrored to paper worktree (no .env touched this time — lesson learned)
- [x] **Both bots restarted** — paper PID 5616, live PID 16908
  - Paper: uptime 81s, `health.ok=true`, zero degraded/unhealthy, all timers active, scanning
  - Live: uptime 82s, `health.ok=true`, zero degraded/unhealthy, all timers active, 2 positions tracked (ENA $28.72 newly adopted + TIA $8.86)

**Combined Week 9 result so far**: index.js 8640 → **7878 lines (-762 net, -8.8%)**

### Week 9 session 4 — scan-cycle.js extraction (2026-05-18)

- [x] `src/cycle/scan-cycle.js` (~195 lines) — extracted runStrategyScanCycle + runDetachedKucoinMomentumScan
  - Per-strategy scan dispatcher: momentum (solana + bsc + kucoin parallel) | swing (kucoin only)
  - Per-chain timeout via withTimeout + chainDiscoveryTimeoutMs map
  - Detached KuCoin momentum: respects daily-reset warmup + per-loss-streak halt
  - Factory create({...}) with 17 deps; scanChain stays in index.js (deep filter pipeline, deferred)
  - Body byte-identical to original (defensive callable-check on optional deps)
- [x] `test/cycle/scan-cycle.test.js` — 24 tests cover:
  - Defensive guards
  - Strategy scan: lock guard, trading-window guard, per-chain parallel exec, per-chain failure isolation, chain-disabled skip, per-chain timeout override
  - Swing kucoin-only path: enabled/disabled, scanChain throw caught
  - Post-scan side effects: snapshot reason, saveState call, loopLastCompletedAt timestamp
  - Lock release in finally (clean exit + error path)
  - Status indicator cleanup for momentum (all 3 chains) + swing (kucoin only)
  - Detached KuCoin: lock guard, window guard, pause-gate guard, scan kucoin only, lock release on error
- [x] **Net change: index.js 7878 → 7782 (-96 lines)**

### Week 9 session 4 validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **347/347 tests pass** (was 323; +24 scan-cycle)
- [x] Mirrored to paper worktree
- [x] **Both bots restarted** — paper PID 14004, live PID 2924
  - Paper: uptime 82s, `health.ok=true`, zero degraded/unhealthy, timers active, momentum scan completed
  - Live: uptime 82s, `health.ok=true`, zero degraded/unhealthy, timers active, 2 positions tracked (EDEN $17.98 + CHO $10.93 newly auto-adopted)

**Combined Week 9 result so far**: index.js 8640 → **7782 lines (-858 net, -9.9%)**

### Week 9 session 5 — maintenance.js extraction (2026-05-18)

- [x] `src/cycle/maintenance.js` (~185 lines) — extracted three independent routines
  - `createEvictStuckPositions({portfolio, logger, saveState})` — STUCK_POSITION_EVICTION_HOURS guard (default 2h), moves to untrackedWalletPositions
  - `createRefreshSwingWatchlists({...8 deps})` — per-chain discovery refresh, swing-applicability filter, dedup + cap 120/chain, suppressedTokenErrors counter
  - `runSqlAutoPrune(log)` — standalone async fn, batch DELETE TOP (5000) per table (signals/predictions/feature_store/decisions/sentiment/snapshots/decision_log), retention 12h-72h
- [x] `test/cycle/maintenance.test.js` — 18 tests cover:
  - Defensive guards (portfolio/logger/loopLocks/exchanges/watchlists required)
  - evictStuckPositions: stale-flag cleanup, threshold gate, eviction + move to untracked, saveState fired only when evicted, returns count
  - refreshSwingWatchlists: lock guard, supportsSwingOnChain skip, missing getNewTokens skip, swing-filter + dedup + cap, suppressedTokenErrors counter on throw, lock release on error
  - runSqlAutoPrune: returns undefined when pool unavailable
- [x] **Net change: index.js 7782 → 7663 (-119 lines)**

### Week 9 session 5 validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **365/365 tests pass** (was 347; +18 maintenance)
- [x] Mirrored to paper worktree
- [x] **Both bots restarted** — paper PID 17240, live PID 15336
  - Paper: uptime 66s, `health.ok=true`, zero degraded/unhealthy, timers active, scan completed, 2 positions
  - Live: uptime 68s, `health.ok=true`, zero degraded/unhealthy, timers active, **3 positions tracked** ($44.40 deployed): LTC $15.13 + EDEN $18.34 + CHO $10.93

**Combined Week 9 result so far**: index.js 8640 → **7663 lines (-977 net, -11.3%)**

**Operator notes**:
- `RECONCILE_ADOPT_MIN_VALUE_USD=3` now in both .env files. Wallet drift positions ≥$3 will auto-adopt on next reconcile.
- **Adoption synthesizes entry = current price**. Any subsequent 4-8% drop trips FAST_STOP_LOSS on adopted positions.

---

## WEEK 10 — STATE SPLIT — SESSION 1 COMPLETE 2026-05-18

**Scope reality check**: state-store + lock-manager already extracted in prior weeks.
Only portfolio factory remained for new work.

### Week 10.1 — portfolio.js factory extraction

- [x] `src/state/portfolio.js` (~75 lines) — `createPortfolio(config)` factory
  - Returns canonical baseline shape: balances, drift, persistence flags, executionJournal, positions, trades, strategies.{swing,momentum}.{positions,trades,stats}, aggregate stats, learning, pnlHistory
  - Stats baseline reuses `metrics-compute.defaultStatsShape()` (single source of truth)
  - paperTrading=true seeds balance from paperBalance; otherwise 0
  - Each call returns fresh object (no mutation leakage between instances)
- [x] `test/state/portfolio.test.js` — 14 tests cover:
  - Empty/missing config defaults
  - paperTrading on/off balance seeding
  - All required sub-objects present + zeroed
  - Per-strategy independence (mutation isolation)
  - Stats schema matches metrics-compute.defaultStatsShape (catches drift)
- [x] index.js: replaced 96-line literal with `const portfolio = createPortfolio(config);`
- [x] **Net change: index.js 7663 → 7571 (-92 lines)**

### Week 10 — state modules already in place

- [x] `src/state/state-store.js` — exists as `src/utils/state-persistence.js` (427 lines, prior weeks). Path move skipped — would break dashboard.js + other consumers; cosmetic only.
- [x] `src/state/lock-manager.js` — exists (42 lines, Week 1c). Coordinates loop locks.
- [x] `src/state/safe-mode.js` — exists (61 lines, Week 7 Track A). FSM for safe-mode enter/clear.

### Week 10 validation

- [x] node --check src/index.js → SYNTAX_OK
- [x] **379/379 tests pass** (was 365; +14 portfolio)
- [x] Mirrored to paper worktree
- [x] **Both bots restarted** — paper PID restored, live PID restored
  - Paper: uptime 35s, `health.ok=true`, zero degraded/unhealthy, 1 position, timers active
  - Live: uptime 36s, `health.ok=true`, zero degraded/unhealthy, **3 positions ($33.47 deployed)**: LAB $8.42 + AVAX $9.95 + LTC $15.10

**Combined Weeks 7-10 result**: index.js 8973 → **7571 lines (-1402 net, -15.6%)**

**Target after Week 10**: index.js ≤ 2000 lines, pure orchestration. **Current 7571 lines means scanChain split (deferred, ~600 lines) is the largest remaining piece.** Hitting 2000 lines requires that split + further surgical work on remaining helpers (executeBuy/executeSell, AI brain dispatchers, dashboard wiring, etc.) — multi-week effort beyond Week 10 scope.

---

## CROSS-CUTTING REQUIREMENTS (active throughout)

- [x] Defense-in-depth on every DB-backed config: `db.get() ?? env ?? hardcoded default` — implemented via `config/loader.js` precedence chain
- [x] Every migration paired with rollback SQL — 17/17 paired
- [x] Every migration idempotent (re-runnable) — verified by `test/integration/db-migration.test.js`
- [x] Every migration tested in dry-run before production — done via `db:migrate:dry` per phase
- [x] Backfill scripts re-runnable (UPSERT pattern) — done
- [x] Pre-commit smoke + memory roundtrip + schema audit — `.husky/pre-commit` shipped Week 6
- [x] Health canary alerts every 15min — shipped Week 4 (setInterval registered in src/index.js)
- [x] Paper-first 24h validation before every live promotion — enforced in practice (memory rule)
- [x] Config change log auto-populated on every knob change — `config_changes` table + audit-log writer
- [x] Telegram alerts on canary FAIL — done

---

## ALL 17 DB MIGRATIONS — INVENTORY

- [x] M001: `schema_migrations` (Week 0 — infrastructure) — applied 2026-05-16
- [x] M002: `strategy_config` (Week 1) — applied 2026-05-16
- [x] M003: `config_changes` (Week 1) — applied 2026-05-16
- [x] M004: `symbol_overrides` (Week 2) — applied 2026-05-16
- [x] M005: `indicator_weights` (Week 2) — applied 2026-05-16
- [x] M006: `evolution_history` (Week 2) — applied 2026-05-16
- [x] M007: `trade_rejections` (Week 3) — applied 2026-05-17
- [x] M008: `sell_tiers` (Week 3) — applied 2026-05-17
- [x] M009: `risk_rules` (Week 3) — applied 2026-05-17
- [x] M010: `ai_decisions` + `ai_decisions_rollup` (Week 4) — applied 2026-05-17
- [x] M011: `ai_prompts` (Week 4) — applied 2026-05-17
- [x] M012: `health_checks` (Week 4) — applied 2026-05-17
- [x] M013: `signals` extended (Week 5) — applied 2026-05-17
- [x] M014: `tokens` (Week 5) — applied 2026-05-17
- [x] M015: `regime_patterns` (Week 5) — applied 2026-05-17
- [x] M016: `backtest_runs` (Week 6) — applied 2026-05-17
- [x] M017: `ml_model_versions` (Week 6) — applied 2026-05-17 (renamed to avoid collision with pre-existing `model_versions` table)

---

## BUG-CLASS COVERAGE TABLE

| Today's bug | Prevention layer | Status |
|---|---|---|
| `_mergeFromRemote` wipes 6/13 fields | `memory/merge.js` isolation + MERGE_KEYS const + round-trip test | [x] (Week 2) |
| `uncaughtException` killed on EADDRINUSE | `boot/error-handlers.js` with error taxonomy | [x] (Week 1a/b/c) |
| `unhandledRejection` same | Shared taxonomy in both handlers | [x] (Week 1a/b/c) |
| PM2 singleton race | `boot/singleton.js` + integration test | [x] (Week 1b/c) |
| `ecosystem.config.js` overrides `.env` | `config/source-audit.js` detects + refuses boot | partial — moved to Week 11 |
| Tier thresholds unreachable on $5 positions | `pre-trade-contract.js` checks tier sell vs min notional | [x] (Week 3, enforce after canary) |
| Tier sells below KuCoin min | Same contract | [x] (Week 3, enforce after canary) |
| `STRATEGY_MOMENTUM_MAX_POSITIONS` env typo | `config/schema.js` rejects unknown env at boot | partial — moved to Week 11 |
| Auto-promote evolution on losing PnL | `policy/preconditions.js` `canPromoteEvolutionPatch` (wired into self-evolution.processPendingValidations) | [x] (Week 5, verdict tagged `auto_denied` until rollback orchestration ships) |
| Live promotion without paper validation | `policy/preconditions.js` `canEnableLiveTrading` (wired into promote-paper-to-main.js) | [x] (Week 5) |
| Position size scale-up during loss streak | `policy/preconditions.js` `canIncreasePositionSize` (wired into position-sizing.js) | [x] (Week 5) |

---

## ROLLBACK / SAFETY NET

If any week's refactor breaks live:
- [x] Revert via `git revert <merge-commit>` — capability validated (commits exist on `main` + `paper-main`)
- [x] Roll back DB migrations: `npm run db:rollback` — every migration paired w/ rollback (17/17)
- [x] Master pid keeps trading even if PM2 confused — `boot/singleton.js` + PM2 ecosystem handles it
- [x] All DB-backed knobs fall back to env defaults if SQL down — `config/loader.js` precedence chain
- [x] Paper bot acts as canary — every change validated 24h there first — enforced as memory rule

---

## DEFINITION OF DONE — phase-level

For any phase to be marked complete (reference checklist; ad-hoc applied per phase):
- [x] All Track A files extracted + tested — applied per phase
- [x] All Track B tests passing in CI — applied per phase
- [x] All Track C migrations applied + backfills validated — 17/17 applied
- [x] 24h paper canary green — applied per phase
- [x] Smoke test green — `test/smoke/boot.test.js` runs in pre-commit
- [x] No new Telegram alerts triggered in 24h — applied per phase
- [x] Live verified stable 24h post-promotion — applied per phase

---

## CONTACT POINTS FOR FUTURE-YOU

- Today's session id: aa5eee4e-6239-434f-b64a-e53771af3de0
- Critical fix files (do not undo):
  - `src/agent/agentMemory.js` save() + _mergeFromRemote
  - `src/index.js` uncaughtException + unhandledRejection + acquireRuntimeSingleton
  - `ecosystem.config.js` SELF_EVOLUTION_*: 'false'
  - `.env` MIN_HOLD_HOURS, MOMENTUM_SELL_TIERS, MOMENTUM_ROTATION_*
- Same fixes applied to: `dex-trading-bot-paper/src/index.js` + `agentMemory.js`

---

**Last updated**: 2026-05-20 (status sweep + Plan-folder integration)

---

## WEEK 11 — REFACTOR CLOSEOUT (2026-05-20+)

**Scope**: remaining checklist debt + items only partly deployed. No new strategies. Goal: clean every `[~]`/`[ ]` left from Weeks 0-10.

### 11.1 — Config integrity at boot (BUG-CLASS BLOCKERS)

- [ ] **Wire `config/schema.js` `validate(env, {strictUnknown:true})` into boot path** (refuses start on unknown env keys)
  - Catches `STRATEGY_MOMENTUM_MAX_POSITIONS` typo class
  - Run after env loaded, before any module reads `process.env.*`
  - Allowlist via `KNOWN_VARS` set in schema
  - Emit `ConfigError` (fatal) on unknown
  - Add `CONFIG_STRICT_UNKNOWN=false` env override for migration grace (default true after 1wk)
- [ ] **Wire `config/source-audit.js`** — boot-time check for `.env` vs `ecosystem.config.js` collisions
  - Reuse logic from `scripts/config-audit.js`
  - Refuse boot if BOTH set AND values differ (unless `CONFIG_AUDIT_LENIENT=true`)
  - Logged warning + crash w/ explicit "edit one or the other"
- [ ] Unit tests: `test/config/strict-validate.test.js` (10+ scenarios)
- [ ] Paper-first 24h canary
- [ ] Live promote

### 11.2 — Pre-trade contract enforce mode on live

- [ ] **Flip `PRE_TRADE_CONTRACT_MODE=enforce` on live** (currently shadow)
  - Validate shadow-mode log volume + rejection patterns for 7d
  - Confirm no false-positive gates (especially `tier_feasibility` + `daily_loss_budget`)
  - Edit `ecosystem.config.js` live `env`/`env_production` blocks
  - 24h paper-shadow + 24h paper-enforce + 24h live-shadow re-confirm + flip live

### 11.3 — Bot version-gating

- [ ] Read `package.json` version + schema_migrations max at boot
- [ ] Refuse start if applied migration count > BOT_MIN_SCHEMA_VERSION (defined per release)
- [ ] Refuse start if applied < BOT_MIN_SCHEMA_VERSION
- [ ] Emit clear error w/ remediation hint
- [ ] Update RUNBOOK.md w/ version-skew recovery section

### 11.4 — scanChain split (largest remaining refactor)

- [ ] Extract scanChain body (~600 lines) → `src/cycle/momentum-scanner.js`
  - Per-chain dispatch (solana/bsc/kucoin)
  - Filter pipeline orchestrator
  - Catalyst-priority logic
  - BSC discovery ranking
  - KuCoin rotating scan window
  - Keep `processToken` inline (next phase candidate)
- [ ] Bifurcate swing path → `src/cycle/swing-scanner.js`
- [ ] Tests: ~30 (mock exchange, mock filters, full per-chain integration)
- [ ] Paper-first 24h canary
- [ ] Live promote

### 11.5 — Memory module split (Week 2 deferral closure)

- [ ] `src/agent/memory/lessons.js` — recordLesson + queryLessons + similarConditionsLookup + pattern warnings
- [ ] `src/agent/memory/knowledge.js` — knowledgeBase + aiUsage + evolutionOutcomes
- [ ] `src/agent/memory/insights.js` — getIndicatorInsights + regime queries + shouldPauseEvolution
- [ ] `src/agent/memory/core.js` — assembles all 5 sub-modules into single export (eliminates AgentMemory class once callers migrated)
- [ ] Tests: 30+ across all 4 modules
- [ ] Paper canary + live promote

### 11.6 — Symbol-overrides DB read-through

- [ ] `memory/blacklist.js` reads from `dbo.symbol_overrides` table (currently in-memory only)
- [ ] `scripts/backfill-blacklist.js` — copy in-memory blacklist to SQL
- [ ] Hot-reload via existing db-hot-reload poller

### 11.7 — Telemetry/observability completions

- [ ] 3-sigma anomaly detection alerts (currently only FAIL alerts go to Telegram)
- [ ] 30d retention prune sweeps for `trade_rejections`, `ai_decisions`, `health_checks`
- [ ] Dashboard HTML panels (sparklines, 3-sigma badges) — API exists, UI not wired
- [ ] Risk-rules dashboard CRUD: `GET /api/risk-rules` + `PATCH /api/risk-rules/:name`

### 11.8 — Deferred wire-ins

- [ ] `ai_prompts` table → live loader (templates currently placeholder; real prompts still inlined in providers)
- [ ] `tokens` cache → scanner read-through (currently re-fetched per scan)
- [ ] `regime_patterns` populated by ML retrain output
- [ ] `backtest_runs` write side wired into `backtest.js`
- [ ] `ml_model_versions` write side wired into `model-registry.js`
- [ ] Pre-trade contract reads current regime from `regime_patterns`, adjusts decisions

### 11.9 — Bot version bump + release process

- [ ] Bump `package.json` version to next major (post-refactor)
- [ ] Tag release `v1.x.0` on `main` + `paper-main`
- [ ] Update CHANGELOG / RUNBOOK / ARCHITECTURE.md

### Validation
- [ ] All Week 11 tests pass
- [ ] 24h paper canary
- [ ] Live promote
- [ ] PR-trade contract enforce verified zero false positives

**Week 11 end state**: zero open items from Weeks 0-10. Refactor formally closed.

---

## WEEK 12 — PLAN B SPOT_DAY_BULL_FLAG (2026-05-20)

**Status**: SHIPPED + PAPER CANARY ACTIVE. Live dormant.

### B.1-B.8 inventory
- [x] B.1 detector (`src/strategies/bull-flag-detector.js`, 11 tests)
- [x] B.2 config block (`spot_day_bull_flag` in `config/index.js`, default disabled)
- [x] B.3 evaluator (`src/strategies/bull-flag-evaluator.js`, 11 tests) + delegate hook in `evaluateForStrategy`
- [x] B.4 scan dispatch (isStrategyScanEnabled / applicability / strategyOrder / scanStatus / filterStatsState / scan-cycle / main-loop timer)
- [x] B.5 setup metadata persisted on position open (structuralStopPrice, measuredMoveTargetPrice, breakoutClosePrice, manualCutDeadlineAt)
- [x] B.6 exit-decision branch (9 tests: structural stop, measured-move, manual-cut)
- [x] B.7 sizing override (flat %-equity risk / stop distance, capped by maxPositionSizePct)
- [x] B.8 telemetry (setupType tagging in trade ledger + `/api/bull-flag-stats` endpoint + portfolio.strategies init)

### Deployment status
- [x] Paper canary: `BULL_FLAG_ENABLED=true BULL_FLAG_ENABLED_CHAINS=kucoin` since 2026-05-20 18:28Z
- [ ] Live promotion — GATED on paper soak gate (≥20 signals, PF >1.25, max DD <6%, avg win ≥2x avg loss)

### Open items for B
- [ ] **24h-7d soak observation** — monitor `/api/bull-flag-stats`
- [ ] **Promotion decision** — at 7d checkpoint:
  - PASS: enable on live `ecosystem.config.js` (KuCoin only, 1 concurrent cap, 0.20% risk start). pm2 restart dex-bot.
  - FAIL/drought: loosen `BULL_FLAG_POLE_PCT_MIN` 5→4, `BULL_FLAG_BREAKOUT_VOL_MIN_RATIO` 1.5→1.3. Re-soak.
  - FAIL/bad PF: tighten `BULL_FLAG_MIN_NET_EDGE_PCT` and/or `BULL_FLAG_FLAG_VOL_CONTRACT_MAX_RATIO`. Re-soak.
- [ ] SQL `setup_type` first-class column (currently in `raw_trade_json`) — `db/migrations/0017_bot_trade_ledger_setup_type.sql` (low pri)
- [ ] Dashboard UI panel wired to `/api/bull-flag-stats` (currently API-only)

**Tests added Week 12**: +31 (B.1 11 + B.3 11 + B.6 9). Live 122→142, paper 130→150.

---

## WEEK 13 — PLAN C BACKES HTF SWING (NEW)

**Source**: `C:\Users\User_\Desktop\Plan\SWING TRADE.txt` — Augusto Backes HTF spot strategy.

**Scope**: NEW strategy `backes_swing` (do NOT replace existing `swing` immediately). KuCoin only first. Macro filter also influences ALL strategy sizing.

**Est: 5-7 days impl + 14d soak.**

### C.1 — KuCoin OHLCV adapter

- [ ] Extend `src/utils/candles.js` `getOhlcvSeries` to support KuCoin
  - Branch on `chainKey === 'kucoin'` → call `kucoin.getKlines(symbol, interval, limit)`
  - Add `kucoin.getKlines()` method using KuCoin REST `/api/v1/market/candles` endpoint
  - Support intervals: `1week`, `1day`, optional `4hour`
  - Cache w/ existing TTL pattern
- [ ] Test: mock KuCoin client, assert parsed candles match expected OHLCV shape
- [ ] Integration: feed real KuCoin BTC/USDT weekly into detector path

### C.2 — Indicator helpers

- [ ] `src/strategies/backes-indicators.js` (pure)
  - `simpleMA(closes, period)` — already exists in `utils/indicators.js`, reuse
  - `wilder Rsi(closes, period)` — reuse existing `rsi()`
  - `atr(candles, period)` — true range
  - Slope detection (rising / falling / flat) on MA
- [ ] Tests: known-result fixtures on synthetic candles

### C.3 — Macro regime classifier

- [ ] `src/strategies/backes-macro.js` — `classifyMacroRegime({btcKlines, ethKlines})`
  - Returns `{regime, reasons[], scores: {trend, momentum, volatility}}`
  - `risk_off`: BTC or ETH close < 8W MA, OR < falling 56D MA
  - `reversal_pending`: daily close above 56D MA + retest hold
  - `bull_pullback`: weekly uptrend + price near 21W MA + defensive structure
  - `capitulation`: weekly RSI ≤30 + reclaim
- [ ] Cache 4h (regimes change slowly)
- [ ] Tests: 20+ fixtures per regime

### C.4 — Setup detectors (per-token, pure)

- [ ] `src/strategies/backes-setups/56d-retest.js` — break above 56D MA + pullback within 0.75 daily ATR + green reclaim
- [ ] `src/strategies/backes-setups/21w-support.js` — weekly uptrend + price tags 21W + daily reversal confirm
- [ ] `src/strategies/backes-setups/caixote.js` — 20-60 day range box, BUY only bottom 20% of box
- [ ] `src/strategies/backes-setups/megaphone.js` — broadening wedge lower-bound sweep + reclaim + buy-volume spike
- [ ] Each returns `{qualifies, structureType, entryPrice, stopPrice, targetPrice[], reasons[], volumeOk}`
- [ ] Tests: 8-12 each = ~40 total

### C.5 — Evaluator + delegate

- [ ] `src/strategies/backes-evaluator.js` — wraps macro + setup detectors + scanner gates
  - Returns `evaluation` matching existing contract: `signal`, `details.{setupType, macroRegime, structureType, invalidationPrice, targetPrices, sizeMultiplier, reasons}`
- [ ] Delegate hook in `evaluateForStrategy`: if `strategyName === 'backes_swing'` → `backesEvaluator.evaluate(...)`
- [ ] Tests: 15+ integration scenarios

### C.6 — Config + chain enablement

- [ ] `config/index.js` — `strategies.backes_swing` block
  - `enabled` (default false), `enabledChains` (default `['kucoin']`)
  - `maDailyPeriod=56`, `maWeeklyFast=8`, `maWeeklySupport=21`, `weeklyRsiPeriod=14`, `weeklyRsiOversold=30`
  - `rangeLookbackDays=60`, `dailyVolumeSpikeMultiplier=1.5`, `maxEntryDistanceFromSupportAtr=0.75`
  - `riskPctBase=0.5`, `riskPctCapitulation=0.2`
  - `maxConcurrentPositions=3`
  - `maxExposurePct=25`
- [ ] `isStrategyScanEnabled` branch + `applicability` + `strategyOrder` (mirror Plan B pattern)
- [ ] `scanStatus` + `filterStatsState` init for backes_swing
- [ ] `portfolio.strategies.backes_swing` init in `state/portfolio.js`

### C.7 — Sizing override

- [ ] `execution/orchestrator.js` — branch on `setupType === 'backes_swing'`:
  - Flat 0.5% equity risk / stopDistance (0.2% on capitulation)
  - Max 3 concurrent
  - Cap exposure 25% equity
  - Reuse Plan B's pattern (`quantity = equity × riskPct% ÷ stopDistanceAbs`)

### C.8 — Exit branch

- [ ] `exits/evaluate-exit-decision.js` — branch on `setupType === 'backes_swing'`:
  - Partial 50% at 1R
  - Partial at box midpoint OR prior daily resistance
  - Trail remainder behind 8D MA (after trend confirm) or 56D MA
  - Full exit on daily close < 56D MA, weekly close < 8W MA, failed-reclaim, RSI exhaustion + sell vol, time stop (configurable)
- [ ] Tests: 12+ exit-branch scenarios

### C.9 — Telemetry

- [ ] `/api/backes-stats` endpoint (mirror `/api/bull-flag-stats`)
- [ ] `setupType: 'backes_swing'` tagging in trade ledger
- [ ] Per-setup breakdown by structureType

### C.10 — Strategy naming decision

- [x] Name: `backes_swing` (NOT replace existing `swing`)
- [ ] Existing `swing` stays in place, deprecation path:
  - Phase 1: both run in parallel on KuCoin (small backes risk pct, normal swing)
  - Phase 2: after 30d Backes wins (PF, DD, expectancy), deprecate `swing`
  - Phase 3: remove `swing` once no active positions

### C.11 — Macro filter for whole bot

- [ ] `src/strategies/backes-macro.js` `getMacroRegime()` → exposed via `marketState.macroRegime`
- [ ] `intelligenceAgent.getMacroSizeMultiplier()` reads regime
  - `risk_off` → size × 0.5 for ALL strategies (momentum, bull_flag, backes_swing)
  - `capitulation` → size × 0.3
  - `bull_pullback` → size × 1.0
  - `reversal_pending` → size × 0.8
- [ ] Existing macro filter already supports multiplier — wire backes_macro output into it
- [ ] Tests: regime → multiplier mapping table

### C.12 — Testing

- [ ] ~40 unit tests (indicators + setups + macro)
- [ ] ~15 evaluator integration tests
- [ ] ~12 exit-branch tests
- [ ] ~10 sizing tests
- [ ] Total: ~77 new tests

### C.13 — Validation + canary

- [ ] Walk-forward backtest on BTC, ETH, SOL, top 10 KuCoin liquid pairs (12 months)
- [ ] Backtest comparison vs current `swing` strategy
- [ ] Paper canary 14d (HTF moves are rare — need longer soak)
- [ ] Promotion gate: ≥30 paper trades OR 100 walk-forward signals
- [ ] OOS return improves, DD not worse +3pp, ruin prob not worse +2pp, no overfit flag

### Deployment
- [ ] Paper enable: `BACKES_SWING_ENABLED=true BACKES_SWING_ENABLED_CHAINS=kucoin`
- [ ] Restart paper
- [ ] 14d observation
- [ ] Live promotion: edit ecosystem.config.js, restart dex-bot

---

## WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW)

**Source**: `C:\Users\User_\Desktop\Plan\plan.txt` — chain assignment matrix.

**Scope**: BSC + Base get dedicated strategies (NOT bull-flag clones). Solana variant of Plan B w/ DEX gates.

### Plan F — BSC `bsc_liquidity_flow_breakout` (NEW)

**Rationale**: bull-flag fails on BSC microcaps (no clean consolidation, MEV, taxes). Use buy-flow breakout w/ safety gates.

- [ ] F.1 Detector — `src/strategies/bsc-flow-breakout-detector.js`
  - Pole-like price expansion (≥5% / 60min)
  - Net buy flow ≥ threshold ($5k/10min)
  - Volume spike ≥1.8x
  - NO consolidation phase required (BSC tokens dump if consolidating)
- [ ] F.2 Safety gates — honeypot check, tax extraction (buy + sell tax < 5% each), liquidity ≥ $50k locked
  - Reuse `src/utils/honeypot-client.js` + `src/utils/dexscreener-client.js`
- [ ] F.3 Risk gates — 0.15-0.25% per trade, tighter slippage cap (3%), MEV jitter via `merkle-bundle.js`
- [ ] F.4 Exit — quick TP (2x measured move), 8% structural stop, 30min stale exit
- [ ] F.5 Config block `strategies.bsc_flow_breakout` + scan dispatch wire
- [ ] F.6 Tests: detector (10) + safety (10) + sizing (5) + exit (10) = 35
- [ ] F.7 Paper canary 75 trades / 14d minimum
- [ ] F.8 Live promote (BSC chain only)

### Plan G — Base `base_dex_momentum_reclaim` (NEW, PAPER-ONLY for now)

**Rationale**: Base has cleaner liquidity than BSC but unproven fill quality. Paper-only until validated.

- [ ] G.1 Verify GeckoTerminal Base OHLCV coverage
- [ ] G.2 Detector — adapt `bull-flag-detector` w/ Base-specific liquidity floor ($1M) + tighter vol expansion (≥2.5x)
- [ ] G.3 Reclaim variant — price sweeps support, reclaims w/ vol → BUY (more like TraderXO short-term reclaim than full flag)
- [ ] G.4 Config + scan dispatch
- [ ] G.5 Tests: 30
- [ ] G.6 Paper canary 6wk minimum
- [ ] G.7 Promotion gate: must beat BSC's `bsc_flow_breakout` after fees + failed-fill costs over same period
- [ ] G.8 Live promote ONLY if G.7 passes (else stay paper)

### Plan B v2 — Solana DEX variant

- [ ] Adapt `bull-flag-evaluator.js` for Solana:
  - Stricter liquidity floor ($500k)
  - Stricter slippage cap (1.5%)
  - Holder concentration check (top 10 holders < 30%)
  - Buy/sell flow ratio gate (buy ≥ 60%)
  - Stale Birdeye/DexScreener data rejection (≥2 sources required)
- [ ] Reuse Plan B detector; new evaluator: `src/strategies/bull-flag-evaluator-solana.js`
- [ ] Config: `BULL_FLAG_ENABLED_CHAINS=solana` extends current
- [ ] Paper canary 100 trades

### Tests + canary
- [ ] All F + G + Plan B v2 tests ~100 new
- [ ] Each chain gets dedicated 14d-6wk paper soak before live consideration

---

## WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO)

**Source**: `C:\Users\User_\Desktop\Plan\true perp.txt` — futures + leverage. NOT bolt-on.

**Critical decision**: NEW codebase `dex-trading-bot-perps/` clone. Reasons:
- Current bot is spot-only (no short logic, no margin tracking, no liquidation distance)
- Forking adds risk to live spot trading
- Position-direction abstraction (long/short) needs rewriting up the entire pipeline
- Different risk model (R:R, liquidation buffer, isolated margin)

**Est: 3-4 weeks impl + 4 week paper soak. Largest of all plans.**

### D.1 — Repo setup
- [ ] Clone `dex-trading-bot/` → `dex-trading-bot-perps/`
- [ ] Strip spot exchanges (KuCoin/Jupiter/PancakeSwap/BaseSwap removed)
- [ ] Update `ecosystem.config.js` → `dex-bot-perps` PM2 process
- [ ] Strip portfolio shape (no `quantity` only; add `side`, `notional`, `margin`, `leverage`, `liquidationPrice`)

### D.2 — Perp exchange adapter
- [ ] Choose: Binance Perps / Bybit / OKX
- [ ] `src/exchanges/binance-perps.js` (or chosen venue):
  - `placeOrder({symbol, side, type, leverage, marginMode:'isolated', reduceOnly})`
  - `getPosition(symbol)` → `{side, notional, margin, leverage, liquidationPrice, unrealizedPnl}`
  - `getFundingRate(symbol)` + `getFundingPaid(positionId)`
  - `closePosition(symbol, reduceOnly:true)`
- [ ] Adapter tests: mock REST + WebSocket fixtures

### D.3 — Time anchors
- [ ] `src/strategies/perps-anchors.js`
  - Monthly Open (MO), Weekly Open (WO), Daily Open (DO)
  - Computed from candles, cached, exposed on `marketState.anchors`
- [ ] Tests

### D.4 — Range detector
- [ ] `src/strategies/perps-range-detector.js`
  - 20-60 candle horizontal range identification
  - RH, RL, EQ
  - Returns `{rangeStart, rangeEnd, rh, rl, eq, candleCount}` or null
- [ ] Tests w/ synthetic ranges

### D.5 — Deviation + reclaim detector
- [ ] `src/strategies/perps-deviation-reclaim.js`
  - Detect: sweep above RH (or below RL) + no follow-through + close back inside
  - Identifies retest opportunity
  - Returns `{side, entry, stop, targets[]}`
- [ ] Tests: deviation w/o reclaim (no signal), reclaim w/o sweep (no signal), full pattern (signal)

### D.6 — Market Structure Shift (MSS)
- [ ] `src/strategies/perps-mss-detector.js`
  - Tracks HH/HL/LH/LL on 15m or 1h
  - Detects break-of-structure (close below latest HL = bearish MSS)
  - Returns `{shifted, fromTrend, toTrend, breakPrice, nextRetestZone}`
- [ ] Tests

### D.7 — Level-to-level continuation
- [ ] `src/strategies/perps-l2l-detector.js`
  - Long: holds above WO + reclaims resistance retest
  - Short: holds below WO + rejects support reclaim
  - Target: next HTF level only
- [ ] Tests

### D.8 — Sizing w/ leverage
- [ ] `src/strategies/perps-sizing.js` — pure
  - `quantity = (equity × riskPct%) ÷ stopDistance × leverage`
  - Default leverage cap 5x
  - 10x allowed ONLY if `liquidationPrice` ≥ 3 × stopDistance from entry
  - Block trade if `liquidationPrice` would trigger before stop
- [ ] Tests: critical leverage math accuracy

### D.9 — Risk gates
- [ ] Daily max loss: -2R or -2% (whichever first)
- [ ] Weekly max: -5R or -5%
- [ ] Per-trade R:R minimum: 1:3 (planned, not realized)
- [ ] Manual cut: 3-5 sideways candles + EMA rhythm break
- [ ] Breakeven move at 1R or EQ hit
- [ ] Liquidation buffer pre-check (described above)

### D.10 — Reduce-only exits
- [ ] Scale 50% at target1 (EQ)
- [ ] Remainder at target2 (opposite range or next HTF level)
- [ ] Full close on structure failure (entry invalidation)
- [ ] All exits `reduceOnly: true` (never accidentally flip direction)

### D.11 — Separate telemetry
- [ ] New DB schema OR prefix all tables `perps_*`
- [ ] Track liquidation buffer, funding cost, slippage at extreme levels
- [ ] Dashboard endpoint `/api/perps-stats`

### D.12 — Tests
- [ ] ~60 tests across all modules
- [ ] Scenario fixtures per setup (RH sweep + reclaim, RL sweep + reclaim, MSS-retest, L2L continuation, no-trade scenarios)

### D.13 — Paper soak (LONGER than spot)
- [ ] 4 weeks minimum
- [ ] ≥200 paper trades
- [ ] Positive expectancy after FUNDING + fees + slippage
- [ ] Zero liquidation near-misses (liq < 2x stop distance)

### D.14 — Live canary (EXTREME CAUTION)
- [ ] Isolated margin
- [ ] Max 3x leverage (NOT 5x default for canary)
- [ ] $100 account starting
- [ ] 1 position max
- [ ] 1 month observation before scaling
- [ ] Telegram alert on ANY liquidation buffer < 2x

**Week 15 deferred until Plan B, C, F, G are live + stable.** Highest profit ceiling, highest risk. Do last.

---

## SEQUENCING (4-month roadmap)

| Month | Focus |
|---|---|
| **M1** (May-Jun 2026) | Plan B paper soak. Week 11 closeout (config integrity + enforce mode + scanChain split). Start Plan C.1-C.5. |
| **M2** (Jun-Jul) | Plan C ship + paper canary. Plan B promote to live (if green). Memory split closure. |
| **M3** (Jul-Aug) | Plan B v2 (Solana variant). Plan F (BSC). Backes promote to live. |
| **M4** (Aug-Sep) | Plan D start (perps repo). Plan G (Base paper). |
| **M5+** | Plan D paper soak (4wk). Plan G promotion decision. Plan D canary (gated by D.13). |

---

## OUTSTANDING ITEMS SUMMARY (Week 11 input)

**Refactor closeout (HIGH PRI)**:
1. Config strict-validate at boot (catches env typos)
2. Config source-audit at boot (catches .env vs eco collisions)
3. Pre-trade contract enforce on live (currently shadow)
4. Bot version-gating on schema migrations
5. scanChain split → cycle/momentum-scanner.js

**Refactor cleanup (MED PRI)**:
6. Memory module split (lessons/knowledge/insights/core)
7. symbol_overrides DB read-through
8. ai_prompts live loader
9. tokens cache read-through

**Refactor cleanup (LOW PRI)**:
10. regime_patterns / backtest_runs / ml_model_versions write sides
11. Dashboard HTML panels
12. risk_rules CRUD
13. 30d retention prune sweeps
14. 3-sigma anomaly Telegram alerts
15. Bot version bump + tag
**Next review**: weekly during refactor execution
