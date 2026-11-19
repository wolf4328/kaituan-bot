import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { mk, tp, hm, pad } from './time.js';

const require = createRequire(import.meta.url);
let ready = null;
export let fontBuf = null;
export async function init() {
  if (!ready) {
    ready = (async () => {
      await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
      fontBuf = new Uint8Array(await readFile(new URL('../assets/NotoSansTC-Bold.otf', import.meta.url)));
    })();
  }
  return ready;
}

// 每款遊戲一個明顯不同的顏色
export const PALETTE = [
  { bg: '#0284c7', fg: '#ffffff' }, { bg: '#ec4899', fg: '#ffffff' }, { bg: '#f59e0b', fg: '#3b2300' },
  { bg: '#16a34a', fg: '#ffffff' }, { bg: '#7c3aed', fg: '#ffffff' }, { bg: '#ef4444', fg: '#ffffff' },
  { bg: '#0d9488', fg: '#ffffff' }, { bg: '#a16207', fg: '#ffffff' }, { bg: '#db2777', fg: '#ffffff' },
  { bg: '#4f46e5', fg: '#ffffff' },
];
export const SKY_SET = PALETTE;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cutW = (s, px, size = 13) => { let w = 0, out = ''; for (const c of [...s]) { const cw = c.charCodeAt(0) > 255 ? size : size * 0.58; if (w + cw > px) return out + '…'; w += cw; out += c; } return out; };
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

