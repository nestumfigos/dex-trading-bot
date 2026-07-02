EXEC('
CREATE OR ALTER VIEW dbo.v_perps_control_plane_summary AS
WITH latest_state AS (
  SELECT
    bot_profile,
    revision,
    ts,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
  FROM dbo.perps_state_snapshots
),
latest_admission AS (
  SELECT
    bot_profile,
    ts,
    required,
    allow_new_entries,
    variant_id,
    reasons_json,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
  FROM dbo.perps_admission_snapshots
),
signals_24h AS (
  SELECT
    bot_profile,
    COUNT(*) AS signals_24h,
    SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted_signals_24h,
    SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END) AS rejected_signals_24h,
    SUM(CASE WHEN shadow = 1 THEN 1 ELSE 0 END) AS shadow_signals_24h,
    MAX(ts) AS last_signal_at
  FROM dbo.perps_signals
  WHERE ts >= DATEADD(hour, -24, SYSUTCDATETIME())
  GROUP BY bot_profile
),
trade_30d AS (
  SELECT
    bot_profile,
    COUNT(*) AS closed_trades_30d,
    SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins_30d,
    SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses_30d,
    SUM(COALESCE(pnl_usd, 0)) AS pnl_30d_usd,
    SUM(COALESCE(fee_usd, 0) + COALESCE(funding_usd, 0) + COALESCE(slippage_usd, 0)) AS total_cost_30d_usd,
    SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_wins_30d_usd,
    ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END)) AS gross_losses_30d_usd,
    AVG(pnl_usd) AS expectancy_30d_usd,
    MAX(ts) AS last_trade_at
  FROM dbo.perps_trades
  WHERE ts >= DATEADD(day, -30, SYSUTCDATETIME())
    AND trade_type = ''EXIT''
  GROUP BY bot_profile
),
open_risk AS (
  SELECT
    bot_profile,
    COUNT(*) AS open_positions,
    SUM(COALESCE(notional_usd, 0)) AS open_notional_usd,
    SUM(COALESCE(remaining_notional_usd, 0)) AS open_remaining_notional_usd,
    SUM(COALESCE(risk_usd, 0)) AS open_risk_usd,
    MIN(liquidation_buffer_multiple) AS min_liquidation_buffer_multiple,
    MAX(updated_at) AS latest_position_update_at
  FROM dbo.perps_positions
  WHERE status = ''open''
  GROUP BY bot_profile
),
profiles AS (
  SELECT bot_profile FROM latest_state
  UNION
  SELECT bot_profile FROM latest_admission
  UNION
  SELECT bot_profile FROM signals_24h
  UNION
  SELECT bot_profile FROM trade_30d
  UNION
  SELECT bot_profile FROM open_risk
)
SELECT
  p.bot_profile,
  ls.revision AS latest_state_revision,
  ls.ts AS latest_state_snapshot_at,
  la.ts AS latest_admission_at,
  la.required AS admission_required,
  la.allow_new_entries,
  la.variant_id AS admission_variant_id,
  la.reasons_json AS admission_reasons_json,
  COALESCE(s.signals_24h, 0) AS signals_24h,
  COALESCE(s.accepted_signals_24h, 0) AS accepted_signals_24h,
  COALESCE(s.rejected_signals_24h, 0) AS rejected_signals_24h,
  COALESCE(s.shadow_signals_24h, 0) AS shadow_signals_24h,
  s.last_signal_at,
  COALESCE(t.closed_trades_30d, 0) AS closed_trades_30d,
  COALESCE(t.wins_30d, 0) AS wins_30d,
  COALESCE(t.losses_30d, 0) AS losses_30d,
  COALESCE(t.pnl_30d_usd, 0) AS pnl_30d_usd,
  COALESCE(t.expectancy_30d_usd, 0) AS expectancy_30d_usd,
  CASE
    WHEN COALESCE(t.gross_losses_30d_usd, 0) > 0 THEN COALESCE(t.gross_wins_30d_usd, 0) / t.gross_losses_30d_usd
    WHEN COALESCE(t.gross_wins_30d_usd, 0) > 0 THEN 999
    ELSE NULL
  END AS profit_factor_30d,
  COALESCE(t.total_cost_30d_usd, 0) AS total_cost_30d_usd,
  t.last_trade_at,
  COALESCE(r.open_positions, 0) AS open_positions,
  COALESCE(r.open_notional_usd, 0) AS open_notional_usd,
  COALESCE(r.open_remaining_notional_usd, 0) AS open_remaining_notional_usd,
  COALESCE(r.open_risk_usd, 0) AS open_risk_usd,
  r.min_liquidation_buffer_multiple,
  r.latest_position_update_at
