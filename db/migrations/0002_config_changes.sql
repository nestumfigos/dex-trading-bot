-- M003: config_changes
-- Audit log of every knob mutation. Read by `npm run config:diff` (Week 6)
-- to show what changed pre-restart.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'config_changes' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.config_changes (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    changed_at DATETIME2 NOT NULL CONSTRAINT DF_config_changes_changed_at DEFAULT SYSUTCDATETIME(),
    scope NVARCHAR(32) NOT NULL,
    strategy NVARCHAR(32) NULL,
    knob NVARCHAR(128) NOT NULL,
    old_value NVARCHAR(1024) NULL,
    new_value NVARCHAR(1024) NULL,
    actor NVARCHAR(128) NOT NULL CONSTRAINT DF_config_changes_actor DEFAULT SUSER_SNAME(),
    source NVARCHAR(64) NULL,
    reason NVARCHAR(512) NULL
  );

  CREATE INDEX IX_config_changes_changed_at ON dbo.config_changes(changed_at DESC);
  CREATE INDEX IX_config_changes_knob ON dbo.config_changes(knob, changed_at DESC);
END;
