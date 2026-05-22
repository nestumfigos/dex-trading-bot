@echo off
REM Watchdog: auto-restart the bot when it exits (e.g. self-evolution restart)
cd /d "%~dp0"
:loop
echo [WATCHDOG] %DATE% %TIME% starting bot... >> bot-stdout.log
node --unhandled-rejections=warn src/index.js >> bot-stdout.log 2>> bot-stderr.log
set EXITCODE=%ERRORLEVEL%
echo [WATCHDOG] %DATE% %TIME% bot exited code %EXITCODE% >> bot-stdout.log
if "%EXITCODE%"=="0" (
  timeout /t 3 /nobreak >nul
) else (
  timeout /t 10 /nobreak >nul
)
goto loop
