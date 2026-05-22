-- M0023: persistent job_queue for crash-recoverable async work.
-- Day 7 follow-up. Provides claim/complete/retry primitives so background
-- coordination (self-evolution outcomes, prompt-validation, post-trade audit)
-- can survive bot restarts without losing in-flight intents.
BEGIN TRANSACTION;
BEGIN TRY

  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'job_queue' AND schema_id = SCHEMA_ID('dbo'))
  BEGIN
    CREATE TABLE dbo.job_queue (
      job_id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
      job_type        NVARCHAR(64)     NOT NULL,
      scope           NVARCHAR(32)     NOT NULL DEFAULT 'global',  -- 'live' | 'paper' | 'global'
      payload         NVARCHAR(MAX)    NULL,                       -- JSON body
      status          NVARCHAR(16)     NOT NULL DEFAULT 'pending', -- pending | claimed | done | failed | dead
      attempts        INT              NOT NULL DEFAULT 0,
      max_attempts    INT              NOT NULL DEFAULT 5,
      claimed_by      NVARCHAR(120)    NULL,                       -- "${profile}:${pid}"
      claimed_at      DATETIME2(3)     NULL,
      visible_after   DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
      created_at      DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
      updated_at      DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
      result          NVARCHAR(MAX)    NULL,
      last_error      NVARCHAR(1024)   NULL
    );
  END;

  -- Hot path: workers poll for pending jobs ready to run (visible_after <= NOW).
  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_job_queue_status_visible_at_type'
      AND object_id = OBJECT_ID('dbo.job_queue')
  )
  BEGIN
    CREATE INDEX IX_job_queue_status_visible_at_type
      ON dbo.job_queue (status, visible_after, job_type)
      INCLUDE (scope, attempts, max_attempts);
  END;

  -- Stale-claim recovery scan.
  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_job_queue_claimed_at'
      AND object_id = OBJECT_ID('dbo.job_queue')
  )
  BEGIN
    CREATE INDEX IX_job_queue_claimed_at
      ON dbo.job_queue (claimed_at)
      WHERE status = 'claimed';
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
