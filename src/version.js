import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 啟動時讀一次目前的版本（git commit），讀不到就顯示「未知」
const cwd = fileURLToPath(new URL('..', import.meta.url));
function git(...args) {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}
const hash = git('rev-parse', '--short', 'HEAD') || '未知';
const when = git('log', '-1', '--format=%cd', '--date=format-local:%m/%d %H:%M');
export const VERSION = when ? `${hash}（${when} 推出）` : hash;
export const STARTED = new Date();
