#!/usr/bin/env bash
# 更新到最新版並重新啟動
set -e
cd "$(dirname "$0")"
git pull
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart kaituan-bot
sleep 5
sudo journalctl -u kaituan-bot -n 10 --no-pager -o cat
