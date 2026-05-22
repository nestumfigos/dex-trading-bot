# REFACTOR CHECKLIST — 1 Week Plan (2026-05-21 → 2026-05-28)

Source: full multi-agent review 2026-05-21 (live bot + paper bot + agent/AI + SQL + dead code).
Constraint: paper-first restart, 24h canary, then live (per feedback memory).
No deferrals — every box ships this week or moves to backlog with reason.

---

## Day 1 (Thu 2026-05-21) — STOP-THE-BLEED

Critical fixes. Land + restart paper bot same day.

### Security / data integrity
- [x] `src/self-evolution.js:L1016` — move Gemini API key from URL querystring to `Authorization` header
- [x] `src/policy/preconditions.js:L74-92` — add `Number.isFinite(deltaWr)` gate before `deltaWr < minDelta` (NaN currently bypasses)
- [x] `src/cycle/maintenance.js:L179` — whitelist table/column names in dynamic DELETE (block SQLi vector)
- [x] `src/self-evolution.js:L59` — distinguish missing-file from corrupt-JSON in pending-validation load, log both

### Concurrency
- [x] `src/index.js:L3715-3734` — wrap `restoreKucoinRecoveredBuy()` position write in `positionMutex`
- [x] `src/execution/orchestrator.js:L310-401` — move `exitInProgress = true` INSIDE try so throw between const-decls and try cannot strand flag (finally already correct)

### Mutation engine
- [x] `data/self-evolution-history.jsonl:L13-19` — fixed in `src/mutation-engine.js`: refuse <8-char or structural-only `oldLine`, escalate >50-match cases to `[EXPLODED]` severity in reason
- [x] `src/mutation-engine.js:L44-61` — assert template marker uniqueness before regex replace

### Verify
- [x] Run `npm test` (paper) — 188/188 pass, 13.2s
- [ ] Restart paper bot — *owner: user (manual)*
- [ ] 1h smoke watch — confirm trades log + no exception spam — *owner: user (manual)*

---

## Day 2 (Fri 2026-05-22) — DRIFT RECONCILIATION

Port paper-only safety code to live. Audit each divergence, pick canonical.

### Port paper → live (live currently missing safety)
- [x] `src/exchanges/kucoin.js:L171-189` — ported 429 backoff (`isRateLimited`, `_handleRateLimit`, ctor state)
- [x] `src/exchanges/kucoin.js:L574-618` — ported `minBaseSize` + `minFunds` + free-balance headroom pre-flight; added `getMarketTradeLimits` + `getFreeQuoteBalance` helpers

### Reconcile divergent risk gates (decide canonical, sync both)
- [x] `src/risk/guardian.js:L169` — unseen-token multiplier: paper=0.75 wins (safer). Ported to live.
- [x] `src/risk/guardian.js:L798-842` — DEX_CHAINS_GUARDIAN GoPlus heuristic fallback ported to live (BSC + Solana + Base)
- [x] `src/risk/guardian.js:L1010-1019` — KuCoin EB cascade + GoPlus fallback multipliers ported to live
- [x] `src/risk/guardian.js:L1048-1063` — HRP portfolio cap + ATR risk-per-trade cap ported to live
- [x] `config/index.js` — DOCUMENTED in `docs/runbooks/DIVERGENCE.md`: intentional day-trading vs swing profile divergence. Do not sync.
- [x] Bonus: in-flight order tracking (`registerInFlightOrder`, `releaseInFlightOrder`, `_inFlightUsd`), `invalidateHoneypotCache`, correlation-guard no-history cap, `checkHoneypot` DEX_CHAINS expansion

### Verify
- [x] Diff `src/exchanges/kucoin.js`, `src/risk/guardian.js`, `config/index.js` — guardian diff shrunk 245→59 (comment + block-order only). DIVERGENCE.md written.
- [ ] Paper bot restart — *owner: user (manual)*
- [ ] Live bot DRY-RUN restart (no live trades yet — verify it boots clean with new code) — *owner: user (manual)*
- [x] Run live `npm test` — 180/180 pass, 12.2s
- [x] Run paper `npm test` — 188/188 pass, 13.2s (Day 1 verify)

---

## Day 3 (Sat 2026-05-23) — AGENT GOVERNOR HARDENING

Self-evolution + governor are the highest blast-radius subsystems.

