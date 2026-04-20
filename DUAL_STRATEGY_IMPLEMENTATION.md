# Dual Strategy Implementation Guide

## Architecture Overview

The bot now supports two simultaneous trading strategies:

### Strategy A: Swing Trading (Established Tokens)
- **Target**: Liquidity > $500k, Age > 7 days, 24h Volume > $100k
- **EMA**: Fast=21, Slow=55, RSI=21
- **Position**: Max 5% per trade, Stop Loss 12%, Take Profit 40%
- **Filters**: Reddit & DeFiLlama disabled
- **AI Floor**: 65% confidence
- **Sell Tiers**: 1.5x (33%), 2.5x (33%), 4x (34%)
- **Max Positions**: 3

### Strategy B: Momentum Trading (New Launches)
- **Target**: Age < 6 hours, Liquidity $10k-$500k
- **EMA**: Fast=9, Slow=21, RSI=14
- **Position**: Max 2% per trade, Stop Loss 8%, Take Profit 25%
- **Filters**: All enabled (Reddit, DeFiLlama, GoPlus, Buy Flow)
- **AI Floor**: 75% confidence
- **Sell Tiers**: 2x (50%), 3x (25%), 5x (25%)
- **Max Positions**: 3

**Total**: 6 concurrent positions max (3+3)

## Portfolio Structure

```javascript
portfolio = {
  positions: {},           // All positions by tokenKey
  trades: [],             // All trades
  
  strategies: {
    swing: {
      positions: {},      // Swing-only positions
      trades: [],
      stats: { ... }
    },
    momentum: {
      positions: {},      // Momentum-only positions  
      trades: [],
      stats: { ... }
    }
  },
  
  stats: { ... }          // Aggregate stats
}
```

## Token Routing Logic

```
Token Discovery
    ↓
Determine Applicable Strategies
    ↓
    ├─→ Strategy A (Swing)? 
    │   └─→ Yes: Evaluate with swing parameters
    │   └─→ No: Skip
    │
    └─→ Strategy B (Momentum)?
        └─→ Yes: Evaluate with momentum parameters
        └─→ No: Skip
    ↓
Route Signals
    ├─→ BUY from Swing → Execute for Swing, add to swing.positions
    ├─→ BUY from Momentum → Execute for Momentum, add to momentum.positions
    ├─→ SELL → Exit position (check both strategy trackers)
```

## Key Changes Implemented

### 1. config/index.js
- Added `config.strategies.swing` with all swing parameters
- Added `config.strategies.momentum` with all momentum parameters
- Kept legacy `config.strategy` for backward compatibility

### 2. src/strategy/momentum.js
- Added `determineApplicableStrategies()` - checks token age/liquidity
- Added `evaluateForStrategy(strategyName)` - uses strategy-specific EMA/RSI/filters

### 3. src/index.js
- Updated portfolio structure with strategy-specific tracking
- Updated processToken() to route to applicable strategies (IN PROGRESS)
- Added strategy-aware execution logic

### 4. src/risk/guardian.js
- Updated `positionSize()` to use strategy-specific config
- Updated position limit checks to be per-strategy
- Added `getStrategyPositionCount()` helper

## Implementation Status

✅ **Completed**:
- config/index.js - Dual strategy config
- src/strategy/momentum.js - Strategy routing methods
- src/index.js - Portfolio structure with per-strategy tracking

🔄 **In Progress**:
- processToken() dual-strategy evaluation
- Risk guardian per-strategy limits
- Dashboard updates for dual strategy display
- Backtest support for dual strategies

⏳ **Pending**:
- Test scenario validation
- Performance tuning
- Paper trading baseline

## Configuration Examples

### Example 1: Swing Only (Conservative)
```bash
STRATEGY_SWING_ENABLED=true
STRATEGY_MOMENTUM_ENABLED=false
```

### Example 2: Momentum Only (Aggressive)
```bash
STRATEGY_SWING_ENABLED=false
STRATEGY_MOMENTUM_ENABLED=true
```

### Example 3: Balanced Dual
```bash
STRATEGY_SWING_ENABLED=true
STRATEGY_MOMENTUM_ENABLED=true

# Adjust position limits
STRATEGY_SWING_MAX_POSITIONS=3
STRATEGY_MOMENTUM_MAX_POSITIONS=3
```

### Example 4: Tuned Swing Parameters
```bash
STRATEGY_SWING_ENABLED=true
STRATEGY_SWING_EMA_FAST=25
STRATEGY_SWING_EMA_SLOW=60
STRATEGY_SWING_POSITION_SIZE_PCT=6
STRATEGY_SWING_TAKE_PROFIT_PCT=50
```

## Files Modified

### Core Strategy Files
- `config/index.js` - Dual strategy configuration
- `src/strategy/momentum.js` - Strategy evaluation methods
- `src/index.js` - Portfolio structure & token routing
- `src/risk/guardian.js` - Per-strategy position sizing & limits

### Supporting Files (Planned)
- `src/dashboard.js` - Separate strategy stats display
- `src/backtest.js` - Strategy filtering in backtests
- `src/wallet-monitor.js` - Per-strategy PnL reporting
- `src/ai/ensemble.js` - Strategy-specific confidence evaluation

## Environment Variables

