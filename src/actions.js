import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { sb, q, getSettings, getGames, getGame } from './db.js';
import { loadPoll, pending, suggest, status, yesOn } from './logic.js';
import { pollMessage, planPanel, eventMessage, overviewMessage, msgLink } from './render.js';
import { full, dayLabel, ts } from './time.js';

export async function fetchMessage(client, channelId, messageId) {
  if (!channelId || !messageId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return null;
  return ch.messages.fetch(messageId).catch(() => null);
}

// 私訊，失敗回傳 null（對方關閉私訊時會失敗）
export async function dm(client, userId, payload) {
  try {
    const u = await client.users.fetch(userId);
    return await u.send(payload);
  } catch (e) {
    console.warn(`私訊 ${userId} 失敗：${e.message}`);
    return null;
  }
}

export async function refreshPollMessage(client, d) {
  const msg = await fetchMessage(client, d.poll.channel_id, d.poll.message_id);
  if (msg) await msg.edit(pollMessage(d)).catch((e) => console.error('更新時間表失敗', e.message));
}

const jumpRow = (url, label = '↗ 跳到時間表') => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label),
);

// 私訊提醒還沒填完的人
export async function nudge(client, d) {
  const link = msgLink(d.poll.guild_id, d.poll.channel_id, d.poll.message_id);
  const sent = [], failed = [];
  for (const u of pending(d)) {
    const left = d.slots.filter((s) => !(d.vote[s.id] || {})[u]).length;
    const ok = await dm(client, u, {
      content: `嗨～開團時間表你還有 **${left} 天**沒填，截止時間是 ${ts(d.poll.deadline, 'f')}（${ts(d.poll.deadline, 'R')}）。\n不能來的日子不要勾就好，其他成員看不到你選了什麼 🙏`,
      components: [jumpRow(link)],
    });
    (ok ? sent : failed).push(u);
  }
  await q(sb.from('polls').update({ nudged: true }).eq('id', d.poll.id));
  return { sent, failed };
}

// 截止投票 → 產生建議排程 → 私訊開團人
export async function closePoll(client, pollId) {
  const rows = await q(sb.from('polls').update({ status: 'closed' }).eq('id', pollId).eq('status', 'open').select());
  if (!rows.length) return false;
  const d = await loadPoll(pollId);
  await q(sb.from('plan_picks').delete().eq('poll_id', pollId));
  const picks = suggest(d);
  if (picks.length) await q(sb.from('plan_picks').insert(picks));
  const d2 = await loadPoll(pollId);
  await refreshPollMessage(client, d2);
  await sendPlan(client, d2);
  return true;
}

export async function sendPlan(client, d) {
  const sent = await dm(client, d.poll.created_by, planPanel(d));
  if (!sent) {
    const ch = await client.channels.fetch(d.poll.channel_id).catch(() => null);
    await ch?.send({
      content: `<@${d.poll.created_by}> 投票截止了，但我沒辦法私訊你。請在伺服器的「隱私設定」打開「允許來自伺服器成員的私人訊息」，或直接用 \`/開團 排程\` 叫出排程清單。`,
      allowedMentions: { users: [d.poll.created_by] },
    });
  }
  return !!sent;
}

// 依排程清單建立場次
export async function createEventsFromPlan(client, d) {
  const settings = await getSettings(d.poll.guild_id);
  const created = [];
  const picks = [...d.picks].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  for (const p of picks) {
    const game = d.games.find((g) => g.id === p.game_id);
    if (!game) continue;
    const st = status(d, game, p.slot_id);
    const yes = st.yes;
    let note = null;
    if (game.mode === 'all' && st.missing.length) note = `缺 ${st.missing.map((u) => `<@${u}>`).join('、')}，照開`;
    else if (st.s === 'no') note = '人數未達條件，照開';
    const ev = await q(sb.from('events').insert({
      guild_id: d.poll.guild_id, channel_id: settings.channel_id || d.poll.channel_id, poll_id: d.poll.id,
      game_id: game.id, starts_at: p.starts_at, players: yes.slice(0, game.cap), bench: yes.slice(game.cap),
      note, created_by: d.poll.created_by,
    }).select().single());
    await postEvent(client, ev, game, settings, `${ev.players.map((u) => `<@${u}>`).join(' ')} 新場次成團！投「可以」的人已經自動加入，不用再按參加。`, ev.players);
    created.push(ev);
  }
  await q(sb.from('polls').update({ status: 'done' }).eq('id', d.poll.id));
  await refreshOverview(client, d.poll.guild_id);
  return created;
}

