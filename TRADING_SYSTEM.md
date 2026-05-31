# TRADING_SYSTEM.md

Single-source doc covering architecture, strategies, risk model, execution, persistence, and audit history. Consolidated from prior scattered `audit/`, `docs/`, and root-level docs.

**Owners:** spot LIVE (`dex-trading-bot`), spot PAPER (`dex-trading-bot-paper`), perps PAPER (`dex-trading-bot-perps`).

---

## 0. Process Topology

| Bot | Repo | Port | Profile | Chains | Lifecycle |
|---|---|---|---|---|---|
| LIVE | `dex-trading-bot` | 3002 | `live` | KuCoin only | manual restart |
| PAPER | `dex-trading-bot-paper` | 3003 (was 3001) | `paper` | all enabled chains | manual restart |
| PERPS | `dex-trading-bot-perps` | 3010 | `perps` | Binance USD-M (paper) | manual restart |

PM2 autorestart **disabled** (Windows pid sync drift). Bots started via PowerShell `Start-Process -WindowStyle Hidden` with explicit env hashtable.

**Auto-start removed:** `DexBot PM2 Restore` scheduled task deleted (2026-05-27). PM2 daemons killed; orphan dependencies stop with Claude shutdown.

---

## 1. Strategy Plan (per `Plan/` folder)

Three saved strategies + perps. Use as **separate lanes**, not blended:

| Chain / Venue | Strategy | Stage |
|---|---|---|
| KuCoin spot | `spot_day_bull_flag` + `backes_swing` + `momentum` | bull-flag = live_canary; backes/momentum = production |
| Solana DEX | `solana_bull_flag_v2` | paper_runtime_canary |
| BSC DEX | `bsc_flow_breakout` | paper_runtime_canary |
| Base DEX | `base_dex_momentum_reclaim` | paper_runtime_canary (live disabled) |
| Binance perps | `traderxo_perps` (deviation_reclaim + level_to_level + MSS) | paper-only, canary capped 3x |

### 1.1 `spot_day_bull_flag` (Ross Cameron / Rayner Teo)
- Pole: ≥5% advance in 1-4 candles
- Flag: 2-8 candles, retrace ≤50% of pole, volume contraction ≤70%
- Trigger: 5m/15m close above flag high, volume ≥1.5× flag median
- Risk: 0.35% base, 0.50% A+
- **C3 gate (2026-05-27):** minRR ≥ 2.0 enforced

### 1.2 `backes_swing` (Augusto Backes HTF)
- Macro filter: BTC/ETH 8W MA + 56D MA + 21W support + weekly RSI ≤30
- Regimes: `risk_off` (block), `capitulation` (0.3× size), `reversal_pending` (0.8×), `bull_pullback` (1.0×)
- Setups: `21w_support`, `56d_retest`, `caixote`, `megaphone`
- Risk: 0.5% base, 0.2% capitulation; 25% portfolio exposure cap; max 3 concurrent
- **Paper-only canary**, not enabled on live

### 1.3 `bsc_flow_breakout`
- Filters: honeypot, tax ≤5%, locked LP ≥$50k, price expansion ≥5% 60m, net buy flow ≥$5k, volume spike ≥1.8×
- Risk: 0.15-0.25%, slippage cap 3%, Merkle private-route eligible

### 1.4 `traderxo_perps` (Binance USD-M)
- Pipeline: anchors (M/W/D opens) → range detect → deviation_reclaim or level_to_level → MSS confirm (≥0.3% displacement OR two-bar close) → ≥3R gate → variant filter
- Sizing: `calculatePaperPosition` enforces ≥2× liquidation buffer pre-open, per-symbol MM tier
- Mode caps: paper=5×, canary=3× + 1 pos + $100 floor, live=same as canary

---

## 2. Architecture / Module Map

