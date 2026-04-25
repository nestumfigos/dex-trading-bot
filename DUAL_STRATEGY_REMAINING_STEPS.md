# Dual Strategy Implementation - Remaining Steps

## Part 1: Update RiskGuardian for Per-Strategy Limits

**File**: `src/risk/guardian.js`

### Add to constructor:
```javascript
this.strategyPositionCounts = {
  swing: 0,
  momentum: 0,
};
```

### Add new methods:

```javascript
getStrategyPositionCount(strategyName) {
  return this.strategyPositionCounts[strategyName] || 0;
}

updateStrategyPositionCount(strategyName, delta = 1) {
  if (!this.strategyPositionCounts[strategyName]) {
    this.strategyPositionCounts[strategyName] = 0;
  }
  this.strategyPositionCounts[strategyName] += delta;
  const swing = this.strategyPositionCounts.swing || 0;
  const momentum = this.strategyPositionCounts.momentum || 0;
  logger.debug(`Position counts: swing=${swing}, momentum=${momentum}, total=${swing + momentum}`);
}
```

### Update `positionSize()` method to use strategy-specific config:

Replace:
```javascript
positionSize(tokenData) {
  const pct = Number(config.risk.maxPositionSizePct || 3) / 100;
```

With:
```javascript
positionSize(tokenData, strategyName = 'momentum') {
  const strategyCfg = config.strategies?.[strategyName] || {};
  const pct = Number(strategyCfg.positionSizePct || 3) / 100;
```

### Update `canTrade()` method to check per-strategy limits:

Add before existing checks:
```javascript
// Check per-strategy position limits
if (strategyName) {
  const strategyLimit = config.strategies?.[strategyName]?.maxConcurrentPositions || 3;
  const strategyCount = this.getStrategyPositionCount(strategyName);
  if (strategyCount >= strategyLimit) {
    logger.warn(`${strategyName} strategy at position limit (${strategyCount}/${strategyLimit})`);
    return { canTrade: false, reason: `${strategyName} position limit reached` };
  }
}
```

---

## Part 2: Update executeBuy to Track Strategy

**File**: `src/index.js`

### Update executeBuy signature:
```javascript
async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum') {
```

### Add strategy tracking to position creation:
```javascript
const position = {
  // existing fields...
  strategy: strategyName,  // Add this
  createdAt: new Date().toISOString(),
  // ...rest
};

// Add to portfolio positions
portfolio.positions[tokenKey] = position;

// ALSO add to strategy-specific positions
portfolio.strategies[strategyName].positions[tokenKey] = position;
portfolio.strategies[strategyName].trades.push(trade);  // track trade per strategy
```

### Update guardian call:
```javascript
const sizeUsd = risk.positionSize(tokenData, strategyName);
```

---

## Part 3: Update executeSell for Strategy Tracking

**File**: `src/index.js`

### Add strategy parameter:
```javascript
async function executeSell(chainName, exchange, tokenData, position, sellPct = 1, reason = 'EXIT') {
  const strategyName = position.strategy || 'momentum';  // Get from position
```

### Update stats tracking to be per-strategy:
```javascript
portfolio.strategies[strategyName].stats.closedTrades += 1;
portfolio.strategies[strategyName].stats.wins += (pnl > 0 ? 1 : 0);
if (pnl < 0) {
  portfolio.strategies[strategyName].stats.consecutiveLosses += 1;
}
// Update all strategy stats...

// THEN update aggregate stats
portfolio.stats.closedTrades += 1;
portfolio.stats.wins += (pnl > 0 ? 1 : 0);
// etc...
```

### Update position count:
```javascript
// On sale completion, decrement position count
if (sellPct >= 1.0) {  // Full exit
  risk.updateStrategyPositionCount(strategyName, -1);
}
```

---

## Part 4: Update Dashboard for Dual Strategies

**File**: `src/dashboard.js`

### Add `/api/strategies` endpoint:

