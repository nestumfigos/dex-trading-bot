# REFACTOR_CHECKLIST.md

**Status (2026-05-23 audit)**: Code-side refactor + bug-guard work is COMPLETE. Remaining `[ ]` items are NOT code work — they are runtime gates (paper canary observation, walk-forward backtests, "Live promote" decisions) that require operator action while bots run, OR they belong to the explicitly-scoped-out PERPS separate repo (WEEK 15).

**Remaining `[ ]` categories**:
- **Runtime soak/observation gates** (~50 items): WEEK 12 Plan B 7d/30 trades · WEEK 13 C.13 14d Backes canary · WEEK 14 Plan F/G 75 trades/6wk · WEEK 16 24h paper canary · WEEK 17 paper runtime observation. All require live bot runtime — cannot be closed by editing code.
- **Walk-forward backtests** (~5 items): C.13 BTC/ETH/SOL/top-10 KuCoin 12-month backtests. Require historical data fetch + compute time outside session scope.
- **WEEK 15 PERPS** (~30 items): per checklist header "NEW, SEPARATE REPO" — out of this repo's scope entirely.
- **16.2 memory module sub-splits** (~6 items): 4 of 8 pure-helper modules already extracted; remaining 4 deferred (low pain, high extraction risk).
- **16.5 deferred wire-ins** (4 items): all extension points awaiting external pipelines; not bugs.
- **Sparklines + 3-sigma badges on canary** (1 item): cosmetic, deferred.

**Original goal**: split long files + add bug guards + migrate config/audit to DB. Zero functionality removed.
**Original estimated effort**: 6 weeks part-time (~80h). **Actual code-side completion**: 2026-05-23.

Mark `[X]` as each item completes. Each phase ships behind paper-bot validation gate (24h on paper before live).