```
src/
├── index.js                     # ~9300 lines orchestrator + cycle + exits + entries
├── boot/                        # singleton + error-handlers + lifecycle
├── state/lock-manager.js        # cleanup hook registry
├── config/{schema,loader}.js    # DB→env→default precedence
├── errors/index.js              # TransientError/FatalError taxonomy
├── agent/
│   ├── agentMemory.js           # SQL-shared lessons/blacklist/knowledge
│   ├── memory/{shape,merge,stats,lessons,knowledge,insights,blacklist,core}.js
│   ├── marketIntelligence.js    # RSS+LLM synthesis (Cerebras→Groq→NVIDIA→Mistral→Gemini)
│   └── regime-patterns.js       # M0015 read-through with 5min cache
├── risk/
│   ├── guardian.js              # 17-gate canTrade + multi-stage sizing
│   ├── pre-trade-contract.js    # 7 pure gates (severity block|warn|log)
│   └── pre-trade-runtime.js     # SQL-cached adapter (PRE_TRADE_CONTRACT_MODE=enforce live+paper)
├── ai/
│   ├── ensemble.js              # 7 providers wrapped with trackAi
│   └── decision-tracker.js      # latency/cost/signal → ai_decisions
├── cycle/                       # health-canary, main-loop, scan-cycle, canary-scheduler
├── policy/preconditions.js      # 5 gates (canPromote/canEnableLive/canIncreaseSize/canRotate/canAcceptAiOverride)
├── execution/
│   ├── orchestrator.js          # buy/sell lifecycle + per-strategy sizing override
│   └── exit-conditions.js + exit-helpers.js
├── exits/evaluate-exit-decision.js  # pure exit contract
├── strategies/{bull-flag,backes,bsc-flow,base-dex-momentum,deployment}.js
├── exchanges/{kucoin,jupiter,pancakeswap,baseswap}.js
└── utils/{sqlServer,migrations,db-hot-reload,...}.js

db/migrations/                   # 0000-0026 (M001-M026)
```

### 2.1 Data Flow

1. **Boot** → singleton lock → load state → init exchanges/AI → register schedules
2. **Scan cycle** → per-strategy scanner → token filter → evaluator (returns `{signal, details}`) → risk gates → pre-trade contract → execute BUY
3. **Exit pass** → per-position checker → trailing-stop apply → strategy exit signal → hold extension → `decide-exit-action` → execute SELL with mutex
4. **Maintenance** → SQL prune → log cleanup → ML retrain → memory persist
5. **Telemetry** → SQL (`signals`, `trades`, `ai_decisions`, `trade_rejections`, `decision_log`)
6. **Intelligence cycle** (30min) → RSS/Reddit/CryptoCompare/CoinGecko → LLM synthesis → watchlist/avoid feeds back into sizing + memory

### 2.2 Separation Rules (2026-05-31 audit)

- Strategy evaluators emit intent only: setup, trigger, stop, targets, confidence. They do not mutate portfolio cash or venue state.
- Risk modules own admissibility and sizing caps. Execution cannot increase a risk-approved `sizeUsd`; positive jitter clamps at the approved size.
- Execution modules own order lifecycle, fill reconciliation, partial-fill state, fee/slippage accounting, and sell recovery. Paper and live must share mutex and timeout-lock semantics.
- Learning/evolution modules observe completed outcomes. They must not alter live parameters without validation plus explicit approval.
- SQL is the queryable source for telemetry and gates; JSON is recovery/cache. Dashboard reads/reporting must not become a trading decision source.

---

## 3. Risk Model (`src/risk/guardian.js`)

### 3.1 `canTrade` cascade (17 gates)

1. Live-BSC disabled flag (live only)
2. Safe mode / state persistence error / balance drift halt
3. Daily drawdown limit (`maxDailyLossPct` ≈ 2.5%)
4. Per-chain daily loss
5. Performance gate (consecutive losses, profit factor ≥ 1.15 after 40 closed trades, slippage ≤ 180bps)
6. Learned bad-token memory
7. Brain profile (chain:strategy:lane:trigger)
8. Portfolio heat (per-chain projection vs chain capital base)
9. **Global gross exposure cap** (`maxGlobalExposurePct ≈ 90%` — B1.2)
10. Momentum 24h move bounds (per-strategy)
11. Strategy + per-chain concurrent position limits
12. Liquidity floor + young-token stricter floor
13. Market impact (x*y=k + 1h volume share + cost-vs-edge net edge ≥ 0.8%)
14. AI confidence floor (70%)
15. GoPlus honeypot (fail-closed for BSC/Solana/Base live)
16. Wallet concentration ≤ 80%
17. Correlation guard (≤75% with any open position)

