# Changelog

## 1.2.0 - 2026-05-22 (pending live promotion — awaiting 24h paper canary)

Week-of-2026-05-21 refactor sweep. Source: multi-agent code review 2026-05-21; the old checklist file has since been consolidated into `TRADING_SYSTEM.md` and the active runbooks.

### Security
- `self-evolution.js`: Gemini API key moved from URL querystring to `x-goog-api-key` header (key leakage via logs/proxies/referers).
- `cycle/maintenance.js`: SQL identifier whitelist on dynamic `DELETE FROM ${table}` (block SQLi vector even though current callers use hardcoded list).
- `self-evolution.js`: external LLM prompts now passed through `redactSecretsInText()` before send (strip keys/wallet addrs/env values).

### Agent governor hardening
- `policy/preconditions.js`: `canPromoteEvolutionPatch` now denies when `causalDeltaWinRate` is NaN (was silently passing — `NaN < x === false`).
- `self-evolution.js`: policy check exception path now fails CLOSED with `verdict='auto_denied_error'` (was silently auto-allowing).
- `self-evolution.js`: corrupt JSON in `pending-validations` distinguished from missing-file; both surface in logs.
- `self-evolution.js`: `node --check` runs on patched source BEFORE disk write; aborts apply on syntax failure.
- `self-evolution.js`: backup directory pruned to last 10 after each successful apply (rollback unambiguity, disk bounded).
- `self-evolution.js`: pending-validation entries TTL-expire at 3× holdout window; outcome recorded as `verdict='expired_ttl'`.
- `evolution-validator.js`: `execNode` returns tristate `{passed, failed, unreliable}` distinguishing real validation failure from env-level error (timeout/ENOENT).
- `mutation-engine.js`: refuses `oldLine` shorter than 8 chars or composed only of structural chars (`{}()[];,`) — prevents 34K-row match explosions that silently No-op'd critical patches.
- `mutation-engine.js`: refuses template markers that are not unique in source (non-greedy regex would silently pick first pair).
- `strategy-brain.js`: `mutateParametersIfReady` now copy-on-write with `version` increment (no half-updated state on mid-flight throw).
- `agent.js`: every action funnels through `_audit()` → `data/agent-decisions.jsonl` for tamper-evident review trail; `requestHumanReview` validates context shape.

### Concurrency
- `index.js`: `restoreKucoinRecoveredBuy` is now `async` and acquires `positionMutex` around check-then-write (eliminates double-create race on concurrent exit-scan + recovery).
- `execution/orchestrator.js`: `position.exitInProgress = true` moved INSIDE try block (throw between flag-set and try cannot strand flag forever).
- `execution/orchestrator.js`: BUY path wires `risk.registerInFlightOrder(chain, sizeUsd)` after mutex + `releaseInFlightOrder()` in `finally` — heat-per-chain tracking now active.

### KuCoin adapter (ported from paper bot — closes drift)
- `exchanges/kucoin.js`: 429 backoff (`isRateLimited()`, `_handleRateLimit()`, exponential pause up to 5 min).
- `exchanges/kucoin.js`: `refreshTickers` early-exits when rate-limited; catch wraps `_handleRateLimit(err)`.
- `exchanges/kucoin.js`: BUY pre-flight now checks `getMarketTradeLimits(symbol)` for `minBaseSize` + `minFunds` + free-balance headroom (was minimal — could over-commit).
- `exchanges/kucoin.js`: stale-symbol filter uses snapshot-before-filter to avoid mutation-during-iteration race.

