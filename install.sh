#!/usr/bin/env bash
# 開團排程機器人 安裝腳本：建立 .env、安裝套件、設定開機自動啟動
set -e
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

# 瀏覽器終端機貼上時有時會重複兩次，這裡自動修正
dedupe() { local v; v="$(printf '%s' "$1" | tr -d '[:space:]')"; local n=${#v}
  if (( n > 0 && n % 2 == 0 )) && [[ "${v:0:n/2}" == "${v:n/2}" ]]; then v="${v:0:n/2}"; fi; printf '%s' "$v"; }

if [ ! -f .env ]; then
  echo "── 第一次安裝，請依序貼上三個值（貼上時畫面不會顯示，貼完直接按 Enter）──"
  read -rsp "1/3 Discord Token: " T; echo
  read -rsp "2/3 Supabase Project URL: " U; echo
  read -rsp "3/3 Supabase service_role 金鑰: " K; echo
  T="$(dedupe "$T")"; U="$(dedupe "$U")"; K="$(dedupe "$K")"
  [[ "$U" == https://*.supabase.co* ]] || { echo "⚠️ Supabase URL 看起來不對（應該是 https://xxxx.supabase.co），請重新執行 bash install.sh"; exit 1; }
  printf 'DISCORD_TOKEN=%s\nSUPABASE_URL=%s\nSUPABASE_SERVICE_KEY=%s\n' "$T" "$U" "$K" > .env
  chmod 600 .env
  echo "✅ 已建立 .env"
fi

echo "── 安裝套件 ──"
npm ci --omit=dev --no-audit --no-fund

echo "── 設定開機自動啟動 ──"
sudo tee /etc/systemd/system/kaituan-bot.service > /dev/null <<UNIT
[Unit]
Description=Kaituan Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
User=$(whoami)
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=384

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable kaituan-bot > /dev/null 2>&1
sudo systemctl restart kaituan-bot
sleep 8
echo "── 最近的紀錄 ──"
sudo journalctl -u kaituan-bot -n 15 --no-pager -o cat
echo
echo "看到「✅ 已上線」就成功了。之後查看紀錄：sudo journalctl -u kaituan-bot -f"
