# RUNBOOK.md

**Status**: active. All 17 migrations applied (M001-M017). Weeks 1-6 of REFACTOR_CHECKLIST.md complete.

---

## Daily ops

- **Start both bots**: desktop `Start Both Bots.bat` (PM2 disabled; manual launcher only)
- **Restart live**: stop master process, relaunch via batch
- **Restart paper**: same, paper worktree
- **Logs**: `logs/` (winston daily rotate)
- **Dashboard**: http://localhost:3002 (live), http://localhost:3001 (paper)

---

## Migrations

- **Apply pending**: `npm run db:migrate`
- **Dry-run (parse only)**: `npm run db:migrate:dry`
- **Status**: `npm run db:status`
- **Rollback latest**: `npm run db:rollback`
- **Rollback specific**: `npm run db:rollback -- 0003`

If checksum drift error:
1. `git log --oneline db/migrations/<file>.sql` to see what changed
2. Either revert the file or ship a new migration that adjusts forward
3. Never edit-in-place an applied migration

---

## Recovery scenarios

### Bot wedged on start (port held)
Cause: stale runtime singleton lock or zombie node process.
Fix:
1. `netstat -ano | findstr :3002` (live) or `:3001` (paper)
2. `taskkill /F /PID <pid>`
3. Remove `data/.runtime.lock` if present
4. Relaunch via batch

### Memory file out of sync with SQL
Cause: write race or partial save.
Fix:
1. Stop bot
2. Compare `data/agent-memory.json` mtime vs latest SQL `agent_memory` row
3. Prefer the newer; back up the other to `data/agent-memory.<ts>.bak.json`
4. Restart

### SQL unreachable
Behavior: pool retries with exponential backoff (1s → 60s cap). Bot continues
on file-only memory. Hot-reload knobs fall back to env after 5min.
Fix: restore SQL connectivity; pool reconnects automatically; no bot restart needed.

### Version skew after deploy
Symptom: dashboard or logs show mismatched `BOT_VERSION`, migration level, or strategy matrix between live and paper.
Fix:
1. Check `/api/status` on both ports and compare `botVersion`, `mode`, and enabled strategies.
2. Run `node scripts/config-diff.js --hours=72` in both worktrees.
3. Run `npm run db:status`; no bot should run against a schema behind its code.
4. If paper is ahead, keep live KuCoin-only until the paper canary gate is complete.
5. If live is accidentally ahead, stop live, copy the last known-good config/env, and restart only after `/api/status` matches the release notes.

### Config strict validation failed
Symptom: boot refuses config when `CONFIG_STRICT_VALIDATE=true`.
Fix:
1. Run `node scripts/config-audit.js --orphans-only`.
2. Remove misspelled env vars or add the knob to `src/config/schema.js` with type/min/default.
3. Re-run with `CONFIG_STRICT_VALIDATE=false` only for emergency recovery; keep source-audit enabled so drift remains visible.
4. For DB-backed knobs, verify scope precedence with `node scripts/config-diff.js --hours=72`.

### Self-evolution auto-promoted bad patch
Should be impossible (gated `SELF_EVOLUTION_AUTO_PROMOTE: 'false'` in
`ecosystem.config.js` since 2026-05-16). If somehow occurred:
1. `npm run rollback:live` to revert promotion
2. Inspect `data/self-evolution-history.jsonl` for the offending patch
3. Restore previous `config/index.js` from git

### Tier sells not firing (live)
Suspect: position too small for tier sellPct × value < KuCoin min notional.
Query `dbo.trade_rejections` for `gate='tier_feasibility'`. Promote to enforce:
set `PRE_TRADE_CONTRACT_MODE=enforce` per scope.
Workaround: lift position size via `MIN_POSITION_SIZE_USD`.

### Policy gate blocked self-evolution promotion
Behavior expected (Week 5): `src/policy/preconditions.canPromoteEvolutionPatch`
denies patches with PnL < 0 / WR < threshold / sample regression.
Diagnose: `node scripts/config-diff.js --hours=72` then check
`dbo.evolution_history` for verdict='auto_denied'. Override (rare):
manually set verdict='promoted' OR adjust thresholds in `strategy_config`
(knobs: `EVO_MIN_WIN_RATE`, `EVO_MIN_PNL_USD`, `EVO_MIN_SAMPLES`).

### Promote-paper-to-main refused (Week 5 gate)
Cause: paper canary < 24h, > 2 crashes in last hour, or < 10 paper trades.
Fix: wait for canary window; investigate crash loop. Override (emergency):
`POLICY_OVERRIDE=true npm run promote:live` or `--force` flag.

### Health canary FAIL alert
`memory_mtime`: agent-memory.json not saving — check `saveIfDirty` cadence.
`counters_monotonic`: memory regression — investigate `_mergeFromRemote`,
look for shape.js MERGE_KEYS drift (test: `node --test test/memory/merge-completeness.test.js`).
`sql_latency`: > 2s — run `scripts/sql-cleanup.js`, check pool config.
`ai_circuit`: all providers in cooldown — verify API keys + rate limits.
`lock_files`: stale .lock under data/ — investigate sibling process.
`positions_intact`: missing price data — verify exchange feed + sentinel.
`restart_count`: > 3/hour — inspect logs for crash loop; check boot/error-handlers.
`disk_space`: < 500MB — prune logs + old artifacts/models.

### Audit + diagnostics (Week 6 scripts)

- `node scripts/config-audit.js` — show every knob with effective value + source
- `node scripts/config-audit.js --orphans-only` — list env vars not in schema
- `node scripts/config-diff.js --hours=72` — recent strategy_config changes
- `node scripts/db-status.js` — migration history + drift detection + table inventory
- `node scripts/memory-inspect.js --top=10` — pretty-print agent memory

---

## Telegram alerts

- Heartbeat: every 5min (alarm if missed > 15min)
- Trade events: BUY / SELL / SL hit
- AI circuit OPEN: cooldown notice
- Health canary FAIL (Week 4) — fires from `src/cycle/health-canary` every 15min

---

## Dashboard API (Week 6 endpoints)

All read endpoints (no auth):
- `GET /api/rejections?hours=24&symbol=KCS&gate=tier_feasibility&limit=50`
- `GET /api/evolution-history?decision=auto_denied&limit=100`
- `GET /api/ai-decisions?hours=24&provider=anthropic&symbol=KCS&limit=50`
- `GET /api/ai-decisions/cost?hours=24` — provider cost rollup
- `GET /api/symbol-overrides?includeInactive=true`
- `GET /api/health-canary?failuresOnly=true&limit=100`
- `GET /api/ml-models?activeOnly=true`
- `GET /api/backtest-runs?patchId=evo-1234&limit=50`

Write endpoints (require `Authorization: Bearer ${DASHBOARD_ADMIN_TOKEN}`):
- `POST /api/symbol-overrides {symbol, chain, scope, action, value, reason, expires_at}`
- `DELETE /api/symbol-overrides/:id` — soft delete (sets active=0)

---

## Known-good state markers

- Last clean restart: see `data/promotion-history.json`
- Last successful migration: **M017 (0016_model_versions)** 2026-05-17
- Release baseline: **v1.1.0** documented 2026-05-21
- Tests passing across Weeks 1-6: see CI / latest `node --test` run
- Pre-commit hook: `.husky/pre-commit` runs smoke + Week 1-6 critical tests
