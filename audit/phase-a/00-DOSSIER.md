# Perps Phase A Dossier — Aggregate Findings + B1-Perps Plan

5 read-only research agents covered: execution, risk/sizing, strategies, paper engine, position model.
Detail in `01-execution.md` … `05-position-funding.md`.

---

## P0-Perps — Account-Ruin / Soak-Invalid

| # | Issue | File | Source |
|---|---|---|---|
| 1 | Live binance-perps.js is `guard()` stub — no REST/WS adapter | `src/exchanges/binance-perps.js:5` | 01-exec |
| 2 | reduceOnly flag not asserted on outbound | `src/paper/paper-perps-adapter.js:101` | 01-exec |
| 3 | Direction-flip vulnerability in movePct (null side falls through to long math) | `src/paper/paper-perps-adapter.js:119-122` | 01-exec |
| 4 | Liq buffer checked AFTER open not BEFORE | `src/paper/paper-perps-adapter.js:44-52` | 02-risk |
| 5 | Daily/weekly R-loss windows reset on bot restart | `src/telemetry/perps-stats.js:178-197` | 02-risk |
| 6 | Liq price frozen at original entry after scale-in | `src/paper/paper-perps-adapter.js:153` | 05-position |
| 7 | Spot rows contaminate perps data files | `data/perps-paper-{open-positions,trades}.json` | 05-position |
| 8 | Admission gate default-disabled (1-trade promotion possible) | `src/paper/paper-strategy-admission.js:37-43` | 04-paper |
| 9 | Position state race: scanner emits EXIT on already-closed position | `src/paper/paper-market-scanner.js:36` | 01-exec |

---

## P1-Perps — Correctness / Wrong Math / Soak Fidelity

