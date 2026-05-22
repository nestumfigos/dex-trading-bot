# Live vs Paper Bot Divergence (intentional)

Audit date: 2026-05-21. Re-run after every cross-port.

## Status by file

| File | Status |
|------|--------|
| `src/exchanges/kucoin.js` | Synced (Day 2 port: 429 backoff, balance pre-flight, minFunds check) |
| `src/risk/guardian.js` | Synced (Day 2 port: in-flight tracking, GoPlus heuristic fallback, ATR cap, HRP cap, unseenMultiplier, no-history correlation cap) |
| `config/index.js` | **INTENTIONALLY DIVERGENT** — see below |
| `src/index.js` (race fix) | Synced (Day 1: `restoreKucoinRecoveredBuy` mutex) |
| `src/execution/orchestrator.js` | Synced (Day 1: `exitInProgress` inside try) |
| `src/self-evolution.js` | Synced (Day 1: Gemini header auth + JSON load logging) |
| `src/policy/preconditions.js` | Synced (Day 1: NaN deltaWr gate) |
| `src/cycle/maintenance.js` | Synced (Day 1: SQL identifier whitelist) |
| `src/mutation-engine.js` | Synced (Day 1: oldLine ambiguity + marker uniqueness) |

## Config divergence rationale

Paper bot = **day-trading research profile**. Tighter stops, faster exits, more aggressive exploration, all chains enabled.
Live bot = **conservative swing profile**. Wider stops, longer holds, KuCoin-only, capital preservation prioritized.

Trying to fully sync `config/index.js` defaults would destroy each profile's intent. Keep divergent ENV defaults; sync code logic only.

### Risk knobs (intentional)

| Key | Live default | Paper default | Reason |
|-----|--------------|---------------|--------|
| `stopLossPct` | 8 | 6 | Live tolerates wider drawdown on swing; paper exits faster on day trades |
| `takeProfitPct` | 25 | 25 | Matched |
| `staleDriftTier1Hours` | 12 | 24 | Live forces out drifters faster (capital scarcity); paper has more patience |
| `staleDriftTier1MinProfitPct` | 1 | 3 | Live exits sooner on weak winners |
| `staleDriftTier2Hours` | 24 | 48 | Same — live tighter |
| `staleDriftTier2MinProfitPct` | 3 | 5 | Same — live tighter |

### Paper-only knobs (not present in live)

These exist only in paper because they exercise multi-chain DEX paths (BSC/Solana/Base) that live does not use per commit `d129b25` (KuCoin-only enforcement):

- `polygon.*` (price provider, off without API key)
- `kucoinEarlyBreakoutSignalCascadeMinConfirmations`, `kucoinEarlyBreakoutStopLossPct`, `kucoinEarlyBreakoutPositionSizeMultiplier`
- `riskPerTradePct`, `atrRiskSizingEnabled`, `atrFallbackStopPct`, `maxKellyFraction`
- `goplusFallbackHeuristicEnabled`, `goplusFallbackMinLiquidityUsd`, `goplusFallbackSizeMultiplier`
- `portfolioOptimization.*` (HRP allocation)

These ENV defaults can be added to live `config/index.js` if/when live re-enables multi-chain trading. The CODE that consumes them (in `guardian.js`) is already ported and gracefully no-ops on `undefined`.

## Re-verification commands

```sh
diff -u dex-trading-bot/src/exchanges/kucoin.js dex-trading-bot-paper/src/exchanges/kucoin.js
diff -u dex-trading-bot/src/risk/guardian.js dex-trading-bot-paper/src/risk/guardian.js
diff -u dex-trading-bot/config/index.js dex-trading-bot-paper/config/index.js
```

Expected (post-Day-2):
- `kucoin.js` — small diffs (paper-specific code paths only)
- `guardian.js` — comment + block-order only; behaviorally identical
- `config/index.js` — large diff (documented above)
