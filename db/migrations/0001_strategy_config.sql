-- M002: strategy_config
-- Hot-reloadable config knobs. Replaces scattered .env vars over time.
-- Defense-in-depth: code falls back to env → hardcoded default if a row is missing.
--
-- scope:   'global' | 'live' | 'paper'
-- strategy: 'momentum' | 'swing' | 'rotation' | NULL for cross-strategy knobs
-- knob:    canonical env-var-style name (e.g. STRATEGY_MOMENTUM_MAX_POSITIONS)
-- value:   stringified value (cast by reader)
-- active:  soft delete flag

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'strategy_config' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.strategy_config (
    id INT IDENTITY(1,1) PRIMARY KEY,
    scope NVARCHAR(32) NOT NULL,
    strategy NVARCHAR(32) NULL,
    knob NVARCHAR(128) NOT NULL,
    value NVARCHAR(1024) NOT NULL,
    value_type NVARCHAR(16) NOT NULL CONSTRAINT DF_strategy_config_value_type DEFAULT 'string',
    source NVARCHAR(64) NOT NULL CONSTRAINT DF_strategy_config_source DEFAULT 'manual',
    notes NVARCHAR(512) NULL,
    active BIT NOT NULL CONSTRAINT DF_strategy_config_active DEFAULT 1,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_strategy_config_created_at DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_strategy_config_updated_at DEFAULT SYSUTCDATETIME(),
    updated_by NVARCHAR(128) NOT NULL CONSTRAINT DF_strategy_config_updated_by DEFAULT SUSER_SNAME()
  );

  CREATE UNIQUE INDEX UX_strategy_config_scope_strat_knob_active
    ON dbo.strategy_config(scope, strategy, knob)
    WHERE active = 1;

  CREATE INDEX IX_strategy_config_knob ON dbo.strategy_config(knob) WHERE active = 1;
END;
