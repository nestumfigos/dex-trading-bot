IF OBJECT_ID('dbo.v_promotion_gate_evaluations_latest', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_promotion_gate_evaluations_latest;
END;

IF OBJECT_ID('dbo.v_mutation_proposals_latest', 'V') IS NOT NULL
BEGIN
  DROP VIEW dbo.v_mutation_proposals_latest;
END;

IF EXISTS (
  SELECT 1
  FROM sys.tables
  WHERE name = 'promotion_gate_evaluations'
    AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  DROP TABLE dbo.promotion_gate_evaluations;
END;

IF EXISTS (
  SELECT 1
  FROM sys.tables
  WHERE name = 'mutation_proposals'
    AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  DROP TABLE dbo.mutation_proposals;
END;
