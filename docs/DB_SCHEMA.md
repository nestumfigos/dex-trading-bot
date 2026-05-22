# DB_SCHEMA.md

**Status**: living doc. Updated per migration.
**MSSQL version**: TBD (record on first `db:status` run).
**Connection**: `SQL_CONNECTION_STRING` env var. Pool from `src/utils/sqlServer.js`.

---

## Migration runner

- Source: `src/utils/migrations.js`
- Files: `db/migrations/NNNN_<name>.sql` applied in numeric order
- Rollbacks: `db/rollbacks/NNNN_<name>.sql` (1:1 pair)
- Bookkeeping: `dbo.schema_migrations`
- CLI: `npm run db:migrate` | `npm run db:rollback [version]` | `npm run db:status` | `npm run db:migrate:dry`
- Idempotency: every migration uses `IF NOT EXISTS` / `IF EXISTS` guards
- Checksum drift: runner refuses to migrate if an applied file's SHA-256 changed on disk

---

## Tables — applied

### `dbo.schema_migrations` (M001 — 0000)

Tracks applied migrations.

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| version | NVARCHAR(64) UNIQUE | matches filename prefix (e.g. `0001`) |
| name | NVARCHAR(256) | filename suffix |
| checksum | NVARCHAR(128) | SHA-256 of file body |
| applied_at | DATETIME2 | default `SYSUTCDATETIME()` |
| applied_by | NVARCHAR(128) | default `SUSER_SNAME()` |
| duration_ms | INT NULL | populated on apply |

Indexes: `IX_schema_migrations_applied_at` (DESC).

### `dbo.strategy_config` (M002 — 0001)

Hot-reloadable config knobs. Replaces scattered .env vars. Defense-in-depth:
code reads via `db-hot-reload.getKnob(name, envFallback ?? hardcodedDefault)`.

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| scope | NVARCHAR(32) | `global` \| `live` \| `paper` |
| strategy | NVARCHAR(32) NULL | `momentum` \| `swing` \| `rotation` \| NULL |
| knob | NVARCHAR(128) | env-var-style name |
| value | NVARCHAR(1024) | stringified |
| value_type | NVARCHAR(16) | `int` \| `float` \| `bool` \| `string` \| `enum` \| `json` |
| source | NVARCHAR(64) | `manual` \| `env_import_YYYY-MM-DD_eco` \| `..._dotenv` |
| notes | NVARCHAR(512) NULL | `hot-reloadable` flag etc. |
| active | BIT | soft delete |
| created_at / updated_at / updated_by | audit |

Indexes:
- `UX_strategy_config_scope_strat_knob_active` UNIQUE filtered WHERE active=1
- `IX_strategy_config_knob` filtered WHERE active=1

Current population: 34 live rows + 33 paper rows (backfilled 2026-05-16).

### `dbo.config_changes` (M003 — 0002)

Audit log of every knob mutation. Append-only.

| Column | Type | Notes |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| changed_at | DATETIME2 | default `SYSUTCDATETIME()` |
| scope | NVARCHAR(32) | |
| strategy | NVARCHAR(32) NULL | |
| knob | NVARCHAR(128) | |
| old_value | NVARCHAR(1024) NULL | |
| new_value | NVARCHAR(1024) NULL | |
| actor | NVARCHAR(128) | default `SUSER_SNAME()` |
| source | NVARCHAR(64) NULL | matches strategy_config.source |
| reason | NVARCHAR(512) NULL | human note |

Indexes: `IX_config_changes_changed_at` (DESC), `IX_config_changes_knob` (knob, time DESC).

### `dbo.symbol_overrides` (M004 — 0003)