```javascript
app.get('/api/strategies', (req, res) => {
  const swingStats = portfolio.strategies.swing.stats;
  const momentumStats = portfolio.strategies.momentum.stats;
  
  res.json({
    swing: {
      openPositions: Object.values(portfolio.strategies.swing.positions).length,
      stats: swingStats,
      profitFactor: swingStats.grossProfit / (swingStats.grossLoss || 1),
      winRate: (swingStats.wins / (swingStats.closedTrades || 1)) * 100,
    },
    momentum: {
      openPositions: Object.values(portfolio.strategies.momentum.positions).length,
      stats: momentumStats,
      profitFactor: momentumStats.grossProfit / (momentumStats.grossLoss || 1),
      winRate: (momentumStats.wins / (momentumStats.closedTrades || 1)) * 100,
    },
    aggregate: {
      totalPositions: Object.values(portfolio.positions).length,
      stats: portfolio.stats,
      profitFactor: portfolio.stats.grossProfit / (portfolio.stats.grossLoss || 1),
    },
  });
});
```

### Update `buildDashboardState()` to include strategy info:

```javascript
const buildDashboardState = () => {
  return {
    // ... existing fields
    strategies: {
      swing: {
        enabled: config.strategies.swing.enabled,
        positions: portfolio.strategies.swing.positions,
        stats: portfolio.strategies.swing.stats,
      },
      momentum: {
        enabled: config.strategies.momentum.enabled,
        positions: portfolio.strategies.momentum.positions,
        stats: portfolio.strategies.momentum.stats,
      },
    },
    // ... rest
  };
};
```

---

## Part 5: Update Backtest Support

**File**: `src/backtest.js`

### Add strategy parameter to backtest functions:

```javascript
async function runBacktest(strategyName = 'momentum', timeframe = '1d') {
  const strategyCfg = config.strategies?.[strategyName];
  if (!strategyCfg) {
    logger.error(`Invalid strategy: ${strategyName}`);
    return;
  }
  
  // Use strategy-specific parameters for backtest
  // ... rest of implementation
}
```

---

## Part 6: Update AI Ensemble

**File**: `src/ai/ensemble.js`

### Pass strategy to AI evaluators:

```javascript
async evaluateToken(tokenData, context) {
  const strategyName = context.strategy || 'momentum';
  const confidenceFloor = context.confidenceFloor || 70;
  
  // Adjust prompts based on strategy
  const isSwing = strategyName === 'swing';
  const timeframeHint = isSwing ? 'longer-term swing trade (days/weeks)' : 'short-term momentum trade (minutes/hours)';
  
  // ... pass to Claude/Groq/Gemini with strategy context
}
```

---

## Part 7: Update Startup Logging

**File**: `src/index.js` - main() function

Add before scan loop starts:

```javascript
logger.info('=========================================');
logger.info(' DEX Momentum Trading Bot - Starting up (DUAL STRATEGY MODE)');
logger.info(`  Overall Mode: ${config.paperTrading ? 'PAPER TRADING' : 'LIVE TRADING'}`);

// Strategy A: Swing
const swingCfg = config.strategies.swing;
if (swingCfg.enabled) {
  logger.info(`  Strategy A - Swing Trading:`);
  logger.info(`    EMA: ${swingCfg.emaFast}/${swingCfg.emaSlow}, RSI: ${swingCfg.rsiPeriod}`);
  logger.info(`    Position: ${swingCfg.positionSizePct}%, Stop: ${swingCfg.stopLossPct}%, Profit: ${swingCfg.takeProfitPct}%`);
  logger.info(`    Max Positions: ${swingCfg.maxConcurrentPositions}, AI Floor: ${swingCfg.aiConfidenceFloor}%`);
  logger.info(`    Disabled Filters: ${swingCfg.disabledFilters?.join(', ') || 'none'}`);
}

// Strategy B: Momentum
const momentumCfg = config.strategies.momentum;
if (momentumCfg.enabled) {
  logger.info(`  Strategy B - Momentum Trading:`);
  logger.info(`    EMA: ${momentumCfg.emaFast}/${momentumCfg.emaSlow}, RSI: ${momentumCfg.rsiPeriod}`);
  logger.info(`    Position: ${momentumCfg.positionSizePct}%, Stop: ${momentumCfg.stopLossPct}%, Profit: ${momentumCfg.takeProfitPct}%`);
  logger.info(`    Max Positions: ${momentumCfg.maxConcurrentPositions}, AI Floor: ${momentumCfg.aiConfidenceFloor}%`);
}

logger.info(`  Total Position Limit: ${swingCfg.maxConcurrentPositions + momentumCfg.maxConcurrentPositions}`);
logger.info('=========================================');
```

