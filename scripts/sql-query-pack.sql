SELECT * FROM dbo.vw_profile_summary ORDER BY bot_profile;

SELECT * FROM dbo.vw_learning_summary ORDER BY bot_profile;

SELECT * FROM dbo.vw_latest_intelligence ORDER BY bot_profile;

SELECT * FROM dbo.vw_self_evolution_summary ORDER BY bot_profile;

SELECT * FROM dbo.vw_agent_memory_summary ORDER BY memory_scope;

SELECT * FROM dbo.vw_live_vs_paper ORDER BY metric;

SELECT * FROM dbo.vw_chain_summary ORDER BY bot_profile, chain_key;

SELECT * FROM dbo.vw_strategy_summary ORDER BY bot_profile, strategy;

SELECT TOP 50 *
FROM dbo.vw_latest_open_positions
ORDER BY bot_profile, opened_at DESC;

SELECT TOP 25 *
FROM dbo.vw_latest_agent_lessons
ORDER BY ts DESC;

SELECT TOP 25 *
FROM dbo.vw_latest_agent_discoveries
ORDER BY ts DESC;

SELECT bot_profile, COUNT(*) AS signal_count, MAX(ts) AS last_signal_at
FROM dbo.signals
GROUP BY bot_profile
ORDER BY bot_profile;

SELECT bot_profile, COUNT(*) AS pnl_points, MAX(ts) AS last_pnl_at
FROM dbo.bot_pnl_history
GROUP BY bot_profile
ORDER BY bot_profile;
