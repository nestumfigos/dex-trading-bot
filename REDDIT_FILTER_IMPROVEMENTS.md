# Reddit Filter & External Filters Improvements

## Problem Summary
The Reddit filter was **silently blocking 90%+ of BSC/Base tokens** by requiring at least 1 Reddit post in the last 1 hour. This killed the signal pipeline without visible indication.

## Changes Made

### 1. **Config-Driven Filters** (`config/index.js`)
Added comprehensive `config.filters` object with environment variable support:

```js
filters: {
  reddit: {
    enabled: process.env.REDDIT_FILTER_ENABLED !== 'false',  // Can disable entirely
    minPostsRequired: parseInt(process.env.REDDIT_MIN_POSTS || '0', 10),  // Default: 0 (any activity OK)
    lookbackHours: parseInt(process.env.REDDIT_LOOKBACK_HOURS || '24', 10),  // Increased: 1h → 24h
    disabledChains: (process.env.REDDIT_DISABLED_CHAINS || '').split(',').filter(c => c.trim()),  // e.g., 'bsc,base'
  },
  coincap: {
    enabled: process.env.COINCAP_FILTER_ENABLED !== 'false',
    maxPriceMismatchPct: parseFloat(process.env.COINCAP_MAX_MISMATCH_PCT || '15'),
  },
  cryptocompare: {
    enabled: process.env.CRYPTOCOMPARE_FILTER_ENABLED !== 'false',
    maxPriceMismatchPct: parseFloat(process.env.CRYPTOCOMPARE_MAX_MISMATCH_PCT || '15'),
  },
  defillama: {
    enabled: process.env.DEFILLAMA_FILTER_ENABLED !== 'false',
    minApyRequired: parseFloat(process.env.DEFILLAMA_MIN_APY || '2'),
  },
}
```

### 2. **Dynamic Filter Configuration** (`src/strategy/momentum.js`)
- Changed filters from hardcoded booleans to dynamic config-driven functions
- Reddit filter now:
  - Uses **24-hour lookback** instead of 1 hour (default)
  - Requires **0 minimum posts** by default (any activity passes)
  - Can be **disabled per-chain** via `REDDIT_DISABLED_CHAINS` env var
  - Checks if token's chain is in the disabled list before blocking
- Added detailed logging: `Reddit filter blocked ${symbol}: X posts found, Y required`

### 3. **Filter Statistics Tracking** (`src/index.js`)
Added `filterStats` object to track suppression metrics:

```js
filterStats = {
  evaluated: 0,      // Total tokens evaluated
  redditBlocked: 0,  // Blocked by Reddit filter
  coincapBlocked: 0, // Blocked by CoinCap filter
  cryptocompareBlocked: 0,
  defillmaBlocked: 0,
  passed: 0,         // Passed all filters
}
```

Reports every 60 seconds:
```
Filter stats (60s): evaluated=450 | passed=89.3% | reddit_blocked=8.2% | coincap_blocked=2.5% | total_filtered=48
```

### 4. **Startup Configuration Display**
On startup, bot now shows active filter settings:

```
=========================================
 DEX Momentum Trading Bot - Starting up
  Mode: LIVE TRADING
  Strategy: EMA(9/21) + RSI(14)
  AI Brain: claude-3-5-haiku-20241022
  Reddit Filter: enabled (24h window, min 0 posts) [disabled for: bsc, base]
  CoinCap Filter: enabled (15% max mismatch)
  CryptoCompare Filter: enabled (15% max mismatch)
  DeFiLlama Filter: enabled (2% min APY)
=========================================
```

## Environment Variables

### Reddit Filter
```bash
REDDIT_FILTER_ENABLED=true              # Enable/disable Reddit filter (default: true)
REDDIT_MIN_POSTS=0                      # Minimum posts required (default: 0 = any activity)
REDDIT_LOOKBACK_HOURS=24                # Lookback window (default: 24 hours)
REDDIT_DISABLED_CHAINS=bsc,base         # Disable Reddit filter for these chains
```

