import { Resvg } from '@resvg/resvg-wasm';
import { init, fontBuf } from './calendar.js';
import { sb } from './db.js';

const steamHeader = (appid) => `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;

// 從 Steam 商店網址取出 appid，例如 https://store.steampowered.com/app/1326470/Sons_Of_The_Forest/
export function steamAppId(text) {
  const m = /store\.steampowered\.com\/app\/(\d+)/.exec(text || '') || /steamstatic\.com\/.*apps\/(\d+)/.exec(text || '');
  return m ? m[1] : null;
}

// 用遊戲名稱搜尋 Steam，回傳 { appid, name } 或 null
export async function steamSearch(name) {
  for (const l of ['tchinese', 'english']) {
    try {
      const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=${l}&cc=TW`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = await r.json();
      const it = j.items?.[0];
      if (it) return { appid: String(it.id), name: it.name };
    } catch (e) { console.warn('Steam 搜尋失敗', e.message); }
  }
  return null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const THEMES = [
  ['#0c2340', '#1e5a8c', '#38bdf8'], ['#0f2a1d', '#1f4d33', '#3c6b3a'], ['#2a1a0e', '#6b3a12', '#b8661c'],
  ['#1a0b2e', '#5b1f8a', '#e0428f'], ['#1c2733', '#4a6b84', '#b9d7ea'], ['#1a0a0a', '#7a1414', '#e2531b'],
];

// 沒有 Steam 圖時，畫一張漸層色底的封面
export async function makeBanner(title, seed = 0) {
  await init();
  const [a, b, c] = THEMES[Math.abs(seed) % THEMES.length];
  const W = 920, H = 430;
  const chars = [...title];
  const size = Math.max(40, Math.min(96, Math.floor(760 / Math.max(1, chars.reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.6), 0)))));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>
  <radialGradient id="r" cx="0.8" cy="0.2" r="0.7"><stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/>
  <text x="${W / 2}" y="${H / 2 - size * 0.9}" font-size="22" fill="#ffffff" fill-opacity="0.8" text-anchor="middle" letter-spacing="8">開 團 囉</text>
  <text x="${W / 2}" y="${H / 2 + size * 0.35}" font-size="${size}" fill="#ffffff" text-anchor="middle">${esc(title)}</text>
</svg>`;
  return Buffer.from(new Resvg(svg, { font: { fontBuffers: [fontBuf], defaultFontFamily: 'Noto Sans TC', loadSystemFonts: false } }).render().asPng());
}

// 上傳到 Supabase Storage 的公開資料夾，回傳網址
let bucketReady = false;
export async function uploadBanner(gameId, png) {
  if (!bucketReady) {
    const { error } = await sb.storage.createBucket('covers', { public: true });
    if (error && !/exist/i.test(error.message)) throw new Error(`建立封面資料夾失敗：${error.message}`);
    bucketReady = true;
  }
  const path = `${gameId}-${Date.now()}.png`;
  const { error } = await sb.storage.from('covers').upload(path, png, { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`上傳封面失敗：${error.message}`);
  return sb.storage.from('covers').getPublicUrl(path).data.publicUrl;
}

// 決定一款遊戲的封面：有填網址用網址 → 搜尋 Steam → 自動產生
export async function resolveCover(game, input) {
  const appid = steamAppId(input);
  if (appid) return steamHeader(appid);
  if (input && /^https?:\/\//.test(input)) return input.trim();
  const found = await steamSearch(game.name);
  if (found) return steamHeader(found.appid);
  const seed = [...game.name].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return uploadBanner(game.id, await makeBanner(game.short || game.name, seed));
}
