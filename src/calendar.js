import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { mk, tp, hm, pad } from './time.js';

const require = createRequire(import.meta.url);
let ready = null;
let fontBuf = null;
async function init() {
  if (!ready) {
    ready = (async () => {
      await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
      fontBuf = new Uint8Array(await readFile(new URL('../assets/NotoSansTC-Bold.otf', import.meta.url)));
    })();
  }
  return ready;
}

export const SKY_SET = [
  { bg: '#0284c7', fg: '#ffffff' }, { bg: '#7dd3fc', fg: '#0c4a6e' }, { bg: '#0369a1', fg: '#ffffff' },
  { bg: '#bae6fd', fg: '#075985' }, { bg: '#38bdf8', fg: '#082f49' }, { bg: '#0ea5e9', fg: '#ffffff' },
];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

// events: [{starts_at, game}], polling: Set of 'd'(日) 數字, games: 遊戲列表（圖例用）
export async function renderMonth(y, m, events, pollingDays, games) {
  await init();
  const W = 980, PAD = 20, HEAD = 110, GAP = 6;
  const cw = (W - PAD * 2 - GAP * 6) / 7;
  const first = mk(y, m, 1);
  const off = (tp(first).wd + 6) % 7; // 週一開頭
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = Math.ceil((off + days) / 7);
  const byDay = {};
  for (const e of events) { const d = tp(e.starts_at).d; (byDay[d] ||= []).push(e); }
  for (const d in byDay) byDay[d].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const maxEv = Math.max(1, ...Object.values(byDay).map((a) => a.length));
  const ch = Math.max(96, 34 + maxEv * 34);
  const gridTop = HEAD + 44;
  const legendY = gridTop + rows * (ch + GAP) + 14;
  const H = legendY + 46;
  const colorOf = (gid) => SKY_SET[Math.max(0, games.findIndex((g) => g.id === gid)) % SKY_SET.length];
  const now = tp(new Date());
  const total = events.length;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="hd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="0.6" stop-color="#38bdf8"/><stop offset="1" stop-color="#7dd3fc"/></linearGradient></defs>
  <rect width="${W}" height="${H}" rx="22" fill="#f0f9ff"/>
  <path d="M0 22 a22 22 0 0 1 22 -22 h${W - 44} a22 22 0 0 1 22 22 v${HEAD - 22} h-${W} z" fill="url(#hd)"/>
  <text x="${PAD + 8}" y="44" font-size="18" fill="#ffffff" opacity="0.85" letter-spacing="3">${y}</text>
  <text x="${PAD + 8}" y="88" font-size="38" fill="#ffffff">${m} 月開團行程</text>
  <rect x="${W - PAD - 120}" y="54" width="112" height="40" rx="20" fill="#ffffff" fill-opacity="0.28"/>
  <text x="${W - PAD - 64}" y="81" font-size="20" fill="#ffffff" text-anchor="middle">${total} 場</text>`;
  '一二三四五六日'.split('').forEach((w, i) => {
    s += `<text x="${PAD + i * (cw + GAP) + cw / 2}" y="${HEAD + 30}" font-size="17" text-anchor="middle" fill="${i > 4 ? '#e11d74' : '#0284c7'}">${w}</text>`;
  });
  for (let d = 1; d <= days; d++) {
    const idx = off + d - 1, r = Math.floor(idx / 7), c = idx % 7;
    const x = PAD + c * (cw + GAP), yy = gridTop + r * (ch + GAP);
    const isToday = now.y === y && now.m === m && now.d === d;
    const polling = pollingDays.has(d);
    s += `<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="10" fill="#ffffff" ${polling ? 'stroke="#7dd3fc" stroke-width="2.5" stroke-dasharray="7 5"' : ''}/>`;
    if (isToday) s += `<circle cx="${x + 20}" cy="${yy + 20}" r="14" fill="#0ea5e9"/>`;
    s += `<text x="${x + 20}" y="${yy + 26}" font-size="16" text-anchor="middle" fill="${isToday ? '#ffffff' : c > 4 ? '#e11d74' : '#0c4a6e'}">${d}</text>`;
    if (polling && !(byDay[d] || []).length) s += `<text x="${x + 10}" y="${yy + 56}" font-size="13" fill="#0284c7">投票中</text>`;
    (byDay[d] || []).forEach((e, i) => {
      const col = colorOf(e.game.id);
      const py = yy + 36 + i * 34;
      s += `<rect x="${x + 6}" y="${py}" width="${cw - 12}" height="30" rx="6" fill="${col.bg}"/>`;
      s += `<text x="${x + 12}" y="${py + 20}" font-size="13" fill="${col.fg}">${hm(e.starts_at)} ${esc(cut(e.game.short || e.game.name, 5))}</text>`;
    });
  }
  let lx = PAD + 4;
  for (const g of games) {
    const col = colorOf(g.id);
    const nm = cut(g.name, 20);
    const tw = [...nm].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 15 : 8.5), 0);
    s += `<rect x="${lx}" y="${legendY}" width="16" height="16" rx="4" fill="${col.bg}"/><text x="${lx + 22}" y="${legendY + 14}" font-size="14" fill="#075985">${esc(nm)}</text>`;
    lx += 48 + tw;
  }
  s += `<rect x="${lx}" y="${legendY}" width="16" height="16" rx="4" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-dasharray="4 3"/><text x="${lx + 22}" y="${legendY + 14}" font-size="14" fill="#075985">投票中</text>`;
  s += '</svg>';

  const png = new Resvg(s, {
    font: { fontBuffers: [fontBuf], defaultFontFamily: 'Noto Sans TC', loadSystemFonts: false },
    fitTo: { mode: 'width', value: W },
  }).render().asPng();
  return Buffer.from(png);
}
export const monthKey = (y, m) => `${y}-${pad(m)}`;