// events: [{starts_at, game}]；polls: [{starts_at, game}]（投票中的日期）；games: 全部遊戲（決定顏色）
export async function renderMonth(y, m, events, polls, games) {
  await init();
  const W = 980, PAD = 20, HEAD = 110, GAP = 6, CHIP = 36, MAXCHIP = 4;
  const cw = (W - PAD * 2 - GAP * 6) / 7;
  const first = mk(y, m, 1);
  const off = (tp(first).wd + 6) % 7; // 週一開頭
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = Math.ceil((off + days) / 7);
  const byDay = {};
  for (const e of events) (byDay[tp(e.starts_at).d] ||= []).push({ ...e, kind: 'ev' });
  for (const p of polls) (byDay[tp(p.starts_at).d] ||= []).push({ ...p, kind: 'poll' });
  for (const d in byDay) byDay[d].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || (a.kind === 'ev' ? -1 : 1));
  // 每一列依當週最多的項目決定高度，空的週比較矮
  const rowH = Array.from({ length: rows }, (_, r) => {
    let n = 0;
    for (let c = 0; c < 7; c++) { const d = r * 7 + c - off + 1; if (d >= 1 && d <= days) n = Math.max(n, Math.min(MAXCHIP, (byDay[d] || []).length)); }
    return Math.max(76, 36 + n * (CHIP + 4) + 4);
  });
  const rowY = rowH.reduce((acc, h, k) => (acc.push(k ? acc[k - 1] + rowH[k - 1] + GAP : 0), acc), []);
  const gridTop = HEAD + 44;
  const used = [...new Map([...events, ...polls].map((x) => [x.game.id, x.game])).values()];
  const legendItems = used.length ? used : [];
  // 圖例換行
  const legendRows = [];
  let row = [], lx = PAD + 4;
  const tw = (t) => [...t].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 15 : 8.5), 0);
  for (const g of legendItems) {
    const w = 48 + tw(cut(g.name, 20));
    if (lx + w > W - PAD && row.length) { legendRows.push(row); row = []; lx = PAD + 4; }
    row.push({ g, x: lx }); lx += w;
  }
  const extra = [{ label: '實心＝已成團', dashed: false }, { label: '虛線框＝投票中', dashed: true }];
  for (const e of extra) {
    const w = 48 + tw(e.label);
    if (lx + w > W - PAD && row.length) { legendRows.push(row); row = []; lx = PAD + 4; }
    row.push({ e, x: lx }); lx += w;
  }
  legendRows.push(row);
  const legendY = gridTop + rowY[rows - 1] + rowH[rows - 1] + 14;
  const H = legendY + legendRows.length * 28 + 20;
  const idx = (gid) => Math.max(0, games.findIndex((g) => g.id === gid));
  const colorOf = (gid) => PALETTE[idx(gid) % PALETTE.length];
  const now = tp(new Date());

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="hd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="0.6" stop-color="#38bdf8"/><stop offset="1" stop-color="#7dd3fc"/></linearGradient></defs>
  <rect width="${W}" height="${H}" rx="22" fill="#f0f9ff"/>
  <path d="M0 22 a22 22 0 0 1 22 -22 h${W - 44} a22 22 0 0 1 22 22 v${HEAD - 22} h-${W} z" fill="url(#hd)"/>
  <text x="${PAD + 8}" y="44" font-size="18" fill="#ffffff" opacity="0.85" letter-spacing="3">${y}</text>
  <text x="${PAD + 8}" y="88" font-size="38" fill="#ffffff">${m} 月開團行程</text>
  <rect x="${W - PAD - 250}" y="54" width="242" height="40" rx="20" fill="#ffffff" fill-opacity="0.28"/>
  <text x="${W - PAD - 129}" y="81" font-size="19" fill="#ffffff" text-anchor="middle">成團 ${events.length} 場・投票中 ${new Set(polls.map((p) => p.pollId)).size} 個</text>`;
  '一二三四五六日'.split('').forEach((w, i) => {
    s += `<text x="${PAD + i * (cw + GAP) + cw / 2}" y="${HEAD + 30}" font-size="17" text-anchor="middle" fill="${i > 4 ? '#e11d74' : '#0284c7'}">${w}</text>`;
  });
  for (let d = 1; d <= days; d++) {
    const i = off + d - 1, r = Math.floor(i / 7), c = i % 7;
    const x = PAD + c * (cw + GAP), yy = gridTop + rowY[r], ch = rowH[r];
    const isToday = now.y === y && now.m === m && now.d === d;
    s += `<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="10" fill="#ffffff"/>`;
    if (isToday) s += `<circle cx="${x + 20}" cy="${yy + 20}" r="14" fill="#0ea5e9"/>`;
    s += `<text x="${x + 20}" y="${yy + 26}" font-size="16" text-anchor="middle" fill="${isToday ? '#ffffff' : c > 4 ? '#e11d74' : '#0c4a6e'}">${d}</text>`;
    const items = byDay[d] || [];
    const show = items.length > MAXCHIP ? items.slice(0, MAXCHIP - 1) : items;
    show.forEach((e, k) => {
      const col = colorOf(e.game.id);
      const py = yy + 36 + k * (CHIP + 4);
      const label = esc(cutW(e.game.short || e.game.name, cw - 26));
      if (e.kind === 'ev') {
        s += `<rect x="${x + 5}" y="${py}" width="${cw - 10}" height="${CHIP}" rx="6" fill="${col.bg}"/>`;
        s += `<text x="${x + 11}" y="${py + 15}" font-size="11" fill="${col.fg}" fill-opacity="0.9">${hm(e.starts_at)}</text>`;
        s += `<text x="${x + 11}" y="${py + 31}" font-size="13" fill="${col.fg}">${label}</text>`;
      } else {
        s += `<rect x="${x + 5}" y="${py}" width="${cw - 10}" height="${CHIP}" rx="6" fill="${col.bg}" fill-opacity="0.1" stroke="${col.bg}" stroke-width="2" stroke-dasharray="5 3"/>`;
        s += `<text x="${x + 11}" y="${py + 15}" font-size="11" fill="${col.bg}">${hm(e.starts_at)} 投票中</text>`;
        s += `<text x="${x + 11}" y="${py + 31}" font-size="13" fill="${col.bg}">${label}</text>`;
      }
    });
    if (items.length > MAXCHIP) {
      const py = yy + 36 + (MAXCHIP - 1) * (CHIP + 4);
      s += `<text x="${x + cw / 2}" y="${py + 21}" font-size="13" fill="#0284c7" text-anchor="middle">＋還有 ${items.length - MAXCHIP + 1} 個</text>`;
    }
  }
  legendRows.forEach((row, ri) => {
    const ly = legendY + ri * 28;
    for (const it of row) {
      if (it.g) {
        const col = colorOf(it.g.id);
        s += `<rect x="${it.x}" y="${ly}" width="16" height="16" rx="4" fill="${col.bg}"/><text x="${it.x + 22}" y="${ly + 14}" font-size="14" fill="#075985">${esc(cut(it.g.name, 20))}</text>`;
      } else {
        s += it.e.dashed
          ? `<rect x="${it.x}" y="${ly}" width="16" height="16" rx="4" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="4 3"/>`
          : `<rect x="${it.x}" y="${ly}" width="16" height="16" rx="4" fill="#64748b"/>`;
        s += `<text x="${it.x + 22}" y="${ly + 14}" font-size="14" fill="#475569">${it.e.label}</text>`;
      }
    }
  });
  s += '</svg>';

  const png = new Resvg(s, {
    font: { fontBuffers: [fontBuf], defaultFontFamily: 'Noto Sans TC', loadSystemFonts: false },
    fitTo: { mode: 'width', value: W },
  }).render().asPng();
  return Buffer.from(png);
}
export const monthKey = (y, m) => `${y}-${pad(m)}`;
