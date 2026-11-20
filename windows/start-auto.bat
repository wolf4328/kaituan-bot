@echo off
chcp 65001 >nul
title 開團排程機器人（自動更新，不要關掉這個視窗）
cd /d "%~dp0.."
set AUTO_UPDATE=1
:loop
echo 檢查更新中...
git pull --ff-only
call npm install --omit=dev --no-audit --no-fund
node src\index.js
echo 機器人停止了，5 秒後重新啟動...
timeout /t 5 /nobreak >nul
goto loop