Per-symbol+chain overrides (block/prefer/size_multiply/custom_stop). Replaces
scattered tokenBlacklist/tokenPreferences in agent-memory.json. Read by
memory/blacklist.js + pre-trade-contract (Week 3).

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| symbol | NVARCHAR(64) | |
| chain | NVARCHAR(32) | `kucoin` \| `bsc` \| `base` \| `solana` |
| scope | NVARCHAR(32) | `global` \| `live` \| `paper` |
| action | NVARCHAR(32) | `block` \| `prefer` \| `size_multiply` \| `custom_stop` |
| value | NVARCHAR(256) NULL | multiplier / stop pct / custom payload |
| reason | NVARCHAR(512) NULL | |
| source | NVARCHAR(64) | `manual` \| `memory` \| `self_evolution` \| `telegram` |
| created_at / updated_at | DATETIME2 | |
| expires_at | DATETIME2 NULL | sweep target |
| active | BIT | default 1 |
| created_by | NVARCHAR(128) NULL | |

Indexes:
- `UX_symbol_overrides_scope_sym_chain_action_active` (UNIQUE, WHERE active=1)
- `IX_symbol_overrides_sym_chain_active` INCLUDE (action, value, expires_at)
- `IX_symbol_overrides_expires_at` (WHERE active=1 AND expires_at IS NOT NULL)

### `dbo.indicator_weights` (M005 — 0004)

Per-indicator per-bucket win-rate + adaptive weight. Populated by
memory/stats.js `recordIndicatorOutcome`. Hot-read by entries/filter.js.

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| indicator | NVARCHAR(64) | `rsi` \| `macd` \| `ema_cross` \| `bb_squeeze` \| `volume_spike` \| ... |
| bucket | NVARCHAR(64) | `rsi:30-40`, `macd:bullish_cross`, `regime:trend_up` |
| scope | NVARCHAR(32) | `global` \| `live` \| `paper` \| `strategy:<name>` |
| strategy | NVARCHAR(32) NULL | `momentum` \| `swing` \| NULL |
| samples / wins / losses | INT | |
| win_rate | FLOAT | |
| weight | FLOAT | adaptive multiplier (>1 amplify, <1 dampen) |
| avg_pnl_pct | FLOAT NULL | |
| last_outcome_at / updated_at / created_at | DATETIME2 | |

Indexes:
- `UX_indicator_weights_indicator_bucket_scope_strategy` (UNIQUE)
- `IX_indicator_weights_indicator_scope` INCLUDE (bucket, weight, win_rate, samples)

### `dbo.evolution_history` (M006 — 0005)

Replaces `data/self-evolution-history.jsonl`. Each row = one self-evolution
decision with pre/post win-rate for causal feedback. Bot dual-writes file + DB
for 1 week before deprecating the file (per Track C plan).

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| decided_at | DATETIME2 | |
| scope | NVARCHAR(32) | |
| strategy | NVARCHAR(32) NULL | |
| patch_id | NVARCHAR(128) | |
| patch_summary | NVARCHAR(1024) NULL | |
| patch_json | NVARCHAR(MAX) NULL | full diff payload |
| decision | NVARCHAR(32) | `proposed` \| `accepted` \| `rejected` \| `promoted` \| `rolled_back` |
| decided_by | NVARCHAR(64) NULL | `auto` \| `human` \| `guardian` |
| reason | NVARCHAR(1024) NULL | |
| samples_pre / samples_post | INT NULL | |
| pre_win_rate / post_win_rate | FLOAT NULL | |
| pre_pnl_usd / post_pnl_usd | FLOAT NULL | |
| causal_delta_winrate / causal_delta_pnl | FLOAT NULL | |
| measured_at | DATETIME2 NULL | when post stats settled |
| notes | NVARCHAR(MAX) NULL | |
| bot_version / strategy_version_id | NVARCHAR(64/128) NULL | |

Indexes:
- `IX_evolution_history_decided_at` (DESC) INCLUDE (scope, strategy, decision, patch_id)
- `IX_evolution_history_patch_id` (patch_id, decided_at DESC)
- `IX_evolution_history_decision_scope` (decision, scope, decided_at DESC)

### `dbo.trade_rejections` (M007 — 0006)

Audit log of every blocked trade attempt (pre-trade contract failures, filter
rejects, AI vetoes). Written by `src/risk/pre-trade-contract.recordRejections`.
30-day retention (prune sweep deferred to Week 6).

