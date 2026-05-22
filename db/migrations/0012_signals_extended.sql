-- M013: signals extended
-- ALTER existing dbo.signals to add fields needed by Week 4 (ai_decision_id link)
-- and Week 5 (memory warnings, signal score, retention tier for prune policy).
-- Pre-existing columns: signal_id, run_id, ts, bot_profile, chain, chain_key,
-- symbol, address, strategy, final_signal, technical_signal, signal_source,
-- confidence, ai_confidence, ai_reason, risk_flags_json, features_json,
-- gate_json, reject_reasons_json.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='ai_decision_id' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals ADD ai_decision_id BIGINT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='memory_warnings_json' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals ADD memory_warnings_json NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='signal_score' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals ADD signal_score FLOAT NULL;
GO

-- Retention tier governs prune policy in scripts/sql-cleanup.js:
--   '12h'       — ephemeral / HOLD-only signals
--   '30d'       — default
--   'permanent' — winning trade signals + flagged for learning
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name='retention_tier' AND object_id=OBJECT_ID('dbo.signals'))
  ALTER TABLE dbo.signals ADD retention_tier NVARCHAR(16) NOT NULL DEFAULT '30d';
GO

-- Prune-sweep index. Filtered to non-permanent rows so the sweep query is small.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_signals_retention_tier_ts' AND object_id=OBJECT_ID('dbo.signals'))
BEGIN
  CREATE INDEX IX_signals_retention_tier_ts
    ON dbo.signals (retention_tier, ts ASC)
    WHERE retention_tier <> 'permanent';
END
GO

-- AI decision link (optional FK). Hot lookup when reconciling signal → ai_decisions row.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_signals_ai_decision_id' AND object_id=OBJECT_ID('dbo.signals'))
BEGIN
  CREATE INDEX IX_signals_ai_decision_id
    ON dbo.signals (ai_decision_id)
    WHERE ai_decision_id IS NOT NULL;
END
GO
