IF OBJECT_ID('dbo.v_perps_promotion_readiness', 'V') IS NOT NULL
  DROP VIEW dbo.v_perps_promotion_readiness;

IF OBJECT_ID('dbo.v_perps_execution_quality_summary', 'V') IS NOT NULL
  DROP VIEW dbo.v_perps_execution_quality_summary;

IF OBJECT_ID('dbo.v_perps_risk_exposure', 'V') IS NOT NULL
  DROP VIEW dbo.v_perps_risk_exposure;

IF OBJECT_ID('dbo.v_perps_control_plane_summary', 'V') IS NOT NULL
  DROP VIEW dbo.v_perps_control_plane_summary;