### Other Filters
```bash
COINCAP_FILTER_ENABLED=true             # Enable/disable CoinCap price check
COINCAP_MAX_MISMATCH_PCT=15             # Max price deviation (default: 15%)

CRYPTOCOMPARE_FILTER_ENABLED=true       # Enable/disable CryptoCompare check
CRYPTOCOMPARE_MAX_MISMATCH_PCT=15       # Max price deviation (default: 15%)

DEFILLAMA_FILTER_ENABLED=true           # Enable/disable DeFiLlama yield check
DEFILLAMA_MIN_APY=2                     # Minimum APY required (default: 2%)
```

## Recommended .env Settings for Different Scenarios

### Scenario 1: Maximize Solana Signals (Reddit-heavy market)
```
REDDIT_MIN_POSTS=1
REDDIT_LOOKBACK_HOURS=24
REDDIT_DISABLED_CHAINS=
```

### Scenario 2: Include BSC/Base (Reddit sparse)
```
REDDIT_MIN_POSTS=0                      # Accept any Reddit activity
REDDIT_LOOKBACK_HOURS=24
REDDIT_DISABLED_CHAINS=bsc,base         # Skip Reddit check for these chains
```

### Scenario 3: Aggressive (Minimal Filters)
```
REDDIT_FILTER_ENABLED=false
COINCAP_FILTER_ENABLED=false
CRYPTOCOMPARE_FILTER_ENABLED=false
DEFILLAMA_FILTER_ENABLED=false
```

### Scenario 4: Conservative (Strict Filters)
```
REDDIT_MIN_POSTS=5                      # At least 5 posts in 24h
REDDIT_LOOKBACK_HOURS=12
DEFILLAMA_MIN_APY=10                    # Only high-yield protocols
```

## Impact Analysis

### Before (Hardcoded)
- 1-hour Reddit window → blocked most new tokens
- Required 1+ post → suppressed 90%+ of BSC/Base
- No visibility into what was blocked
- Not configurable without code changes

### After (Configurable)
- 24-hour window by default → more reasonable
- 0 minimum posts by default → less restrictive
- Per-chain control → can disable Reddit on BSC/Base
- Statistics reporting every 60s → visibility into filter impact
- All configurable via env vars → no code changes needed

## Testing the Filter

### Check current filter impact:
Monitor logs for the recurring message:
```
Filter stats (60s): evaluated=450 | passed=89.3% | reddit_blocked=8.2% | ...
```

### Temporarily disable Reddit filter on BSC:
```bash
REDDIT_DISABLED_CHAINS=bsc npm start
```

### Completely disable all external filters:
```bash
REDDIT_FILTER_ENABLED=false \
COINCAP_FILTER_ENABLED=false \
CRYPTOCOMPARE_FILTER_ENABLED=false \
DEFILLAMA_FILTER_ENABLED=false \
npm start
```

### Use strict Reddit requirement:
```bash
REDDIT_MIN_POSTS=2 \
REDDIT_LOOKBACK_HOURS=12 \
npm start
```

## Monitoring Recommendations

1. **First 30 minutes**: Watch logs for filter statistics
   - If `reddit_blocked > 50%`, consider disabling for BSC/Base
   - If `passed < 30%`, filters are too strict

2. **Compare signal rates**: 
   - Measure trades/hour with Reddit filter ON vs OFF
   - If >50% fewer trades with Reddit ON, disable it per-chain

3. **Adjust based on chain**:
   - Solana: Reddit is useful (highly discussed)
   - BSC: Reddit less useful (smaller Reddit presence)
   - Base: Reddit minimal (newer chain)

## Future Enhancements

1. Per-token override list (force-include/exclude specific addresses)
2. Whitelist/blacklist integration with Discord/Twitter
3. Time-based filter adjustments (stricter during low-liquidity hours)
4. Filter effectiveness scoring (% of signals that resulted in profitable trades)
