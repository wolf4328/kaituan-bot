@echo off
chcp 65001 >nul
title 開團排程機器人（不要關掉這個視窗）
cd /d "%~dp0.."
if not exist node_modules call npm ci --omit=dev --no-audit --no-fund
:loop
node src\index.js
echo 機器人停止了，5 秒後自動重開...
timeout /t 5 /nobreak >nul
goto loop
