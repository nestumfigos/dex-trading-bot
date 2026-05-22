BEGIN TRANSACTION;
BEGIN TRY

-- M011: ai_prompts
-- Versioned prompt templates. Bot reads the active row per (name, scope).
-- Update prompt → INSERT new version, mark new active=1, old active=0
-- (handled by upsert in seed-ai-prompts.js).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_prompts' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.ai_prompts (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    name          NVARCHAR(64)  NOT NULL,                    -- 'anthropic_trade_signal' | 'groq_lesson' | ...
    version       INT           NOT NULL DEFAULT 1,
    scope         NVARCHAR(32)  NOT NULL DEFAULT 'global',
    provider      NVARCHAR(32)  NULL,                        -- anthropic | groq | nvidia | ...
    template      NVARCHAR(MAX) NOT NULL,                    -- prompt body w/ {{placeholders}}
    system_msg    NVARCHAR(MAX) NULL,                        -- optional system role text
    description   NVARCHAR(512) NULL,
    active        BIT           NOT NULL DEFAULT 1,
    source        NVARCHAR(64)  NOT NULL DEFAULT 'manual',   -- manual | seed | self_evolution
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by    NVARCHAR(128) NULL
  );
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
BEGIN TRANSACTION;
BEGIN TRY


-- One active version per (name, scope).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_ai_prompts_name_scope_active' AND object_id = OBJECT_ID('dbo.ai_prompts'))
BEGIN
  CREATE UNIQUE INDEX UX_ai_prompts_name_scope_active
    ON dbo.ai_prompts (name, scope)
    WHERE active = 1;
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
BEGIN TRANSACTION;
BEGIN TRY


-- Version history scan.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_prompts_name_version' AND object_id = OBJECT_ID('dbo.ai_prompts'))
BEGIN
  CREATE INDEX IX_ai_prompts_name_version
    ON dbo.ai_prompts (name, scope, version DESC);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

