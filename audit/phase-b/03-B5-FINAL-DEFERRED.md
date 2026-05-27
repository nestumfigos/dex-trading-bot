# Phase B5 Summary — Final Deferred Pass

Closes every item the B4 dossier flagged "still deferred". Direct-on-main, both repos.

Tests on completion: **202/202 spot green, 49/49 perps green.**

## Spot

| # | Item | File | Status |
|---|---|---|---|
| B5.9  | `RISK_MAX_NATIVE_PRICE_AGE_MS` default tightened 120s → 30s per audit | `src/index.js:2758` | ✓ |
| B5.8  | Wire Merkle `pollBundleStatus` → `recordRelayLandedOutcome` (fire-and-forget after submission-accepted) | `src/utils/merkle-bundle.js:234` | ✓ |
| B5.dash.3 | 24h PnL no longer silently falls back to `unrealizedPnl`; prefer server-supplied, else recompute, else `—` | `public/dashboard.js:107` | ✓ |
| B5.dash.5 | Polling default 5s → 10s; localStorage `dt.refreshMs` override preserved | `public/dashboard.js:5` | ✓ |
| B5.dash.6 | Invested-% prefers server-side `exposurePctOfEquity`; falls back to local recompute only when missing | `public/dashboard.js:92` | ✓ |
| B5.dash.9 | Chart CDN failure surfaces a 15s banner alert so operator sees the chart is unavailable (KPIs still update) | `public/dashboard.js:486` | ✓ |

## Perps

| # | Item | File | Status |
|---|---|---|---|
| B5P.6 | Cross-margin assertion in `calculatePaperPosition` and `paper-perps-adapter.openPosition`; gate already enforces, three layers now | `src/strategies/perps-sizing.js`, `src/paper/paper-perps-adapter.js` | ✓ |
| B5P.4 | Per-symbol maintenance-margin tier table (BTC/ETH/SOL) with leverage-cap-aware fallback. Caller passes `symbol`+`notionalUsdHint`; sizing resolves MM automatically when not explicitly supplied | new `src/strategies/perps-maintenance-margin.js`, `src/strategies/perps-sizing.js` | ✓ |
| B5P.5 | `calculatePaperPosition` accepts `markPrice`; uses it as the reference for stop-distance + liquidationPrice math. Falls back to entryPrice when WS markPrice unavailable. Result includes `referencePrice` + `markPriceUsed` flags | `src/strategies/perps-sizing.js` | ✓ |
| B5P.3 | 8h discrete funding accrual. Counts UTC boundaries (00:00/08:00/16:00) crossed between `openedAt` and close instead of linear `heldHours/8`. Position opened mid-cycle and closed before the next boundary now pays $0 funding; position spanning N boundaries pays N × rate × notional | `src/paper/paper-perps-adapter.js:179` | ✓ |
| B5P.2 | New WebSocket consumer for binance `markPrice@1s` per-symbol streams. Exposes `subscribe / unsubscribe / getLatest / getLatestMarkPrice / getStatus / close`. Auto-reconnect with jitter + max-attempts ceiling | new `src/market/binance-perps-ws.js` | ✓ |
| B5P.1 | Binance USD-M perps REST adapter scaffold (signed). Methods: `placeOrder / cancelOrder / getOrder / getOpenOrders / getAccount / getPositionRisk / getMarkPrice / getExchangeInfo`. clientOrderId is mandatory (auto-UUID prefix `bot-`) for retry idempotency. NOT wired into `binance-perps.js` — guard stub stays in place so accidental imports still throw NotImplementedError. Operator wires this when canary plan triggers (PERPS_BOOTSTRAP D.14) | new `src/exchanges/binance-perps-rest.js` | ✓ |

## Notes

- **B5P.1 not wired**: deliberate. `scaffold-guards.test.js` enforces the guard stub. When operator promotes to live, replace the import line in upstream code, not the file itself. The REST adapter is constructor-gated on `apiKey + apiSecret` so it cannot be accidentally instantiated.
- **B5P.2 not wired**: deliberate. New consumer doesn't auto-start. Caller (paper or live) must invoke `createBinancePerpsWsConsumer({...}).subscribe([...])` to begin streaming. Once wired, sizing path can pass `markPrice` from `getLatestMarkPrice(symbol)` into `calculatePaperPosition`.
- **Funding test fixture untouched**: existing `paper lifecycle charges both-side costs and elapsed funding by default` runs over a long-enough span (~24h) to cross multiple boundaries, so the discrete model still produces non-zero funding.
- **MM tier numbers** match Binance USD-M tier table as of 2025-Q4; refresh when binance changes them.

## Cumulative Phase B State (post-B5)

| Batch | Spot | Perps | Total |
|---|---|---|---|
| B1  | 9  | —  | 9 |
| B1P | —  | 10 | 10 |
| B2  | 14 | 11 | 25 |
| B3  | 16 | 3  | 19 |
| B4  | 10 | 3  | 13 |
| **B5** | **6** | **6** | **12** |
| **TOTAL** | **55** | **33** | **88** |

Total live edits **88 items** across spot + perps + 25 audit reports + 9 verified-no-fix comments.

## What's Truly Still Open

- **Operator must flip the binance-perps live import** when canary criteria met (B5P.1 is built but gated).
- **Operator must call subscribe() on markPrice WS consumer** when ready (B5P.2 is built but inert).
- **Funding-stream subscription** — separate from markPrice (the WS module currently only fans out markPrice ticks; fundingRate comes alongside markPrice payloads anyway, so latest.fundingRate IS populated).
- **MM tier refresh** when binance changes the table.
- **Real backfill on regime_patterns** if a live DB still missing the M0024 → M0025 → M0026 chain.

These are operator actions, not code work.

## Commit Plan
- Spot: single commit on `master`.
- Perps: single commit on `master`.
