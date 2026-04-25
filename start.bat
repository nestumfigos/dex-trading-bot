@echo off
cd /d "C:\Users\User_\Desktop\dex-trading-bot"

:restart
node src/index.js
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="0" goto done

echo Bot exited with code %EXIT_CODE%. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart

:done
pause