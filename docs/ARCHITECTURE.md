# ARCHITECTURE.md

**Status**: active. Version 1.1.0 module map below reflects actual state as of 2026-05-21.

---

## Process topology

- **Live bot**: `src/index.js`, port 3002, KuCoin only, `BOT_PROFILE=live`
- **Paper bot**: `dex-trading-bot-paper/src/index.js`, port 3001, all chains, `BOT_PROFILE=paper`
- **PM2 status**: declared in `ecosystem.config.js` but `autorestart: false` (Windows pid-tracking broke on us). Master process is stable on its own; PM2 used only for declarative spawn config.
- **Launcher**: desktop `Start Both Bots.bat`

---

## Module map (v1.1.0)

```
src/
├── index.js                     # ~9300 lines orchestrator + cycle + exits + entries (cycle/exits/entries split DEFERRED — bug-class work shipped via gates instead)
├── boot/                        # Week 1b/1c
│   ├── singleton.js             # lock file + Atomics.wait + sibling takeover + lockManager hook
│   ├── error-handlers.js        # transient-aware uncaughtException + unhandledRejection
│   └── lifecycle.js             # createLifecycle({getDashboardServer, telemetry, saveState, lockManager}) — per-hook timeout + hard kill backstop
├── state/                       # Week 1b
│   └── lock-manager.js          # cleanup hook registry (register/drain/clear/list)
├── config/                      # Week 1a
│   ├── schema.js                # KNOBS catalog + cast/validate
│   └── loader.js                # DB→env→default→fallback precedence
├── errors/                      # Week 1a
│   └── index.js                 # TransientError/FatalError taxonomy + isTransient()
├── agent/memory/                # Week 2
│   ├── shape.js                 # MEMORY_DATA_SHAPE single source of truth
│   └── merge.js                 # pure mergeFromRemote (delegated from agentMemory.js)
├── risk/                        # Week 3
│   ├── guardian.js              # legacy gates
│   ├── pre-trade-contract.js    # 7 pure gates (tier_feasibility, position_size, symbol_block, duplicate_order, daily_loss_budget, consecutive_loss_streak, ai_circuit)
│   └── pre-trade-runtime.js     # SQL-cached runtime adapter (shadow/enforce mode)
├── ai/                          # Week 4
│   ├── ensemble.js              # 7 providers wrapped with trackAi
│   └── decision-tracker.js      # trackAi() — captures latency/cost/signal into ai_decisions
├── cycle/                       # Week 4
│   ├── health-canary.js         # 8 dep-injected checks (memory_mtime / counters / sql / ai_circuit / lock_files / positions / restarts / disk)
│   ├── main-loop.js             # strategy-specific scan/exit timers
│   ├── scan-cycle.js            # per-strategy scan dispatch wrapper
│   └── canary-scheduler.js      # health-canary schedule registration
├── policy/                      # Week 5
│   └── preconditions.js         # 5 gates (canPromote / canEnableLive / canIncreaseSize / canRotate / canAcceptAiOverride) + loadThresholds DB→env→DEFAULTS
├── brain/anthropic.js           # wrapped with trackAi (Week 4)
├── dashboard.js                 # Express UI
├── dashboard-extensions.js      # Week 6: 10 endpoints (rejections, evolution, ai-decisions, ai-decisions/cost, symbol-overrides CRUD, health-canary, ml-models, backtest-runs)
├── exchanges/                   # kucoin, jupiter, pancakeswap, baseswap
├── execution/
│   └── orchestrator.js          # buy/sell lifecycle, bull-flag/Backes/BSC sizing overrides
├── exits/
│   └── evaluate-exit-decision.js # pure exit contract, including bull-flag, Backes, BSC flow setup branches
├── strategies/
│   ├── deployment.js            # paper-only strategy registry + live-chain blocks
│   ├── bull-flag-*.js           # KuCoin live bull-flag + Solana paper v2 evaluator
│   ├── backes-*.js              # Backes HTF macro, indicators, setups, evaluator
│   ├── bsc-flow-*.js            # BSC flow detector, shared safety clients, evaluator
│   └── base-dex-momentum-*.js   # Base OHLCV-backed flag/reclaim detector + evaluator
├── utils/
│   ├── sqlServer.js             # mssql pool + schema DDL
│   ├── migrations.js            # Week 0 — migration runner + checksum drift detection
│   ├── db-hot-reload.js         # Week 0 — config polling
│   ├── dexscreener-client.js    # shared throttled/cached DexScreener client
│   ├── honeypot-client.js       # shared Honeypot.is client
│   ├── merkle-bundle.js         # BSC private transaction/bundle route helper
│   └── position-sizing.js       # wired Week 5 with canIncreasePositionSize
├── strategy-brain.js
└── self-evolution.js            # wired Week 5 with canPromoteEvolutionPatch
```

