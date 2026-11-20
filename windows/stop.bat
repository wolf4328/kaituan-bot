@echo off
chcp 65001 >nul
echo 正在停止開團排程機器人...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like \"*start-auto.bat*\" -or $_.CommandLine -like \"*src\index.js*\") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo 已停止。
pause