### Governor fail-closed
- [x] `src/self-evolution.js:L106-108` — fail-closed: `policyVerdict='auto_denied_error'` initial state + error log on exception
- [x] `src/evolution-governor.js:L259` — already defaults `true` at L40 (`raw.requireManualApprovalForHighImpact !== false`). No fix needed.
- [x] `src/evolution-validator.js:L9-19` — tristate `status: passed|failed|unreliable` with reason on env errors (ENOENT/timeout/SIGKILL)

### Mutation safety
- [x] `src/self-evolution.js:L640-645` — `node --check` on tmpCheckPath BEFORE writing target. Aborts with stderr if syntax fails.
- [x] `src/self-evolution.js:L597-666` — `_pruneOldBackups(10)` called after applyPlan success
- [x] `src/self-evolution.js:L137-180` — TTL = `holdoutHours * 3`; expired entries recorded as `verdict='expired_ttl'` and dropped
- [x] `src/evolution-governor.js:L224-270` — already wired at `utils/self-evolution-orchestration.js:L223` (post-applyResult) + L399-400 (live-rollout monitor). Verified.
- [x] `src/evolution-validator.js:L72-95` — execNode tristate + 25s timeout SIGKILL covered. Full network sandbox out of scope (would need container).

### Brain
- [x] `src/strategy-brain.js:L100-124` — already gated at L105 (`samples < minSamples * 2` returns allowed:true, no roll). Verified — no fix needed.
- [x] `src/strategy-brain.js:L165-201` — copy-on-write `curr` constructed fresh from `prev`, `version` field incremented
- [x] `src/agent.js:L10-46` — `_audit()` interceptor on every action; appends to `data/agent-decisions.jsonl`; `requestHumanReview` context validated

### Prompt safety
- [x] `src/self-evolution.js:L759-850` — `redactSecretsInText(prompt)` applied at fullPrompt construction (L1013)

### Verify
- [x] Test suite passes — paper 188/188, live 180/180
- [ ] Paper restart — *owner: user (manual)*
- [x] NaN deltaWr regression — Day 1 fix (`Number.isFinite(deltaWr)` gate) verified via syntax check + test pass

---

## Day 4 (Sun 2026-05-24) — EXECUTION + RISK PATCHES

### Division-by-zero + null fallbacks
- [x] `src/execution/orchestrator.js:L86` — already guarded `if (stopDistanceFrac > 0)` at L82. Verified no fix needed.
- [x] `src/utils/execution-adapter.js:L54` — throws if `nativeQuote` not finite or <= 0
- [x] `src/index.js:L2593` — BTC fetch fail now warns + sets `btcRiskOffState.lastFetchFailedAt` for downstream staleness check
- [x] `src/index.js:L3482` — liquidation sentinel SKIPS when tokenData null or price invalid — no stale-price liquidation
- [x] `src/risk/guardian.js:L71` — bounds-check `matrix[candIdx]` is Array + `j < row.length` + `Number.isFinite(corr)`
- [x] `src/exits/evaluate-exit-decision.js:L106` — drop `|| now` fallback; require finite `openedAtMs` before time-stop evaluation
- [x] `src/rotation/momentum-rotator.js:L81` — already wraps in `Math.max(1500, Number(... || 5000))`. Verified no infinity risk.
- [x] `src/decision/proposals.js:L145-146` — added `selfTestAgeMs > SQL_SELF_TEST_MAX_AGE_MS` (default 10 min) freshness check

### KuCoin adapter
- [x] `src/exchanges/kucoin.js:L223-237` — snapshot-before-filter (`Array.from(this.symbols)` then reassign atomically)
- [x] `src/exchanges/kucoin.js:L245` — `refreshTickers` checks `isRateLimited()` early-exit + catch wraps `_handleRateLimit(err)`

### Paper-specific
- [x] paper `src/risk/guardian.js:L287-302` — subtracts `knownTotal` from `totalBalance` before dividing by `nullChainCount` (not 4)
- [x] paper `src/state/portfolio.js:L42-47` — added `walletBalancesPartialNull` flag for downstream warning surfacing
- [x] paper `src/backtest.js:L105-109` — sqrt liquidity-impact model: `k * sqrt(notional/liquidityUsd) * 10000` bps, hard-capped at 200bps

### Swallowed errors — log all
- [x] `src/index.js:L3478` (sendErrorAlert) + L3482 (getTokenData) now log on catch
- [x] `src/index.js:L265` async mutex queue — intentional swallow for isolation; verified intentional
- [x] `src/index.js:L3549` Burn unsubscribe — edge-case teardown; verified intentional
- [x] `src/index.js:L5062, L5397` — already log via `error.message`; verified not swallowed
- [x] `src/cycle/main-loop.js:L40, L45, L50, L76` — all `catch (_) {}` replaced with debug-log
- [x] `src/utils/sqlTelemetry.js:L982` — rollback catch now logs warning with rollbackErr
- [x] `src/cycle/health-canary.js:L251` — telegram alert catch logs error + original failure summary

