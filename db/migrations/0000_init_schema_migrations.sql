-- M001: schema_migrations bootstrap
-- Tracks every applied migration. Idempotent: safe re-run.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'schema_migrations' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.schema_migrations (
    id INT IDENTITY(1,1) PRIMARY KEY,
    version NVARCHAR(64) NOT NULL,
    name NVARCHAR(256) NOT NULL,
    checksum NVARCHAR(128) NOT NULL,
    applied_at DATETIME2 NOT NULL CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
    applied_by NVARCHAR(128) NOT NULL CONSTRAINT DF_schema_migrations_applied_by DEFAULT SUSER_SNAME(),
    duration_ms INT NULL,
    CONSTRAINT UQ_schema_migrations_version UNIQUE (version)
  );

  CREATE INDEX IX_schema_migrations_applied_at ON dbo.schema_migrations(applied_at DESC);
END;
