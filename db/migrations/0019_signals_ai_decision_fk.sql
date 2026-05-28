-- M0019: constrain signals.ai_decision_id to existing AI decisions.
BEGIN TRANSACTION;
BEGIN TRY

  IF COL_LENGTH('dbo.signals', 'ai_decision_id') IS NOT NULL
     AND COL_LENGTH('dbo.ai_decisions', 'id') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_signals_ai_decision_id'
     )
  BEGIN
    ALTER TABLE dbo.signals
      ADD CONSTRAINT FK_signals_ai_decision_id
      FOREIGN KEY (ai_decision_id) REFERENCES dbo.ai_decisions(id)
      ON DELETE SET NULL;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
