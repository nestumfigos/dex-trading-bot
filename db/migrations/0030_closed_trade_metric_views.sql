EXEC('
CREATE OR ALTER VIEW dbo.vw_profile_summary AS
WITH trade_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS trade_count,
    SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
    SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
    SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
    SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
    SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd <= 0 THEN 1 ELSE 0 END) AS loss_count,
    SUM(CASE WHEN trade_type = ''SELL'' THEN COALESCE(pnl_usd, 0) ELSE 0 END) AS realized_pnl_usd,
    SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_profit_usd,
    SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS gross_loss_usd,
    MAX(ts) AS last_trade_at
  FROM dbo.bot_trade_ledger
  GROUP BY bot_profile
),
position_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS open_positions,
    SUM(COALESCE(entry_usd, 0)) AS open_cost_basis_usd,
    MAX(opened_at) AS last_position_opened_at
  FROM dbo.positions
  WHERE closed_at IS NULL
  GROUP BY bot_profile
),
pnl_stats AS (
  SELECT
    bot_profile,
    MAX(ts) AS last_pnl_at,
    MAX(CASE WHEN rn = 1 THEN cash END) AS latest_cash,
    MAX(CASE WHEN rn = 1 THEN equity END) AS latest_equity,
    MAX(CASE WHEN rn = 1 THEN total_pnl END) AS latest_total_pnl,
    MAX(CASE WHEN rn = 1 THEN unrealized_pnl END) AS latest_unrealized_pnl
  FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
    FROM dbo.bot_pnl_history
  ) x
  GROUP BY bot_profile
),
run_stats AS (
  SELECT
    bot_profile,
    COUNT(*) AS run_count,
    MAX(started_at) AS last_run_started_at
  FROM dbo.bot_runs
  GROUP BY bot_profile
)
SELECT
  p.bot_profile,
  COALESCE(r.run_count, 0) AS run_count,
  r.last_run_started_at,
  COALESCE(t.trade_count, 0) AS trade_count,
  COALESCE(t.buy_count, 0) AS buy_count,
  COALESCE(t.sell_count, 0) AS sell_count,
  COALESCE(t.sell_failed_count, 0) AS sell_failed_count,
  COALESCE(t.win_count, 0) AS win_count,
  COALESCE(t.loss_count, 0) AS loss_count,
  CASE WHEN COALESCE(t.win_count, 0) + COALESCE(t.loss_count, 0) > 0
    THEN (CAST(t.win_count AS FLOAT) / CAST(t.win_count + t.loss_count AS FLOAT)) * 100
    ELSE NULL
  END AS win_rate_pct,
  CASE WHEN COALESCE(t.gross_loss_usd, 0) > 0
    THEN CAST(t.gross_profit_usd AS FLOAT) / CAST(t.gross_loss_usd AS FLOAT)
    ELSE NULL
  END AS profit_factor,
  COALESCE(t.realized_pnl_usd, 0) AS realized_pnl_usd,
  COALESCE(t.gross_profit_usd, 0) AS gross_profit_usd,
  COALESCE(t.gross_loss_usd, 0) AS gross_loss_usd,
  t.last_trade_at,
  COALESCE(ps.open_positions, 0) AS open_positions,
  COALESCE(ps.open_cost_basis_usd, 0) AS open_cost_basis_usd,
  ps.last_position_opened_at,
  pnl.latest_cash,
  pnl.latest_equity,
  pnl.latest_total_pnl,
  pnl.latest_unrealized_pnl,
  pnl.last_pnl_at
FROM (
  SELECT DISTINCT bot_profile FROM dbo.bot_runs
  UNION SELECT DISTINCT bot_profile FROM dbo.bot_trade_ledger
  UNION SELECT DISTINCT bot_profile FROM dbo.positions
  UNION SELECT DISTINCT bot_profile FROM dbo.bot_pnl_history
) p
LEFT JOIN run_stats r ON r.bot_profile = p.bot_profile
LEFT JOIN trade_stats t ON t.bot_profile = p.bot_profile
LEFT JOIN position_stats ps ON ps.bot_profile = p.bot_profile
LEFT JOIN pnl_stats pnl ON pnl.bot_profile = p.bot_profile;
');
GO

EXEC('
CREATE OR ALTER VIEW dbo.vw_chain_summary AS
SELECT
  bot_profile,
  COALESCE(chain_key, ''unknown'') AS chain_key,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS closed_trade_count,
  SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
  SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd <= 0 THEN 1 ELSE 0 END) AS loss_count,
  CASE WHEN SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END) > 0
    THEN (
      CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS FLOAT)
      / CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END) AS FLOAT)
    ) * 100
    ELSE NULL
  END AS win_rate_pct,
  SUM(CASE WHEN trade_type = ''SELL'' THEN COALESCE(pnl_usd, 0) ELSE 0 END) AS realized_pnl_usd,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_profit_usd,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS gross_loss_usd,
  CASE WHEN SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) > 0
    THEN (
      CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS FLOAT)
      / CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS FLOAT)
    )
    ELSE NULL
  END AS profit_factor,
  MAX(ts) AS last_trade_at
FROM dbo.bot_trade_ledger
GROUP BY bot_profile, COALESCE(chain_key, ''unknown'');
');
GO

EXEC('
CREATE OR ALTER VIEW dbo.vw_strategy_summary AS
SELECT
  bot_profile,
  COALESCE(strategy, ''unknown'') AS strategy,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS closed_trade_count,
  SUM(CASE WHEN trade_type = ''BUY'' THEN 1 ELSE 0 END) AS buy_count,
  SUM(CASE WHEN trade_type = ''SELL'' THEN 1 ELSE 0 END) AS sell_count,
  SUM(CASE WHEN trade_type = ''SELL_FAILED'' THEN 1 ELSE 0 END) AS sell_failed_count,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd <= 0 THEN 1 ELSE 0 END) AS loss_count,
  CASE WHEN SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END) > 0
    THEN (
      CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS FLOAT)
      / CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END) AS FLOAT)
    ) * 100
    ELSE NULL
  END AS win_rate_pct,
  SUM(CASE WHEN trade_type = ''SELL'' THEN COALESCE(pnl_usd, 0) ELSE 0 END) AS realized_pnl_usd,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_profit_usd,
  SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS gross_loss_usd,
  CASE WHEN SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) > 0
    THEN (
      CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS FLOAT)
      / CAST(SUM(CASE WHEN trade_type = ''SELL'' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS FLOAT)
    )
    ELSE NULL
  END AS profit_factor,
  MAX(ts) AS last_trade_at
FROM dbo.bot_trade_ledger
GROUP BY bot_profile, COALESCE(strategy, ''unknown'');
');