```
db/
├── migrations/                  # 0000-0017 (M001-M018)
└── rollbacks/                   # 1:1 pair per migration

scripts/                         # Week 6 process discipline + backfills
├── config-audit.js              # list all knobs + source + last change + orphans
├── config-diff.js               # recent strategy_config changes
├── db-status.js                 # migration history + drift + table inventory
├── memory-inspect.js            # pretty-print agent memory state
├── backfill-config-from-env.js  # Week 1
├── backfill-sell-tiers.js       # Week 3
├── seed-risk-rules.js           # Week 3
├── backfill-ai-prompts.js       # Week 4
├── backfill-model-versions.js   # Week 6
├── promote-paper-to-main.js     # wired Week 5 with canEnableLiveTrading
└── rollback-live-promotion.js
```

---

## Deferred from Weeks 3-6 (line-count refactors only; bug-class work shipped via gates)

- `src/cycle/main-loop.js + momentum-scanner.js + swing-scanner.js + exit-pass.js + maintenance.js + retraining.js` (Week 4 Track A)
- `src/exits/{checker,stop-loss,take-profit,tiered,time-based,rotation}.js` (Week 3 Track A)
- `src/entries/{discover,filter,sizing,execute}.js` (Week 3 Track A)
- `src/agent/memory/{core,lessons,stats,blacklist,knowledge,insights}.js` (Week 2 Track A — full 7-way split)
- `src/boot/init.js` + `src/state/portfolio.js` (Week 1c — closure-bound across hundreds of call sites)
- Token cache + regime_patterns read-through (bundled with cycle-split)
- Prompt template DB loader (read ai_prompts at runtime)
- Perps bot remains a separate future worktree, not part of v1.1.0 runtime.

---

## Data flow (high level)

1. **Boot** → singleton lock → load state → init exchanges/AI → register schedules
2. **Cycle** → momentum scan → filter chain → pre-trade contract → execute BUY
3. **Exit pass** → per-position checker → tier / SL / TP / time / rotation → execute SELL
4. **Maintenance** → SQL prune → log cleanup → ML retrain (daily) → memory persist
5. **Telemetry** → write to SQL (`signals`, `trades`, `ai_decisions`, `trade_rejections`)
6. **Strategy telemetry** → setup-specific fields persist through `setup_type`, `/api/bull-flag-stats`, and `/api/backes-stats`

---

## Persistence layers

- **Primary**: MSSQL (`SQL_CONNECTION_STRING`)
- **Mirror**: `data/agent-memory.json`, `data/state.json` (atomic write tmp+rename)
- **Restore order**: SQL → file fallback if SQL down
- **Migrations**: `db/migrations/` ↔ `dbo.schema_migrations`

---

## Decisions worth remembering

- **PM2 autorestart off** (2026-05-16): pid sync drifted on Windows, caused duplicate-spawn races. Master process is stable; manual restart only.
- **SELF_EVOLUTION off in live** (2026-05-16): auto-mutating on negative PnL was unsafe. Now further gated by `policy/preconditions.canPromoteEvolutionPatch` (verdict tagged `auto_denied`) at the post-validation step (Week 5).
- **Atomics.wait spin-wait fix** in singleton (2026-05-16): replaced busy-wait CPU spin.
- **Sibling takeover** when prior owner dies (2026-05-16).
- **Live bot KuCoin only** (2026-05-15+): BSC/Base reserved for paper.
- **MERGE_KEYS as single source of truth** (Week 2): adding a field to `agentMemory.data` without updating `shape.js` MERGE_KEYS fails CI. Structurally blocks 2026-05-16 silent-wipe class. Caught a regression in Week 5 (wrapper was missing — re-landed via `pureMergeFromRemote` delegation).
- **PRE_TRADE_CONTRACT_MODE=shadow default** (Week 3): pre-trade gates ship in observability-only mode by default. Promote per-scope via `PRE_TRADE_CONTRACT_MODE=enforce` after paper canary green.
- **`trackAi()` wrapper preserves backoff catch** (Week 4): re-throws on API failure so each ensemble provider's rate-limit catch + cooldown logic still fires; tracker writes a `success=0` row regardless.
- **Health canary degrades open** (Week 4): `disk_space` check SKIPPED when `fs.statfs` unavailable; any check exception → `status='FAIL'` for that check but never crashes scheduler.
- **Policy thresholds DB→env→DEFAULTS** (Week 5): `loadThresholds({sql, scope})` returns Map for any gate; SQL down still produces valid Map from env + hardcoded DEFAULTS. No gate hot-path requires SQL.
- **Dashboard write endpoints require Bearer token** (Week 6): `DASHBOARD_ADMIN_TOKEN` env or 503 refused; missing token never silently no-ops.
- **Paper-only strategy canaries** (2026-05-21): Backes, BSC flow, Base reclaim, and Solana bull-flag v2 are blocked from live by deployment registry until promotion gates complete.
- **BSC flow private route** (2026-05-21): BSC paper strategy carries 0.15-0.25% risk sizing, 3% slippage cap, shared Honeypot/DexScreener checks, and Merkle private-route support for live BSC promotion work.

Update this section as architectural decisions accumulate.