### 3.2 Position sizing chain (`positionSize`)

```
base = 30% chain wallet
  × regimeMultiplier  (high-vol 0.75×, extreme-vol 0.5×)
  × brainMultiplier    (chain:strategy:lane:trigger; 0.5–1.2)
  × recoveryMultiplier (active when in a hole; preserve capital)
  × macroMultiplier    (intelligence sentiment-based)
  × correlationMultiplier (0.5× when candidate has no history)
  × rolloutMultiplier  (promotion stage)
  × adaptiveSleeveMultiplier (win-rate-driven 0.45–1.15)
  × volatilityPenalty  (>20% 24h = 0.7×, >10% = 0.85×)
  × teamWalletUnlockedPenalty (0.5×)
  × dex-lane multipliers (BSC exploration/borderline/relaxed, KuCoin early-breakout)
  × goPlusFallbackPenalty (0.5× if heuristic-only)
  × agePenalty         (<24h: 0.5×; <6h: additional 0.6× = 0.3× compound)
  × KuCoin 80% wallet cap
  × HRP target weight cap
  × ATR-derived risk-per-trade cap (riskBudget = equity × riskPerTradePct ÷ atrStop)
  × liquidity-depth cap (max 1.5% of book)
clamp to [minPositionSizeUsd, remainingChainCapacity]
```

### 3.3 Pre-Trade Contract Gates (`pre-trade-contract.js`)

| Gate | Trigger | Severity (default) |
|---|---|---|
| tier_feasibility | Smallest sell tier < min notional | block |
| position_size | Outside [MIN_POSITION_SIZE_USD, MAX_POSITION_PCT × wallet] | block |
| symbol_block | `symbol_overrides.action='block'` | block |
| duplicate_order | In-flight order for same key | block |
| daily_loss_budget | Today's PnL ≤ -DAILY_DRAWDOWN_LIMIT_USD | block |
| consecutive_loss_streak | Current streak ≥ MAX_CONSECUTIVE_LOSSES | block |
| ai_circuit | AI circuit open without override | block |

Mode: `PRE_TRADE_CONTRACT_MODE=enforce` set in spot+paper ecosystem.config.js and PowerShell restart env (verified 2026-05-27).

Runtime adapter must load `risk_rules.scope` and persist `trade_rejections.wallet_usd`; scoped block/warn/log overrides are part of the risk contract, not dashboard-only metadata.

---

## 4. Execution (`src/execution/orchestrator.js`)

### 4.1 BUY pipeline

1. Per-strategy sizing override (bull-flag, backes_swing, bsc_flow_breakout use equity × riskPct ÷ stopDistance)
2. Pre-trade contract via `runPreTradeContract` (BUY side)
3. Distributed lock acquire (TTL = max(SQL_LOCK_TTL_MS, execTimeoutMs + 10s) — B3.exec.8)
4. Telemetry logOrder + register in-flight $-exposure
5. Position mutex acquire
6. Buy preflight checks
7. Entry delay jitter
8. Venue execute with timeout
9. Finalize buy execution (telemetry, position state)
10. Failure recovery hooks
11. Release in-flight + mutex + distributed lock

### 4.2 SELL pipeline

1. Position mutex **first** (B1.4 — race fix)
2. Skip if exitInProgress or qty=0
3. Pre-trade contract (SELL side)
4. Venue execute
5. On failure: `recoverFailedSellExecutionFromExchange` (matches by recent fills, B3 sell-recovery)
6. Finalize sell execution

Paper and live both use the actual buy timeout (`execTimeoutMs || buyTimeoutMs || 30000`) for lock TTL. This prevents duplicate orders when operator config raises buy timeout but leaves generic timeout at default.

### 4.3 Exit conditions (`src/execution/exit-conditions.js`)

`applyTrailingStopState` (ratchet upward only) → strategy `evaluateExitForStrategy` → `shouldExtendMaxHold` (trend health) → `decide-exit-action` → dispatch. Reasons: `STOP_LOSS`, `TRAILING_STOP`, `TIME_STOP`, `MIN_HOLD_NO_GAIN`, `STALE_DRIFT`, `SELL_TIER_*`, `SELL_TIER_ACCEL_*`, `SELL_TIER_REVERSAL_*`, `ORPHANED_TIERS_EXIT`, `TAKE_PROFIT`.

