-- Rollback M0023: drop job_queue.
BEGIN TRANSACTION;
BEGIN TRY

  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_job_queue_claimed_at' AND object_id = OBJECT_ID('dbo.job_queue'))
    DROP INDEX IX_job_queue_claimed_at ON dbo.job_queue;
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_job_queue_status_visible_at_type' AND object_id = OBJECT_ID('dbo.job_queue'))
    DROP INDEX IX_job_queue_status_visible_at_type ON dbo.job_queue;
  IF OBJECT_ID('dbo.job_queue', 'U') IS NOT NULL
    DROP TABLE dbo.job_queue;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