| Column | Type | Notes |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| rejected_at | DATETIME2 | default `SYSUTCDATETIME()` |
| scope | NVARCHAR(32) | `live` \| `paper` \| `global` |
| strategy | NVARCHAR(32) NULL | |
| side | NVARCHAR(8) | `BUY` \| `SELL` |
| symbol | NVARCHAR(64) | |
| chain | NVARCHAR(32) | |
| address | NVARCHAR(128) NULL | |
| gate | NVARCHAR(64) | rule name from `risk_rules` |
| severity | NVARCHAR(16) | `block` \| `warn` \| `log` |
| reason | NVARCHAR(1024) NULL | |
| requested_size_usd | FLOAT NULL | |
| wallet_usd | FLOAT NULL | |
| position_value_usd | FLOAT NULL | |
| metadata | NVARCHAR(MAX) NULL | JSON: tier index, min notional, etc |
| bot_version | NVARCHAR(64) NULL | |

Indexes:
- `IX_trade_rejections_rejected_at` (DESC) INCLUDE (scope, strategy, side, symbol, gate)
- `IX_trade_rejections_symbol_chain` (symbol, chain, time DESC) INCLUDE (gate, severity)
- `IX_trade_rejections_gate` (gate, time DESC) INCLUDE (scope, severity)

### `dbo.sell_tiers` (M008 — 0007)

Replaces `MOMENTUM_SELL_TIERS` (and swing/rotation) JSON-in-env. Hot-reloadable
via `pre-trade-runtime.loadSellTiers` (60s cache TTL).

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| scope | NVARCHAR(32) | `live` \| `paper` \| `global` |
| strategy | NVARCHAR(32) | `momentum` \| `swing` \| `rotation` |
| tier_index | INT | 1..N |
| profit_multiplier | FLOAT | `1.04` = +4% |
| sell_pct | FLOAT | `0.30` = 30% |
| min_notional_usd | FLOAT NULL | pre-computed exchange floor (filled by future exchange-aware backfill) |
| chain | NVARCHAR(32) NULL | NULL = all chains |
| active | BIT | default 1 (soft delete via UPDATE) |
| source | NVARCHAR(64) | `manual` \| `env_import_<date>` \| `self_evolution` |
| notes / created_at / updated_at / updated_by | audit |

Indexes:
- `UX_sell_tiers_scope_strat_idx_chain_active` UNIQUE filtered WHERE active=1
- `IX_sell_tiers_strategy_active` (strategy, scope, tier_index) INCLUDE (profit_multiplier, sell_pct, min_notional_usd, chain) WHERE active=1

Current population: 6 rows (momentum tiers × live + paper backfilled 2026-05-17).

### `dbo.risk_rules` (M009 — 0008)

Catalog of risk gates registered by the pre-trade contract. Each gate can be
toggled active/inactive + severity adjusted per scope without code change.
Severity (code-validated): `block` | `warn` | `log`.

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| name | NVARCHAR(64) | matches `GATE_CATALOG[].name` |
| scope | NVARCHAR(32) | `live` \| `paper` \| `global` |
| severity | NVARCHAR(16) | `block` (default) \| `warn` \| `log` |
| enabled | BIT | default 1 |
| description | NVARCHAR(512) NULL | from `GATE_CATALOG[].description` |
| config_json | NVARCHAR(MAX) NULL | per-rule tunables (currently unused) |
| source | NVARCHAR(64) | `manual` \| `seed` \| `self_evolution` |
| created_at / updated_at / updated_by | audit |

Indexes:
- `UX_risk_rules_name_scope` UNIQUE (name, scope)
- `IX_risk_rules_scope_enabled` (scope, enabled) INCLUDE (name, severity)

Current population: 21 rows (7 gates × live/paper/global, all severity=block, seeded 2026-05-17).

### `dbo.ai_decisions` (M010 — 0009)

Per-call AI inference record. Written by `src/ai/decision-tracker.trackAi`.
7-day full retention; older rows aggregated into `ai_decisions_rollup`.