---

## 5. Persistence (SQL)

Primary: MSSQL via `SQL_CONNECTION_STRING`. Mirror: `data/{agent-memory,state}.json` atomic write. Restore order: SQL → file fallback.

### 5.1 Tables (`src/utils/sqlServer.js` + `db/migrations/`)

**Core:** `bot_kv`, `bot_locks`, `bot_runs`, `signals`, `orders`, `fills`, `positions`, `position_snapshots`, `ops_events`, `bot_state_snapshots`, `bot_trade_ledger` (+`setup_type`), `bot_pnl_history`, `decision_log`, `decision_reflections`

**Learning:** `learning_bad_token_memory`, `learning_sleeve_performance`, `learning_brain_profiles`, `strategy_brain_profiles`

**Governance:** `strategy_versions`, `promotion_events`, `regime_patterns`, `_schema_version` (M0025 pin), `schema_migrations`

**Strategy/Risk:** `strategy_config`, `config_changes`, `symbol_overrides`, `indicator_weights`, `evolution_history`, `trade_rejections`, `sell_tiers`, `risk_rules`, `ai_decisions`, `ai_prompts`, `health_checks`, `tokens`, `backtest_runs`, `model_versions`, `job_queue`

### 5.2 Migrations

0000–0026 applied (M0017 checksum reconciled via `scripts/reconcile-m0017-checksum.js`). `IF NOT EXISTS` guards on all DDL; M0021 dropped tables revived in M0024 with filtered indexes. `_schema_version` pin (M0025) prevents accidental skip.

### 5.3 SQL Express constraint

10GB per-DB hard cap (edition-locked). Mitigation: `scripts/purge-bot-state-snapshots.js --days N --apply` purges `bot_state_snapshots` older than N days and shrinks via DBCC SHRINKFILE.

### 5.4 Pool resilience

`getPool` retries up to 5× with exponential backoff (500ms → 8s) before surfacing connection failure (B3.sql.10).

---

## 6. Agent Memory + Intelligence

### 6.1 `agent/agentMemory.js`

- SQL-first (`bot_kv` shared across paper/live), disk fallback (`data/agent-memory.json`)
- 7 sub-modules: shape (single source of truth) → merge (reflection-tested coverage) → stats → lessons → knowledge → insights → blacklist
- `MEMORY_DATA_SHAPE` keys: `version`, `tradeLessons` (300 cap), `strategyDiscoveries` (100), `tokenBlacklist`, `tokenPreferences`, `evolutionOutcomes` (50), `knowledgeBase` (200), 6 counter buckets, `aiUsage`
- Daily AI lesson budget (`dailyAiLessonLimit`), paper-AI gated off by default
- `stableKnowledgeId` uses sha256 16-char prefix (C7 — was sha1)

### 6.2 `agent/marketIntelligence.js`

Cycle every 30min (floor 15min — see C6 doc note). Sources: 5 RSS + 4 Reddit + CryptoCompare + CoinGecko trending. Synthesis fallback chain: **Cerebras → Groq → NVIDIA → Mistral → Gemini**. Output: `{macroSentiment, sentimentScore, hotSectors, coldSectors, narrativeThemes, watchlistTokens, avoidTokens, strategyRecommendation, riskWarnings, selfImprovementInsights, summary}`.

Feeds back: blacklists avoid tokens (12h), watchlist boosts position sizing, runs `deepResearchToken` on top 3 watchlist symbols (staggered 8s).

### 6.3 RL online updater

- Closed-trade updates accept singular `symbol` and array `symbols`; both execution-flow and scheduler paths feed learning.
- Default mode is shadow: append pending validation rows, do not mutate live Q-table unless `rl.onlineUpdatesEnabled=true`.
- Reward shape uses fractional returns (`0.20` = 20%) and subtracts current drawdown penalty, so policies optimize risk-adjusted outcomes.

### 6.4 Self-evolution

