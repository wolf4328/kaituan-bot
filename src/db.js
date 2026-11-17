import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_KEY，請檢查 .env');
  process.exit(1);
}
export const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// 包一層：出錯就丟例外，回傳 data
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(`資料庫錯誤：${error.message}`);
  return data;
}

export async function getSettings(guildId) {
  let row = await q(sb.from('settings').select('*').eq('guild_id', guildId).maybeSingle());
  if (!row) row = await q(sb.from('settings').insert({ guild_id: guildId }).select().single());
  return row;
}
export async function setSettings(guildId, patch) {
  await getSettings(guildId);
  return q(sb.from('settings').update(patch).eq('guild_id', guildId).select().single());
}

export const getGames = (guildId) => q(sb.from('games').select('*').eq('guild_id', guildId).order('created_at'));
export const getGame = (id) => q(sb.from('games').select('*').eq('id', id).maybeSingle());

export async function getMembers(gameIds) {
  if (!gameIds.length) return [];
  return q(sb.from('game_members').select('*').in('game_id', gameIds));
}

export const getPoll = (id) => q(sb.from('polls').select('*').eq('id', id).maybeSingle());
export const getSlots = (pollId) => q(sb.from('poll_slots').select('*').eq('poll_id', pollId).order('starts_at'));
export async function getVotes(slotIds) {
  if (!slotIds.length) return [];
  return q(sb.from('votes').select('*').in('slot_id', slotIds));
}
export const getPicks = (pollId) => q(sb.from('plan_picks').select('*').eq('poll_id', pollId));
export const getEvent = (id) => q(sb.from('events').select('*').eq('id', id).maybeSingle());

// 最近一次還沒結束的投票（open 或 closed）
export async function latestPoll(guildId, statuses = ['open', 'closed']) {
  const rows = await q(sb.from('polls').select('*').eq('guild_id', guildId).in('status', statuses).order('created_at', { ascending: false }).limit(1));
  return rows[0] || null;
}