| Column | Type | Notes |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| decided_at | DATETIME2 | default `SYSUTCDATETIME()` |
| scope | NVARCHAR(32) | `live` \| `paper` \| `global` |
| strategy | NVARCHAR(32) NULL | |
| provider | NVARCHAR(32) | `anthropic` \| `groq` \| `nvidia` \| `cerebras` \| `openrouter` \| `sambanova` \| `together` \| `openai` |
| model | NVARCHAR(128) NULL | |
| purpose | NVARCHAR(64) NULL | `trade_signal` \| `lesson` \| `research` \| `sentiment` \| `exit_classification` |
| symbol | NVARCHAR(64) NULL | |
| chain | NVARCHAR(32) NULL | |
| prompt_name / prompt_version | references `ai_prompts` |
| request_tokens / response_tokens | INT NULL | |
| cost_usd | FLOAT NULL | from `estimateCost(provider, req, res)` unless caller-provided |
| latency_ms | INT NULL | |
| success | BIT | default 1 |
| error_code | NVARCHAR(64) NULL | `TIMEOUT` \| `RATE_LIMIT` \| `AUTH` \| `PARSE` \| `UNKNOWN` |
| error_message | NVARCHAR(1024) NULL | |
| signal | NVARCHAR(16) NULL | `BUY` \| `HOLD` \| `SELL` |
| confidence | FLOAT NULL | |
| response_excerpt | NVARCHAR(2000) NULL | first 2000 chars (debug) |
| metadata | NVARCHAR(MAX) NULL | JSON |
| bot_version | NVARCHAR(64) NULL | |

Indexes:
- `IX_ai_decisions_decided_at` (DESC) INCLUDE (scope, provider, success, latency_ms, cost_usd, purpose)
- `IX_ai_decisions_symbol` (symbol, chain, time DESC) INCLUDE (provider, signal, confidence, success)
- `IX_ai_decisions_provider` (provider, time DESC) INCLUDE (cost_usd, latency_ms, success, model)

### `dbo.ai_decisions_rollup` (M010 — 0009)

Daily aggregate. Populated by future hourly rollup job (deferred).

| Column | Type | Notes |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| day | DATE | |
| scope / provider / model / purpose | composite key |
| call_count / success_count | INT | |
| total_cost_usd | FLOAT | |
| avg_latency_ms / p95_latency_ms | FLOAT NULL | |
| buy_count / hold_count / sell_count | INT | |
| avg_confidence | FLOAT NULL | |
| rolled_at | DATETIME2 | |

Indexes:
- `UX_ai_decisions_rollup_day` UNIQUE (day, scope, provider, model, purpose)

### `dbo.ai_prompts` (M011 — 0010)

Versioned prompt templates. Bot will read the active row per (name, scope)
once the loader wire-up ships (currently placeholder shells in 18 seed rows).

| Column | Type | Notes |
|---|---|---|
| id | INT IDENTITY PK | |
| name | NVARCHAR(64) | `anthropic_trade_signal` \| `groq_lesson` \| ... |
| version | INT | default 1 |
| scope | NVARCHAR(32) | `live` \| `paper` \| `global` |
| provider | NVARCHAR(32) NULL | |
| template | NVARCHAR(MAX) | body w/ `{{placeholders}}` |
| system_msg | NVARCHAR(MAX) NULL | |
| description | NVARCHAR(512) NULL | |
| active | BIT | default 1 |
| source | NVARCHAR(64) | `manual` \| `seed` \| `self_evolution` |
| created_at / updated_at / updated_by | audit |

Indexes:
- `UX_ai_prompts_name_scope_active` UNIQUE filtered WHERE active=1
- `IX_ai_prompts_name_version` (name, scope, version DESC)

Current population: 18 rows (6 templates × live/paper/global, seeded 2026-05-17).

### `dbo.health_checks` (M012 — 0011)

Per-cycle canary log. Written by `src/cycle/health-canary.runHealthCanary`.
30-day retention (prune deferred to Week 6).