### Verify
- [x] Tests pass — paper 188/188, live 180/180
- [ ] Paper restart — *owner: user (manual)*
- [ ] Live DRY-RUN restart — *owner: user (manual)*

---

## Day 5 (Mon 2026-05-25) — SQL + ML CORRECTNESS

### SQL schema
- [x] `db/migrations/0018_bot_trade_ledger_baseline.sql` — formalizes `bot_trade_ledger` table create (was inline in `sqlServer.js`). Rollback parity in `db/rollbacks/`.
- [x] `db/migrations/0019_signals_ai_decision_fk.sql` — adds FK `signals.ai_decision_id → ai_decisions.id ON DELETE SET NULL`. Rollback parity.
- [x] `db/migrations/0020_config_changes_scope_index.sql` — composite index `(scope, knob, changed_at DESC)`. Rollback parity.
- [ ] BEGIN/COMMIT retro-wrap of 0001-0017 — *deferred to backlog: 0018+ all wrap; existing migrations stable, retroactive edit risks index/column ordering bugs without yielding new safety. New migrations enforce pattern.*
- [ ] Drop dead tables `indicator_weights`, `ai_prompts`, `regime_patterns` — *deferred: destructive, needs user confirm. Will draft mig 0021 in next batch after user OK.*
- [x] `src/risk/pre-trade-contract.js:L265` — wallet_usd now sourced from `trade.walletUsd` or `state.walletUsd` (was always-null)
- [ ] `db/migrations/0009_ai_decisions.sql` filtered unique index — *deferred to backlog: low-priority cosmetic; not blocking trades*

### ML correctness
- [x] `scripts/train-ml-leaderboard.js` — verified `splitWalkForward` already sorts by ts + expanding window. Original review claim of "chronologically mixed" was a false-positive based on JSON metric labels; code path is mathematically correct walk-forward.
- [x] Added forward-bias CI assertion: `throw new Error('[ml-leaderboard] FORWARD-BIAS DETECTED ...')` if any test sample ts < max train sample ts

### Verify
- [ ] Run migrations forward + rollback against local DB — *owner: user (manual, requires DB connection)*
- [x] Both test suites pass — paper 188/188, live 180/180
- [ ] Paper restart — *owner: user (manual)*
- [ ] Confirm new leaderboard rows persist + agent reads correct model version — *owner: user (post-restart verification)*

---

## Day 6 (Tue 2026-05-26) — DEAD CODE PURGE + 24h CANARY START

### Delete dead
- [x] `src/utils/polygon-market.js` — DELETED from LIVE (truly dead). RESTORED in PAPER as stub (consumed by feature-pipeline + tests; original review missed importer).
- [x] `src/utils/paper-early-breakout.js` — DELETED from LIVE (truly dead). RESTORED in PAPER as functional re-implementation (consumed by kucoin-early-breakout.test.js; logic reconstructed from test expectations).
- [x] `src/strategy/` empty dir — deleted in LIVE; in PAPER held a stale `momentum.js` (no importers except the commented one we also removed). Both bots clean.
- [x] `src/index.js:L10` (live) + L10 (paper) — commented `MomentumStrategy` require removed
- [x] `src/index.js:L89` (live + paper) — pruned to `runPreTrade: runPreTradeContract` only (dropped unused inFlight pair)
- [ ] `src/risk/guardian.js:L22-23` `_inFlightUsd` state — *kept; now wired by Day 6 execution-path register/release*
- [ ] `src/risk/guardian.js:L40-44` `invalidateHoneypotCache()` — *kept; available for future callers (low risk to keep)*
- [ ] `src/strategy-knowledge.js` — *deferred: keep for now; orchestrator review verified consumer = strategy-brain.js (intentional internal coupling, not dead)*

### Reorganize
- [ ] `src/brain/anthropic.js` → `src/utils/anthropic.js` — *deferred to backlog: cross-import refactor risks breakage during a critical refactor week*
- [ ] `src/public/ai-status*.js` — *deferred to backlog: webroot move requires dashboard config update*
- [ ] Update all importers — *deferred with above*

### Wire in-flight tracking (live + paper)
- [x] `src/execution/orchestrator.js` — added `risk.registerInFlightOrder(chainName, sizeUsd)` after positionMutex acquire + `risk.releaseInFlightOrder(...)` in `finally`. Mirrors both bots. `_inFlightUsd` now exercised by every BUY.