FROM profiles p
LEFT JOIN latest_state ls ON ls.bot_profile = p.bot_profile AND ls.rn = 1
LEFT JOIN latest_admission la ON la.bot_profile = p.bot_profile AND la.rn = 1
LEFT JOIN signals_24h s ON s.bot_profile = p.bot_profile
LEFT JOIN trade_30d t ON t.bot_profile = p.bot_profile
LEFT JOIN open_risk r ON r.bot_profile = p.bot_profile;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_perps_risk_exposure AS
SELECT
  bot_profile,
  position_id,
  lifecycle_id,
  signal_id,
  symbol,
  COALESCE(strategy, ''unknown'') AS strategy,
  setup,
  side,
  status,
  opened_at,
  updated_at,
  entry_price,
  stop_price,
  liquidation_price,
  leverage,
  margin_mode,
  notional_usd,
  remaining_notional_usd,
  risk_usd,
  CASE WHEN notional_usd > 0 THEN (risk_usd / notional_usd) * 100 ELSE NULL END AS risk_to_notional_pct,
  liquidation_buffer_multiple,
  raw_position_json
FROM dbo.perps_positions;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_perps_execution_quality_summary AS
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  symbol,
  COUNT(*) AS trades,
  SUM(CASE WHEN trade_type = ''EXIT'' THEN 1 ELSE 0 END) AS closed_trades,
  SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
  SUM(COALESCE(pnl_usd, 0)) AS pnl_usd,
  AVG(pnl_usd) AS expectancy_usd,
  CASE
    WHEN ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END)) > 0
      THEN SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) / ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END))
    WHEN SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) > 0 THEN 999
    ELSE NULL
  END AS profit_factor,
  AVG(fee_usd) AS avg_fee_usd,
  AVG(funding_usd) AS avg_funding_usd,
  AVG(slippage_usd) AS avg_slippage_usd,
  SUM(COALESCE(fee_usd, 0)) AS total_fee_usd,
  SUM(COALESCE(funding_usd, 0)) AS total_funding_usd,
  SUM(COALESCE(slippage_usd, 0)) AS total_slippage_usd,
  SUM(COALESCE(fee_usd, 0) + COALESCE(funding_usd, 0) + COALESCE(slippage_usd, 0)) AS total_cost_usd,
  CASE
    WHEN SUM(COALESCE(notional_usd, 0)) > 0
      THEN (SUM(COALESCE(fee_usd, 0) + COALESCE(funding_usd, 0) + COALESCE(slippage_usd, 0)) / SUM(COALESCE(notional_usd, 0))) * 10000
    ELSE NULL
  END AS avg_cost_bps_on_notional,
  MAX(ts) AS last_trade_at