| # | Issue | File | Source |
|---|---|---|---|
| 10 | Look-ahead bias: signals confirmed on current incomplete candle | engine:25, l2l:27, deviation-reclaim:25 | 03-strategies |
| 11 | MSS confirms on any close beyond 4 prior bars (no displacement floor) | `src/strategies/perps-mss-detector.js:5-23` | 03-strategies |
| 12 | RH/RL sweep + reclaim counted same candle | `src/strategies/perps-deviation-reclaim.js:19-39` | 03-strategies |
| 13 | Funding modeled linear, not 8h-discrete (real settle at UTC 00/08/16) | `paper-perps-adapter.js:74,113`, `traderxo-replay.js:65-68` | 01-exec, 04-paper, 05-position |
| 14 | Fee tier hardcoded 0.05%; real maker 0.02% / taker 0.04% | `paper-perps-adapter.js:72,114` | 01-exec, 04-paper |
| 15 | Slippage flat 2bps, depth-independent | `paper-perps-adapter.js:73,115` | 04-paper |
| 16 | markPrice/fundingRate WS feed not consumed; liq math deferred | `src/market/binance-public-perps.js:1-63` | 05-position |
| 17 | Missing clientOrderId on perps-reduce-only.js | `src/exits/perps-reduce-only.js:3-22` | 01-exec |
| 18 | -2R per-trade vs -2R daily aggregate semantics conflated | `src/risk/perps-gates.js:48` | 02-risk |
| 19 | Leverage cap 5× in paper; spec canary says 3× max | `src/risk/perps-gates.js:34` | 02-risk |
| 20 | Maintenance margin hardcoded 0.5%; varies per symbol/tier | `src/strategies/perps-sizing.js:28,32` | 02-risk |
| 21 | Sizing uses entry price not mark price | `src/strategies/perps-sizing.js:23` | 02-risk |
| 22 | riskUsd point-in-time (doesn't reset when equity grows) | `paper-perps-adapter.js:36-42` | 02-risk |
| 23 | Cross-margin not asserted everywhere | `perps-gates.js:32` + adapter | 02-risk |
| 24 | Canary mode enforcement missing (1-position max, $100 floor) | global | 02-risk |
| 25 | Anchors computed once per signal; never refreshed under management | `traderxo-paper-engine.js:245` | 03-strategies |
| 26 | L2L target validity not checked vs latest extremes | `perps-l2l-detector.js:29,47` | 03-strategies |
| 27 | Manual cut after 5 bars lacks trend context | `traderxo-paper-engine.js:112-115` | 03-strategies |
| 28 | Backtest endpoints accept user options without gate validation | `src/server.js:110-149` | 05-position |
| 29 | Telemetry tables missing `perps_*` prefix | `src/telemetry/perps-stats.js:170-173` | 05-position |
| 30 | Stressed-expectancy doubles funding unfairly | `src/telemetry/perps-stats.js:205-211` | 04-paper |

---

## P2-Perps — Hygiene

- Range tolerance basis-dependent (midpoint vs fixed) — `perps-range-detector.js:16-20`.
- normalizeCandles silently drops invalid — `perps-anchors.js:13-25`.
- Range detector lacks recency/contiguity — `perps-range-detector.js:12-23`.
- Scanner hardcoded 3 symbols — `paper-market-scanner.js:12`.
- Walk-forward floor only 10 trades vs historical 30 — `public-replay-service.js:48`.
- No HTTP 429 backoff — `binance-public-perps.js:17-21`.
- minNotionalUsd floor arbitrary — `paper-perps-adapter.js:124`.
- `_not-implemented.js` reachable from misconfigured ENV — `binance-perps.js`.
- Liq buffer not exposed in `/api/open-positions` — `server.js:73-80`.
- Position model missing `originalNotionalUsd` immutable field — `paper-perps-adapter.js:54-76`.
- Fundingrate hardcoded 1bp/8h — `paper-perps-adapter.js:74`.
- Concurrency guard on signal processor — `paper-signal-processor.js:14-66`.

---

## B1-Perps Batch

Direct on master. One commit per item. Defer #1 (binance adapter implementation, multi-day) to B-Perps-Adapter project. Defer #16 (markPrice WS feed) to same.

### B1P.1 — reduceOnly assertion on every exit
File: `src/paper/paper-perps-adapter.js`. Assert `order.reduceOnly === true` at top of exit path; throw if false.

### B1P.2 — Side guard in movePct
File: `src/paper/paper-perps-adapter.js:119-122`. Throw if `position.side` not in `['long','short']`.

### B1P.3 — Liq buffer pre-open check
File: `src/paper/paper-perps-adapter.js:44-52`. Move liq buffer check into `calculatePaperPosition()` so it can refuse to return position object; gate path becomes redundant defense.

### B1P.4 — Admission default-on
File: `src/paper/paper-strategy-admission.js:37`. Flip default: `required: env !== 'false' ? true : true` → simply `required: env === 'false' ? false : true` with code comment explaining whitelist intent.

### B1P.5 — Persistent daily/weekly R-loss windows
File: `src/telemetry/perps-stats.js`. Add `riskWindowState` field to state file; restore on boot; window summary reads persisted base + live trades since.

### B1P.6 — Liq recompute on scale-in
File: `src/paper/paper-perps-adapter.js:153`. On partial exit, recompute `liquidationPrice` + `liquidationBufferMultiple` against remaining margin + remaining notional.

### B1P.7 — Purge spot rows + enforce write-time prefix
Files: `data/perps-paper-{open-positions,trades}.json`, telemetry write path. Filter on read; assert prefix on every write.

### B1P.8 — clientOrderId on reduce-only exit
File: `src/exits/perps-reduce-only.js:3-22`. Accept or generate UUID; include in returned order.

### B1P.9 — Canary mode + leverage cap
Files: `src/risk/perps-gates.js`. Add `mode: 'paper'|'canary'|'live'`. Canary: lev ≤ 3, max 1 open position, equity floor $100.

### B1P.10 — Position state sync in scanner
File: `src/paper/paper-market-scanner.js:36`. Re-check adapter `positions` Map before emitting EXIT signal.

---

## Mandatory Checkpoint
After B1P lands, restart paper engine; verify scaffold-guards + paper-milestone tests green; 1h dry-run before any further changes.
