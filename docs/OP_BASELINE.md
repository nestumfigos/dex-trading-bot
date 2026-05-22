# Op Fixes Baseline — 2026-05-18T12:01:19Z

Captured at start of 24-48h monitoring window after Op-1 (PENGU fix) + Op-3a (wider stops).

## Pre-fix 30d baseline

### Live (real money)
- Sells: 12 | Wins: 5 | Losses: 7 | WR: **41.7%** | Net PnL: **-$1.14**
- Loss sources: FAST_STOP_LOSS $-2.02 (3 trades), MIN_HOLD_NO_GAIN $-1.09 (4 trades)
- Profit sources: FAST_TRAILING_STOP +$1.05, SELL_TIER_1/2 +$0.92
- 75% of trades from wallet_adoption (9 of 12), only 3 real technical entries in 30d

### Paper
- Sells: 129 | Wins: 44 | Losses: 85 | WR: **34.1%** | Net PnL: **-$248.79**
- Loss sources: STOP_LOSS -$356, FAST_STOP_LOSS -$243, MIN_HOLD_NO_GAIN -$172
- Profit sources: TAKE_PROFIT +$163, FAST_TRAILING +$111, MOMENTUM_VOLUME_COLLAPSE +$85, tier sells +$103

## Fixes shipped

| ID | Change | Hypothesis |
|---|---|---|
| Op-1 | Adopted positions: RECONCILE_ADOPT_STOP_LOSS_PCT=18 + RECONCILE_ADOPT_STOP_GRACE_HOURS=4 | Stops PENGU pattern (synth entry → instant stop). Future adoptions get 18% stop + 4h grace. |
| Op-3a | STOP_LOSS_PCT: 4 → 10 | 4% too tight for crypto vol. 10% reduces whipsaw exits. |

## 24-48h checklist (re-run baseline query, compare):

```bash
cat c:/Users/User_/Desktop/dex-trading-bot/data/state.json | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j=JSON.parse(s);const p=j.portfolio||j;
  const trades=Array.isArray(p.trades)?p.trades:[];
  const sells=trades.filter(t=>t.type==='SELL');
  const since=Date.parse('2026-05-18T12:01:19Z');
  const recent=sells.filter(t=>Date.parse(t.timestamp||0)>=since);
  const wins=recent.filter(t=>Number(t.pnl||0)>0);
  const losses=recent.filter(t=>Number(t.pnl||0)<0);
  const total=recent.reduce((s,t)=>s+Number(t.pnl||0),0);
  console.log('post-fix sells:',recent.length,'| wins:',wins.length,'| losses:',losses.length);
  console.log('post-fix PnL: $'+total.toFixed(2));
  console.log('post-fix WR:',recent.length>0?(wins.length/recent.length*100).toFixed(1)+'%':'n/a');
  const counts={};const pnl={};
  for(const t of recent){const r=t.reason||'?';counts[r]=(counts[r]||0)+1;pnl[r]=(pnl[r]||0)+Number(t.pnl||0);}
  for(const [r,c] of Object.entries(counts).sort((a,b)=>b[1]-a[1])){console.log(' ',r+':',c,'$'+pnl[r].toFixed(2));}
});
"
```

## Decision tree

- **STOP_LOSS firings ↓ AND WR ↑**: keep config, consider TP1 tightening (25→18%)
- **STOP_LOSS firings ↓ BUT WR unchanged**: positive — losses smaller, no harm
- **STOP_LOSS firings ↓ BUT avg loss ↑ a lot**: roll STOP_LOSS_PCT back to 8% (compromise between 4 and 10)
- **Net PnL still negative after 48h**: filter pipeline issue, not stop width — investigate entry quality

## Bot state at baseline

- index.js: 7571 lines (was 8973, -15.6%)
- 14 modules extracted (Weeks 7-10)
- 385 tests passing
- Live positions: LAB $8.40, AVAX $9.99, LTC $15.12 (still on old 4% stops, persisted)
- Paper positions: 1
- Both bots: health.ok, zero degraded/unhealthy