FROM dbo.perps_trades
WHERE ts >= DATEADD(day, -30, SYSUTCDATETIME())
GROUP BY bot_profile, COALESCE(strategy, ''unknown''), symbol;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_perps_promotion_readiness AS
WITH strategy_stats AS (
  SELECT
    bot_profile,
    COALESCE(strategy, ''unknown'') AS strategy,
    COUNT(*) AS sample_size_30d,
    AVG(pnl_usd) AS expectancy_30d_usd,
    CASE
      WHEN ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END)) > 0
        THEN SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) / ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END))
      WHEN SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) > 0 THEN 999
      ELSE NULL
    END AS profit_factor_30d,
    SUM(COALESCE(pnl_usd, 0)) AS pnl_30d_usd,
    MAX(ts) AS last_trade_at
  FROM dbo.perps_trades
  WHERE ts >= DATEADD(day, -30, SYSUTCDATETIME())
    AND trade_type = ''EXIT''
  GROUP BY bot_profile, COALESCE(strategy, ''unknown'')
),
latest_gate AS (
  SELECT
    bot_profile,
    target_profile,
    strategy,
    strategy_version,
    ts,
    passed,
    score,
    sample_size,
    expectancy_usd,
    stressed_expectancy_usd,
    profit_factor,
    max_drawdown_pct,
    failure_reasons_json,
    ROW_NUMBER() OVER (PARTITION BY bot_profile, target_profile, strategy ORDER BY ts DESC) AS rn
  FROM dbo.promotion_gate_evaluations
),
latest_walk_forward AS (
  SELECT
    bot_profile,
    strategy,
    ts,
    passed,
    metrics_json,
    failure_reasons_json,
    ROW_NUMBER() OVER (PARTITION BY bot_profile, strategy ORDER BY ts DESC) AS rn
  FROM dbo.walk_forward_results
),
latest_admission AS (
  SELECT
    bot_profile,
    ts,
    required,
    allow_new_entries,
    variant_id,
    ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
  FROM dbo.perps_admission_snapshots
),
strategy_universe AS (
  SELECT bot_profile, strategy FROM strategy_stats
  UNION
  SELECT bot_profile, strategy FROM latest_gate
  UNION
  SELECT bot_profile, strategy FROM latest_walk_forward
  UNION
  SELECT bot_profile, COALESCE(strategy, ''unknown'') FROM dbo.perps_signals
)
SELECT
  u.bot_profile,
  COALESCE(g.target_profile, ''live_perps'') AS target_profile,
  u.strategy,
  g.strategy_version,
  COALESCE(s.sample_size_30d, 0) AS sample_size_30d,
  COALESCE(s.expectancy_30d_usd, 0) AS expectancy_30d_usd,
  s.profit_factor_30d,
  COALESCE(s.pnl_30d_usd, 0) AS pnl_30d_usd,
  s.last_trade_at,
  g.ts AS latest_gate_at,
  g.passed AS latest_gate_passed,
  g.score AS latest_gate_score,
  g.sample_size AS gate_sample_size,
  g.expectancy_usd AS gate_expectancy_usd,
  g.stressed_expectancy_usd AS gate_stressed_expectancy_usd,
  g.profit_factor AS gate_profit_factor,
  g.max_drawdown_pct AS gate_max_drawdown_pct,
  g.failure_reasons_json AS gate_failure_reasons_json,
  w.ts AS latest_walk_forward_at,
  w.passed AS latest_walk_forward_passed,
  w.failure_reasons_json AS walk_forward_failure_reasons_json,
  a.ts AS latest_admission_at,
  a.required AS admission_required,
  a.allow_new_entries,
  a.variant_id AS admission_variant_id,
  CASE
    WHEN COALESCE(g.passed, 0) = 1
      AND COALESCE(w.passed, 0) = 1
      AND COALESCE(s.sample_size_30d, 0) >= 100
      AND COALESCE(s.expectancy_30d_usd, 0) > 0
      AND COALESCE(s.profit_factor_30d, 0) >= 1.25
      THEN ''eligible_for_operator_review''
    WHEN COALESCE(g.passed, 0) = 1 THEN ''gate_passed_needs_replay_or_sample''
    WHEN COALESCE(s.sample_size_30d, 0) = 0 THEN ''blocked_no_live_sample''
    ELSE ''blocked''
  END AS readiness_status
FROM strategy_universe u
LEFT JOIN strategy_stats s ON s.bot_profile = u.bot_profile AND s.strategy = u.strategy
LEFT JOIN latest_gate g ON g.bot_profile = u.bot_profile AND g.strategy = u.strategy AND g.rn = 1
LEFT JOIN latest_walk_forward w ON w.bot_profile = u.bot_profile AND w.strategy = u.strategy AND w.rn = 1
LEFT JOIN latest_admission a ON a.bot_profile = u.bot_profile AND a.rn = 1;
');
