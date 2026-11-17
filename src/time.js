// 台灣時間（UTC+8，沒有日光節約）的日期工具
const OFF = 8 * 3600 * 1000;
export const WD = '日一二三四五六';
export const pad = (n) => String(n).padStart(2, '0');

// 把任何時間轉成台灣時間的年月日時分
export function tp(date) {
  const d = new Date(new Date(date).getTime() + OFF);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}
// 用台灣時間的年月日時分建立 Date
export function mk(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFF);
}
export const ymd = (date) => { const p = tp(date); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
export const fromYmd = (s, hh = 0, mm = 0) => { const [y, m, d] = s.split('-').map(Number); return mk(y, m, d, hh, mm); };
export const dayLabel = (date) => { const p = tp(date); return `${p.m}/${p.d}（${WD[p.wd]}）`; };
export const hm = (date) => { const p = tp(date); return `${pad(p.hh)}:${pad(p.mm)}`; };
export const full = (date) => `${dayLabel(date)} ${hm(date)}`;
export const ts = (date, f = 'F') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${f}>`;
export const addDays = (date, n) => new Date(new Date(date).getTime() + n * 86400000);
export const addMin = (date, n) => new Date(new Date(date).getTime() + n * 60000);
export function todayStart() { const p = tp(new Date()); return mk(p.y, p.m, p.d); }

// "21:00" / "9:30" / "21：00" → [21, 0]
export function parseHM(s) {
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}
// "11/21"、"2026/11/21"、"11-21" → Date（台灣當天 00:00）。沒寫年份時自動判斷今年或明年
export function parseMD(s) {
  const m = /(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})/.exec(s || '');
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let y = m[1] ? +m[1] : tp(new Date()).y;
  let date = mk(y, mo, d);
  if (!m[1] && date < addDays(todayStart(), -30)) date = mk(y + 1, mo, d);
  const p = tp(date);
  if (p.m !== mo || p.d !== d) return null;
  return date;
}
export function withTime(date, [h, mi]) { const p = tp(date); return mk(p.y, p.m, p.d, h, mi); }
