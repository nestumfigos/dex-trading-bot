# Phase B4 Summary — Deferred Items Pass

Picks up the items the dossier flagged "deferred" in B2 + B3. Direct-on-main, both repos.

Tests on completion: **202/202 spot green, 49/49 perps green.**

## Spot

| # | Item | File | Status |
|---|---|---|---|
| B4.cso.1 | CMC + NVIDIA credential log redaction (API key + bearer never reach error logs) | `src/utils/coinmarketcap.js`, `src/utils/nvidia-ai.js` | ✓ |
| B4.risk.7 | Untracked-wallet warn-once when >50% of capital base | `src/risk/guardian.js` `getChainCapitalBaseUsd` | ✓ (warn — bot cannot manage operator-only positions) |
| B4.risk.8 | PF-gate skip-on-no-loss now logs a warn-once so operator sees the skip path is intentional, not a bug | `src/risk/guardian.js:506` | ✓ |
| B4.risk.9 | KuCoin 80% cap: **verified no-fix** — only invoked in `checkChainHeat` which runs pre-order; comment pinned | `src/risk/guardian.js:606` | ✓ |
| B4.dash.4 | `/api/status` adds `fetchedAt` + `fetchedAtEpochMs` so UI can render "as of …" | `src/dashboard.js:613` | ✓ |
| B4.dash.7 | Force-sell button now requires the operator to type the symbol AND provides Bearer token header (route was already token-gated by B1.1) | `public/dashboard.js:178` | ✓ |
| B4.dash.10 | `PATCH /api/risk-rules/:name` validates scope ∈ {live\|paper\|both}, name length ≤ 64, rejects unknown body fields | `src/dashboard-extensions.js:322` | ✓ |
| B4.api.8 | Merkle relay scoring distinguishes `accepted` (HTTP 200 + bundleHash) from `landed` (post-poll inclusion). `getRelayScore` weights landed 5× when present; falls back to legacy accepted-only score otherwise. New `recordRelayLandedOutcome` exported for callers wiring `pollBundleStatus` | `src/utils/merkle-bundle.js:81` | ✓ |
| B4.api.9 | `ws-discovery.startEvmPairCreated` validates listener count immediately after subscribe; failed-zero schedules reconnect | `src/discovery/ws-discovery.js:430` | ✓ |
| B4.exec.10 | Quote freshness: **verified-already-enforced** — `getNativeQuoteOrThrow` already throws on stale/missing timestamp via `config.risk.maxNativePriceAgeMs`. Audit-recommended 30s ceiling can be set via env override; default 120s retained for ops compatibility | `src/index.js:2758` | ✓ |

## Perps

| # | Item | File | Status |
|---|---|---|---|
| B4P.norm | `normalizeCandlesWithMeta` exported; returns `{candles, inputCount, droppedCount, reasons}` so callers can detect data-quality issues. Legacy `normalizeCandles` wraps it for backward compat | `src/strategies/perps-anchors.js:13` | ✓ |
| B4P.range | Range detector adds recency floor: at least one touch on each side must fall inside the last half of the lookback window, otherwise `range_touches_not_recent` rejects | `src/strategies/perps-range-detector.js:18` | ✓ |
| B4P.backtest-gate | `/api/backtests/traderxo/*` POST options sanitized via `ALLOWED_RESEARCH_OPTIONS` whitelist; leverage clamped at 5, equity at 100k, mode forced to `paper`. Rejected keys surfaced in response | `src/server.js:22` | ✓ |

## Test Fixture Changes

- `dex-trading-bot-perps/test/traderxo-paper-strategy.test.js` — both `rangeCandles` fixtures (in `horizontal range requires repeated RH and RL touches` and `native paper scanner opens, scales, and closes a genuine perps lifecycle`) extended with recent RH (109.95) + RL (100.05) touches so they satisfy the new recency floor.

## Still Deferred (out of scope)

- **Binance perps adapter implementation** (W15 D.2 — multi-day).
- **markPrice / fundingRate WS feed** consumer.
- **8h-discrete funding** settlement accrual.
- **Maintenance margin per-symbol fetch** from Binance tier table.
- **Sizing entry → mark price** plumbing (needs fill-ack).
- **Cross-margin assertion in every code path** (defensive duplication).
- **Dashboard hygiene 3,5,6,9** — 24h PnL client-side recompute, polling rate tighten, invested-% drift, chart CDN fail-loud. All client-side and out of server-fix scope.
- **Wire Merkle `pollBundleStatus` → `recordRelayLandedOutcome`** on the caller side. Hook is added by B4.api.8 but the producer-side wiring needs caller refactor.
- **Tighten `RISK_MAX_NATIVE_PRICE_AGE_MS` default** from 120s → 30s after ops validate slow-refresh paths.

## Cumulative Phase B State (post-B4)

| Batch | Spot items | Perps items | Total |
|---|---|---|---|
| B1  | 9  | —  | 9 |
| B1P | —  | 10 | 10 |
| B2  | 14 | 11 | 25 |
| B3  | 16 | 3  | 19 |
| **B4** | **10** | **3** | **13** |
| **TOTAL** | **49** | **27** | **76** |

Total live edits **76 items** across the spot + perps codebases, plus 25 audit reports.

## Commit Plan
- Spot: single commit on `master`.
- Perps: single commit on `master` (now consolidated; ruflo/phase1-perps merged earlier in this session).
