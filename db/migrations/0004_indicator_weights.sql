-- M005: indicator_weights
-- Per-indicator per-bucket win-rate + adaptive weight, populated by memory/stats.js
-- recordIndicatorOutcome. Replaces in-memory indicatorPatterns map. Hot-read by
-- entries/filter.js for signal scoring.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'indicator_weights' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.indicator_weights (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    indicator       NVARCHAR(64)  NOT NULL,   -- rsi | macd | ema_cross | bb_squeeze | volume_spike | ...
    bucket          NVARCHAR(64)  NOT NULL,   -- e.g. 'rsi:30-40', 'macd:bullish_cross', 'regime:trend_up'
    scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- global | live | paper | strategy:<name>
    strategy        NVARCHAR(32)  NULL,                        -- 'momentum' | 'swing' | NULL
    samples         INT           NOT NULL DEFAULT 0,
    wins            INT           NOT NULL DEFAULT 0,
    losses          INT           NOT NULL DEFAULT 0,
    win_rate        FLOAT         NOT NULL DEFAULT 0.0,
    weight          FLOAT         NOT NULL DEFAULT 1.0,        -- adaptive multiplier (>1 amplify, <1 dampen)
    avg_pnl_pct     FLOAT         NULL,
    last_outcome_at DATETIME2     NULL,
    updated_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

-- Unique (indicator, bucket, scope, strategy) — strategy NULL handled via filtered index.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'UX_indicator_weights_indicator_bucket_scope_strategy'
     AND object_id = OBJECT_ID('dbo.indicator_weights')
)
BEGIN
  CREATE UNIQUE INDEX UX_indicator_weights_indicator_bucket_scope_strategy
    ON dbo.indicator_weights (indicator, bucket, scope, strategy);
END
GO

-- Hot-read scoring lookup.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_indicator_weights_indicator_scope'
     AND object_id = OBJECT_ID('dbo.indicator_weights')
)
BEGIN
  CREATE INDEX IX_indicator_weights_indicator_scope
    ON dbo.indicator_weights (indicator, scope)
    INCLUDE (bucket, weight, win_rate, samples);
END
GO
