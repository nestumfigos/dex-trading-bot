@echo off
REM pm2 boot-persistence (2026-07-25). Invoked by the Windows Task Scheduler
REM "dex-bot-pm2-resurrect" task at user logon. Root cause it fixes: on
REM 2026-07-19 a machine-level event killed every node process AND the pm2
REM daemon at once, leaving nothing to autorestart the fleet -> 6-day silent
REM outage. This restores the saved process list (dump.pm2: dex-bot,
REM dex-bot-paper, dex-bot-perps) after any reboot/kill.
REM
REM Manual test:  scripts\pm2-boot-resurrect.cmd
REM Log:          %USERPROFILE%\.pm2\boot-resurrect.log

setlocal
set "PM2_HOME=%USERPROFILE%\.pm2"
set "LOG=%PM2_HOME%\boot-resurrect.log"
set "PM2=%APPDATA%\npm\pm2.cmd"

echo(>> "%LOG%"
echo [%DATE% %TIME%] boot-resurrect start (pid %RANDOM%)>> "%LOG%"

REM Give the network stack + SQL Server time to come up before the bots
REM try to connect (they tolerate a cold DB but this avoids noisy retries).
timeout /t 45 /nobreak >nul 2>&1

REM Wake / spawn the daemon, then restore the saved list. `resurrect` is a
REM no-op-safe if the apps are already online (idempotent on a warm daemon),
REM so this is harmless if something already started the fleet.
call "%PM2%" ping >> "%LOG%" 2>&1
call "%PM2%" resurrect >> "%LOG%" 2>&1
call "%PM2%" list >> "%LOG%" 2>&1

echo [%DATE% %TIME%] boot-resurrect done>> "%LOG%"
endlocal