- Generated behavior must carry `validation.preApplyPassed=true` and `approval.approved=true` before apply.
- Generated plans cannot relax capital protections such as max daily loss or concurrent position caps.
- Direct live apply is prohibited; paper validation and promotion are the path to live.
- Apply failures throw through rollback so earlier file writes are restored if any later mutation is denied.

---

## 7. Operational Runbook

### 7.1 Restart sequence (mandatory order per memory `feedback_paper_first_restart_sequence`)

1. Stop spot LIVE
2. Stop spot PAPER
3. Stop perps paper
4. Restart spot PAPER → **24h canary observation** (dashboard PnL, fee model, fusion thresholds)
5. Restart perps PAPER (admission gate active, mode caps live)
6. Restart spot LIVE

### 7.2 Required env per bot

All three: `SQL_ENABLED=true`, `SQL_CONNECTION_STRING=...`, `PRE_TRADE_CONTRACT_MODE=enforce`, `BOT_VERSION=...`.
- LIVE: `BOT_PROFILE=live`, `PAPER_TRADING=false`, `PORT=3002`
- PAPER: `BOT_PROFILE=paper`, `PAPER_TRADING=true`, `PORT=3003`
- PERPS: `BOT_PROFILE=perps`, `PERPS_PAPER_SERVICE_ENABLED=true`, `PERPS_MODE=paper`, `PORT=3010`

### 7.3 RPC endpoints (publicnode chain)

BSC: `https://bsc-rpc.publicnode.com` (~75ms p50). Base: `https://base-rpc.publicnode.com` (~76ms). Solana: see config. Replaced binance dataseed + mainnet.base.org which timed out 32s+.

### 7.4 Common Runbooks (separate files in `docs/runbooks/`)

- `loop-stalled.md` — bot scan loop not advancing
- `safe-mode-active.md` — manual operator review pause
- `sql-unhealthy.md` — pool retry storm, capacity, drift
- `DIVERGENCE.md` — live↔paper threshold drift detection
- `AI_KEY_ROTATION.md` — Groq/Cerebras/Mistral key rotation
- `SOAK_OBSERVATION_GATES.md` — canary observation thresholds
- `PERPS_BOOTSTRAP.md` — perps live promotion canary plan

---

## 8. Phase A Audit — 50 Findings (Historical)

12 parallel read-only agents. Categories: P0 (account-ruin, 9), P1 (correctness, 14), P2 (hygiene, 27), P3 (dead code/tests/docs).

