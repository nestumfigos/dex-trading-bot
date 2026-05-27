# Phase B3 Summary — Hygiene Pass

P2 hygiene items from Phase A audits. Direct-on-main, both repos.

Tests on completion: **202/202 spot green, 49/49 perps green.**

## Spot

| # | Item | File | Status |
|---|---|---|---|
| B3.api.4  | 429 backoff helper + adoption (CoinPaprika, DeFiLlama, Solscan) | `src/utils/http-retry.js` (new), `coinpaprika-market.js`, `onchain/defillama.js`, `onchain/solscan.js` | ✓ |
| B3.api.5  | X/Twitter sentiment error logging (warn → error + HTTP code) | `src/utils/x-sentiment.js` | ✓ |
| B3.api.6  | Python sidecar 12s → 4s timeout (fits inside trading loop tick) | `src/utils/python-sidecar.js` | ✓ |
| B3.api.7  | Jito bundle poll bounded by maxAttempts=15 | `src/utils/jito-bundle.js:297` | ✓ |
| B3.api.10 | DeFiLlama macro error: log url+status+timestamp before propagation | `src/utils/onchain-macro.js` | ✓ |
| B3.api.11 | CoinGecko not-found cache 1h → 5min | `src/utils/coingecko.js:67` | ✓ |
| B3.strat.6 | EMA empty-array null guard → returns neutral instead of NaN→bearish | `src/utils/timeframe-confluence.js` | ✓ |
| B3.strat.7 | RSI extreme threshold uses `rsiBuyMaxThreshold` config (was hardcoded 95) | `src/utils/indicators.js:170` | ✓ |
| B3.strat.9 | Orderbook depth filter: **verified-no-fix** (audit reread, logic correct; comment pinned) | `src/utils/orderbook-imbalance.js:53` | ✓ |
| B3.exec.4  | Jupiter retry permanent-error fail-fast (price-impact, no-route, blacklisted) | `src/exchanges/jupiter.js:295` | ✓ |
| B3.exec.8  | Distributed lock TTL ≥ execTimeoutMs + 10s buffer | `src/execution/orchestrator.js:177` | ✓ |
| B3.exec.10 | Quote staleness validation: **deferred** (needs cross-module timestamp plumbing; tracking comment in code) | `src/utils/execution-adapter.js` | △ |
| B3.dash.8  | Admin token 30min idle expiry + sliding refresh | `public/dashboard.js:600` | ✓ |
| B3.sql.7   | **M0026** drops `IX_regime_patterns_lookup` and recreates with `WHERE active=1` filter; bumps `_schema_version` to 26 | `db/migrations/0026_regime_patterns_active_filter.sql` (new) | ✓ |
| B3.sql.10  | SQL pool retry with exponential backoff (500ms→8s, 5 attempts) | `src/utils/sqlServer.js:66` | ✓ |
| B3.sl.11   | Promotion governance exposes `discrepancy.scoreRaw` (unclamped); evolution-governor uses it for threshold compare | `src/utils/promotion-governance.js`, `src/evolution-governor.js:245` | ✓ |

## Perps

| # | Item | File | Status |
|---|---|---|---|
| B3P.04 | Range tolerance basis switched midpoint → `high` for regime-independent threshold | `src/strategies/perps-range-detector.js:18` | ✓ |
| B3P.09 | Walk-forward floor 10 → 30 trades (aligns with historical-replay gate) | `src/backtest/public-replay-service.js:48` | ✓ |
| B3P.14 | Binance public perps `getKlines` retries 429 + 5xx + transient with exponential backoff | `src/market/binance-public-perps.js:12` | ✓ |

## Test Fixture Changes

- `dex-trading-bot-perps/test/traderxo-replay.test.js:178` — assertion updated `validation_trade_count_below_10` → `_below_30` to match B3P.09 raised floor.

## Deferred (still tracking)

- **B3.exec.10** quote-freshness: needs `getNativeQuoteWithMeta(chain, tokenData) → { price, fetchedAt }` and config knob `execution.maxQuoteAgeMs`. Tracking comment lives in `src/utils/execution-adapter.js`.
- **B3.dash.{3,4,5,6,7,9,10}** dashboard hygiene (24h PnL client-side recompute, KPI timestamps, polling rate, invested % drift, force-sell confirm, chart CDN fail-loud, risk-rules PATCH schema) — all client-side. Out of B3 server-fix scope; revisit when UI sprint runs.
- **B3.api.8** Merkle relay landed-vs-success cross-check — needs `bundleStats` integration that doesn't exist yet.
- **B3.api.9** WebSocket subscription re-validation on reconnect — needs ws-discovery refactor.
- **B3.risk.{7,8,9}** untracked wallet exposure / PF skip-on-no-loss / KuCoin 80% pre-order — out of hygiene scope (correctness items, would fit B2 if not B3).

## Cumulative Phase B State

| Batch | Spot items | Perps items | Status |
|---|---|---|---|
| B1  | 9 | — | committed |
| B1P | — | 10 | committed |
| B2  | 14 | 11 | committed |
| **B3** | **16** | **3** | this commit |

Total live edits **63 items**, plus 25 audit reports, plus 7 verified-no-fix comments.

## Commit Plan
- Spot: single commit on `master` (B3 hygiene + M0026).
- Perps: single commit on `master` (B3P hygiene + WF floor test fixture).