### Risk gates (ported from paper — closes drift)
- `risk/guardian.js`: GoPlus heuristic fallback for BSC + Solana + Base when oracle unavailable (was BSC-only outright block).
- `risk/guardian.js`: HRP portfolio allocation cap + ATR risk-per-trade cap.
- `risk/guardian.js`: KuCoin early-breakout position multiplier + GoPlus fallback size multiplier cascades.
- `risk/guardian.js`: correlation guard returns `noHistoryCapMultiplier: 0.5` when candidate has no history (was outright skip).
- `risk/guardian.js`: `checkHoneypot` fail-closed for all live DEX chains (BSC + Solana + Base), not BSC-only.
- `risk/guardian.js`: in-flight USD tracking now used in chain-heat calculation.
- `risk/guardian.js`: matrix bounds + finite check in correlation iteration.

### Execution + null/divide guards
- `utils/execution-adapter.js`: throws if `nativeQuote` not finite or ≤ 0 (was producing Infinity sizing).
- `index.js`: BTC ticker fetch failure surfaces `btcRiskOffState.lastFetchFailedAt` for downstream staleness check (was fail-open).
- `index.js`: liquidation sentinel SKIPS sell when `tokenData` null or price invalid (was selling at stale price).
- `exits/evaluate-exit-decision.js`: time-stop refuses to evaluate if `openedAt` missing (was masked by `|| now`).
- `decision/proposals.js`: SQL self-test freshness window check (`SQL_SELF_TEST_MAX_AGE_MS`, default 10 min) — stale OK is now blocker.

### Swallowed errors (now logged)
- `index.js`: liquidation sentinel `sendErrorAlert` + `getTokenData`
- `cycle/main-loop.js`: `clearInterval` failures (debug log)
- `utils/sqlTelemetry.js`: rollback failure
- `cycle/health-canary.js`: telegram alert failure (includes original failure summary)

### SQL
- `db/migrations/0018_bot_trade_ledger_baseline.sql` — formalizes table create that was inline in `sqlServer.js` (fixes 0017 referencing un-migrated schema).
- `db/migrations/0019_signals_ai_decision_fk.sql` — FK `signals.ai_decision_id → ai_decisions.id ON DELETE SET NULL`.
- `db/migrations/0020_config_changes_scope_index.sql` — composite hot-path index `(scope, knob, changed_at DESC)`.
- All three with `BEGIN TRANSACTION`/`ROLLBACK` wrappers + rollback parity files.
- `risk/pre-trade-contract.js`: `wallet_usd` populated from caller (was always-NULL).

### ML correctness
- `scripts/train-ml-leaderboard.js`: forward-bias assertion throws if any test sample ts < max train sample ts (defensive; existing `splitWalkForward` verified mathematically correct).

### Removed (dead code)
- `src/utils/polygon-market.js` — 0 importers in live, deleted.
- `src/utils/paper-early-breakout.js` — 0 importers in live, deleted.
- `src/strategy/` empty leftover dir — deleted.
- `index.js`: commented `MomentumStrategy` require (10+ commits stale).
- `index.js`: unused `registerPreTradeInFlight` / `releasePreTradeInFlight` imports.

### Operations
- `docs/runbooks/DIVERGENCE.md` — documents intentional live vs paper config divergence (day-trading vs swing profile) — do not sync.
- Historical refactor checklist content consolidated into `TRADING_SYSTEM.md` and active runbooks.

## 1.1.0 - 2026-05-21

### Added
- Strict config validation and source-audit tooling.
- Pre-trade contract runtime with shadow/enforce modes.
- Bot version gating and promotion safety checks.
- SQL read-through/backfill paths for symbol overrides, AI prompts, token cache tables, model versions, and sell tiers.
- Risk-rules CRUD endpoints and dashboard admin protection.
- Health canary, SQL telemetry, and 3-sigma anomaly detector module.
- Bull-flag stats UI/API, Backes stats API, and first-class `setup_type` trade-ledger column.

### Changed
- Live deployment stays KuCoin-only; paper deployment carries multi-chain paper-only strategy canaries.
- Refactor checklist backlog consolidated into Week 18 with completed historical work preserved in place.

### Validation
- Focused live and paper strategy suite: 334/334 passing on 2026-05-21.