**P0** (#1-9): unauth admin endpoint, no global exposure cap, in-flight underflow, concurrent SELL race, no idempotency, scale-in entry-price overwrite, online Q-update without shadow, regime_patterns DDL drift, kvPut MERGE not SERIALIZABLE.

**P1** (#10-23): ADX TR error, BTC 1h estimated not fetched, pattern look-ahead, RL no DD penalty, RL volume leakage, decision-queue race, AI budget uncapped, Bayesian fusion paper-only, fee double-sub, unrealized PnL fee missing, leverage calc entry vs mark, 5 config drifts, evolution-governor too lax, TF confluence RSI hardcoded.

**P2** (#24-50): API hygiene (credentials, 429, fail-modes, timeouts, Jito poll), execution discipline (slippage cap, retry storm, lock TTL, sell recovery), RL schedule (lr, epsilon, DD asymmetry, discrepancy clamp), dashboard (token TTL, freshness, force-sell, PATCH schema), SQL/structure (pool retry, dust threshold, EMA null guard, sentiment string handling, hybrid promotion logic).

---

## 9. Phase B + C Fix Log (107+ Items)

**B1 (P0 spot, 9 items):** all landed.
**B1P (P0 perps, 10 items):** all landed.
**B2/B2P (P1 math, 24 items):** all landed including Bayesian fusion port to LIVE + 5 config drifts synced.
**B3/B3P (P2 hygiene, 17+ items):** all landed.
**B4/B4P (security + ops, 12+ items):** all landed including credential redaction, untracked wallet visibility, KuCoin 80% pre-order cap, dashboard hygiene.
**B5/B5P (final hardening, 9 items):** RISK_MAX_NATIVE_PRICE_AGE_MS default, pollBundleStatus wiring, cross-margin assertion, 8h discrete funding, MM tier table, markPrice WS, mark-price sizing, binance perps REST scaffold.
**B6P (perps live flip prep, 3 items):** conditional live wire, WS markPrice subscribe, MM tier refresh script.

**C-Phase (2026-05-27):**
- **C1** Deleted `MarketAnalyst` dead-code placeholder (inverted RSI buy logic, 0 callers). Removed in both repos: `src/agent/marketAnalyst.js`, `src/agent.js`, `bot/test/agent-trade-trigger.test.js`, plus instantiation in `src/index.js`.
- **C2** Verified `PRE_TRADE_CONTRACT_MODE=enforce` in restart env hashtable (was silent `shadow` default if missed).
- **C3** Added `minRR ≥ 2.0` gate to `bull-flag-evaluator.js` (spot+paper). Plan-required ≥3R for perps, ≥2R for spot day-trade.
- **C5** Fixed paper `getChainWalletBalanceUsd` divisor from hardcoded `/4` to `config.chains.enabled.length` (spot repo; paper already had smarter per-chain remainder math).
- **C6** Documented previously-silent 15min `INTELLIGENCE_INTERVAL_MINUTES` clamp.
- **C7** Bumped `stableKnowledgeId` from sha1→sha256 (collision safety at knowledgeBase scale).

Tests: 202/202 spot green, 49/49 perps green at last check (pre-C-phase; C edits non-test-breaking).

---

## 10. Live ↔ Paper Parity Contract

**Should match (any drift = bug):** all 23 P1 math fixes, fee accounting, pre-trade contract gate set, position sizing chain, exit reasons, deployment registry, strategy evaluators.

**Allowed to differ:**
- LIVE chain: `kucoin` only. PAPER: `kucoin + solana + bsc` (base disabled both).
- PAPER-only canary strategies: `solana_bull_flag_v2`, `bsc_flow_breakout`, `base_dex_momentum_reclaim`, `backes_swing`.
- LIVE-only modules: on-chain pipeline (`onchain/{buyflow,solscan,defillama}.js`), `kucoin-early-breakout.js`, Jito/Merkle bundles.

**Drift detection:** `docs/runbooks/DIVERGENCE.md`.

---

## 11. Open Deferrals

- **Binance perps live adapter** — REST scaffold complete (B5P.1), credentials + ramp pending per `PERPS_BOOTSTRAP.md` D.14 canary plan.
- **markPrice/fundingRate WS** — consumer wired (B5P.2 + B6P.ws-wire), scanner integration verified.
- **Mark-price sizing plumb** — wired (B5P.5); awaiting binance live fill-ack to validate.
- **Funding 8h discrete accrual** — semantics correct (B5P.3); precise per-epoch settlement deferred until live.
- **Cross-margin assertion redundancy** — defense-in-depth added (B5P.6); paper-only currently.

---

## 12. Security Posture

- CMC + NVIDIA + Groq + Mistral keys redacted in logs (B4.cso.1).
- Dashboard admin token (`DASHBOARD_ADMIN_TOKEN`) required on all write endpoints; 503 if missing.
- Force-sell requires double-confirm (B4.dash.7).
- Risk-rule PATCH server-side schema validation (B4.dash.10).
- Admin token session TTL enforced (B3.dash.8).
- Symbol overrides (block list) loaded from SQL on boot, refreshed via TTL.

Key rotation: `SECURITY_PROVIDER_KEY_ROTATION_CHECKLIST.md`.

---

## 13. Tests

- Spot: 202 tests covering strategies, risk gates, execution, exits, persistence, AI ensemble, decision queue, pre-trade contract, agent memory merge coverage.
- Perps: 49 tests covering paper engine, admission gate, range detector, deviation reclaim, MSS, L2L, sizing, scaffold guards, replay service, walk-forward.
- Gaps (Phase A 12-test-coverage.md): partial-fill-retry, order-timeout-cancel, perp-liquidation, unrealized-pnl-slippage, global-limits-cascade, concurrent-position-merge, gap-fill-stop-loss, exchange-api-failures, model-promotion-parity, crash-recovery-state.

---

*Generated by Ruflo Phase A→B→C audit chain. Update this file as architecture/risk model changes; keep separate `docs/runbooks/*.md` for incident playbooks.*