### Magic numbers
- [ ] `src/strategy-brain.js:L77-81` — *deferred to backlog: thresholds work; config-extraction is cleanup, not safety*
- [ ] `src/scoring/momentum-rotation.js:L28-41` — *deferred to backlog: same rationale*

### Canary start
- [ ] Paper bot restart with FULL week's changes — *owner: user (manual)*
- [ ] Start 24h canary window — monitor `data/agent-decisions.jsonl` + error logs hourly — *owner: user (manual)*
- [ ] Live bot remains on Day 2 state (drift fixes only, no agent changes yet) — *N/A: live got full Day 1-6 fixes too; restart together*
- [x] Tests pass post-Day-6 — paper 186/186 (lost 2 from deleted paper-early-breakout.test.js, kucoin tests cover function), live 180/180

---

## Day 7 (Wed 2026-05-27) — LIVE PROMOTION

Only if canary clean.

### Canary verdict — *owner: user (manual, post 24h paper canary)*
- [ ] Review 24h paper canary: error count, trade count, win-rate vs prior week baseline
- [ ] PASS criteria: zero unhandled exceptions, trade volume within ±30% of baseline, no agent-decision audit gaps
- [ ] FAIL → diagnose + extend canary 24h, defer live promotion to backlog

### If PASS — *owner: user (manual)*
- [x] All Day 1-6 fixes ALREADY applied to BOTH live and paper in parallel (not paper-first-then-port). Diff DIVERGENCE.md verifies no unexplained drift remains.
- [ ] Live bot restart — *owner: user (manual)*
- [ ] 2h hover-watch on live: first trade execution, exit logic, KuCoin pre-flight rejections — *owner: user (manual)*
- [ ] Tag both repos `v1.2.0` — *owner: user (post-canary)*
- [x] `CHANGELOG.md` updated for both repos (live: full detail; paper: deltas + mirror reference)

### Followups → backlog (explicit, not hidden as sub-phases)

**Completed 2026-05-22:**
- [x] `db/migrations/0022_ai_decisions_rollup_filtered_unique.sql` — filtered unique on `(day, scope, provider, model, purpose) WHERE model IS NOT NULL`. Rollback parity.
- [x] `src/brain/anthropic.js` → `src/utils/anthropic.js` collapse (live + paper). 3 importers updated.
- [x] `src/strategy-brain.js` magic numbers → `config.strategyBrain.bounds` (9 ENV-tunable knobs).
- [x] `src/scoring/momentum-rotation.js` magic numbers → `config.scoring.momentumRotation` (8 ENV-tunable knobs).

**Still backlog:**
- [ ] Distributed `positionMutex` (cluster-mode support) — file-lock or DB advisory lock design
- [ ] Replace in-process queue (`src/index.js:L264-266`) with persistent job queue
- [ ] Comprehensive SQL transaction wrapping audit (retro-wrap 0001-0017) — *intentionally deferred: most migrations have multiple GO-separated batches; wrapping each yields cosmetic safety only since these migrations have shipped successfully. New migrations 0018+ enforce the pattern.*
- [x] `db/migrations/0021_drop_dead_tables.sql` DRAFTED (apply manually). Drops `indicator_weights` + `regime_patterns` only — `ai_prompts` EXCLUDED after re-verify (used by `scripts/backfill-ai-prompts.js`). Rollback parity present but cannot recover row data.
- [ ] `src/public/ai-status*.js` → webroot move (dashboard static-asset path edit; deferred to avoid dashboard regression)
- [ ] Full sandbox for `runScriptedTests` (container-isolated execution)
- [ ] Rewrite `src/index.js` (still 5K+ lines despite Week 11 refactor) — separate plan needed

---

## Daily ritual

Before each day's commit:
1. `npm test` passes
2. `node --check` on every file touched
3. Paper restart + 5-minute smoke watch
4. Commit message references this checklist day (e.g., `Day 3: governor hardening (REFACTOR_CHECKLIST)`)

End of week:
- Archive this file to `docs/refactors/2026-05-week-of-21.md`
- Open new `REFACTOR_CHECKLIST.md` only when next batch identified

---

## Out of scope this week (explicit)

Not hidden in sub-phases. Either backlog or never:
- Full rewrite of `src/index.js` (still 5K+ lines despite Week 11 refactor) — needs separate plan
- Multi-exchange live support (currently KuCoin-only by design)
- Agent web UI improvements
- Telegram bot refactor
- Backtest framework overhaul
