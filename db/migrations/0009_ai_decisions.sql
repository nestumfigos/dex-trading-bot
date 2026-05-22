BEGIN TRANSACTION;
BEGIN TRY

-- M010: ai_decisions
-- Per-call AI inference record. Tracks provider, model, latency, cost, signal.
-- 7d full retention; older rows aggregated into ai_decisions_rollup (M010b).
-- Written by src/ai/decision-tracker.recordAiDecision.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_decisions' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.ai_decisions (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    decided_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    scope           NVARCHAR(32)  NOT NULL DEFAULT 'global',  -- live | paper
    strategy        NVARCHAR(32)  NULL,
    provider        NVARCHAR(32)  NOT NULL,                    -- anthropic | groq | nvidia | cerebras | openrouter | sambanova | together
    model           NVARCHAR(128) NULL,
    purpose         NVARCHAR(64)  NULL,                        -- trade_signal | lesson | research | sentiment | exit_classification
    symbol          NVARCHAR(64)  NULL,
    chain           NVARCHAR(32)  NULL,
    prompt_name     NVARCHAR(64)  NULL,                        -- references ai_prompts.name when used
    prompt_version  INT           NULL,                        -- references ai_prompts.version
    request_tokens  INT           NULL,
    response_tokens INT           NULL,
    cost_usd        FLOAT         NULL,
    latency_ms      INT           NULL,
    success         BIT           NOT NULL DEFAULT 1,
    error_code      NVARCHAR(64)  NULL,                        -- TIMEOUT | RATE_LIMIT | AUTH | PARSE | UNKNOWN
    error_message   NVARCHAR(1024) NULL,
    signal          NVARCHAR(16)  NULL,                        -- BUY | HOLD | SELL | NULL when failed
    confidence      FLOAT         NULL,
    response_excerpt NVARCHAR(2000) NULL,                      -- first 2000 chars of response (debug)
    metadata        NVARCHAR(MAX) NULL,                        -- JSON: tier, regime, ensemble weight
    bot_version     NVARCHAR(64)  NULL
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


-- Hot scan: dashboard latest.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_decisions_decided_at' AND object_id = OBJECT_ID('dbo.ai_decisions'))
BEGIN
  CREATE INDEX IX_ai_decisions_decided_at
    ON dbo.ai_decisions (decided_at DESC)
    INCLUDE (scope, provider, success, latency_ms, cost_usd, purpose);
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


-- Per-symbol drill-down.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_decisions_symbol' AND object_id = OBJECT_ID('dbo.ai_decisions'))
BEGIN
  CREATE INDEX IX_ai_decisions_symbol
    ON dbo.ai_decisions (symbol, chain, decided_at DESC)
    INCLUDE (provider, signal, confidence, success);
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


-- Provider cost breakdown.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_decisions_provider' AND object_id = OBJECT_ID('dbo.ai_decisions'))
BEGIN
  CREATE INDEX IX_ai_decisions_provider
    ON dbo.ai_decisions (provider, decided_at DESC)
    INCLUDE (cost_usd, latency_ms, success, model);
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


-- ─── Rollup table (daily aggregate for ≥7d data) ────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_decisions_rollup' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.ai_decisions_rollup (
    id                BIGINT IDENTITY(1,1) PRIMARY KEY,
    day               DATE          NOT NULL,
    scope             NVARCHAR(32)  NOT NULL DEFAULT 'global',
    provider          NVARCHAR(32)  NOT NULL,
    model             NVARCHAR(128) NULL,
    purpose           NVARCHAR(64)  NULL,
    call_count        INT           NOT NULL DEFAULT 0,
    success_count     INT           NOT NULL DEFAULT 0,
    total_cost_usd    FLOAT         NOT NULL DEFAULT 0,
    avg_latency_ms    FLOAT         NULL,
    p95_latency_ms    FLOAT         NULL,
    buy_count         INT           NOT NULL DEFAULT 0,
    hold_count        INT           NOT NULL DEFAULT 0,
    sell_count        INT           NOT NULL DEFAULT 0,
    avg_confidence    FLOAT         NULL,
    rolled_at         DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
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


IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_ai_decisions_rollup_day' AND object_id = OBJECT_ID('dbo.ai_decisions_rollup'))
BEGIN
  CREATE UNIQUE INDEX UX_ai_decisions_rollup_day
    ON dbo.ai_decisions_rollup (day, scope, provider, model, purpose);
END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

