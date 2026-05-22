-- Rollback M0019
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_signals_ai_decision_id')
  ALTER TABLE dbo.signals DROP CONSTRAINT FK_signals_ai_decision_id;
GO