### Strategy A (Swing Trading)
```bash
STRATEGY_SWING_ENABLED=true
STRATEGY_SWING_EMA_FAST=21
STRATEGY_SWING_EMA_SLOW=55
STRATEGY_SWING_RSI_PERIOD=21
STRATEGY_SWING_MIN_LIQUIDITY=500000
STRATEGY_SWING_MIN_AGE_DAYS=7
STRATEGY_SWING_MIN_24H_VOLUME=100000
STRATEGY_SWING_POSITION_SIZE_PCT=5
STRATEGY_SWING_STOP_LOSS_PCT=12
STRATEGY_SWING_TAKE_PROFIT_PCT=40
STRATEGY_SWING_AI_CONFIDENCE=65
STRATEGY_SWING_MAX_POSITIONS=3
STRATEGY_SWING_DISABLED_FILTERS=reddit,defillama
STRATEGY_SWING_VOLUME_SPIKE=1.8
```

### Strategy B (Momentum Trading)
```bash
STRATEGY_MOMENTUM_ENABLED=true
STRATEGY_MOMENTUM_EMA_FAST=9
STRATEGY_MOMENTUM_EMA_SLOW=21
STRATEGY_MOMENTUM_RSI_PERIOD=14
STRATEGY_MOMENTUM_MIN_LIQUIDITY=10000
STRATEGY_MOMENTUM_MAX_AGE_DAYS=0.25
STRATEGY_MOMENTUM_POSITION_SIZE_PCT=2
STRATEGY_MOMENTUM_STOP_LOSS_PCT=8
STRATEGY_MOMENTUM_TAKE_PROFIT_PCT=25
STRATEGY_MOMENTUM_AI_CONFIDENCE=75
STRATEGY_MOMENTUM_MAX_POSITIONS=3
STRATEGY_MOMENTUM_DISABLED_FILTERS=
STRATEGY_MOMENTUM_VOLUME_SPIKE=2.5
```

## Risk Management

### Overlapping Controls
- **Global Position Limit**: 6 max (3 swing + 3 momentum)
- **Daily Drawdown**: Applies to aggregate portfolio
- **Correlation Guard**: Checks all open positions
- **Honeypot Check**: Per-token, applies to both strategies
- **Circuit Breaker**: Global, disables both strategies

### Per-Strategy Controls
- **Position Size**: Swing 5%, Momentum 2%
- **Stop Loss**: Swing 12%, Momentum 8%
- **Take Profit**: Swing 40%, Momentum 25%
- **Max Positions**: 3 each
- **AI Confidence Floor**: Swing 65%, Momentum 75%

### Protected Against
- Overlap trading (same token in both strategies simultaneously)
- Over-leveraging (6 total position limit)
- Rogue losses (tighter stops on riskier strategy)
- AI overconfidence (stricter floors)

## Testing Recommendations

### Phase 1: Paper Trading
1. **Week 1**: Momentum only (existing logic)
2. **Week 2**: Swing only (new logic)
3. **Week 3**: Hybrid (both enabled, 50 min trades each strategy)

### Phase 2: Performance Validation
- Monitor win rates per strategy
- Compare Sharpe ratios
- Track correlation between strategies
- Validate position overlap (should be 0%)

### Phase 3: Live Trading
- Start with small position sizes
- Gradually increase over 2-4 weeks
- Monitor daily PnL by strategy
- Watch for drawdown clustering

## Monitoring Dashboard

Startup will show:
```
=== DEX Momentum Trading Bot ===
Mode: LIVE TRADING
Strategies: swing+momentum (dual)
  
Strategy A - Swing Trading
  EMA: 21/55, RSI: 21
  Risk: 5% position, 12% stop, 40% profit
  Max positions: 3
  AI floor: 65%
  
Strategy B - Momentum Trading
  EMA: 9/21, RSI: 14
  Risk: 2% position, 8% stop, 25% profit
  Max positions: 3
  AI floor: 75%

Position Limits: 3 swing + 3 momentum = 6 total
```

During trading, logs will show:
```
Token WETH: ✓ Swing ✗ Momentum (age=15d, liq=$2.3M)
  → Routing to Strategy A (Swing)
  
Token NEWCOIN: ✗ Swing ✓ Momentum (age=2h, liq=$250k)
  → Routing to Strategy B (Momentum)
```

## Troubleshooting

### No Swing Trades
- Check: Token age > 7 days? Liquidity > $500k? Volume > $100k?
- Verify: `STRATEGY_SWING_ENABLED=true`
- Review: Watchlist has suitable tokens

### No Momentum Trades  
- Check: Token age < 6 hours? Liquidity > $10k?
- Verify: `STRATEGY_MOMENTUM_ENABLED=true`
- Review: Discovery mode not set to 'watchlist'

### Overlapping Positions
- Should never happen (architecture prevents it)
- If observed: Report as bug

### Unbalanced PnL
- Compare win rates and profit factors per strategy
- Adjust position sizes if one strategy outperforms

## Next Steps

1. **Complete processToken() implementation** - Route tokens to applicable strategies
2. **Update risk/guardian.js** - Per-strategy position limits
3. **Update dashboard.js** - Show separate strategy stats
4. **Paper trade** - Validate 2-4 weeks before live
5. **Monitor** - Track per-strategy performance daily
