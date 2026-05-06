@echo off
setlocal
cd /d C:\Users\User_\Desktop\dex-trading-bot
call pm2 resurrect
call pm2 start ecosystem.config.js --env production
call pm2 save
endlocal
