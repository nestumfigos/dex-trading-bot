-- M013 rollback. Drops new columns + indexes added in 0012.
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_signals_ai_decision_id' AND object_id=OBJECT_ID('dbo.signals'))
  DROP INDEX IX_signals_ai_decision_id ON dbo.signals;
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_signals_retention_tier_ts' AND object_id=OBJECT_ID('dbo.signals'))
  DROP INDEX IX_signals_retention_tier_ts ON dbo.signals;
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE name='retention_tier' AND object_id=OBJECT_ID('dbo.signals'))
BEGIN
  DECLARE @def_name NVARCHAR(256);
  SELECT @def_name = d.name
    FROM sys.default_constraints d
    JOIN sys.columns c ON c.default_object_id = d.object_id
   WHERE c.object_id = OBJECT_ID('dbo.signals') AND c.name = 'retention_tier';
  IF @def_name IS NOT NULL EXEC('ALTER TABLE dbo.signals DROP CONSTRAINT ' + @def_name);
  ALTER TABLE dbo.signals DROP COLUMN retention_tier;
END
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE name='signal_score' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals DROP COLUMN signal_score;
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE name='memory_warnings_json' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals DROP COLUMN memory_warnings_json;
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE name='ai_decision_id' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals DROP COLUMN ai_decision_id;
GO
