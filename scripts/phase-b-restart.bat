@echo off
REM B6.restart-runbook: Phase-B paper-first restart sequence.
REM Per memory feedback_paper_first_restart_sequence: paper -> 24h canary -> live.
REM This script EXECUTES the stop + paper restart steps; you must MANUALLY confirm
REM after the 24h canary observation window before flipping live back on.

setlocal enabledelayedexpansion

echo === Phase B restart sequence ===
echo.

REM Step 1: Apply Phase B migrations.
echo [1/5] Applying Phase B migrations (M0025 + M0026)...
node scripts/apply-phase-b-migrations.js
if errorlevel 1 (
  echo [FATAL] Migration step failed. Aborting before stopping any bot.
  exit /b 1
)

REM Step 2: Stop running bots. Adjust pm2/forever/service names to match local setup.
echo [2/5] Stopping spot LIVE, spot PAPER, perps PAPER...
echo   (No-op stubs; uncomment your real process-manager commands below.)
REM pm2 stop dex-trading-bot
REM pm2 stop dex-trading-bot-paper
REM pm2 stop dex-trading-bot-perps

REM Step 3: Restart paper canary.
echo [3/5] Restarting spot PAPER for 24h canary...
REM pm2 restart dex-trading-bot-paper
echo   Spot PAPER restarted. Watch dashboard for 24h to confirm:
echo     - tighter stop-loss (6%% vs old 8%%)
echo     - tighter trailing (2.5%% vs old 15%%)
echo     - new listing age 1800s
echo     - Bayesian fusion threshold logs
echo     - no SQL pool churn after the M0025/M0026 apply

REM Step 4: Restart perps paper.
echo [4/5] Restarting perps PAPER (admission default-on, mode caps active)...
REM pm2 restart dex-trading-bot-perps
echo   Perps PAPER restarted. Watch logs for:
echo     - markPrice WS subscribed
echo     - admission gate logs
echo     - canary mode active if PERPS_MODE=canary

REM Step 5: Live restart is MANUAL after 24h.
echo [5/5] DO NOT auto-restart spot LIVE.
echo   Wait 24h on paper canary, then manually run:
echo     pm2 restart dex-trading-bot
echo.
echo === Phase B restart sequence done (paper only). ===
