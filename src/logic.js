import { q, sb, getPoll, getSlots, getVotes, getMembers, getPicks } from './db.js';
import { hm } from './time.js';

// 一次載入某個投票需要的所有資料
export async function loadPoll(pollId) {
  const poll = await getPoll(pollId);
  if (!poll) return null;
  const slots = await getSlots(pollId);
  const votes = await getVotes(slots.map((s) => s.id));
  const games = poll.game_ids.length ? await q(sb.from('games').select('*').in('id', poll.game_ids)) : [];
  games.sort((a, b) => poll.game_ids.indexOf(a.id) - poll.game_ids.indexOf(b.id));
  const members = await getMembers(poll.game_ids);
  const picks = await getPicks(pollId);
  // vote[slotId][userId] = 'y' | 'n'
  const vote = {};
  for (const s of slots) vote[s.id] = {};
  for (const v of votes) if (vote[v.slot_id]) vote[v.slot_id][v.user_id] = v.value;
  const roster = {}; // roster[gameId] = { ids: [...], required: [...] }
  for (const g of games) roster[g.id] = { ids: [], required: [] };
  for (const m of members) {
    if (!roster[m.game_id]) continue;
    roster[m.game_id].ids.push(m.user_id);
    if (m.required) roster[m.game_id].required.push(m.user_id);
  }
  return { poll, slots, vote, games, roster, picks };
}

export const yesOn = (d, slotId) => Object.entries(d.vote[slotId] || {}).filter(([, v]) => v === 'y').map(([u]) => u);

// 還沒填完的人
export function pending(d) {
  return d.poll.member_ids.filter((u) => d.slots.some((s) => !(d.vote[s.id] || {})[u]));
}

// 某款遊戲在某個時段能不能開：ok 可成團 / near 全員制差 1～2 人 / no 不能開
export function status(d, game, slotId) {
  const r = d.roster[game.id] || { ids: [], required: [] };
  const yes = yesOn(d, slotId).filter((u) => r.ids.includes(u));
  const missing = r.ids.filter((u) => !yes.includes(u));
  const reqMiss = r.required.filter((u) => !yes.includes(u));
  const need = game.mode === 'all' ? r.ids.length : game.min_players;
  if (!r.ids.length) return { s: 'no', yes, missing, need, why: '還沒設定團員' };
  if (reqMiss.length) return { s: 'no', yes, missing, need, why: `必到成員不能來`, reqMiss };
  if (game.mode === 'all') {
    if (!missing.length) return { s: 'ok', yes, missing, need };
    if (missing.length <= 2) return { s: 'near', yes, missing, need };
    return { s: 'no', yes, missing, need, why: `只有 ${yes.length}/${r.ids.length}` };
  }
  return yes.length >= game.min_players
    ? { s: 'ok', yes, missing, need }
    : { s: 'no', yes, missing, need, why: `只有 ${yes.length} 人，門檻 ${game.min_players}` };
}

// 依規則產生建議排程：全員制先排，差一點的日子保留給開團人決定
export function suggest(d) {
  const plan = {}; // slotId -> gameId
  const hold = new Set();
  const order = [...d.games].sort((a, b) => (a.mode === 'all' ? 0 : 1) - (b.mode === 'all' ? 0 : 1));
  for (const g of order) {
    const free = d.slots.map((s) => s.id).filter((id) => !plan[id] && !hold.has(id));
    const picks = free.filter((id) => status(d, g, id).s === 'ok')
      .sort((a, b) => yesOn(d, b).length - yesOn(d, a).length)
      .slice(0, g.weekly_target);
    picks.forEach((id) => (plan[id] = g.id));
    if (g.mode === 'all') {
      const short = g.weekly_target - picks.length;
      free.filter((id) => !plan[id] && status(d, g, id).s === 'near')
        .sort((a, b) => status(d, g, a).missing.length - status(d, g, b).missing.length)
        .slice(0, Math.max(0, short)).forEach((id) => hold.add(id));
    }
  }
  return Object.entries(plan).map(([slot_id, game_id]) => ({
    poll_id: d.poll.id, slot_id, game_id, starts_at: d.slots.find((s) => s.id === slot_id).starts_at,
  }));
}

// 同一時段多開一款遊戲時，預設往後延 3 小時
export function defaultPickTime(d, slotId, existing) {
  const slot = d.slots.find((s) => s.id === slotId);
  const same = existing.filter((p) => p.slot_id === slotId).map((p) => new Date(p.starts_at).getTime());
  if (!same.length) return slot.starts_at;
  const t = new Date(Math.max(...same) + 3 * 3600 * 1000);
  return t.toISOString();
}

export const gameLabel = (g) => (g.mode === 'all' ? `${g.name}（全員）` : `${g.name}（${g.min_players} 人成團）`);
export { hm };