export async function postEvent(client, ev, game, settings, content, mentionIds) {
  const ch = await client.channels.fetch(ev.channel_id).catch(() => null);
  if (!ch) throw new Error('找不到開團頻道，請用 /設定 重新指定');
  checkPerms(ch);
  const msg = await ch.send({ content, ...eventMessage(ev, game, settings), allowedMentions: { users: mentionIds } });
  let threadId = null;
  try {
    const th = await msg.startThread({ name: `${game.name} | ${full(ev.starts_at)}`.slice(0, 100), autoArchiveDuration: 10080 });
    threadId = th.id;
  } catch (e) { console.warn('建立討論串失敗', e.message); }
  await q(sb.from('events').update({ message_id: msg.id, thread_id: threadId }).eq('id', ev.id));
  return msg;
}

// 檢查機器人在頻道裡有沒有需要的權限，缺的話丟出看得懂的錯誤
const NEED = [
  ['ViewChannel', '查看頻道'], ['SendMessages', '發送訊息'], ['EmbedLinks', '嵌入連結'], ['AttachFiles', '附加檔案'],
  ['ReadMessageHistory', '讀取訊息歷史'], ['CreatePublicThreads', '建立公開討論串'], ['SendMessagesInThreads', '在討論串中發送訊息'],
];
export function checkPerms(ch) {
  const me = ch.guild?.members.me;
  const perms = me && ch.permissionsFor(me);
  if (!perms) return;
  const miss = NEED.filter(([k]) => !perms.has(PermissionFlagsBits[k])).map(([, n]) => n);
  if (miss.length) throw new Error(`機器人在 <#${ch.id}> 少了這些權限：${miss.join('、')}。\n請到頻道設定 → 權限 → 加入「開團排程機器人」→ 把這幾項打勾（綠色）。`);
}

export async function refreshEventMessage(client, ev) {
  const game = await getGame(ev.game_id);
  const settings = await getSettings(ev.guild_id);
  const msg = await fetchMessage(client, ev.channel_id, ev.message_id);
  if (msg && game) await msg.edit(eventMessage(ev, game, settings)).catch((e) => console.error('更新場次卡失敗', e.message));
}

export async function postInThread(client, ev, payload) {
  const target = ev.thread_id ? await client.channels.fetch(ev.thread_id).catch(() => null) : null;
  if (target) {
    if (target.archived) await target.setArchived(false).catch(() => {});
    return target.send(payload).catch(() => null);
  }
  const ch = await client.channels.fetch(ev.channel_id).catch(() => null);
  return ch?.send(payload).catch(() => null);
}

// 場次總覽：同一則訊息一直更新
export async function refreshOverview(client, guildId) {
  const settings = await getSettings(guildId);
  if (!settings.channel_id) return;
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const events = await q(sb.from('events').select('*').eq('guild_id', guildId).eq('status', 'active').gte('starts_at', since).order('starts_at').limit(25));
  const games = await getGames(guildId);
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const payload = overviewMessage(events, byId);
  const msg = await fetchMessage(client, settings.channel_id, settings.overview_message_id);
  if (msg) { await msg.edit(payload).catch(() => {}); return; }
  const ch = await client.channels.fetch(settings.channel_id).catch(() => null);
  if (!ch) return;
  const m = await ch.send(payload).catch(() => null);
  if (m) {
    await m.pin().catch(() => {});
    await q(sb.from('settings').update({ overview_message_id: m.id }).eq('guild_id', guildId));
  }
}

// 固定團身分組：有在任何一款遊戲團員名單裡的人就給（不會自動拿掉）
export async function syncRole(client, guildId) {
  const settings = await getSettings(guildId);
  if (!settings.member_role_id) return '';
  const guild = client.guilds.cache.get(guildId);
  const role = guild?.roles.cache.get(settings.member_role_id);
  if (!role) return '（找不到固定團身分組）';
  const games = await getGames(guildId);
  const rows = games.length ? await q(sb.from('game_members').select('user_id').in('game_id', games.map((g) => g.id))) : [];
  const want = new Set(rows.map((r) => r.user_id));
  await guild.members.fetch().catch(() => {});
  let fail = 0;
  for (const id of want) {
    const m = guild.members.cache.get(id);
    if (m && !m.roles.cache.has(role.id)) await m.roles.add(role).catch(() => fail++);
  }
  // 安全起見：只會「給」身分組，絕不自動拿掉別人的身分組
  return fail ? `（有 ${fail} 人的身分組改不了，請確認機器人的身分組排在「${role.name}」上面）` : '';
}

export { loadPoll, yesOn, dayLabel };
