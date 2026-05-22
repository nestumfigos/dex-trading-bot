-- M016: backtest_runs
-- Every backtest invocation stored with config snapshot + outcome. Self-evolution
-- reads from this table for validation evidence ("did this patch have a
-- positive backtest before promotion?"). 90-day retention.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'backtest_runs' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.backtest_runs (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    run_id              NVARCHAR(64)  NOT NULL,                  -- caller-provided UUID
    started_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    finished_at         DATETIME2     NULL,
    scope               NVARCHAR(32)  NOT NULL DEFAULT 'global', -- live | paper | research
    strategy            NVARCHAR(32)  NULL,
    bot_version         NVARCHAR(64)  NULL,
    strategy_version_id NVARCHAR(128) NULL,                       -- links to promotion-governance hash
    config_json         NVARCHAR(MAX) NULL,                       -- full knob snapshot at run time
    universe            NVARCHAR(256) NULL,                       -- CSV: 'kucoin,bsc,base'
    time_range_start    DATETIME2     NULL,
    time_range_end      DATETIME2     NULL,
    trade_count         INT           NULL,
    win_count           INT           NULL,
    loss_count          INT           NULL,
    win_rate            FLOAT         NULL,
    total_pnl_usd       FLOAT         NULL,
    sharpe_ratio        FLOAT         NULL,
    max_drawdown_pct    FLOAT         NULL,
    avg_trade_pnl_usd   FLOAT         NULL,
    avg_hold_minutes    FLOAT         NULL,
    profit_factor       FLOAT         NULL,
    metadata            NVARCHAR(MAX) NULL,                       -- JSON: per-strategy stats, equity curve, etc
    status              NVARCHAR(32)  NOT NULL DEFAULT 'completed', -- running | completed | failed
    error_message       NVARCHAR(1024) NULL,
    patch_id            NVARCHAR(128) NULL                        -- if backtest was triggered by self-evolution
  );
END
GO

-- Time-ordered scan.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_backtest_runs_started_at' AND object_id=OBJECT_ID('dbo.backtest_runs'))
BEGIN
  CREATE INDEX IX_backtest_runs_started_at
    ON dbo.backtest_runs (started_at DESC)
    INCLUDE (scope, strategy, status, win_rate, total_pnl_usd, sharpe_ratio);
END
GO

-- Run lookup by id.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_backtest_runs_run_id' AND object_id=OBJECT_ID('dbo.backtest_runs'))
BEGIN
  CREATE UNIQUE INDEX UX_backtest_runs_run_id ON dbo.backtest_runs (run_id);
END
GO

-- Patch lookup (self-evolution: "show me all backtests for patch X").
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_backtest_runs_patch_id' AND object_id=OBJECT_ID('dbo.backtest_runs'))
BEGIN
  CREATE INDEX IX_backtest_runs_patch_id
    ON dbo.backtest_runs (patch_id, started_at DESC)
    WHERE patch_id IS NOT NULL;
END
GO