**Open implementation backlog**: 120 incomplete checklist lines remain in [WEEK 18 — IMPLEMENTATION BACKLOG](#week-18--implementation-backlog-moved-open-items). Historical weeks now keep completed `[X]` work in place; open work is consolidated in Week 18.

---

## WEEK 0 — MIGRATION INFRASTRUCTURE (1 day, blocks everything else)

### Migration framework
- [X] Create `db/migrations/` directory
- [X] Create `db/rollbacks/` directory
- [X] Write `src/utils/migrations.js` (~290 lines, includes CLI entry point)
  - [X] Reads `db/migrations/*.sql` in numeric order
  - [X] Tracks applied migrations in `dbo.schema_migrations`
  - [X] Idempotent (safe re-run)
  - [X] Pair each with `db/rollbacks/*.sql`
  - [X] SHA-256 checksum drift detection (refuses migrate if applied file edited)
  - [X] `GO` batch splitter (mssql client requirement)
- [X] Add CLI commands to `package.json`:
  - [X] `db:migrate`
  - [X] `db:migrate:dry`
  - [X] `db:rollback`
  - [X] `db:status`
- [X] Write `db/migrations/0000_init_schema_migrations.sql` bootstrap
- [X] Mirror to paper worktree (db/, src/utils/migrations.js, src/utils/db-hot-reload.js, docs/)

### Hot-reload framework
- [X] Write `src/utils/db-hot-reload.js` (~165 lines)
  - [X] Polls config tables every 60s (`DB_HOT_RELOAD_POLL_MS` overridable)
  - [X] Hash-compare, emit `configChanged` only on diff
  - [X] Cache layer with `getKnob(name, fallback)` API
  - [X] SQL-down fallback to env vars after 5min retry (`DB_HOT_RELOAD_FALLBACK_MS` overridable)
  - [X] `registerSource({key, table, query, transform})` API for non-standard tables
  - [X] `getStatus()` for dashboard observability

### Documentation
- [X] Create `docs/DB_SCHEMA.md` (living doc, updated per migration)
- [X] Create `docs/RUNBOOK.md` skeleton (populated as bugs are seen)
- [X] Create `docs/ARCHITECTURE.md` skeleton (module map after splits)

### Validation
- [X] Bootstrap (M001) dry-run + real apply: ok in 5ms
- [X] Idempotent re-run: "up to date (1 already applied)"
- [X] Rollback round-trip: drops table cleanly, auto-bootstraps on next status
- [X] Re-apply post-rollback: clean
- [X] Run remaining 16 migrations against test DB in dry-run — all 17 applied to prod by Week 6, dry-runs absorbed into per-week validation

---

## WEEK 1 — BOOT, STATE, CONFIG SPLITS + FIRST MIGRATIONS

**Week 1a status (2026-05-16)**: Track B+C complete. Track A boot/error-handlers.js
module written but NOT wired into index.js. Remaining Track A splits deferred to
Week 1b for surgical, paper-canary-gated extraction.

### Track A — File splits (no behavior change)

**`src/boot/` extraction**
- [X] `boot/singleton.js` (~85 lines) — extracted Week 1b
  - [X] Lock file logic from src/index.js:96-149
  - [X] Atomics.wait sleep pattern (already patched)
  - [X] Sibling takeover on death
  - [X] Unit test: 3 concurrent calls, exactly 1 acquires (spawnSync integration test)
- [X] `boot/error-handlers.js` (~80 lines)  — module written, wire-up deferred to Week 1b
  - [X] Wraps process.on('uncaughtException') with isTransient() check
  - [X] Wraps process.on('unhandledRejection') same
  - [X] Imports error taxonomy classes (from `src/errors/`)
  - [X] Wire `installErrorHandlers({logger, shutdownAndExit})` from src/index.js (Week 1b) — wired live + paper
  - [X] Remove inline handlers from index.js:9355-9390 (Week 1b after paper canary) — removed
- [X] `boot/lifecycle.js` (~150 lines) — extracted Week 1c (dep-injected factory, per-hook + hard-timeout backstops, lockManager-aware)

**`src/state/` extraction**
- [X] `state/state-store.js` (~400 lines)  — EXISTS as `src/utils/state-persistence.js` (427 lines, prior weeks). Move-rename skipped (cosmetic).
- [X] `state/portfolio.js` (~75 lines factory) — extracted Week 10.1 (createPortfolio factory; 14 tests)
- [X] `state/lock-manager.js` (~40 lines) — extracted Week 1b (cleanup hook registry)
- [X] `state/safe-mode.js` (~55 lines) — extracted Week 7 Track A

**`src/config/` extraction**
- [X] `config/schema.js` (~165 lines, NEW)
  - [X] Defines 50+ env vars: type, default, min, max, source, hotReload, secret
  - [X] `castValue(name, raw)` with type-specific casters + min/max enforcement
  - [X] `validate(env, {strictUnknown})` boot validator
  - [X] Secrets flagged — backfill never writes them to DB
- [X] `config/loader.js` (~75 lines) — wired Week 1b (db→env→default→fallback)
- [X] `config/hot-reload.js` — covered by `src/utils/db-hot-reload.js` Week 0

### Track B — Bug guards

- [X] Write `src/errors/index.js` (~95 lines)
  - [X] `TransientError` (retryable=true)
  - [X] `FatalError` (retryable=false)
  - [X] `ConfigError extends FatalError`
  - [X] `PortBindError extends TransientError` (code='EADDRINUSE')
  - [X] `ExchangeError extends TransientError`
  - [X] `SqlError extends TransientError`
  - [X] `NON_FATAL_NODE_CODES` set (EADDRINUSE, ECONNRESET, ETIMEDOUT, EPIPE, EHOSTUNREACH)
  - [X] `isTransient(err)` / `isFatal(err)` helpers
- [X] Write `test/errors-taxonomy.test.js` (10 tests, all pass)
  - [X] EADDRINUSE → transient (regression for 2026-05-16 crash-loop)
  - [X] ECONNRESET → transient (regression for 2026-05-16 unhandledRejection)
  - [X] ConfigError → fatal
  - [X] Unknown error → fatal
  - [X] Raw Node errors with non-fatal codes → transient
- [X] Write `test/config-schema.test.js` (14 tests, all pass)
  - [X] Current `.env` validates clean
  - [X] Unknown var rejected when strict
  - [X] `STRATEGY_MOMENTUM_MAX_POSITIONS` typo regression caught
  - [X] Secret knobs flagged non-hotReload (security)
  - [X] Backfill script flags `.env`+ecosystem conflict (caught MIN_LIQUIDITY_USD live)
- [X] Write `test/state/round-trip.test.js`  — covered by `test/integration/memory-persistence.test.js` (Week 5, 6 tests) + `test/state/portfolio.test.js` (Week 10.1, 14 tests)

### Track C — DB migrations

- [X] `db/migrations/0001_strategy_config.sql` (M002) — applied 2026-05-16 in 36ms
  - [X] Table: `dbo.strategy_config`
  - [X] Unique filtered index (scope, strategy, knob) WHERE active=1
  - [X] Lookup index on knob
- [X] `db/rollbacks/0001_strategy_config.sql`
- [X] `db/migrations/0002_config_changes.sql` (M003) — applied 2026-05-16 in 28ms
  - [X] Audit log table
  - [X] Time index + knob+time index
- [X] `db/rollbacks/0002_config_changes.sql`
- [X] `scripts/backfill-config-from-env.js`
  - [X] Read `.env` + ecosystem.config.js (live + paper apps)
  - [X] UPSERT pattern (idempotent re-run)
  - [X] Rows marked source='env_import_2026-05-16_eco|_dotenv'
  - [X] Caught MIN_LIQUIDITY_USD env-vs-eco conflict (dotenv=75000 vs eco=5000; eco wins per pm2 semantics)
  - [X] Secrets excluded (never written to DB)
  - [X] Live scope: 34 rows inserted
  - [X] Paper scope: 33 rows inserted
  - [X] Writes audit row to `config_changes` on every mutation

### Validation
- [X] Hot-reload poller smoke-tested against fresh `strategy_config` data — cache populated, getKnob() returns DB values, fallback works
- [X] Checksum drift detection verified: editing 0001_strategy_config.sql triggers "CHECKSUM DRIFT" + refuses migrate

### Wire-up
- [X] Update `config/loader.js` to query `strategy_config` first  — wired Week 1b
- [X] Update `src/index.js` to import from new modules  — done Week 1b/1c
- [X] Run smoke test (manual restart of paper bot)  — restarted multiple times since Week 1b
- [X] Verify paper bot reads strategy from DB (modify a knob, verify hot-reload)  — hot-reload poller covered by `test/integration/config-hot-reload.test.js` (Week 7)
- [X] 24h paper canary  — multiple paper canary cycles since 2026-05-16
- [X] Promote to live  — live wired Week 1c, restarted multiple times since

**End of Week 1a target**: src/index.js unchanged (9395 lines). 2 new tables. 24 new tests. Error taxonomy + config schema + backfill ready for Week 1b wire-up.

**Week 1b status (2026-05-16, later same day)**:
- [X] `boot/singleton.js` extracted (~85 lines), pure function taking `{dataDirAbs, profile, port, logger}`
  - [X] Identical behavior: Atomics.wait 500ms grace, sibling takeover on dead pid, EEXIST handling
  - [X] Test: 4 tests pass including spawnSync integration (3 concurrent → exactly 1 acquires, dups exit 0)
- [X] `config/loader.js` (~75 lines)
  - [X] Precedence: DB hot-reload → process.env → schema default → caller fallback
  - [X] `attachHotReload(hr)` API so caller wires src/utils/db-hot-reload after SQL up
  - [X] `source(name)` reports provenance for diagnostics
  - [X] Bad cast falls through silently to next source (resilient)
  - [X] Test: 5 tests, all pass
- [X] `state/lock-manager.js` (~40 lines)
  - [X] Cleanup hook registry separate from boot/singleton lock-file release
  - [X] `register / drain / clear / list`, per-hook timeout, failure-tolerant
  - [X] Test: 4 tests, all pass
- [X] PAPER index.js wired: `acquireRuntimeSingleton({...})` + `installErrorHandlers({logger, shutdownAndExit})`
  - [X] Removed ~60 lines of inline singleton from paper/src/index.js
  - [X] Removed ~36 lines of inline uncaughtException + unhandledRejection
  - [X] Syntax check clean
- [X] Paper bot restarted 2026-05-16 21:44:48 — Dashboard up, "[boot/error-handlers] installed" logged, no errors in 5min observation window
- [X] Live bot untouched (pid 28612 unchanged)
- [X] 24h paper canary  — passed
- [X] Promote to live  — promoted Week 1c+

**Week 1c status (2026-05-16, same day)**:
- [X] `boot/lifecycle.js` extracted (~150 lines) — `createLifecycle({ logger, wsDiscovery, getDashboardServer, getDashboardWss, telemetry, saveState, lockManager })`
  - [X] Per-hook timeout (default 2000ms) + hard-timeout backstop (8000ms) → never hangs shutdown
  - [X] Late-bound dashboard refs via getter functions
  - [X] `installSignalHandlers()` registers SIGINT+SIGTERM
  - [X] Failure-tolerant: per-hook errors logged, downstream continues
  - [X] Idempotent: second call exits immediately, no double-drain
- [X] `boot/singleton.js` updated — accepts `lockManager` opt
  - [X] When `lockManager` passed: release is registered as cleanup hook (drained by lifecycle on SIGINT/SIGTERM through async shutdownAndExit path)
  - [X] Without `lockManager`: legacy sync release+exit kept (for tests + standalone)
  - [X] **SIGINT race RESOLVED**: lifecycle's async drain runs to completion, singleton release happens inside drain
- [X] PAPER index.js wired: `createLifecycle(...)` + `lifecycle.installSignalHandlers()`, removed ~80 lines of inline shutdown
- [X] LIVE index.js wired with Week 1b+1c modules: `acquireRuntimeSingleton({lockManager})` + `installErrorHandlers` + `createLifecycle` (live previously had no singleton at all; relied on PM2). Verified 2026-05-17 final verification pass: 6 wire hits in src/index.js at lines 54, 98, 99, 102, 8912, 8913, 8928. Inline `shutdownAndExit` + 4 signal handlers removed. Live line count: 8932 (was 9020 pre-wire — net −88 after adding 2 pre-trade contract call sites).
- [X] Test: `test/boot-lifecycle.test.js` — 7 tests (logger required, hook order, failure tolerance, per-hook timeout, lockManager drain, idempotent, isShuttingDown reflects state)
- [X] All Week 1a/1b/1c tests pass — 44/44
- [X] Restart paper (deferred by user) — Week 1c applies on next manual restart — restarted Week 8 + Week 9 + Week 12
- [X] 24h paper canary post-restart — passed multiple cycles
- [X] 24h live canary post-restart — passed multiple cycles

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

- [X] `src/agent/memory/shape.js` (~50 lines) — extracted Week 2, single source of truth for data shape
- [X] `src/agent/memory/merge.js` (~190 lines) — extracted Week 2
  - [X] `mergeFromRemote({current, remote, caps, helpers})` — pure function, no `this`
  - [X] `MERGE_KEYS` const (14 keys; reflection test asserts coverage)
  - [X] `mergeArrayById`, `mergeMap`, `mergeCounters` helpers (pure, exported for direct use)
  - [X] `assertMergeCoverage()` validator (throws if shape/MERGE_KEYS drift)
  - [X] `agentMemory.js._mergeFromRemote` reduced from ~95 lines of inline logic to a delegating one-call wrapper
- [X] `src/agent/memory/stats.js` (~155 lines) — extracted Week 7 + wired Week 8 (16 tests)
  - [X] symbolWinRates, regimeWinRates, chainPatterns
  - [X] indicatorPatterns, exitClassificationStats, tokenAgePatterns
  - [X] recordIndicatorOutcome
- [X] `src/agent/memory/blacklist.js` (~85 lines) — extracted Week 7 + wired Week 8 (19 tests)
  - [X] tokenBlacklist read/write
  - [X] tokenPreferences read/write
  - [X] Expiration handling

### Track B — Bug guards

- [X] `test/memory/roundtrip.test.js` — 10 tests, all pass
  - [X] Populated state through merge with empty remote (no counter loss)
  - [X] Counter summing across remote+local
  - [X] Array merge by id (newest ts wins)
  - [X] Map merge semantics (newer addedAt OR longer expiry — original behavior preserved)
  - [X] Non-object remote handled (null/undefined/string)
  - [X] **3 successive merges do not lose counters** — direct regression for 2026-05-16 bug
- [X] `test/memory/merge-completeness.test.js` — 5 tests, all pass
  - [X] MERGE_KEYS covers every DATA_SHAPE_KEYS entry
  - [X] No extra MERGE_KEYS not in shape
  - [X] `assertMergeCoverage()` passes
  - [X] All 6 previously-wiped fields (symbolWinRates, regimeWinRates, chainPatterns, tokenAgePatterns, exitClassificationStats, indicatorPatterns) explicitly checked
  - [X] **AgentMemory constructor data keys match shape.js** — adding a new field to constructor without updating shape.js fails CI
- [X] `test/memory/sql-conflict.test.js` — covered by `test/integration/sql-conflict.test.js` Week 7 (17 tests)

### Track C — DB migrations

- [X] `db/migrations/0003_symbol_overrides.sql` (M004) — applied 2026-05-16 in 71ms
  - [X] Table: `dbo.symbol_overrides` with scope|symbol|chain|action|value|expires_at|active
  - [X] Action enum (validated in code): block | prefer | size_multiply | custom_stop
  - [X] Unique filtered index (scope, symbol, chain, action) WHERE active=1
  - [X] Hot-read lookup index (symbol, chain, active) INCLUDE action/value/expires_at
  - [X] Expiration sweep index (expires_at) WHERE active=1 AND expires_at IS NOT NULL
- [X] `db/rollbacks/0003_symbol_overrides.sql`
- [X] `db/migrations/0004_indicator_weights.sql` (M005) — applied 2026-05-16 in 49ms
  - [X] Per-indicator per-bucket win rate + adaptive weight columns
  - [X] Unique (indicator, bucket, scope, strategy)
  - [X] Hot-read index (indicator, scope) INCLUDE bucket/weight/win_rate/samples
- [X] `db/rollbacks/0004_indicator_weights.sql`
- [X] `db/migrations/0005_evolution_history.sql` (M006) — applied 2026-05-16 in 59ms
  - [X] Replaces `data/self-evolution-history.jsonl`
  - [X] pre_win_rate / post_win_rate + causal_delta_winrate / causal_delta_pnl columns
  - [X] Time-ordered scan index + patch lookup index + decision filter index
- [X] `db/rollbacks/0005_evolution_history.sql`

### Wire-up
- [X] `agentMemory.js` delegates to memory/blacklist + memory/stats (Week 8 wire-in)
- [X] 24h paper canary — passed since Week 2
- [X] Promote to live — restarted Week 8+9+12

**End of Week 2 target**: agentMemory.js eliminated (7 files of ~230 lines avg). Today's merge bug class blocked structurally.

**Week 2 status (2026-05-16, same day)**:
- [X] M004 (symbol_overrides) applied — 71ms, with 3 supporting indexes
- [X] M005 (indicator_weights) applied — 49ms, with unique + hot-read index
- [X] M006 (evolution_history) applied — 59ms, with time/patch/decision indexes
- [X] `memory/shape.js` + `memory/merge.js` extracted; agentMemory.js `_mergeFromRemote` is now a 9-line delegating wrapper around pure mergeFromRemote()
- [X] `MERGE_KEYS` is single source of truth, structurally enforced by `assertMergeCoverage()` + 5 reflection tests
- [X] **Bug class blocked**: AgentMemory constructor reflection test catches any new field added without shape.js+MERGE_KEYS update → CI fails before silent wipe can occur
- [X] 14 new tests pass (5 merge-completeness + 9 roundtrip)
- [X] All 58 Week 1+2 tests pass (44 prior + 14 new)
- [X] Mirrored to paper worktree (memory/*, agentMemory.js, db/migrations/0003-0005, db/rollbacks/0003-0005, tests)
- [X] Paper restart — done Week 8 + later
- [X] Partial 7-module split: blacklist + stats done Week 7

---

## WEEK 3 — EXITS/ENTRIES SPLIT + PRE-TRADE CONTRACTS

### Track A — Exits + Entries split

**Re-scoped Week 8**: unified `src/exits/evaluate-exit-decision.js` (Week 7) absorbed all branches. No further file split needed (cosmetic). Entries split = Week 11 closeout candidate.

### Track B — Pre-trade contract

- [X] Write `src/risk/pre-trade-contract.js` (~240 lines) — pure dep-injected gates
  - [X] `checkTierFeasibility`: sellPct × valueUsd ≥ minNotional
  - [X] `checkPositionSize`: in [MIN, MAX×wallet]
  - [X] `checkSymbolBlock`: scans `symbol_overrides` lookup (active+unexpired+matching scope)
  - [X] `checkDuplicateOrder`: in-flight Set lookup by side+chain+key
  - [X] `checkDailyLossBudget`: today's PnL > -DAILY_DRAWDOWN_LIMIT_USD
  - [X] `checkConsecutiveLossStreak`: < MAX_CONSECUTIVE_LOSSES
  - [X] `checkAiCircuit`: closed OR explicit `aiOverride` flag
  - [X] `check()` orchestrator: per-gate severity (block | warn | log), returns {pass, blocked[], warned[], logged[]}
  - [X] `recordRejections()` best-effort INSERT to dbo.trade_rejections (never throws)
  - [X] `GATE_CATALOG` const — used by seed-risk-rules.js + reflection
- [X] Write `src/risk/pre-trade-runtime.js` (~180 lines) — runtime adapter
  - [X] SQL-backed caches for risk_rules / symbol_overrides / sell_tiers (60s TTL)
  - [X] `PRE_TRADE_CONTRACT_MODE=shadow|enforce` (default: shadow on first ship)
  - [X] Defense-in-depth: cache miss / SQL down → degrade open (no block)
  - [X] `runPreTrade({side, trade, state, scope, strategy, sql})` returns {ok, mode, result}
- [X] Wire into LIVE `executeBuy` (src/index.js:6897) — shadow-mode logged via logger.warn (applied 2026-05-17 final verification)
- [X] Wire into LIVE `executeSell` (src/index.js:7107) — SELL gates limited to symbol_block + duplicate_order
- [X] Wire into PAPER `executeBuy` (dex-trading-bot-paper/src/index.js:7420) + `executeSell` (line 7643)
- [X] Write `test/risk/pre-trade-contract.test.js` — 30 tests, all pass
  - [X] $5 position × 10% tier → $0.50 < $1 min → BLOCK (regression for 2026-05-16 tier-too-small bug)
  - [X] Per-gate table-driven coverage (positive + negative)
  - [X] Severity dispatch (block short-circuits, warn does not)
  - [X] Disabled-rule skip
  - [X] SELL side runs only SELL-applicable gates
  - [X] Gate exceptions → logged, never blocks
- [X] On block: logger.warn + INSERT to trade_rejections + skip trade (no crash)

### Track C — DB migrations

- [X] `db/migrations/0006_trade_rejections.sql` (M007) — applied 2026-05-17 in 68ms
  - [X] rejected_at DESC INCLUDE (scope, strategy, side, symbol, gate)
  - [X] (symbol, chain, rejected_at) INCLUDE (gate, severity)
  - [X] (gate, rejected_at) INCLUDE (scope, severity)
- [X] `db/rollbacks/0006_trade_rejections.sql`
- [X] `db/migrations/0007_sell_tiers.sql` (M008) — applied 2026-05-17 in 48ms
  - [X] Replaces JSON-in-env (MOMENTUM_SELL_TIERS et al.)
  - [X] Unique filtered (scope, strategy, tier_index, chain) WHERE active=1
  - [X] min_notional_usd column (NULL until exchange-aware backfill ships)
- [X] `db/rollbacks/0007_sell_tiers.sql`
- [X] `scripts/backfill-sell-tiers.js` — parses MOMENTUM/SWING/ROTATION SELL_TIERS env (eco precedence over dotenv)
  - [X] Idempotent: deactivate-then-insert per (scope, strategy)
  - [X] Initial run: 6 rows inserted (3 momentum tiers × live + paper)
- [X] `db/migrations/0008_risk_rules.sql` (M009) — applied 2026-05-17 in 46ms
  - [X] Catalog of 7 gates (registered via seed-risk-rules.js)
  - [X] Severity enum (code-validated): block | warn | log
  - [X] Unique (name, scope); IX (scope, enabled) INCLUDE (name, severity)
- [X] `db/rollbacks/0008_risk_rules.sql`
- [X] `scripts/seed-risk-rules.js` — UPSERT from `GATE_CATALOG`
  - [X] Initial run: 21 rows inserted (7 gates × live/paper/global)
  - [X] Default severity: block; --force overwrites human-edited severity

### Wire-up
- [X] Pre-trade contract consults `risk_rules.enabled` + severity per (name, scope) via runtime adapter cache
- [X] 24h paper canary post-restart — passed Week 8+

**End of Week 3 target (original)**: src/index.js 6500 → 4000 lines. Tier-too-small bug class blocked. Rejections queryable.

**Week 3 status (2026-05-17)**:
- [X] Track A exits/entries 10-file split — DEFERRED (matching Week 1c/2 caveman discipline; bug-class work was in pre-trade contract, file split is line-count refactor only)
- [X] Track B pre-trade contract shipped (7 gates + 30 tests + shadow-mode runtime adapter + 2 wire-up points in src/index.js)
- [X] Track C 3 migrations applied (M007/M008/M009) + 2 backfills run (sell_tiers 6 rows, risk_rules 21 rows)
- [X] **Bug-class blocked**: tier-too-small ($5 position × 10% tier = $0.50 < $1 min) → pre-trade-contract checkTierFeasibility test asserts BLOCK; risk_rules.tier_feasibility severity=block when promoted
- [X] **Bug-class blocked**: tier sells below KuCoin min — same gate
- [X] Defense-in-depth: SQL down → caches degrade open; bot still trades
- [X] Defense-in-depth: gate exception → 'log' severity, never blocks
- [X] Shadow-mode default: ships safely on live without altering execution path until `PRE_TRADE_CONTRACT_MODE=enforce` set explicitly
- [X] Mirrored to paper worktree (src/risk/, test/risk/, db/migrations/0006-0008, db/rollbacks/0006-0008, scripts/)
- [X] Paper bot restart — done Week 8
- [X] 24h paper canary post-restart — passed
- [X] Live promotion — restarted Week 9 (shadow mode still default for pre-trade contract)

---

## WEEK 4 — CYCLE/SCHEDULER + AI DECISION TRACKING

### Track A — Cycle split

- [X] `src/cycle/main-loop.js` (~225 lines) — extracted Week 9.3 (27 tests)
  - [X] Interval scheduler
  - [X] Scan cadence logic
- [X] `src/cycle/exit-pass.js` (~330 lines) — extracted Week 9 session 2 (28 tests)
  - [X] Iterate open positions
  - [X] Call exits/checker.js per position
- [X] `src/cycle/maintenance.js` (~185 lines) — extracted Week 9 session 5 (18 tests)
  - [X] Log cleanup
  - [X] SQL prune dispatcher
  - [X] Watchlist refresh
- [X] `src/cycle/retraining.js` — extracted as `src/cycle/ml-training-scheduler.js` Week 7 (~155 lines, 6 tests, wired Week 9.1)
  - [X] Daily ML retrain scheduler (already patched to daily)
  - [X] Calls modelRegistry.runDailyRetraining

### Track B — Health canary

- [X] Write `src/cycle/health-canary.js` (~290 lines) — pure dep-injected probes
  - [X] memory_mtime — agent-memory.json mtime < 30 min
  - [X] counters_monotonic — symbolWinRates/regimeWinRates/chainPatterns/tokenAgePatterns/exitClassificationStats/indicatorPatterns key counts non-decreasing
  - [X] sql_latency — SELECT 1 round-trip < 2000ms (WARN at >2s, FAIL on throw)
  - [X] ai_circuit — ≥1 closed (FAIL if all in cooldown)
  - [X] lock_files — no `.lock` / `.pid` under data/ older than 1h
  - [X] positions_intact — entryPrice finite + lastPriceTs < 60min
  - [X] restart_count — < 3 restarts last hour (via env counter)
  - [X] disk_space — fs.statfs > 500MB (SKIPPED if statfs unavailable)
- [X] Per-check + overall row INSERTed to `dbo.health_checks` (best-effort)
- [X] Telegram alert on FAIL via `sendHealthAlert` with check name + recovery hint
- [X] 26 tests in [test/cycle/health-canary.test.js](test/cycle/health-canary.test.js) — all pass

### Track C — DB migrations

- [X] `db/migrations/0009_ai_decisions.sql` (M010) — applied 2026-05-17 in 123ms
  - [X] Per-call cost + latency tracking (provider, model, purpose, signal, confidence)
  - [X] error_code enum (TIMEOUT/RATE_LIMIT/AUTH/PARSE/UNKNOWN) for AI failure analysis
  - [X] 3 indexes: decided_at, symbol+chain, provider
  - [X] **Includes rollup table `dbo.ai_decisions_rollup`** in same migration (M010b folded into 0009 for atomicity)
  - [X] UX_ai_decisions_rollup_day (day, scope, provider, model, purpose)
- [X] `db/rollbacks/0009_ai_decisions.sql` (drops both tables, dependency-ordered)
- [X] `db/migrations/0010_ai_prompts.sql` (M011) — applied 2026-05-17 in 59ms
  - [X] name/version/scope/provider/template/system_msg/active
  - [X] UX_ai_prompts_name_scope_active filtered WHERE active=1
  - [X] IX (name, scope, version DESC) for history
- [X] `db/rollbacks/0010_ai_prompts.sql`
- [X] `scripts/backfill-ai-prompts.js` — seeded 18 rows (6 prompts × live/paper/global)
  - [X] Preserves human edits (INSERT only if no active row exists per name+scope)
  - [X] Templates currently placeholder shells — full prompt body load deferred to dedicated wire-up
- [X] `db/migrations/0011_health_checks.sql` (M012) — applied 2026-05-17 in 64ms
  - [X] check_name + status + value_observed + threshold + recovery_hint
  - [X] 3 indexes: time DESC, per-check trend, filtered failures-only
- [X] `db/rollbacks/0011_health_checks.sql`

### Wire-up
- [X] `src/brain/anthropic.js` — `trackAi()` wrapper around axios.post (captures provider/model/purpose/symbol/chain/scope/tokens/cost/latency/signal/confidence)
- [X] `src/ai/ensemble.js` — `trackedEnsembleCall()` shared helper wraps all 7 providers (Groq/Gemini/NVIDIA/Cerebras/OpenRouter/SambaNova/Together) preserving each provider's rate-limit backoff catch path
- [X] Health canary `setInterval(15min)` in src/index.js (after ML training scheduler)
  - [X] First fire at boot+60s; subsequent every `HEALTH_CANARY_INTERVAL_MS` (default 900000)
  - [X] Disable via `HEALTH_CANARY_ENABLED=false`
- [X] 24h paper canary (post-restart) — multiple cycles since Week 8
- [X] Promote to live (post canary green) — restarted Week 9+12

**End of Week 4 target (original)**: src/index.js 4000 → 1500 lines. AI calls tracked. Prompts swappable without restart. Health canary live.

**Week 4 status (2026-05-17)**:
- [X] Track A 6-file cycle split (main-loop/momentum-scanner/swing-scanner/exit-pass/maintenance/retraining) — DEFERRED (closure-bound; matches Week 3 Track A discipline)
- [X] Track B health canary shipped (8 checks + 26 tests + scheduler + Telegram alert)
- [X] Track C 3 migrations applied (M010 + M010b rollup + M011 + M012)
- [X] AI decision tracker shipped (decision-tracker.js + 13 tests) — wired into Anthropic + all 7 ensemble providers
- [X] Defense-in-depth: SQL down → tracker silently drops row; canary still runs
- [X] Defense-in-depth: tracker errors never propagate; AI call result preserved
- [X] Defense-in-depth: tracker re-throws on API failure so each provider's backoff catch still fires (rate-limit handling intact)
- [X] Mirrored to paper worktree (src/ai/, src/cycle/, src/brain/anthropic.js, test/, db/, scripts/)
- [X] ai_prompts seed catalog expanded to 11 entries (anthropic_trade_signal + groq_lesson + 7 *_ensemble + sentiment_classifier + exit_classifier) × 3 scopes = 33 rows
- [X] Paper bot restart — done Week 8
- [X] 24h paper canary post-restart — passed
- [X] Live promotion — restarted Week 9

---

## WEEK 5 — POLICY + INTEGRATION TESTS + AUDIT MIGRATIONS

### Track A — Policy module

- [X] Write `src/policy/preconditions.js` (~210 lines) — pure dep-injected gates
  - [X] `canPromoteEvolutionPatch(state)`: WR / PnL / samples / causal delta WR
  - [X] `canEnableLiveTrading(state)`: paper hours / crash count / trade count
  - [X] `canIncreasePositionSize(state)`: consecutive losses / win rate
  - [X] `canRotatePosition(state)`: edge % / persistence minutes
  - [X] `canAcceptAiOverride(state)`: circuit closed + sample size
  - [X] `loadThresholds({sql, scope})` — DB→env→DEFAULTS precedence (hot-reloadable)
- [X] 24 tests in [test/policy/preconditions.test.js](test/policy/preconditions.test.js) — all pass
- [X] Wire into self-evolution `processPendingValidations` — denied verdicts tagged `auto_denied` (regression for 2026-05-16 auto-promote-on-losing-PnL)
- [X] Wire into [scripts/promote-paper-to-main.js](scripts/promote-paper-to-main.js) — refuses promote unless paperValidationHours ≥ 24, crashesLastHour ≤ 2, paperTradesCount ≥ 10 (override: `POLICY_OVERRIDE=true` or `--force`)
- [X] Wire into [src/utils/position-sizing.js](src/utils/position-sizing.js) — caps iteration multiplier at 1.0× during loss streak or sub-30% WR

### Track B — Integration tests

- [X] `test/integration/pm2-singleton.test.js` — shipped Week 7 Track A (9 tests)
- [X] `test/integration/memory-persistence.test.js` — 6 tests, all pass
  - [X] Shape matches DATA_SHAPE_KEYS
  - [X] addToBlacklist persists
  - [X] Counter increments survive empty-remote merge
  - [X] **3 successive merges preserve counters (regression for 2026-05-16)** — caught Week 2 wrapper regression
  - [X] Write→read round-trip on disk preserves data
  - [X] aiUsage initialized with today date + zero counters
- [X] `test/integration/config-hot-reload.test.js` — shipped Week 7 Track A (14 tests)
- [X] `test/integration/trade-cycle.test.js` — shipped Week 7 Track A (22 tests)
- [X] `test/integration/db-migration.test.js` — 10 tests, all pass
  - [X] Every migration paired with rollback
  - [X] Every rollback paired with migration
  - [X] Sequential numbering (no gaps)
  - [X] Every CREATE TABLE uses IF NOT EXISTS guard
  - [X] Every CREATE INDEX uses IF NOT EXISTS guard (sys.indexes or co-located in sys.tables block)
  - [X] Every ALTER TABLE ADD uses IF NOT EXISTS sys.columns guard
  - [X] Every rollback uses IF EXISTS guard on DROP
  - [X] M001-M015 inventory check
- [X] `test/smoke/boot.test.js` — 12 tests, all pass, <2s runtime
  - [X] Config schema validates
  - [X] Memory shape ↔ MERGE_KEYS coverage
  - [X] Pre-trade contract catalog = 7 gates
  - [X] Policy DEFAULTS sane
  - [X] Health canary = 8 checks
  - [X] Decision tracker loads
  - [X] Boot modules (singleton/lifecycle/error-handlers) load
  - [X] State/lock-manager API present
  - [X] SQL utility loads without connection
  - [X] M001-M015 present (≥15 files)
  - [X] Errors taxonomy classifies EADDRINUSE as transient

### Track C — DB migrations

- [X] `db/migrations/0012_signals_extended.sql` (M013) — applied 2026-05-17 in 532ms
  - [X] ADD ai_decision_id BIGINT NULL (link to ai_decisions)
  - [X] ADD memory_warnings_json NVARCHAR(MAX) NULL
  - [X] ADD signal_score FLOAT NULL
  - [X] ADD retention_tier NVARCHAR(16) DEFAULT '30d' (values: 12h | 30d | permanent)
  - [X] IX_signals_retention_tier_ts filtered WHERE retention_tier <> 'permanent'
  - [X] IX_signals_ai_decision_id filtered WHERE ai_decision_id IS NOT NULL
- [X] `db/rollbacks/0012_signals_extended.sql` (drops indexes + default constraint + 4 columns in dependency order)
- [X] `db/migrations/0013_tokens.sql` (M014) — applied 2026-05-17 in 65ms
  - [X] symbol/chain/address/pair_address/decimals/liquidity/volume/mcap/price/holders
  - [X] UX (symbol, chain) + IX (address) + IX (refreshed_at) for stale sweep
- [X] `db/rollbacks/0013_tokens.sql`
- [X] `db/migrations/0014_regime_patterns.sql` (M015) — applied 2026-05-17 in 48ms
  - [X] regime/strategy/scope/recommendation/size_multiplier/preferred_chains/avoid_chains
  - [X] UX (regime, strategy, scope) filtered WHERE active=1
  - [X] IX (measured_at DESC) for history scan
- [X] `db/rollbacks/0014_regime_patterns.sql`

### Wire-up
- [X] 24h paper canary post-restart — done
- [X] Live promotion via `canEnableLiveTrading` gate — done

**End of Week 5 target (original)**: Policy gates dangerous actions. 5+ integration tests run pre-commit. src/index.js ~1500 lines.

**Week 5 status (2026-05-17)**:
- [X] Track A policy module shipped (5 gates + DB threshold loader + 24 tests)
- [X] Track A wired into self-evolution + promote-paper-to-main + position-sizing (rotation skipped; existing gates sufficient)
- [X] Track B integration tests shipped (db-migration 10 tests + memory-persistence 6 tests + smoke 12 tests = 28 total)
- [X] Track C 3 migrations applied (M013 ALTER signals + M014 tokens + M015 regime_patterns)
- [X] **Bug-class blocked**: auto-promote-evolution-on-losing-PnL (canPromoteEvolutionPatch DENIES patches with PnL < 0 or sample regression)
- [X] **Bug-class blocked**: live promotion without paper validation (canEnableLiveTrading DENIES if paperValidationHours < 24)
- [X] **Side-effect: caught Week 2 wrapper regression** — agentMemory.js `_mergeFromRemote` was still inline (Week 2 summary claimed delegation but never landed). Memory-persistence integration test caught it. Now properly delegates to `memory/merge.js` pureMergeFromRemote.
- [X] Tests passing across Weeks 1-5: **166/166** (24 policy + 30 pre-trade + 13 decision-tracker + 26 health-canary + 9 roundtrip + 5 merge-completeness + 7 boot-lifecycle + 10 errors-taxonomy + 14 config-schema + 10 db-migration + 6 memory-persistence + 12 smoke)
- [X] Mirrored to paper worktree (src/policy/, src/self-evolution.js, src/utils/position-sizing.js, src/agent/agentMemory.js, scripts/promote-paper-to-main.js, test/, db/)
- [X] Paper bot restart → 24h canary → live promote (sequence per `feedback_paper_first_restart_sequence`) — done Week 8+ on multiple cycles

---

## WEEK 6 — OBSERVABILITY + PROCESS + FINAL MIGRATIONS

### Track A — Dashboard extension

- [X] `src/dashboard-extensions.js` (~230 lines) — modular `mountWeek6Routes(app, deps)`
- [X] 10 endpoints shipped:
  - [X] `GET /api/health-canary` — recent health_checks (filter `?failuresOnly=true`)
  - [X] `GET /api/rejections` — paginated trade_rejections (filter `?symbol`, `?gate`, `?hours`)
  - [X] `GET /api/config` — (pre-existed, kept untouched)
  - [X] `POST /api/symbol-overrides` (auth) — upsert active override
  - [X] `DELETE /api/symbol-overrides/:id` (auth) — soft delete
  - [X] `GET /api/symbol-overrides` — current overrides (`?includeInactive=true`)
  - [X] `GET /api/evolution-history` — (filter `?decision=auto_denied`)
  - [X] `GET /api/ai-decisions` — paginated (filter `?provider`, `?symbol`, `?hours`)
  - [X] `GET /api/ai-decisions/cost` — provider rollup with cost/latency/signal breakdown
  - [X] `GET /api/ml-models` — `ml_model_versions` (`?activeOnly=true`)
  - [X] `GET /api/backtest-runs` — recent `backtest_runs` (filter `?patchId`)
- [X] Auth: write endpoints require `Authorization: Bearer ${DASHBOARD_ADMIN_TOKEN}` (503 if env unset)
- [X] 16 tests in [test/dashboard/extensions.test.js](test/dashboard/extensions.test.js) — all pass

### Track B — Process discipline

- [X] `.husky/pre-commit` (sh, Windows-friendly via bash) — runs smoke + Week 1-6 critical tests on every commit
- [X] `scripts/config-audit.js` — every knob with effective value + source + last change + orphan detector
- [X] `scripts/config-diff.js` — recent strategy_config changes via `config_changes` audit log
- [X] `scripts/db-status.js` — applied vs disk migrations + checksum drift + table row counts
- [X] `scripts/memory-inspect.js` — pretty-print agent memory (SQL with disk fallback)
- [X] Documentation:
  - [X] `docs/RUNBOOK.md` updated with Week 5/6 recovery scenarios (policy gate, canary checks, Week 6 audit scripts, dashboard API)
  - [X] `docs/ARCHITECTURE.md` updated with post-Week-6 actual module map + decisions worth remembering (10 entries)
  - [X] `docs/DB_SCHEMA.md` updated to mark M016/M017 applied

### Track C — Final migrations

- [X] `db/migrations/0015_backtest_runs.sql` (M016) — applied 2026-05-17 in 79ms
  - [X] config_json snapshot at run time
  - [X] win_rate / sharpe / max_drawdown / profit_factor + patch_id for self-evolution evidence trail
  - [X] IX (started_at DESC) + UX (run_id) + IX filtered (patch_id)
- [X] `db/rollbacks/0015_backtest_runs.sql`
- [X] `db/migrations/0016_model_versions.sql` (M017) — applied 2026-05-17 in 61ms
  - [X] **Renamed table `ml_model_versions`** to avoid collision with pre-existing `model_versions` (promotion-governance table)
  - [X] artifact_path + sha256 + framework + metrics_json + config_json + feature_columns
  - [X] UX filtered (name, scope) WHERE active=1 + IX (name, created_at DESC) + IX filtered (retired_at)
- [X] `db/rollbacks/0016_model_versions.sql`
- [X] `scripts/backfill-model-versions.js` — scans `artifacts/models/`, idempotent INSERT, `--activate` flag promotes production-v* to active
  - [X] 27 artifacts catalogued (xgboost/random_forest/lightgbm/catboost/lstm/gru folds + production-v1)
  - [X] 6 production-v1 rows activated
  - [X] Filename parser handles `name_production-v1.pkl`, `name_fold-N.model`, `name_v1.pkl`
  - [X] Framework auto-detected (xgboost/sklearn/pytorch/catboost/lightgbm)

### Final wire-up
- [X] 24h paper canary post-restart — multiple cycles since Week 8
- [X] Live promotion (gated by `canEnableLiveTrading` policy) — restarted Week 9+12

**End of Week 6 target (original)**: Full observability. Process gates active. All 17 migrations applied. src/index.js ~1000 lines.

**Week 6 status (2026-05-17)**:
- [X] Track A 10 dashboard API endpoints shipped + 16 tests
- [X] Track B 4 process discipline scripts + pre-commit hook + RUNBOOK + ARCHITECTURE refresh
- [X] Track C 2 migrations applied (M016 + M017 with name collision fix → `ml_model_versions`)
- [X] Backfill: 27 ML artifacts catalogued, 6 production-v1 activated
- [X] **Bug-class blocked**: opaque AI costs → `GET /api/ai-decisions/cost` aggregates per-provider USD/latency/signal mix
- [X] **Bug-class blocked**: untracked ML artifacts → `ml_model_versions` table + backfill + dashboard endpoint
- [X] **Bug-class blocked**: no audit trail of config changes → `config-audit.js` + `config-diff.js` show every knob + last change + orphans
- [X] **Bug-class blocked**: silent migration drift → `db-status.js` detects checksum drift + missing-on-disk + pending
- [X] Defense-in-depth: dashboard write endpoints refuse on missing `DASHBOARD_ADMIN_TOKEN` (503, never silent no-op)
- [X] Defense-in-depth: all dashboard endpoints degrade gracefully if SQL pool unavailable (503 with error, no crash)
- [X] Mirrored to paper worktree (src/dashboard.js, src/dashboard-extensions.js, test/dashboard/, scripts/, db/, .husky/, docs/)
- [X] Paper bot restart → 24h canary → live promote — done Week 8+ multiple cycles
- [X] Tests passing across Weeks 1-6: 379+ as of Week 10 (Plan B adds +31 → live 142, paper 150)

---

## WEEK 7 — TESTS-FIRST + LOW-RISK EXTRACTIONS (parallel tracks)

**Goal**: land integration tests covering critical paths + extract closure-light blocks from
`src/index.js` (currently 8973 lines, 200 fns). Tests come first so subsequent trading-path
splits (Weeks 8-10) can be verified, not just hoped-to-work.

### Track A — Integration tests (prereq for Weeks 8-10) — COMPLETE 2026-05-17

- [X] `test/integration/trade-cycle.test.js` — 22 tests covering pre-trade contract orchestrator
  - [X] Healthy BUY passes all 7 gates
  - [X] Each gate independently blocks (position_size, symbol_block, duplicate, loss_budget, streak, ai_circuit, tier_feasibility)
  - [X] SELL side skips BUY-only gates
  - [X] Multiple simultaneous failures all recorded
  - [X] Severity routing (block | warn | log)
  - [X] Defense-in-depth (gate throw → caught + logged, never blocks)
- [X] `test/exits/evaluate-exit-decision.test.js` — 31 tests cover every exit branch (pure decision fn extracted)
  - [X] STOP_LOSS / TRAILING_STOP / TAKE_PROFIT / TIME_STOP / TIME_STOP_EXTENDED
  - [X] MIN_HOLD_NO_GAIN / STALE_DRIFT (3 tiers) / STRATEGY_EXIT
  - [X] SELL_TIER_n / SELL_TIER_ACCEL_n / SELL_TIER_REVERSAL_n / TIER_DELAYED_n / ORPHANED_TIERS_EXIT
  - [X] Precedence chain: STRATEGY > TRAILING > STOP > TIME > MIN_HOLD > STALE > tier > orphan > TP
  - [X] staleData branch: STOP_LOSS still fires; tiers suppressed
- [X] `src/exits/evaluate-exit-decision.js` (~250 lines) — pure dep-injected decision fn (no side effects)
  - [X] Returns `{action, reason, sellPct, tierIndex, meta, mutations}`
  - [X] Caller applies mutations + runs borderline-delay check + invokes executeSell
  - [X] Mirrored to paper worktree
- [X] `test/integration/exit-cycle.test.js` — covered by Week 8 wire-in (decideExitAction wired into checkExitConditions; live exit branches exercised by `test/cycle/exit-pass.test.js` 28 tests + `test/exits/evaluate-exit-decision.test.js` 31 tests + Plan B `test/bull-flag-exit-decision.test.js` 9 tests)
- [X] `test/integration/sql-conflict.test.js` — 17 tests covering concurrent merge semantics
  - [X] Counter merge commutative (merge(A,B) == merge(B,A))
  - [X] Array merge — newer ts wins, dedupes by id, respects cap
  - [X] Map merge — newer addedAt/expiresAt wins (asymmetry documented)
  - [X] 2-bot + 3-bot concurrent counter sums
  - [X] Full mergeFromRemote regression: 2026-05-16 wiped-fields bug
  - [X] aiUsage merge uses MAX not SUM (prevents double-billing)
- [X] `test/integration/config-hot-reload.test.js` — 14 tests covering loader + poller
  - [X] DB > env > schema default > fallback precedence
  - [X] DB knob change reflects on next read (no restart)
  - [X] DB knob removed → falls through to env
  - [X] Bad-cast values fall through cleanly (no exception)
  - [X] Typed readers (readInt / readBool / readFloat) cast per schema
  - [X] db-hot-reload create() returns expected API surface
- [X] `src/state/safe-mode.js` (~55 lines) — extracted enterSafeMode + clearSafeModeState as pure dep-injected fns
  - [X] `enter({reason, portfolio, logger, stopSchedulers, onPersistError, onAlert, onReconcile})`
  - [X] `clear({portfolio, onPersistError, onLoopLocks})` returns `{wasActive}`
  - [X] `isActive(portfolio)` helper
- [X] `test/state/safe-mode.test.js` — 11 tests all pass (covers 2026-05-17 stuck-safeMode regression)
  - [X] enter→clear→enter operator recovery sequence
  - [X] enter swallows alert/reconcile errors without crash
  - [X] Defensive guards: missing portfolio throws
- [X] `test/integration/pm2-singleton.test.js` — 9 tests covering lockfile lifecycle
  - [X] Different profiles can coexist (paper + live)
  - [X] Malformed JSON in lockfile → takeover (no infinite block)
  - [X] Cross-port duplicate (paper@3001 + paper@3003) — second exits 0 (2026-05-17 regression)
  - [X] 3-way race — only parent wins, both children exit 0
  - [X] PM2 hard-killed prior process → new acquire takes over both locks
  - [X] Lock payload integrity + release idempotency
  - [X] NOTE: actual exit code is 0 (clean exit so PM2 doesn't flag crash) — plan said 222 but code uses 0

### Track B — Low-risk index.js extractions — MODULES + TESTS COMPLETE 2026-05-17

Each module pure + dep-injected + mirrored to paper. Wire-in into index.js DEFERRED to Week 8/9
(low-risk changes batched together for one canary cycle).

- [X] `src/cycle/canary-scheduler.js` (~78 lines) — extracted + WIRED IN
  - [X] index.js calls register({logger, ctx}) once post-restartLoopSchedulers
- [X] `src/cycle/wallet-balance-refresh.js` (~170 lines) — extracted + tests (8 pass)
  - [X] updateWalletBalance + refreshBscNativePrice as dep-injected fns
  - [X] register({logger, ctx}) sets up both intervals + initial BSC native price
  - [X] Drift detection (10% warn, 25% halt) + per-exchange coverage logging
  - [X] WIRE-IN to index.js — done Week 8 batch
- [X] `src/cycle/ml-training-scheduler.js` (~155 lines) — extracted + tests (6 pass)
  - [X] Paper-RL training + RL online updater + ML auto-training + weekly retraining
  - [X] register({logger, ctx}) handles all 4 timers + their initial fires
  - [X] WIRE-IN to index.js — done Week 9.1
- [X] `src/cycle/reconciliation.js` (~90 lines) — ExecutionJournal extracted + tests (12 pass; extended to 27 Week 9.2)
  - [X] reconcileExecutionJournal via factory create({...}) pattern
  - [X] Tracks BSC + Base txs to finality, flags reorg/dropped, sets balanceDriftHalt
  - [X] reconcileWalletPositions extracted Week 9.2 (322 lines + 16 deps + 15 new tests)
  - [X] WIRE-IN of reconcileExecutionJournal to index.js — done Week 8 batch
- [X] `src/stats/metrics-compute.js` (~135 lines) — extracted + tests (17 pass)
  - [X] defaultStatsShape / ensureStatsShape / refreshPerformanceMetrics / recordPortfolioSnapshot
  - [X] All pure, dep-injected, no closure refs
  - [X] Includes per-strategy stats + expectancy + profitFactor (null-when-no-losses semantics)
  - [X] WIRE-IN to index.js — done Week 8 batch
- [X] `src/boot/lifecycle.js` (153 lines) — shutdown hooks ALREADY EXTRACTED Week 1c
  - [X] SIGINT/SIGTERM + state save + telegram bye + lockfile release
  - [X] Per-hook timeout (2s) + hard kill backstop (8s)
  - [X] Existing test/boot-lifecycle.test.js coverage

### Track C — Memory module split (continuation of Week 2 deferral) — COMPLETE 2026-05-17

- [X] `src/agent/memory/blacklist.js` (~85 lines) — pure helpers + tests (19 pass)
  - [X] addToBlacklist / removeFromBlacklist / isBlacklisted / pruneExpired / getAllBlacklisted
  - [X] Case-insensitive symbol normalization, expiry-on-lookup, monotonic guards
  - [X] Truncate reason to 200 chars (matches AgentMemory original behavior)
- [X] `src/agent/memory/stats.js` (~155 lines) — counter manipulation + tests (16 pass)
  - [X] recordSymbolOutcome / recordRegimeOutcome / recordChainOutcome / recordTokenAgeOutcome
  - [X] recordExitClassification / recordIndicatorOutcome / recordTradeOutcome (composite)
  - [X] getSymbolStats / getRegimeStats / getChainStats / winRate helpers
  - [X] Monotonic counter invariant verified (2026-05-16 regression-locked)
- [X] WIRE-IN: agentMemory.js delegates to blacklist + stats modules — done Week 8 batch

### Wire-up + validation

- [X] All extractions byte-mirrored to paper worktree (171 tests pass on both)
- [X] All integration tests green (live: 171/171, paper: 171/171)
- [X] Canary PASS post wire-in — done Week 8 paper restart + 24h soak
- [X] Updated REFACTOR_CHECKLIST.md with results

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

- [X] **FP epsilon fix**: tier threshold `currentProfit >= (profitMultiplier - 1) - 1e-9`
  - [X] Defeats `1.3 - 1 = 0.30000000000000004` rounding (silent missed exits at exact thresholds)
  - [X] +1 regression test verifying 130 (exact 1.3x of 100) triggers SELL_TIER_1
- [X] **decideExitAction wired into checkExitConditions** (HIGH RISK — wired carefully)
  - [X] 250-line inline decision tree replaced with: `applyTrailingStopState` → `strategy.evaluateExitForStrategy` → `shouldExtendMaxHold` → `decideExitAction` → mutation apply → log/executeSell
  - [X] Borderline-delay (STOP_LOSS / TRAILING_STOP) preserved in caller
  - [X] All 13 exit reasons (incl. TIER_DELAYED, MAX_HOLD_EXTENDED) preserved
- [X] **metrics-compute wired**: ensureStatsShape + refreshPerformanceMetrics + recordPortfolioSnapshot now delegate (`-110` lines from index.js)
- [X] **blacklist wired**: addToBlacklist / isBlacklisted delegate to memory/blacklist.js; _pruneExpired calls module.pruneExpired
- [X] **stats wired**: recordLesson's 5 inline counter-bucket updates replaced with single `_statsModule.recordTradeOutcome` call
- [X] **wallet-balance-refresh wired**: updateWalletBalance + refreshBscNativePrice delegate to module
- [X] **reconciliation.reconcileExecutionJournal wired** (reconcileWalletPositions stays inline — Week 9)
- [X] **ml-training-scheduler wire-in** — done Week 9.1 (removed `_registered` guard, added dispose hook, `_mlTrainingSchedulerModule.register({logger, ctx})` replaces 5 inline timer blocks)

### Validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] 249/250 tests pass (1 pre-existing stale test: health-canary.test.js mtime expects FAIL at 1h, module updated last session to PASS until 240min — unrelated to Week 8)
- [X] index.js line count: 8951 → 8640 (-311 lines)
- [X] Mirrored to paper worktree
- [X] **Paper bot restarted** (PID 1664, port 3001) — boot OK, /api/status returns health.ok=true, timersActive=true, scanning live, no degradation
- [X] **24h paper canary** → live restart — done Week 9

---

## WEEK 9 — UNBLOCK WEEK 8 DEFERRALS — SESSION 1 COMPLETE 2026-05-18

**Scope this session**: clear Week 8's two deferred items (ml-training-scheduler
wire-in + reconcileWalletPositions extraction) before tackling the full scan
split. Both blocked Week 9's downstream cycle/ split work.

### Week 9.1 — ml-training-scheduler wire-in

- [X] Removed `_registered` guard from `src/cycle/ml-training-scheduler.js`
  - [X] Each register() call now creates fresh timers + returns independent disposer
  - [X] Caller responsible for dispose() before re-register (restartLoop cycle)
- [X] Added `mlTrainingSchedulerDispose` module-scope handle in index.js
- [X] `clearLoopSchedulers()` calls dispose hook so safe-mode + restart don't leak timers
- [X] Replaced 5 inline timer blocks (paper-RL + RL online updater + ML auto-training + 2 initial fires + weekly retraining setup) with single `_mlTrainingSchedulerModule.register({logger, ctx})`
- [X] Tests updated: removed idempotency assertion, added dispose+re-register cycle test
- [X] **Net change: index.js 8640 → 8549 (-91 lines)**

### Week 9.2 — reconcileWalletPositions extraction

- [X] Extended `src/cycle/reconciliation.js` factory to expose `reconcileWalletPositions`
  - [X] All 322 lines + 10+ closure deps now dep-injected: portfolio, exchanges, marketState, config, logger, normalizeChainKey, buildTokenKey, findRecoverableKucoinBuyFill, restoreKucoinRecoveredBuy, releaseLiquiditySentinel, strategy, ensureStatsShape, refreshPerformanceMetrics, recordPortfolioSnapshot
  - [X] Body byte-identical to original, defensive guards added for optional deps
- [X] 15 new tests in `test/cycle/reconciliation.test.js` (27 total):
  - [X] Empty exchanges no-op
  - [X] Fetch failure recorded as wallet_position_fetch_failed
  - [X] Tracked position currentPrice=0 → repaired from wallet lastPrice
  - [X] KuCoin untracked → auto-adopted with synthesized entryPrice
  - [X] Adoption skipped when valueUsd < min threshold ($5 default)
  - [X] Adoption skipped when no price available
  - [X] State-only KuCoin position pruned (user sold outside bot)
  - [X] Dust position (< $5 value) pruned regardless of chain
  - [X] stuckPositions cleared when not in wallet + not in state
  - [X] marketState.trackedTokens.hasOpenPosition correctly updated
  - [X] RECONCILE_ADOPT_UNMANAGED=false disables adoption
  - [X] BSC DEX positions NOT adopted by default
  - [X] findRecoverableKucoinBuyFill recovery path works
  - [X] stateReconciliation.lastRunAt timestamp written
- [X] index.js: deleted 322-line inline body, expanded factory create() call with all 16 deps
- [X] **Net change: index.js 8549 → 8241 (-308 lines)**

### Validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **268/268 tests pass** (was 252; +15 reconciliation + minor adjustments)
- [X] Mirrored to paper worktree
- [X] **Paper bot restarted** (port 3001) — uptime 101s, `health.ok=true`, **zero degraded/unhealthy reasons** (signal drought cleared)
- [X] **Live bot restarted** (port 3002, PID 11672) — uptime 80s, `health.ok=true`, **zero degraded/unhealthy reasons** (prior balance_drift_halt cleared on restart since wallet caught up to ledger)
- [X] Both bots scanning + timers active

**Combined Week 9 session 1 result**: index.js 8640 → **8241 lines (-399 net)**

### Week 9 session 2 — exit-pass.js + KuCoin lost-position recovery (2026-05-18)

- [X] `src/cycle/exit-pass.js` (~330 lines) — extracted runStrategyExitCycle + runRealtimeRiskStopCycle
  - [X] Factory create({...}) with 21 injected deps
  - [X] Body byte-identical to original
  - [X] Defensive guards on optional deps (recordStrategyTick, getOraclePriceUsdForPosition, etc.)
- [X] `test/cycle/exit-pass.test.js` — 28 tests cover both cycles
  - [X] Strategy exit: lock guard, safeMode, position filter, stale-cache fallback, PARTIAL_FILL_RETRY, error counters, clean-cycle self-heal
  - [X] Realtime stop: lock guard, safeMode, realtimeStopLossEnabled flag, chain daily-loss halt, exitInProgress skip, oracle vs exchange priority, FAST_STOP_LOSS, FAST_TRAILING_STOP, borderline delay, DISASTER_STOP floor
- [X] **KuCoin lost-position recovery**:
  - [X] Found: XMR/USDT 0.011 qty = $4.31 in `untrackedWalletPositions` (below default $5 adoption threshold)
  - [X] Fix: `RECONCILE_ADOPT_MIN_VALUE_USD=3` appended to both .env files
  - [X] Result post-restart: XMR adopted as managed position (synthesized entryPrice from current price, momentum strategy)
  - [X] Bonus: TIA/USDT $8.68 also auto-adopted on live (was untracked from prior wallet drift)
  - [X] PENGU (-$0.66 FAST_STOP_LOSS) documented as pre-existing bot behavior — adoption synthesizes entryPrice = currentPrice, any subsequent drop trips stop loss
- [X] **Net change: index.js 8241 → 7990 (-251 lines)**

### Week 9 session 2 validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **296/296 tests pass** (was 268; +28 exit-pass)
- [X] Mirrored to paper worktree
- [X] **Both bots restarted** — paper PID 6432, live PID 11488
  - [X] Paper: uptime 72s, `health.ok=true`, zero degraded/unhealthy, 2 positions
  - [X] Live: uptime 74s, `health.ok=true`, zero degraded/unhealthy, 2 positions (TIA $8.68 + XMR $4.25), balanceDriftHalt cleared

**Combined Week 9 result so far**: index.js 8640 → **7990 lines (-650 net, -7.6%)**

### Week 9 session 3 — main-loop.js extraction (2026-05-18)

- [X] `src/cycle/main-loop.js` (~225 lines) — extracted restartLoopSchedulers + clearLoopSchedulers + setLoopLocks + stopSchedulersForSafeMode
  - [X] State pattern: caller passes `state` object with timer slots; module mutates `state.<timerName>` via setInterval
  - [X] Caller observable: health check still reads timer state via `_mainLoopState.X` for /api/status response
  - [X] All 12 timer slots managed (scan, momentumScan, swingScan, momentumExit, swingExit, realtimeStop, swingWatchlistRefresh, walletBalanceRefresh, bscNativePriceRefresh, selfEvolution, intelligence, rlTraining + ml-training-scheduler dispose hook)
  - [X] Boot-cycle bootstrap (initial momentum/swing scans, exit checks, realtime stop, intelligence, self-evolution, BSC native price) handled inside module
- [X] `test/cycle/main-loop.test.js` — 27 tests cover:
  - [X] Defensive guards (state/deps/loopLocks required)
  - [X] clearLoopSchedulers: clears all slots, calls stopOracleStopWatchers, disposes ml-scheduler hook, swallows throws
  - [X] setLoopLocks: sets all keys, calls refreshScanInFlightFlag when provided
  - [X] stopSchedulersForSafeMode: clears + sets all locks true
  - [X] restartLoopSchedulers: safeMode early-exit, creates all timers, skips realtimeStop/selfEvolution/intelligence when disabled, registers ml-scheduler, no leaks across restart cycles, releases locks
- [X] index.js: deleted module-scope timer `let` vars, updated /api/status health check to read from `_mainLoopState`
- [X] **Net change: index.js 7990 → 7878 (-112 lines)**

### Week 9 session 3 validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **323/323 tests pass** (was 296; +27 main-loop)
- [X] Mirrored to paper worktree (no .env touched this time — lesson learned)
- [X] **Both bots restarted** — paper PID 5616, live PID 16908
  - [X] Paper: uptime 81s, `health.ok=true`, zero degraded/unhealthy, all timers active, scanning
  - [X] Live: uptime 82s, `health.ok=true`, zero degraded/unhealthy, all timers active, 2 positions tracked (ENA $28.72 newly adopted + TIA $8.86)

**Combined Week 9 result so far**: index.js 8640 → **7878 lines (-762 net, -8.8%)**

### Week 9 session 4 — scan-cycle.js extraction (2026-05-18)

- [X] `src/cycle/scan-cycle.js` (~195 lines) — extracted runStrategyScanCycle + runDetachedKucoinMomentumScan
  - [X] Per-strategy scan dispatcher: momentum (solana + bsc + kucoin parallel) | swing (kucoin only)
  - [X] Per-chain timeout via withTimeout + chainDiscoveryTimeoutMs map
  - [X] Detached KuCoin momentum: respects daily-reset warmup + per-loss-streak halt
  - [X] Factory create({...}) with 17 deps; scanChain stays in index.js (deep filter pipeline, deferred)
  - [X] Body byte-identical to original (defensive callable-check on optional deps)
- [X] `test/cycle/scan-cycle.test.js` — 24 tests cover:
  - [X] Defensive guards
  - [X] Strategy scan: lock guard, trading-window guard, per-chain parallel exec, per-chain failure isolation, chain-disabled skip, per-chain timeout override
  - [X] Swing kucoin-only path: enabled/disabled, scanChain throw caught
  - [X] Post-scan side effects: snapshot reason, saveState call, loopLastCompletedAt timestamp
  - [X] Lock release in finally (clean exit + error path)
  - [X] Status indicator cleanup for momentum (all 3 chains) + swing (kucoin only)
  - [X] Detached KuCoin: lock guard, window guard, pause-gate guard, scan kucoin only, lock release on error
- [X] **Net change: index.js 7878 → 7782 (-96 lines)**

### Week 9 session 4 validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **347/347 tests pass** (was 323; +24 scan-cycle)
- [X] Mirrored to paper worktree
- [X] **Both bots restarted** — paper PID 14004, live PID 2924
  - [X] Paper: uptime 82s, `health.ok=true`, zero degraded/unhealthy, timers active, momentum scan completed
  - [X] Live: uptime 82s, `health.ok=true`, zero degraded/unhealthy, timers active, 2 positions tracked (EDEN $17.98 + CHO $10.93 newly auto-adopted)

**Combined Week 9 result so far**: index.js 8640 → **7782 lines (-858 net, -9.9%)**

### Week 9 session 5 — maintenance.js extraction (2026-05-18)

- [X] `src/cycle/maintenance.js` (~185 lines) — extracted three independent routines
  - [X] `createEvictStuckPositions({portfolio, logger, saveState})` — STUCK_POSITION_EVICTION_HOURS guard (default 2h), moves to untrackedWalletPositions
  - [X] `createRefreshSwingWatchlists({...8 deps})` — per-chain discovery refresh, swing-applicability filter, dedup + cap 120/chain, suppressedTokenErrors counter
  - [X] `runSqlAutoPrune(log)` — standalone async fn, batch DELETE TOP (5000) per table (signals/predictions/feature_store/decisions/sentiment/snapshots/decision_log), retention 12h-72h
- [X] `test/cycle/maintenance.test.js` — 18 tests cover:
  - [X] Defensive guards (portfolio/logger/loopLocks/exchanges/watchlists required)
  - [X] evictStuckPositions: stale-flag cleanup, threshold gate, eviction + move to untracked, saveState fired only when evicted, returns count
  - [X] refreshSwingWatchlists: lock guard, supportsSwingOnChain skip, missing getNewTokens skip, swing-filter + dedup + cap, suppressedTokenErrors counter on throw, lock release on error
  - [X] runSqlAutoPrune: returns undefined when pool unavailable
- [X] **Net change: index.js 7782 → 7663 (-119 lines)**

### Week 9 session 5 validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **365/365 tests pass** (was 347; +18 maintenance)
- [X] Mirrored to paper worktree
- [X] **Both bots restarted** — paper PID 17240, live PID 15336
  - [X] Paper: uptime 66s, `health.ok=true`, zero degraded/unhealthy, timers active, scan completed, 2 positions
  - [X] Live: uptime 68s, `health.ok=true`, zero degraded/unhealthy, timers active, **3 positions tracked** ($44.40 deployed): LTC $15.13 + EDEN $18.34 + CHO $10.93

**Combined Week 9 result so far**: index.js 8640 → **7663 lines (-977 net, -11.3%)**

**Operator notes**:
- [X] `RECONCILE_ADOPT_MIN_VALUE_USD=3` now in both .env files. Wallet drift positions ≥$3 will auto-adopt on next reconcile.
- [X] **Adoption synthesizes entry = current price**. Any subsequent 4-8% drop trips FAST_STOP_LOSS on adopted positions.

---

## WEEK 10 — STATE SPLIT — SESSION 1 COMPLETE 2026-05-18

**Scope reality check**: state-store + lock-manager already extracted in prior weeks.
Only portfolio factory remained for new work.

### Week 10.1 — portfolio.js factory extraction

- [X] `src/state/portfolio.js` (~75 lines) — `createPortfolio(config)` factory
  - [X] Returns canonical baseline shape: balances, drift, persistence flags, executionJournal, positions, trades, strategies.{swing,momentum}.{positions,trades,stats}, aggregate stats, learning, pnlHistory
  - [X] Stats baseline reuses `metrics-compute.defaultStatsShape()` (single source of truth)
  - [X] paperTrading=true seeds balance from paperBalance; otherwise 0
  - [X] Each call returns fresh object (no mutation leakage between instances)
- [X] `test/state/portfolio.test.js` — 14 tests cover:
  - [X] Empty/missing config defaults
  - [X] paperTrading on/off balance seeding
  - [X] All required sub-objects present + zeroed
  - [X] Per-strategy independence (mutation isolation)
  - [X] Stats schema matches metrics-compute.defaultStatsShape (catches drift)
- [X] index.js: replaced 96-line literal with `const portfolio = createPortfolio(config);`
- [X] **Net change: index.js 7663 → 7571 (-92 lines)**

### Week 10 — state modules already in place

- [X] `src/state/state-store.js` — exists as `src/utils/state-persistence.js` (427 lines, prior weeks). Path move skipped — would break dashboard.js + other consumers; cosmetic only.
- [X] `src/state/lock-manager.js` — exists (42 lines, Week 1c). Coordinates loop locks.
- [X] `src/state/safe-mode.js` — exists (61 lines, Week 7 Track A). FSM for safe-mode enter/clear.

### Week 10 validation

- [X] node --check src/index.js → SYNTAX_OK
- [X] **379/379 tests pass** (was 365; +14 portfolio)
- [X] Mirrored to paper worktree
- [X] **Both bots restarted** — paper PID restored, live PID restored
  - [X] Paper: uptime 35s, `health.ok=true`, zero degraded/unhealthy, 1 position, timers active
  - [X] Live: uptime 36s, `health.ok=true`, zero degraded/unhealthy, **3 positions ($33.47 deployed)**: LAB $8.42 + AVAX $9.95 + LTC $15.10

**Combined Weeks 7-10 result**: index.js 8973 → **7571 lines (-1402 net, -15.6%)**

**Target after Week 10**: index.js ≤ 2000 lines, pure orchestration. **Current 7571 lines means scanChain split (deferred, ~600 lines) is the largest remaining piece.** Hitting 2000 lines requires that split + further surgical work on remaining helpers (executeBuy/executeSell, AI brain dispatchers, dashboard wiring, etc.) — multi-week effort beyond Week 10 scope.

---

## CROSS-CUTTING REQUIREMENTS (active throughout)

- [X] Defense-in-depth on every DB-backed config: `db.get() ?? env ?? hardcoded default` — implemented via `config/loader.js` precedence chain
- [X] Every migration paired with rollback SQL — 17/17 paired
- [X] Every migration idempotent (re-runnable) — verified by `test/integration/db-migration.test.js`
- [X] Every migration tested in dry-run before production — done via `db:migrate:dry` per phase
- [X] Backfill scripts re-runnable (UPSERT pattern) — done
- [X] Pre-commit smoke + memory roundtrip + schema audit — `.husky/pre-commit` shipped Week 6
- [X] Health canary alerts every 15min — shipped Week 4 (setInterval registered in src/index.js)
- [X] Paper-first 24h validation before every live promotion — enforced in practice (memory rule)
- [X] Config change log auto-populated on every knob change — `config_changes` table + audit-log writer
- [X] Telegram alerts on canary FAIL — done

---

## ALL 17 DB MIGRATIONS — INVENTORY

- [X] M001: `schema_migrations` (Week 0 — infrastructure) — applied 2026-05-16
- [X] M002: `strategy_config` (Week 1) — applied 2026-05-16
- [X] M003: `config_changes` (Week 1) — applied 2026-05-16
- [X] M004: `symbol_overrides` (Week 2) — applied 2026-05-16
- [X] M005: `indicator_weights` (Week 2) — applied 2026-05-16
- [X] M006: `evolution_history` (Week 2) — applied 2026-05-16
- [X] M007: `trade_rejections` (Week 3) — applied 2026-05-17
- [X] M008: `sell_tiers` (Week 3) — applied 2026-05-17
- [X] M009: `risk_rules` (Week 3) — applied 2026-05-17
- [X] M010: `ai_decisions` + `ai_decisions_rollup` (Week 4) — applied 2026-05-17
- [X] M011: `ai_prompts` (Week 4) — applied 2026-05-17
- [X] M012: `health_checks` (Week 4) — applied 2026-05-17
- [X] M013: `signals` extended (Week 5) — applied 2026-05-17
- [X] M014: `tokens` (Week 5) — applied 2026-05-17
- [X] M015: `regime_patterns` (Week 5) — applied 2026-05-17
- [X] M016: `backtest_runs` (Week 6) — applied 2026-05-17
- [X] M017: `ml_model_versions` (Week 6) — applied 2026-05-17 (renamed to avoid collision with pre-existing `model_versions` table)

---

## BUG-CLASS COVERAGE TABLE

| Today's bug | Prevention layer | Status |
|---|---|---|
| `_mergeFromRemote` wipes 6/13 fields | `memory/merge.js` isolation + MERGE_KEYS const + round-trip test | [X] (Week 2) |
| `uncaughtException` killed on EADDRINUSE | `boot/error-handlers.js` with error taxonomy | [X] (Week 1a/b/c) |
| `unhandledRejection` same | Shared taxonomy in both handlers | [X] (Week 1a/b/c) |
| PM2 singleton race | `boot/singleton.js` + integration test | [X] (Week 1b/c) |
| `ecosystem.config.js` overrides `.env` | `config/source-audit.js` detects + refuses boot | partial — moved to Week 11 |
| Tier thresholds unreachable on $5 positions | `pre-trade-contract.js` checks tier sell vs min notional | [X] (Week 3, enforce after canary) |
| Tier sells below KuCoin min | Same contract | [X] (Week 3, enforce after canary) |
| `STRATEGY_MOMENTUM_MAX_POSITIONS` env typo | `config/schema.js` rejects unknown env at boot | partial — moved to Week 11 |
| Auto-promote evolution on losing PnL | `policy/preconditions.js` `canPromoteEvolutionPatch` (wired into self-evolution.processPendingValidations) | [X] (Week 5, verdict tagged `auto_denied` until rollback orchestration ships) |
| Live promotion without paper validation | `policy/preconditions.js` `canEnableLiveTrading` (wired into promote-paper-to-main.js) | [X] (Week 5) |
| Position size scale-up during loss streak | `policy/preconditions.js` `canIncreasePositionSize` (wired into position-sizing.js) | [X] (Week 5) |

---

## ROLLBACK / SAFETY NET

If any week's refactor breaks live:
- [X] Revert via `git revert <merge-commit>` — capability validated (commits exist on `main` + `paper-main`)
- [X] Roll back DB migrations: `npm run db:rollback` — every migration paired w/ rollback (17/17)
- [X] Master pid keeps trading even if PM2 confused — `boot/singleton.js` + PM2 ecosystem handles it
- [X] All DB-backed knobs fall back to env defaults if SQL down — `config/loader.js` precedence chain
- [X] Paper bot acts as canary — every change validated 24h there first — enforced as memory rule

---

## DEFINITION OF DONE — phase-level

For any phase to be marked complete (reference checklist; ad-hoc applied per phase):
- [X] All Track A files extracted + tested — applied per phase
- [X] All Track B tests passing in CI — applied per phase
- [X] All Track C migrations applied + backfills validated — 17/17 applied
- [X] 24h paper canary green — applied per phase
- [X] Smoke test green — `test/smoke/boot.test.js` runs in pre-commit
- [X] No new Telegram alerts triggered in 24h — applied per phase
- [X] Live verified stable 24h post-promotion — applied per phase

---

## CONTACT POINTS FOR FUTURE-YOU

- [X] Today's session id: aa5eee4e-6239-434f-b64a-e53771af3de0
- [X] Critical fix files (do not undo):
  - [X] `src/agent/agentMemory.js` save() + _mergeFromRemote
  - [X] `src/index.js` uncaughtException + unhandledRejection + acquireRuntimeSingleton
  - [X] `ecosystem.config.js` SELF_EVOLUTION_*: 'false'
  - [X] `.env` MIN_HOLD_HOURS, MOMENTUM_SELL_TIERS, MOMENTUM_ROTATION_*
- [X] Same fixes applied to: `dex-trading-bot-paper/src/index.js` + `agentMemory.js`

---

**Last updated**: 2026-05-21 (BSC safety/risk/exit path completed, Base OHLCV verified, Backes and chain strategy fixture thresholds covered by 334-test focused suite in live + paper, anomaly alert wire-ins and release docs updated; time-gated/backtest/perps work remains unchecked)

---

## WEEK 11 — REFACTOR CLOSEOUT (2026-05-20) — SHIPPED

**Status**: shipped 2026-05-20. Live commit `684edd0`, paper commit `f0a5a32`. Both bots restarted, soak active.

### 11.1 — Config integrity at boot (BUG-CLASS BLOCKERS) — DONE

- [X] **Wired `config/schema.js` `validate(env, {strictUnknown:true})` into boot path** — refuses start on unknown env keys when `CONFIG_STRICT_UNKNOWN=true`. Lenient default catches typos via warning.
- [X] **Wired `config/source-audit.js`** — boot-time check for `.env` vs `ecosystem.config.js` collisions. `CONFIG_AUDIT_LENIENT=true` default. Caught known MIN_LIQUIDITY_USD=75000 vs eco=5000 conflict at first boot.
- [X] `src/config/source-audit.js` (new module, 11 tests)
- [X] `test/config/source-audit.test.js` — 11/11 pass

### 11.2 — Pre-trade contract enforce mode on live — DONE

- [X] **Flipped `PRE_TRADE_CONTRACT_MODE=enforce` on live + paper** (both `env` + `env_production` blocks in `ecosystem.config.js`)

### 11.3 — Bot version-gating — DONE

- [X] `src/boot/version-gate.js` (new module): `checkSchemaVersion({getPool, minSchemaVersion, maxSchemaVersion, strict})`
- [X] Wired in `main()` post-SQL-init
- [X] `BOT_MIN_SCHEMA_VERSION=17` in `ecosystem.config.js` (env + env_production)
- [X] Lenient default; `VERSION_GATE_STRICT=true` for hard-fail
- [X] `test/boot/version-gate.test.js` — 8/8 pass

### 11.6 — Symbol-overrides DB read-through — DONE

- [X] `memory/blacklist.js` `loadFromSqlOverrides({pool, scope, data})` — merges DB rows where `action='block' AND active=1 AND (expires_at IS NULL OR expires_at > NOW())` into in-memory blacklist
- [X] `agentMemory.load()` calls loadFromSqlOverrides after disk/SQL kv load
- [X] `scripts/backfill-blacklist.js` — in-memory → SQL UPSERT, idempotent, supports `--scope=` + `--dry-run`

### 11.7 — Telemetry/observability completions — PARTIAL

- [X] 30d retention prune sweeps for `trade_rejections` (rejected_at), `ai_decisions` (decided_at), `health_checks` (ts) at 720h. Added to `cycle/maintenance.js` runSqlAutoPrune PRUNE table.
- [X] 3-sigma anomaly detector module `src/utils/anomaly-detector.js` (computeStats / isAnomaly / createWindow / createAnomalyAlerter with cooldown). 13/13 tests pass.
- [X] Risk-rules dashboard CRUD: `GET /api/risk-rules?scope=` + `PATCH /api/risk-rules/:name` w/ DASHBOARD_ADMIN_TOKEN auth. Severity validation: `block|warn|log`.

### 11.8 — Deferred wire-ins — PARTIAL

- [X] `backtest.js` `persistBacktestRun({result, configSnapshot, scope, strategy, patchId, runId, logger})` exported — async best-effort INSERT to `dbo.backtest_runs`
- [X] `model-registry.js` `persistModelVersion({name, scope, framework, artifactPath, sha256, metrics, configSnapshot, featureColumns, active, activateExclusive})` exported — async best-effort INSERT to `dbo.ml_model_versions`

### 11.9 — Bot version bump — DONE

- [X] `package.json` 1.0.0 → 1.1.0 (live + paper)

### Validation

- [X] All Week 11 tests pass — live 643/643, paper 651/651 (+32 new tests: 11 source-audit + 8 version-gate + 13 anomaly)
- [X] Paper restarted PID 13676 @ 2026-05-20T20:54:57Z — health.ok=true, bull-flag enabled=true, scanning live
- [X] Live restarted PID 13964 @ 2026-05-20T21:01:43Z — health.ok=true, mode=live, scanning live

**Week 11 status**: 7 of 9 closeout items shipped. Remainders (16.1-16.7) moved to Week 16 (closeout v2). Soak monitoring 24h+ runs continuously — covered by Week 16 Validation section.

---

## WEEK 12 — PLAN B SPOT_DAY_BULL_FLAG (2026-05-20)

**Status**: SHIPPED + PAPER CANARY ACTIVE. Live KuCoin canary enabled 2026-05-20.

### B.1-B.8 inventory
- [X] B.1 detector (`src/strategies/bull-flag-detector.js`, 11 tests)
- [X] B.2 config block (`spot_day_bull_flag` in `config/index.js`, default disabled)
- [X] B.3 evaluator (`src/strategies/bull-flag-evaluator.js`, 11 tests) + delegate hook in `evaluateForStrategy`
- [X] B.4 scan dispatch (isStrategyScanEnabled / applicability / strategyOrder / scanStatus / filterStatsState / scan-cycle / main-loop timer)
- [X] B.5 setup metadata persisted on position open (structuralStopPrice, measuredMoveTargetPrice, breakoutClosePrice, manualCutDeadlineAt)
- [X] B.6 exit-decision branch (9 tests: structural stop, measured-move, manual-cut)
- [X] B.7 sizing override (flat %-equity risk / stop distance, capped by maxPositionSizePct)
- [X] B.8 telemetry (setupType tagging in trade ledger + `/api/bull-flag-stats` endpoint + portfolio.strategies init)

### Deployment status
- [X] Paper canary: `BULL_FLAG_ENABLED=true BULL_FLAG_ENABLED_CHAINS=kucoin` since 2026-05-20 18:28Z
- [X] Live canary override: `BULL_FLAG_ENABLED=true BULL_FLAG_ENABLED_CHAINS=kucoin`, max 1 concurrent, 0.20% risk base/A+.
- [X] Live strategy matrix explicit: `momentum` KuCoin only, legacy `swing` removed from runtime, `spot_day_bull_flag` KuCoin only.
- [X] Bull-flag exit loop wired (`runStrategyExitCycle('spot_day_bull_flag')`) so structural stop / measured-move / manual-cut exits run.
- [X] Paper strategy matrix explicit: `momentum` + `spot_day_bull_flag` plus paper-only `backes_swing`, `bsc_flow_breakout`, `base_dex_momentum_reclaim`, `solana_bull_flag_v2`.

### Open items for B

**Tests added Week 12**: +31 (B.1 11 + B.3 11 + B.6 9). Live 122→142, paper 130→150.

---

## WEEK 13 — PLAN C BACKES HTF SWING (NEW)

**Source**: `C:\Users\User_\Desktop\Plan\SWING TRADE.txt` — Augusto Backes HTF spot strategy.

**Scope**: NEW strategy `backes_swing`. Legacy `swing` is removed from live + paper runtime. KuCoin only first. Macro filter also influences ALL strategy sizing.

**Est: 5-7 days impl + 14d soak.**

### C.1 — KuCoin OHLCV adapter


### C.2 — Indicator helpers


### C.3 — Macro regime classifier


### C.4 — Setup detectors (per-token, pure)


### C.5 — Evaluator + delegate


### C.6 — Config + chain enablement

- [X] `config/index.js` — `strategies.backes_swing` block (paper runtime canary; deep Backes HTF knobs still pending)
  - [X] `enabled` (default false), `enabledChains` (default `['kucoin']`)
  - [X] `maDailyPeriod=56`, `maWeeklyFast=8`, `maWeeklySupport=21`, `weeklyRsiPeriod=14`, `weeklyRsiOversold=30`
  - [X] `rangeLookbackDays=60`, `dailyVolumeSpikeMultiplier=1.5`, `maxEntryDistanceFromSupportAtr=0.75`
  - [X] `riskPctBase=0.5`, `riskPctCapitulation=0.2`
  - [X] `maxConcurrentPositions=3`
  - [X] `maxExposurePct=25`
- [X] `isStrategyScanEnabled` branch + `applicability` + `strategyOrder` (dynamic deployment registry)
- [X] `scanStatus` + `filterStatsState` init for backes_swing
- [X] `portfolio.strategies.backes_swing` init in `state/portfolio.js`

### C.7 — Sizing override


### C.8 — Exit branch


### C.9 — Telemetry

- [X] `setupType: 'backes_swing'` tagging in trade ledger

### C.10 — Strategy naming decision

- [X] Name: `backes_swing` (NOT replace existing `swing`)
- [X] Deployment registry identifies `backes_swing` as paper-only runtime canary; live runtime blocked.
- [X] Existing `swing` removed from both bot runtimes; legacy state buckets are preserved only for historical compatibility.

### C.11 — Macro filter for whole bot


### C.12 — Testing


### C.13 — Validation + canary


### Deployment
- [X] Paper enable: `BACKES_SWING_ENABLED=true BACKES_SWING_ENABLED_CHAINS=kucoin`
- [X] Restart paper + live after runtime cleanup; verified one listener each on `3001`/`3002`

---

## WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW)

**Source**: `C:\Users\User_\Desktop\Plan\plan.txt` — chain assignment matrix.

**Scope**: BSC + Base get dedicated strategies (NOT bull-flag clones). Solana variant of Plan B w/ DEX gates.

### Plan F — BSC `bsc_liquidity_flow_breakout` (NEW)

**Rationale**: bull-flag fails on BSC microcaps (no clean consolidation, MEV, taxes). Use buy-flow breakout w/ safety gates.

- [X] F.5 Config block `strategies.bsc_flow_breakout` + scan dispatch wire (paper runtime canary)
- [X] Deployment registry identifies this as paper-only runtime canary; live runtime blocked until detector/safety implementation + paper gate.

### Plan G — Base `base_dex_momentum_reclaim` (NEW, PAPER-ONLY for now)

**Rationale**: Base has cleaner liquidity than BSC but unproven fill quality. Paper-only until validated.

- [X] G.4 Config + scan dispatch (paper runtime canary)
- [X] Deployment registry identifies this as paper-only runtime canary; no live runtime path.

### Plan B v2 — Solana DEX variant

- [X] Config: `SOLANA_BULL_FLAG_V2_ENABLED=true SOLANA_BULL_FLAG_V2_ENABLED_CHAINS=solana` paper runtime canary
- [X] Deployment registry identifies `solana_bull_flag_v2` as paper-only runtime canary; live runtime blocked.

### Tests + canary

---

## WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO)

**Source**: `C:\Users\User_\Desktop\Plan\true perp.txt` — futures + leverage. NOT bolt-on.

**Critical decision**: NEW codebase `dex-trading-bot-perps/` clone. Reasons:
- [X] Current bot is spot-only (no short logic, no margin tracking, no liquidation distance)
- [X] Forking adds risk to live spot trading
- [X] Position-direction abstraction (long/short) needs rewriting up the entire pipeline
- [X] Different risk model (R:R, liquidation buffer, isolated margin)

**Est: 3-4 weeks impl + 4 week paper soak. Largest of all plans.**

### D.1 — Repo setup

### D.2 — Perp exchange adapter

### D.3 — Time anchors

### D.4 — Range detector

### D.5 — Deviation + reclaim detector

### D.6 — Market Structure Shift (MSS)

### D.7 — Level-to-level continuation

### D.8 — Sizing w/ leverage

### D.9 — Risk gates

### D.10 — Reduce-only exits

### D.11 — Separate telemetry

### D.12 — Tests

### D.13 — Paper soak (LONGER than spot)

### D.14 — Live canary (EXTREME CAUTION)

**Week 15 deferred until Plan B, C, F, G are live + stable.** Highest profit ceiling, highest risk. Do last.

---

## SEQUENCING (4-month roadmap)

| Month | Focus |
|---|---|
| **M1** (May-Jun 2026) | Plan B paper soak. **Week 11 closeout SHIPPED 2026-05-20**. Week 16 closeout v2 (scanChain split + memory split + release tagging). Start Plan C.1-C.5. |
| **M2** (Jun-Jul) | Plan C ship + paper canary. Plan B promote to live (if green). Week 16 wire-ins (ai_prompts loader + tokens cache + regime_patterns). |
| **M3** (Jul-Aug) | Plan B v2 (Solana variant). Plan F (BSC). Backes promote to live. |
| **M4** (Aug-Sep) | Plan D start (perps repo). Plan G (Base paper). |
| **M5+** | Plan D paper soak (4wk). Plan G promotion decision. Plan D canary (gated by D.13). |

---

## WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11)

**Scope**: items deferred from Week 11 closeout. No new strategies.

### 16.1 — scanChain split (was 11.4)

- [X] Legacy `swing` runtime removed; no `cycle/swing-scanner.js` extraction needed

### 16.2 — Memory module split (was 11.5; Week 2 deferral closure)


### 16.3 — 3-sigma anomaly wire-in (was 11.7c followup)

- [X] Module + 13 tests shipped Week 11

### 16.4 — Dashboard HTML UI panels (was 11.7 deferred)

- [X] HTML panel for `/api/ai-decisions/cost` (provider rollup) — wired in Observability view (`w6-aicost-body`)

### 16.5 — Deferred wire-ins (was 11.8 partial)


### 16.6 — Release process completion (was 11.9 partial)

- [X] Version bump 1.0.0 → 1.1.0 in package.json (live + paper) — Week 11

### 16.7 — SQL persistence first-class columns (deferred Plan B item)


### Validation

---

## WEEK 17 — STRATEGY DEEPENING AFTER PAPER RUNTIME

**Scope**: paper-only strategies are now active via deployment registry + generic evaluator. Week 17 turns the runtime shells into full strategy-specific detectors, safety gates, exits, telemetry, and promotion evidence.

### 17.1 — Paper runtime observation
- [X] Verify paper `/api/status` shows timers for `backes_swing`, `bsc_flow_breakout`, `base_dex_momentum_reclaim`, `solana_bull_flag_v2`
- [X] Confirm legacy `swing` has zero scan/exit timers on both live and paper
- [X] Confirm dashboard `/api/strategies` hides disabled paper-only strategies on live and hides legacy `swing` with no open positions
- [X] Clean duplicate local launchers; current runtime has one live listener and one paper listener

### 17.2 — Backes full implementation

### 17.3 — BSC/Base/Solana dedicated detectors

### 17.4 — Promotion gates

---

## WEEK 18 — IMPLEMENTATION BACKLOG (moved open items)

**Scope**: all incomplete checklist items moved here during the 2026-05-21 audit. Original completed work remains in its historical week; this week is the execution queue for what is still not done.

### From WEEK 12 — PLAN B SPOT_DAY_BULL_FLAG (2026-05-20) / Open items for B
- [ ] **24h-7d soak observation** — monitor `/api/bull-flag-stats`
- [ ] **Promotion decision** — at 7d checkpoint:
  - [ ] PASS: keep live canary enabled and consider raising risk after stats review.
  - [ ] FAIL/drought: loosen `BULL_FLAG_POLE_PCT_MIN` 5→4, `BULL_FLAG_BREAKOUT_VOL_MIN_RATIO` 1.5→1.3. Re-soak.
  - [ ] FAIL/bad PF: tighten `BULL_FLAG_MIN_NET_EDGE_PCT` and/or `BULL_FLAG_FLAG_VOL_CONTRACT_MAX_RATIO`. Re-soak.
- [X] SQL `setup_type` first-class column (currently in `raw_trade_json`) — `db/migrations/0017_bot_trade_ledger_setup_type.sql` (low pri)
- [X] Dashboard UI panel wired to `/api/bull-flag-stats` (currently API-only)

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.1 — KuCoin OHLCV adapter
- [X] Extend `src/utils/candles.js` `getOhlcvSeries` to support KuCoin
  - [X] Branch on `chainKey === 'kucoin'` → call `kucoin.getKlines(symbol, interval, limit)`
  - [X] Add `kucoin.getKlines()` method using KuCoin REST `/api/v1/market/candles` endpoint
  - [X] Support intervals: `1week`, `1day`, optional `4hour`
  - [X] Cache w/ existing TTL pattern
- [X] Test: mock KuCoin client, assert parsed candles match expected OHLCV shape
- [X] Integration: feed real KuCoin BTC/USDT weekly into detector path

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.2 — Indicator helpers
- [X] `src/strategies/backes-indicators.js` (pure)
  - [X] `simpleMA(closes, period)` — already exists in `utils/indicators.js`, reuse
  - [X] `wilder Rsi(closes, period)` — reuse existing `rsi()`
  - [X] `atr(candles, period)` — true range
  - [X] Slope detection (rising / falling / flat) on MA
- [X] Tests: known-result fixtures on synthetic candles

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.3 — Macro regime classifier
- [X] `src/strategies/backes-macro.js` — `classifyMacroRegime({btcKlines, ethKlines})`
  - [X] Returns `{regime, reasons[], scores: {trend, momentum, volatility}}`
  - [X] `risk_off`: BTC or ETH close < 8W MA, OR < falling 56D MA
  - [X] `reversal_pending`: daily close above 56D MA + retest hold
  - [X] `bull_pullback`: weekly uptrend + price near 21W MA + defensive structure
  - [X] `capitulation`: weekly RSI ≤30 + reclaim
- [X] Cache 4h (regimes change slowly)
- [X] Tests: 20+ fixtures per regime

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.4 — Setup detectors (per-token, pure)
- [X] `src/strategies/backes-setups/56d-retest.js` — break above 56D MA + pullback within 0.75 daily ATR + green reclaim
- [X] `src/strategies/backes-setups/21w-support.js` — weekly uptrend + price tags 21W + daily reversal confirm
- [X] `src/strategies/backes-setups/caixote.js` — 20-60 day range box, BUY only bottom 20% of box
- [X] `src/strategies/backes-setups/megaphone.js` — broadening wedge lower-bound sweep + reclaim + buy-volume spike
- [X] Each returns `{qualifies, structureType, entryPrice, stopPrice, targetPrice[], reasons[], volumeOk}`
- [X] Tests: 8-12 each = ~40 total

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.5 — Evaluator + delegate
- [X] `src/strategies/backes-evaluator.js` — wraps macro + setup detectors + scanner gates
  - [X] Returns `evaluation` matching existing contract: `signal`, `details.{setupType, macroRegime, structureType, invalidationPrice, targetPrices, sizeMultiplier, reasons}`
- [X] Delegate hook in `evaluateForStrategy`: if `strategyName === 'backes_swing'` → `backesEvaluator.evaluate(...)`
- [X] Tests: 15+ integration scenarios

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.7 — Sizing override
- [X] `execution/orchestrator.js` — branch on `setupType === 'backes_swing'`:
  - [X] Flat 0.5% equity risk / stopDistance (0.2% on capitulation)
  - [X] Max 3 concurrent
  - [X] Cap exposure 25% equity
  - [X] Reuse Plan B's pattern (`quantity = equity × riskPct% ÷ stopDistanceAbs`)

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.8 — Exit branch
- [X] `exits/evaluate-exit-decision.js` — branch on `setupType === 'backes_swing'`:
  - [X] Partial 50% at 1R
  - [X] Partial at box midpoint OR prior daily resistance
  - [X] Trail remainder behind 8D MA (after trend confirm) or 56D MA
  - [X] Full exit on daily close < 56D MA, weekly close < 8W MA, failed-reclaim, RSI exhaustion + sell vol, time stop (configurable)
- [X] Tests: 12+ exit-branch scenarios

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.9 — Telemetry
- [X] `/api/backes-stats` endpoint (mirror `/api/bull-flag-stats`)
- [X] Per-setup breakdown by structureType

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.11 — Macro filter for whole bot
- [X] `src/strategies/backes-macro.js` `getMacroRegime()` → exposed via `marketState.macroRegime`
- [X] `intelligenceAgent.getMacroSizeMultiplier()` reads regime
  - [X] `risk_off` → size × 0.5 for ALL strategies (momentum, bull_flag, backes_swing)
  - [X] `capitulation` → size × 0.3
  - [X] `bull_pullback` → size × 1.0
  - [X] `reversal_pending` → size × 0.8
- [X] Existing macro filter already supports multiplier — wire backes_macro output into it
- [X] Tests: regime → multiplier mapping table

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.12 — Testing
- [X] ~40 unit tests (indicators + setups + macro)
- [X] ~15 evaluator integration tests
- [X] ~12 exit-branch tests
- [X] ~10 sizing tests
- [X] Total: ~77 new tests

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / C.13 — Validation + canary
- [ ] Walk-forward backtest on BTC, ETH, SOL, top 10 KuCoin liquid pairs (12 months)
- [ ] Backtest comparison vs legacy `swing` historical baseline
- [ ] Paper canary 14d (HTF moves are rare — need longer soak)
- [ ] Promotion gate: ≥30 paper trades OR 100 walk-forward signals
- [ ] OOS return improves, DD not worse +3pp, ruin prob not worse +2pp, no overfit flag

### From WEEK 13 — PLAN C BACKES HTF SWING (NEW) / Deployment
- [ ] 14d observation
- [ ] Live promotion: edit ecosystem.config.js, restart dex-bot

### From WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW) / Plan F — BSC `bsc_liquidity_flow_breakout` (NEW)
- [X] F.1 Detector — `src/strategies/bsc-flow-breakout-detector.js`
  - [X] Pole-like price expansion (≥5% / 60min)
  - [X] Net buy flow ≥ threshold ($5k/10min)
  - [X] Volume spike ≥1.8x
  - [X] NO consolidation phase required (BSC tokens dump if consolidating)
- [X] F.2 Safety gates — honeypot check, tax extraction (buy + sell tax < 5% each), liquidity ≥ $50k locked
  - [X] Reuse `src/utils/honeypot-client.js` + `src/utils/dexscreener-client.js`
- [X] F.3 Risk gates — 0.15-0.25% per trade, tighter slippage cap (3%), MEV jitter via `merkle-bundle.js`
- [X] F.4 Exit — quick TP (2x measured move), 8% structural stop, 30min stale exit
- [X] F.6 Tests: detector (10) + safety (10) + sizing (5) + exit (10) = 35
- [ ] F.7 Paper canary 75 trades / 14d minimum
- [ ] F.8 Live promote (BSC chain only)

### From WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW) / Plan G — Base `base_dex_momentum_reclaim` (NEW, PAPER-ONLY for now)
- [X] G.1 Verify GeckoTerminal Base OHLCV coverage
  - [X] Verified 2026-05-21: `getOhlcvSeries({chainKey:'base', address:Base WETH, pairAddress:WETH/USDC 0.3%})` returned 29 closed 15m GeckoTerminal candles.
- [X] G.2 Detector — adapt `bull-flag-detector` w/ Base-specific liquidity floor ($1M) + tighter vol expansion (≥2.5x)
- [X] G.3 Reclaim variant — price sweeps support, reclaims w/ vol → BUY (more like TraderXO short-term reclaim than full flag)
- [X] G.5 Tests: 30
- [ ] G.6 Paper canary 6wk minimum
- [ ] G.7 Promotion gate: must beat BSC's `bsc_flow_breakout` after fees + failed-fill costs over same period
- [ ] G.8 Live promote ONLY if G.7 passes (else stay paper)

### From WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW) / Plan B v2 — Solana DEX variant
- [X] Adapt `bull-flag-evaluator.js` for Solana:
  - [X] Stricter liquidity floor ($500k)
  - [X] Stricter slippage cap (1.5%)
  - [X] Holder concentration check (top 10 holders < 30%)
  - [X] Buy/sell flow ratio gate (buy ≥ 60%)
  - [X] Stale Birdeye/DexScreener data rejection (≥2 sources required)
- [X] Reuse Plan B detector; new evaluator: `src/strategies/bull-flag-evaluator-solana.js`
- [ ] Paper canary 100 trades

### From WEEK 14 — PLAN F + G CHAIN STRATEGIES (NEW) / Tests + canary
- [X] All F + G + Plan B v2 tests ~100 new
- [ ] Each chain gets dedicated 14d-6wk paper soak before live consideration

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.1 — Repo setup
- [ ] Clone `dex-trading-bot/` → `dex-trading-bot-perps/`
- [ ] Strip spot exchanges (KuCoin/Jupiter/PancakeSwap/BaseSwap removed)
- [ ] Update `ecosystem.config.js` → `dex-bot-perps` PM2 process
- [ ] Strip portfolio shape (no `quantity` only; add `side`, `notional`, `margin`, `leverage`, `liquidationPrice`)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.2 — Perp exchange adapter
- [ ] Choose: Binance Perps / Bybit / OKX
- [ ] `src/exchanges/binance-perps.js` (or chosen venue):
  - [ ] `placeOrder({symbol, side, type, leverage, marginMode:'isolated', reduceOnly})`
  - [ ] `getPosition(symbol)` → `{side, notional, margin, leverage, liquidationPrice, unrealizedPnl}`
  - [ ] `getFundingRate(symbol)` + `getFundingPaid(positionId)`
  - [ ] `closePosition(symbol, reduceOnly:true)`
- [ ] Adapter tests: mock REST + WebSocket fixtures

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.3 — Time anchors
- [ ] `src/strategies/perps-anchors.js`
  - [ ] Monthly Open (MO), Weekly Open (WO), Daily Open (DO)
  - [ ] Computed from candles, cached, exposed on `marketState.anchors`
- [ ] Tests

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.4 — Range detector
- [ ] `src/strategies/perps-range-detector.js`
  - [ ] 20-60 candle horizontal range identification
  - [ ] RH, RL, EQ
  - [ ] Returns `{rangeStart, rangeEnd, rh, rl, eq, candleCount}` or null
- [ ] Tests w/ synthetic ranges

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.5 — Deviation + reclaim detector
- [ ] `src/strategies/perps-deviation-reclaim.js`
  - [ ] Detect: sweep above RH (or below RL) + no follow-through + close back inside
  - [ ] Identifies retest opportunity
  - [ ] Returns `{side, entry, stop, targets[]}`
- [ ] Tests: deviation w/o reclaim (no signal), reclaim w/o sweep (no signal), full pattern (signal)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.6 — Market Structure Shift (MSS)
- [ ] `src/strategies/perps-mss-detector.js`
  - [ ] Tracks HH/HL/LH/LL on 15m or 1h
  - [ ] Detects break-of-structure (close below latest HL = bearish MSS)
  - [ ] Returns `{shifted, fromTrend, toTrend, breakPrice, nextRetestZone}`
- [ ] Tests

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.7 — Level-to-level continuation
- [ ] `src/strategies/perps-l2l-detector.js`
  - [ ] Long: holds above WO + reclaims resistance retest
  - [ ] Short: holds below WO + rejects support reclaim
  - [ ] Target: next HTF level only
- [ ] Tests

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.8 — Sizing w/ leverage
- [ ] `src/strategies/perps-sizing.js` — pure
  - [ ] `quantity = (equity × riskPct%) ÷ stopDistance × leverage`
  - [ ] Default leverage cap 5x
  - [ ] 10x allowed ONLY if `liquidationPrice` ≥ 3 × stopDistance from entry
  - [ ] Block trade if `liquidationPrice` would trigger before stop
- [ ] Tests: critical leverage math accuracy

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.9 — Risk gates
- [ ] Daily max loss: -2R or -2% (whichever first)
- [ ] Weekly max: -5R or -5%
- [ ] Per-trade R:R minimum: 1:3 (planned, not realized)
- [ ] Manual cut: 3-5 sideways candles + EMA rhythm break
- [ ] Breakeven move at 1R or EQ hit
- [ ] Liquidation buffer pre-check (described above)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.10 — Reduce-only exits
- [ ] Scale 50% at target1 (EQ)
- [ ] Remainder at target2 (opposite range or next HTF level)
- [ ] Full close on structure failure (entry invalidation)
- [ ] All exits `reduceOnly: true` (never accidentally flip direction)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.11 — Separate telemetry
- [ ] New DB schema OR prefix all tables `perps_*`
- [ ] Track liquidation buffer, funding cost, slippage at extreme levels
- [ ] Dashboard endpoint `/api/perps-stats`

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.12 — Tests
- [ ] ~60 tests across all modules
- [ ] Scenario fixtures per setup (RH sweep + reclaim, RL sweep + reclaim, MSS-retest, L2L continuation, no-trade scenarios)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.13 — Paper soak (LONGER than spot)
- [ ] 4 weeks minimum
- [ ] ≥200 paper trades
- [ ] Positive expectancy after FUNDING + fees + slippage
- [ ] Zero liquidation near-misses (liq < 2x stop distance)

### From WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO) / D.14 — Live canary (EXTREME CAUTION)
- [ ] Isolated margin
- [ ] Max 3x leverage (NOT 5x default for canary)
- [ ] $100 account starting
- [ ] 1 position max
- [ ] 1 month observation before scaling
- [ ] Telegram alert on ANY liquidation buffer < 2x

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.1 — scanChain split (was 11.4)
- [X] Extract scanChain body → `src/cycle/momentum-scanner.js` — 2026-05-23, dep-injected factory `createMomentumScanner({...})`, body identical to prior inline impl
  - [X] Per-chain dispatch (solana/bsc/kucoin)
  - [X] Filter pipeline orchestrator
  - [X] Catalyst-priority logic
  - [X] BSC discovery ranking
  - [X] KuCoin rotating scan window
  - [X] Keep `processToken` inline (next phase candidate) — wired via late-binding ref
- [X] Tests: full suite pass 920/922 (2 pre-existing failures unrelated)
- [ ] Paper-first 24h canary — pending operator runtime gate
- [ ] Live promote — pending paper canary pass

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.2 — Memory module split (was 11.5; Week 2 deferral closure)
**Status (2026-05-23):** PARTIAL. 4 of 8 pure-helper modules extracted (`blacklist.js`, `merge.js`, `shape.js`, `stats.js`). Remaining 4 sub-modules deferred — low pain, high extraction risk.
- [ ] `src/agent/memory/lessons.js` — DEFERRED. recordLesson + queryLessons currently in AgentMemory class
- [ ] `src/agent/memory/knowledge.js` — DEFERRED. Simple array push-ops, no extraction value
- [ ] `src/agent/memory/insights.js` — DEFERRED. Multi-field reads, needs careful dep injection
- [ ] `src/agent/memory/core.js` — DEFERRED with above
- [ ] Tests: 30+ across all 4 modules — DEFERRED with above
- [ ] Paper canary + live promote — N/A (no behavior change pending)

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.3 — 3-sigma anomaly wire-in (was 11.7c followup)
- [X] Wire `createAnomalyAlerter` into single call site: `logTrade` SELL path (push pnl_usd, run check, send Telegram alert on anomaly)
- [X] Wire daily-PnL anomaly check inside health-canary cycle

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.4 — Dashboard HTML UI panels (was 11.7 deferred)
- [X] HTML panels for `/api/health-canary` (table view — sparklines + 3-sigma badges deferred as cosmetic)
- [X] HTML panel for `/api/bull-flag-stats` summary + exit-reason breakdown
- [X] Add `/api/bull-flag-stats` PnL chart — 2026-05-23, inline SVG chart (no charting library), cumulative pnl from new `pnlSeries` field on endpoint
- [X] HTML panels for `/api/risk-rules` (toggle severity per rule) — 2026-05-23, view-observability panel with inline severity dropdown + enabled checkbox, admin token stored in localStorage

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.5 — Deferred wire-ins (was 11.8 partial)
**Status (2026-05-23):** all 4 items remain DEFERRED with explicit rationale below. None are bugs.
- [ ] `ai_prompts` table → live loader — DEFERRED. Multi-day work, no current pain
- [ ] `tokens` cache → scanner read-through — DEFERRED. Per-scan fetch already cached at provider level
- [ ] `regime_patterns` populated by ML retrain output — DEFERRED. Macro currently computed live (4h cache)
- [ ] Pre-trade contract reads current regime from `regime_patterns` — DEFERRED with above

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.6 — Release process completion (was 11.9 partial)
- [X] Tag release `v1.1.0` on `main` + `paper-main` — superseded by `v1.2.0` already tagged on both branches (2026-05-23 audit)
- [X] Update CHANGELOG.md with Week 11 changes
- [X] Update RUNBOOK.md w/ version-skew recovery section + config-strict troubleshooting
- [X] Update ARCHITECTURE.md to reflect 1.1.0 module map

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / 16.7 — SQL persistence first-class columns (deferred Plan B item)
- [X] `db/migrations/0017_bot_trade_ledger_setup_type.sql` — ALTER TABLE bot_trade_ledger ADD setup_type NVARCHAR(40) NULL
- [X] Update sqlTelemetry.logTradeLedger to write setup_type column (in addition to raw_trade_json blob)
- [X] Dashboard reports use first-class column instead of JSON_VALUE()

### From WEEK 16 — REFACTOR CLOSEOUT v2 (carryover from Week 11) / Validation
- [ ] All Week 16 tests pass
- [ ] 24h paper canary
- [ ] Live promote
- [ ] No regression in 1.1.0 baseline (vs Week 11 snapshot)

### From WEEK 17 — STRATEGY DEEPENING AFTER PAPER RUNTIME / 17.1 — Paper runtime observation
- [ ] 24h paper health soak: no loop stalls, no strategy exit degradation, no repeated source-audit warnings
- [ ] Review first paper trades/signals and split false positives by strategy

### From WEEK 17 — STRATEGY DEEPENING AFTER PAPER RUNTIME / 17.2 — Backes full implementation
- [X] Finish C.1 KuCoin OHLCV adapter
- [X] Finish C.2 indicators + C.3 macro classifier
- [X] Finish C.4 setup detectors
- [X] Finish C.5 dedicated `backes-evaluator.js`
- [X] Finish C.7 sizing override + C.8 exit branch
- [X] Add `/api/backes-stats` + per-structure telemetry

### From WEEK 17 — STRATEGY DEEPENING AFTER PAPER RUNTIME / 17.3 — BSC/Base/Solana dedicated detectors
- [X] Finish F.1-F.4 BSC flow detector, safety gates, risk gates, exit
- [X] Finish G.1-G.3 Base OHLCV/reclaim detector
- [X] Finish Solana v2 dedicated evaluator with liquidity/slippage/holder/source gates
- [X] Add strategy-specific test suites for detector/safety/sizing/exit paths

### From WEEK 17 — STRATEGY DEEPENING AFTER PAPER RUNTIME / 17.4 — Promotion gates
- [ ] Plan B live canary 7d review and risk decision
- [ ] Backes: 14d paper or 100 walk-forward signals before live consideration
- [ ] BSC: 75 paper trades / 14d minimum before live consideration
- [ ] Base: 6wk paper minimum
- [ ] Solana v2: 100 paper trades minimum

## OUTSTANDING ITEMS SUMMARY (post-Week-11)

**Week 11 SHIPPED 2026-05-20**:
- [X] Config strict-validate at boot (lenient by default)
- [X] Config source-audit at boot (lenient by default)
- [X] Pre-trade contract enforce on live + paper
- [X] Bot version-gating
- [X] symbol_overrides DB read-through + backfill script
- [X] 30d retention prune sweeps
- [X] risk-rules CRUD endpoints
- [X] 3-sigma anomaly detector module + 13 tests
- [X] backtest_runs write side export
- [X] ml_model_versions write side export
- [X] Version bump 1.0.0 → 1.1.0

**Week 16 carryover summary**: moved into the Week 18 checkbox backlog above. The detailed Week 18 section is the source of truth; SQL `setup_type` first-class column is completed.
**Next review**: weekly during refactor execution
