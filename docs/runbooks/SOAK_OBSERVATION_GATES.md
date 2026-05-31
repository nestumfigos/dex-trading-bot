# Soak / Observation Gates Runbook

**Purpose:** explicit operator-runtime checklist for observation gates that cannot be closed by editing code. These items require live bots accumulating trade data over wall-clock time.

**Why not auto-close them:** marking them `[X]` without observation would deceive future agents and operators. Strategy promotion gates exist exactly to catch the failure mode of "passes backtest, dies live". Bypassing them undoes years of risk discipline.

## Active observation tasks

### WEEK 12 — Plan B (spot_day_bull_flag) — live canary
| Gate | Criteria | Source of truth |
|---|---|---|
| 24h-7d soak | `/api/bull-flag-stats` returns sells > 0 with PnL series | Live bot dashboard |
| 7d promotion review | sells ≥ 7 (≥1/day); profit factor ≥ 1.3; max drawdown ≤ 5% | Same |
| Loosen-or-tighten decision | If signal drought: `BULL_FLAG_POLE_PCT_MIN 5→4` and `BULL_FLAG_BREAKOUT_VOL_MIN_RATIO 1.5→1.3`. If bad PF: tighten `BULL_FLAG_MIN_NET_EDGE_PCT` and `BULL_FLAG_FLAG_VOL_CONTRACT_MAX_RATIO` | Operator + .env edit |

Status check: open dashboard `/view-observability` → Bull-Flag panel + cumulative PnL chart shipped 2026-05-23.

### WEEK 13 — Plan C (Backes HTF Swing)
| Gate | Criteria |
|---|---|
| Walk-forward backtest | BTC, ETH, SOL, top 10 KuCoin liquid pairs, 12 months. Need `scripts/run-walkforward-backes.js` runner (TODO). |
| Backtest vs legacy `swing` baseline | OOS return improves, DD not worse +3pp, ruin prob not worse +2pp |
| Paper canary | 14 days (HTF moves are rare) — need 30+ signals OR 100 walk-forward signals |
| Promotion gate | ≥30 paper trades w/ positive expectancy |
| 14d post-promotion observation | No regression vs paper |

### WEEK 14 — Plans F + G + Plan B v2
| Gate | Strategy | Criteria |
|---|---|---|
| F.7 BSC flow breakout paper | bsc_flow_breakout | 75 paper trades / 14 days minimum |
| F.8 Live promote | bsc_flow_breakout | After F.7 pass; BSC chain only |
| G.6 Base reclaim paper | base_dex_momentum_reclaim | 6 weeks paper |
| G.7 Promotion | base_dex_momentum_reclaim | Must beat bsc_flow_breakout net edge over same period |
| G.8 Live promote | base_dex_momentum_reclaim | Only if G.7 passes |
| Solana v2 paper | solana_bull_flag_v2 | 100 paper trades |

### WEEK 16 closeout — refactor canary
| Gate | Criteria |
|---|---|
| 24h paper canary | All 16.x code changes (scanChain extract, memory split, prompt loader, tokens cache, regime patterns) cause no regression vs baseline. |
| Live promote | After paper passes 24h. |
| No regression vs 1.1.0 baseline | Trade volume + win rate + PF within ±5% of Week 11 snapshot |

### WEEK 17 — Strategy deepening
| Gate | Criteria |
|---|---|
| 24h paper health soak | No loop stalls, no strategy exit degradation, no repeated source-audit warnings |
| First paper trades review | Manually classify false positives by strategy. Adjust gates if FP rate > 30%. |
| Each chain dedicated soak | per chain (BSC 75 trades / 14d, Base 6wk, Solana 100 trades, Backes 14d/100 wf) |

## How to mark a gate `[X]`

1. **Pull the metric** from the dashboard or SQL:
   - bull-flag: `GET /api/bull-flag-stats`
   - backes: `GET /api/backes-stats`
   - health: `GET /api/health-canary?limit=100`
   - trades: `SELECT * FROM dbo.bot_trade_ledger WHERE setup_type = 'X' AND closed_at >= DATEADD(d, -7, SYSUTCDATETIME())`
2. **Verify the threshold** as documented above. Be honest — a gate that "looks close" is a fail.
3. **Record the closeout here or in the relevant promotion record** with date, metric source, and evidence.
4. **Commit** with message `Close W<NN>.<n> gate: <criteria summary>` and push both repos.

## What blocks all of these

- Bot must be running continuously on live or paper (depending on gate).
- AI providers must work (Anthropic + Groq + Gemini keys must be valid — see live error log for "AI brain failure" patterns).
- SQL telemetry must persist trades (`SQL_ENABLED=true` on live).
- Dashboards must be reachable: live `3002`, paper `3003`, perps paper `3004`.

## Historical Snapshot at 2026-05-23

- **Live bot**: was running pid 7304, KuCoin scan ~60 tokens/cycle, 60 consecutive cycles signal-drought on `spot_day_bull_flag` (filters too tight or no setups in current market).
- **Paper bot**: was running pid 3664, scanning solana/bsc/kucoin.
- **AI providers**: groq + gemini + claude failing — keys need rotation per [docs/runbooks/README](README.md).
- **No new bull-flag, backes, F, G, or Solana-v2 trades closed yet** — all gates remain pending.

Set a calendar reminder for **7 days from 2026-05-23 = 2026-05-30** to do the Plan B (bull-flag) 7-day review.

Do not use this old PID snapshot as current status. Pull current state from the
health endpoints and SQL before closing any soak item.
