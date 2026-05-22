# Changelog

## 1.2.0 - 2026-05-22 (pending canary)

Mirrored from live bot 1.2.0 refactor (Week-of-2026-05-21). See live `CHANGELOG.md` for full detail.

Paper-specific deltas:
- `risk/guardian.js`: `getChainWalletBalanceUsd` paper /N fallback now subtracts known-real chain balances before dividing, eliminating double-count when one chain outage co-occurs with real balance on another.
- `state/portfolio.js`: added `walletBalancesPartialNull` flag for downstream warning surfacing.
- `backtest.js`: liquidity-impact term in fill model — `k * sqrt(notional/liquidityUsd) * 10000` bps, capped at 200bps (closes 10-50bps thin-book understatement gap).
- `src/utils/paper-early-breakout.js` + `src/utils/polygon-market.js` reconstructed as functional stubs after misidentified-as-dead deletion (consumed by feature-pipeline + test/kucoin-early-breakout.test.js).
- `test/paper-early-breakout.test.js` removed (kucoin-early-breakout.test.js covers same function).

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
