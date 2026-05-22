-- M015: regime_patterns
-- Populated by ML retrain. Each row = one (regime, strategy, scope) action
-- recommendation derived from historical PnL. Pre-trade contract reads the
-- active row for the current regime + applies the recommended action / size
-- multiplier / preferred chain.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='regime_patterns' AND schema_id=SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.regime_patterns (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    regime              NVARCHAR(64)  NOT NULL,           -- 'trend_up' | 'trend_down' | 'chop' | 'breakout' | ...
    strategy            NVARCHAR(32)  NOT NULL,           -- 'momentum' | 'swing' | 'rotation'
    scope               NVARCHAR(32)  NOT NULL DEFAULT 'global',
    recommendation      NVARCHAR(32)  NOT NULL,           -- 'aggressive' | 'normal' | 'defensive' | 'pause'
    size_multiplier     FLOAT         NOT NULL DEFAULT 1.0,
    preferred_chains    NVARCHAR(256) NULL,               -- CSV: 'kucoin,bsc'
    avoid_chains        NVARCHAR(256) NULL,
    confidence          FLOAT         NULL,               -- 0..1
    samples             INT           NULL,
    win_rate            FLOAT         NULL,
    avg_pnl_pct         FLOAT         NULL,
    source              NVARCHAR(64)  NOT NULL DEFAULT 'ml_retrain',
    active              BIT           NOT NULL DEFAULT 1,
    measured_at         DATETIME2     NULL,
    created_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

-- One active row per (regime, strategy, scope) — hot read at every entry decision.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_regime_patterns_regime_strat_scope_active' AND object_id=OBJECT_ID('dbo.regime_patterns'))
BEGIN
  CREATE UNIQUE INDEX UX_regime_patterns_regime_strat_scope_active
    ON dbo.regime_patterns (regime, strategy, scope)
    WHERE active = 1;
END
GO

-- History scan (compare last vs current recommendation).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_regime_patterns_measured_at' AND object_id=OBJECT_ID('dbo.regime_patterns'))
BEGIN
  CREATE INDEX IX_regime_patterns_measured_at ON dbo.regime_patterns (measured_at DESC)
    INCLUDE (regime, strategy, recommendation, confidence);
END
GO