---

## Part 8: Key Function Signatures Update

### executeBuy() - Add strategyName parameter
```javascript
async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum')
```

### executeSell() - Extract from position
```javascript
async function executeSell(chainName, exchange, tokenData, position, ...) {
  const strategyName = position.strategy || 'momentum';
```

### RiskGuardian.canTrade() - Add strategyName
```javascript
canTrade(tokenData, strategyName = 'momentum') {
  // Check per-strategy position limits
}
```

### RiskGuardian.positionSize() - Add strategyName
```javascript
positionSize(tokenData, strategyName = 'momentum') {
  const strategyCfg = config.strategies?.[strategyName] || {};
  // Use strategy-specific positionSizePct
}
```

---

## Testing Checklist

- [ ] Config loads with both strategies enabled
- [ ] Portfolio structure includes strategy-specific tracking
- [ ] determineApplicableStrategies() correctly identifies swing vs momentum tokens
- [ ] evaluateForStrategy() uses strategy-specific parameters
- [ ] processToken() routes to correct strategy
- [ ] executeBuy() tracks position to correct strategy  
- [ ] Position count limits enforced per-strategy
- [ ] Dashboard shows separate stats for each strategy
- [ ] No token appears in both strategies simultaneously
- [ ] Positions correctly tracked in portfolio.positions AND portfolio.strategies[strategyName].positions
- [ ] Stats aggregate correctly (sum of both strategies)
- [ ] Paper trading runs for 50+ cycles without errors

---

## Environment Variables Reference

```bash
# Strategy A: Swing Trading
STRATEGY_SWING_ENABLED=true
STRATEGY_SWING_EMA_FAST=21
STRATEGY_SWING_EMA_SLOW=55
STRATEGY_SWING_RSI_PERIOD=21
STRATEGY_SWING_RSI_BUY=40
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
STRATEGY_SWING_BREAKOUT_LOOKBACK=30
STRATEGY_SWING_BREAKOUT_BUFFER=0.001

# Strategy B: Momentum Trading
STRATEGY_MOMENTUM_ENABLED=true
STRATEGY_MOMENTUM_EMA_FAST=9
STRATEGY_MOMENTUM_EMA_SLOW=21
STRATEGY_MOMENTUM_RSI_PERIOD=14
STRATEGY_MOMENTUM_RSI_BUY=45
STRATEGY_MOMENTUM_MIN_LIQUIDITY=10000
STRATEGY_MOMENTUM_MAX_AGE_DAYS=0.25
STRATEGY_MOMENTUM_MIN_NET_BUY_FLOW=15000
STRATEGY_MOMENTUM_POSITION_SIZE_PCT=2
STRATEGY_MOMENTUM_STOP_LOSS_PCT=8
STRATEGY_MOMENTUM_TAKE_PROFIT_PCT=25
STRATEGY_MOMENTUM_AI_CONFIDENCE=75
STRATEGY_MOMENTUM_MAX_POSITIONS=3
STRATEGY_MOMENTUM_DISABLED_FILTERS=
STRATEGY_MOMENTUM_VOLUME_SPIKE=2.5
STRATEGY_MOMENTUM_LOW_VOL_SPIKE=2.1
STRATEGY_MOMENTUM_HIGH_VOL_SPIKE=3.0
STRATEGY_MOMENTUM_BREAKOUT_LOOKBACK=20
STRATEGY_MOMENTUM_BREAKOUT_BUFFER=0.002
```

---

## Files Modified Summary

| File | Changes | Status |
|------|---------|--------|
| config/index.js | Added strategies.swing & strategies.momentum config | ✅ |
| src/strategy/momentum.js | Added determineApplicableStrategies() & evaluateForStrategy() | ✅ |
| src/index.js | Portfolio structure with per-strategy tracking, processToken dual-routing | ⏳ |
| src/risk/guardian.js | Per-strategy position limits, getStrategyPositionCount() | ⏳ |
| src/dashboard.js | /api/strategies endpoint, strategy-specific stats display | ⏳ |
| src/backtest.js | Strategy parameter support | ⏳ |
| src/ai/ensemble.js | Strategy context in AI evaluation | ⏳ |

Status: ✅ = Completed | ⏳ = Requires implementation
