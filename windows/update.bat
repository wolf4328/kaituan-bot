@echo off
chcp 65001 >nul
cd /d "%~dp0.."
git pull
call npm ci --omit=dev --no-audit --no-fund
echo.
echo 更新完成！請把「開團排程機器人」那個黑色視窗關掉，再重新開 windows\start.bat
pause
