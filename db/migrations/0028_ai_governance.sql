IF NOT EXISTS (
  SELECT 1
  FROM sys.tables
  WHERE name = 'mutation_proposals'
    AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.mutation_proposals (
    proposal_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_mutation_proposals_id DEFAULT NEWID() PRIMARY KEY,
    bot_profile NVARCHAR(20) NOT NULL,
    target_profile NVARCHAR(20) NULL,
    strategy NVARCHAR(80) NOT NULL,
    strategy_version NVARCHAR(80) NULL,
    proposal_type NVARCHAR(40) NOT NULL CONSTRAINT DF_mutation_proposals_type DEFAULT ('config_patch'),
    proposer NVARCHAR(80) NULL,
    status NVARCHAR(40) NOT NULL CONSTRAINT DF_mutation_proposals_status DEFAULT ('proposed'),
    stage NVARCHAR(40) NOT NULL CONSTRAINT DF_mutation_proposals_stage DEFAULT ('proposal'),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_mutation_proposals_created_at DEFAULT SYSUTCDATETIME(),
    reviewed_at DATETIME2(3) NULL,
    patch_hash NVARCHAR(120) NULL,
    patch_json NVARCHAR(MAX) NOT NULL,
    rationale_json NVARCHAR(MAX) NULL,
    expected_impact_json NVARCHAR(MAX) NULL,
    risk_notes_json NVARCHAR(MAX) NULL,
    evidence_refs_json NVARCHAR(MAX) NULL,
    review_notes_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_mutation_proposals_status'
    AND object_id = OBJECT_ID('dbo.mutation_proposals')
)
BEGIN
  CREATE INDEX IX_mutation_proposals_status
    ON dbo.mutation_proposals(status, stage, created_at DESC);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_mutation_proposals_profile_strategy'
    AND object_id = OBJECT_ID('dbo.mutation_proposals')
)
BEGIN
  CREATE INDEX IX_mutation_proposals_profile_strategy
    ON dbo.mutation_proposals(bot_profile, strategy, created_at DESC);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.tables
  WHERE name = 'promotion_gate_evaluations'
    AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.promotion_gate_evaluations (
    evaluation_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_promotion_gate_evaluations_id DEFAULT NEWID() PRIMARY KEY,
    candidate_id UNIQUEIDENTIFIER NULL,
    proposal_id UNIQUEIDENTIFIER NULL,
    bot_profile NVARCHAR(20) NOT NULL,
    target_profile NVARCHAR(20) NOT NULL,
    strategy NVARCHAR(80) NOT NULL,
    strategy_version NVARCHAR(80) NULL,
    strategy_class NVARCHAR(40) NULL,
    ts DATETIME2(3) NOT NULL CONSTRAINT DF_promotion_gate_evaluations_ts DEFAULT SYSUTCDATETIME(),
    passed BIT NOT NULL CONSTRAINT DF_promotion_gate_evaluations_passed DEFAULT (0),
    score FLOAT NULL,
    sample_size INT NULL,
    expectancy_usd FLOAT NULL,
    stressed_expectancy_usd FLOAT NULL,
    profit_factor FLOAT NULL,
    max_drawdown_pct FLOAT NULL,
    symbol_concentration_pct FLOAT NULL,
    regime_coverage_count INT NULL,
    execution_discrepancy_pct FLOAT NULL,
    failure_reasons_json NVARCHAR(MAX) NULL,
    metrics_json NVARCHAR(MAX) NULL,
    thresholds_json NVARCHAR(MAX) NULL,
    raw_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_promotion_gate_eval_profile_strategy'
    AND object_id = OBJECT_ID('dbo.promotion_gate_evaluations')
)
BEGIN
  CREATE INDEX IX_promotion_gate_eval_profile_strategy
    ON dbo.promotion_gate_evaluations(bot_profile, target_profile, strategy, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_promotion_gate_eval_passed'
    AND object_id = OBJECT_ID('dbo.promotion_gate_evaluations')
)
BEGIN
  CREATE INDEX IX_promotion_gate_eval_passed
    ON dbo.promotion_gate_evaluations(passed, ts DESC);
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_promotion_gate_eval_proposal'
    AND object_id = OBJECT_ID('dbo.promotion_gate_evaluations')
)
BEGIN
  CREATE INDEX IX_promotion_gate_eval_proposal
    ON dbo.promotion_gate_evaluations(proposal_id, ts DESC);
END;

EXEC('
CREATE OR ALTER VIEW dbo.v_mutation_proposals_latest AS
SELECT TOP 500
  proposal_id,
  bot_profile,
  target_profile,
  strategy,
  strategy_version,
  proposal_type,
  proposer,
  status,
  stage,
  created_at,
  reviewed_at,
  patch_hash,
  patch_json,
  rationale_json,
  expected_impact_json,
  risk_notes_json,
  evidence_refs_json,
  review_notes_json
FROM dbo.mutation_proposals
ORDER BY created_at DESC;
');

EXEC('
CREATE OR ALTER VIEW dbo.v_promotion_gate_evaluations_latest AS
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY bot_profile, target_profile, strategy, COALESCE(strategy_version, '''')
      ORDER BY ts DESC
    ) AS rn
  FROM dbo.promotion_gate_evaluations
)
SELECT
  evaluation_id,
  candidate_id,
  proposal_id,
  bot_profile,
  target_profile,
  strategy,
  strategy_version,
  strategy_class,
  ts,
  passed,
  score,
  sample_size,
  expectancy_usd,
  stressed_expectancy_usd,
  profit_factor,
  max_drawdown_pct,
  symbol_concentration_pct,
  regime_coverage_count,
  execution_discrepancy_pct,
  failure_reasons_json,
  metrics_json,
  thresholds_json,
  raw_json
FROM ranked
WHERE rn = 1;
');