| Column | Type | Notes |
|---|---|---|
| id | BIGINT IDENTITY PK | |
| checked_at | DATETIME2 | default `SYSUTCDATETIME()` |
| scope | NVARCHAR(32) | `live` \| `paper` |
| overall_status | NVARCHAR(16) | `PASS` \| `WARN` \| `FAIL` |
| check_name | NVARCHAR(64) | from `CHECKS` catalog |
| status | NVARCHAR(16) | `PASS` \| `WARN` \| `FAIL` \| `SKIPPED` |
| value_observed | NVARCHAR(256) NULL | `'1500ms'` \| `'12 positions'` \| `'450MB'` |
| threshold | NVARCHAR(256) NULL | `'< 2000ms'` \| `'> 500MB'` |
| message | NVARCHAR(1024) NULL | |
| recovery_hint | NVARCHAR(512) NULL | from `RECOVERY_HINTS` map |
| duration_ms | INT NULL | per-check timing |
| bot_version | NVARCHAR(64) NULL | |

Indexes:
- `IX_health_checks_checked_at` (DESC) INCLUDE (scope, overall_status, check_name, status)
- `IX_health_checks_check_name` (check_name, scope, time DESC) INCLUDE (status, value_observed)
- `IX_health_checks_failures` filtered WHERE status='FAIL' INCLUDE (check_name, status, message)

### `dbo.bot_trade_ledger.setup_type` (M018 — 0017)

Promotes setup identity out of `raw_trade_json` for setup-level dashboards and
queries.

| Column | Type | Notes |
|---|---|---|
| setup_type | NVARCHAR(40) NULL | `spot_day_bull_flag`, paper-only setup identifiers, or NULL |

Indexes:
- `IX_bot_trade_ledger_setup_type_ts` on `(bot_profile, setup_type, ts DESC)` INCLUDE `(trade_type, symbol, chain_key, strategy, pnl_usd)` WHERE `setup_type IS NOT NULL`

---

## Tables — planned (per REFACTOR_CHECKLIST.md)

| Migration | Table | Week | Status |
|---|---|---|---|
| M002 | `dbo.strategy_config` | 1 | **applied 2026-05-16** |
| M003 | `dbo.config_changes` | 1 | **applied 2026-05-16** |
| M004 | `dbo.symbol_overrides` | 2 | **applied 2026-05-16** |
| M005 | `dbo.indicator_weights` | 2 | **applied 2026-05-16** |
| M006 | `dbo.evolution_history` | 2 | **applied 2026-05-16** |
| M007 | `dbo.trade_rejections` | 3 | **applied 2026-05-17** |
| M008 | `dbo.sell_tiers` | 3 | **applied 2026-05-17** |
| M009 | `dbo.risk_rules` | 3 | **applied 2026-05-17** |
| M010 | `dbo.ai_decisions` + `dbo.ai_decisions_rollup` | 4 | **applied 2026-05-17** |
| M011 | `dbo.ai_prompts` | 4 | **applied 2026-05-17** |
| M012 | `dbo.health_checks` | 4 | **applied 2026-05-17** |
| M013 | `dbo.signals` extended | 5 | **applied 2026-05-17** |
| M014 | `dbo.tokens` | 5 | **applied 2026-05-17** |
| M015 | `dbo.regime_patterns` | 5 | **applied 2026-05-17** |
| M016 | `dbo.backtest_runs` | 6 | **applied 2026-05-17** |
| M017 | `dbo.ml_model_versions` | 6 | **applied 2026-05-17** (renamed from `model_versions` to avoid collision) |
| M018 | `dbo.bot_trade_ledger.setup_type` | 18 | **added 2026-05-21** |

Update the **Status** column and add a per-table section above as each migration ships.

---

## Hot-reload sources

- Source: `src/utils/db-hot-reload.js`
- Default poll: 60s (override `DB_HOT_RELOAD_POLL_MS`)
- SQL-down fallback to env vars after 5min (override `DB_HOT_RELOAD_FALLBACK_MS`)
- Register sources via `registerSource({ key, table, query, transform })`
- Subscribe via `bus.on('configChanged', ({ key, before, after }) => ...)`

Active sources (populated as wired): _none yet_

---

## Conventions

- Every migration: paired rollback, idempotent, < 5s on production-size data
- Defense-in-depth: every DB-backed knob falls back to env → hardcoded default
- Audit columns: `created_at`, `updated_at`, `created_by` where mutable
- Retention: short-lived telemetry tables get a `retention_days` comment block
