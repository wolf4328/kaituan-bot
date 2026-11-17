import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
} from 'discord.js';
import { sb, q, getSettings, setSettings, getGames, getGame, latestPoll, getEvent } from './db.js';
import {
  dm, nudge, closePoll, sendPlan, createEventsFromPlan, postEvent, refreshEventMessage, refreshPollMessage,
  refreshOverview, postInThread, syncRole, fetchMessage,
} from './actions.js';
import { loadPoll, status, defaultPickTime, gameLabel, yesOn } from './logic.js';
import { votePanel, planPanel, eventMessage, pollMessage, msgLink, SKY } from './render.js';
import {
  tp, mk, ymd, fromYmd, dayLabel, hm, full, ts, addDays, todayStart, parseHM, parseMD, withTime, pad, WD,
} from './time.js';
import { renderMonth, monthKey } from './calendar.js';

const E = MessageFlags.Ephemeral;
const drafts = new Map(); // 發起投票的暫存設定，key = userId

// ─── 權限 ───
function isAdminMember(member, perms, settings) {
  if (perms?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roles = member?.roles?.cache ?? (Array.isArray(member?.roles) ? new Map(member.roles.map((r) => [r, true])) : null);
  return !!(settings.admin_role_id && roles?.has(settings.admin_role_id));
}
async function requireAdmin(i) {
  const settings = await getSettings(i.guildId);
  if (isAdminMember(i.member, i.memberPermissions, settings)) return settings;
  await i.reply({ content: '🔒 這個指令只有管理員能用。', flags: E });
  return null;
}
async function canManagePoll(i, poll) {
  if (i.user.id === poll.created_by) return true;
  const guild = i.client.guilds.cache.get(poll.guild_id);
  const member = await guild?.members.fetch(i.user.id).catch(() => null);
  if (!member) return false;
  return isAdminMember(member, member.permissions, await getSettings(poll.guild_id));
}
const nameOf = (guild, id) => guild?.members.cache.get(id)?.displayName ?? '（已離開）';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 遊戲選項：從選單選的是 id；自己打字的話就用名稱或簡稱找
async function pickGame(i) {
  const v = (i.options.getString('遊戲') || '').trim();
  if (UUID.test(v)) { const g = await getGame(v); if (g && g.guild_id === i.guildId) return g; }
  const games = await getGames(i.guildId);
  const norm = (x) => (x || '').toLowerCase().replace(/[\s\-_]+/g, '');
  const k = norm(v);
  if (!k) return null;
  return games.find((g) => norm(g.name) === k || norm(g.short) === k)
    || games.find((g) => norm(g.name).includes(k) || norm(g.short).includes(k)) || null;
}
const NO_GAME = '找不到這款遊戲。請從選單裡點選，或先用 `/遊戲 新增` 加入。可以用 `/遊戲 列表` 看有哪些遊戲。';
async function pickEvent(i) {
  const v = (i.options.getString('場次') || '').trim();
  if (!UUID.test(v)) return null;
  const ev = await getEvent(v);
  return ev && ev.guild_id === i.guildId ? ev : null;
}

// ─── 入口 ───
export async function onInteraction(i) {
  try {
    if (i.isAutocomplete()) return await autocomplete(i);
    if (i.isChatInputCommand()) return await command(i);
    if (i.isModalSubmit()) return await modal(i);
    if (i.isMessageComponent()) return await component(i);
  } catch (e) {
    console.error(e);
    if (i.isAutocomplete()) return;
    const content = `⚠️ 出錯了：${e.message}`;
    if (i.deferred || i.replied) await i.followUp({ content, flags: E }).catch(() => {});
    else await i.reply({ content, flags: E }).catch(() => {});
  }
}

// ─── 自動完成 ───
async function autocomplete(i) {
  const f = i.options.getFocused(true);
  const kw = String(f.value || '').toLowerCase();
  if (f.name === '遊戲') {
    const games = await getGames(i.guildId);
    return i.respond(games.filter((g) => !kw || g.name.toLowerCase().includes(kw) || (g.short || '').toLowerCase().includes(kw))
      .slice(0, 25).map((g) => ({ name: g.name.slice(0, 100), value: g.id })));
  }
  if (f.name === '場次') {
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const evs = await q(sb.from('events').select('*').eq('guild_id', i.guildId).eq('status', 'active').gte('starts_at', since).order('starts_at').limit(50));
    const games = Object.fromEntries((await getGames(i.guildId)).map((g) => [g.id, g]));
    return i.respond(evs.map((e) => ({ name: `${full(e.starts_at)} ${games[e.game_id]?.name ?? ''}`.slice(0, 100), value: e.id }))
      .filter((o) => !kw || o.name.toLowerCase().includes(kw)).slice(0, 25));
  }
  return i.respond([]);
}

// ─── 斜線指令 ───
async function command(i) {
  const name = i.commandName;
  const sub = i.options.getSubcommand(false);
  if (name === '我的場次') return myEvents(i);
  if (name === '月曆') return calendarCmd(i);
  if (name === '遊戲' && sub === '列表') return listGames(i);

  const settings = await requireAdmin(i);
  if (!settings) return;
  if (name === '設定') return settingsCmd(i, sub, settings);
  if (name === '遊戲') return gameCmd(i, sub);
  if (name === '團員') return rosterCmd(i, sub);
  if (name === '開團') return pollCmd(i, sub, settings);
  if (name === '場次') return eventCmd(i, sub, settings);
}

// ── /設定 ──
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
async function settingsCmd(i, sub, settings) {
  if (sub === '頻道') {
    const ch = i.options.getChannel('頻道');
    await setSettings(i.guildId, { channel_id: ch.id, overview_message_id: null });
    await i.reply({ content: `✅ 之後的時間表和場次卡都會發在 ${ch}。我也會在那裡貼一則「場次總覽」，建議把它釘選起來。`, flags: E });
    return refreshOverview(i.client, i.guildId);
  }
  if (sub === '管理員') {
    const r = i.options.getRole('身分組');
    await setSettings(i.guildId, { admin_role_id: r.id });
    return i.reply({ content: `✅ ${r} 的成員現在可以用管理指令了。`, flags: E });
  }
  if (sub === '預設時間') {
    const lines = WD_ORDER.map((w) => `週${WD[w]} ${settings.default_times[String(w)] || '21:00'}`).join('\n');
    return i.showModal(new ModalBuilder().setCustomId('settime').setTitle('每天的預設開打時間').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('只改後面的時間就好').setStyle(TextInputStyle.Paragraph).setValue(lines)),
    ));
  }
  if (sub === '提醒') {
    const patch = {};
    const a = i.options.getInteger('開打前分鐘'); const b = i.options.getInteger('截止前催填小時');
    if (a != null) patch.remind_minutes = a;
    if (b != null) patch.nudge_hours = b;
    const s = Object.keys(patch).length ? await setSettings(i.guildId, patch) : settings;
    return i.reply({ content: `✅ 開打前 **${s.remind_minutes} 分鐘**提醒；投票截止前 **${s.nudge_hours} 小時**私訊沒填的人${s.nudge_hours ? '' : '（已關閉自動催填）'}。`, flags: E });
  }
  if (sub === '固定團身分組') {
    const r = i.options.getRole('身分組');
    await setSettings(i.guildId, { member_role_id: r?.id ?? null });
    if (!r) return i.reply({ content: '✅ 已關閉身分組自動同步。', flags: E });
    await i.deferReply({ flags: E });
    const warn = await syncRole(i.client, i.guildId);
    return i.editReply(`✅ 之後團員名單變動時，會自動給／拿掉 ${r}。已經先同步一次。${warn}`);
  }
  if (sub === '查看') {
    const s = settings;
    const e = new EmbedBuilder().setColor(SKY).setTitle('⚙️ 目前設定').addFields(
      { name: '開團頻道', value: s.channel_id ? `<#${s.channel_id}>` : '（未設定，請用 /設定 頻道）' },
      { name: '管理員身分組', value: s.admin_role_id ? `<@&${s.admin_role_id}>` : '只有伺服器管理員', inline: true },
      { name: '固定團身分組', value: s.member_role_id ? `<@&${s.member_role_id}>` : '不同步', inline: true },
      { name: '提醒', value: `開打前 ${s.remind_minutes} 分鐘；截止前 ${s.nudge_hours} 小時催填` },
      { name: '預設時間', value: WD_ORDER.map((w) => `週${WD[w]} ${s.default_times[String(w)] || '21:00'}`).join('　') },
    );
    return i.reply({ embeds: [e], flags: E });
  }
}

// ── /遊戲 ──
function gamePatch(i) {
  const p = {};
  const map = { 名稱: 'name', 模式: 'mode', 簡稱: 'short', 介紹: 'description', 圖片網址: 'image_url' };
  for (const [k, v] of Object.entries(map)) { const x = i.options.getString(k); if (x != null) p[v] = x.trim(); }
  const ints = { 門檻: 'min_players', 人數上限: 'cap', 每週場數: 'weekly_target' };
  for (const [k, v] of Object.entries(ints)) { const x = i.options.getInteger(k); if (x != null) p[v] = x; }
  if (p.image_url && !/^https?:\/\//.test(p.image_url)) throw new Error('圖片網址要用 http 或 https 開頭');
  return p;
}
const gameSummary = (g, n) => `**${g.name}**${g.short ? `（${g.short}）` : ''}\n${g.mode === 'all' ? '全員到齊才開' : `${g.min_players} 人以上就開`}・上限 ${g.cap} 人・每週建議 ${g.weekly_target} 場${n != null ? `・團員 ${n} 人` : ''}`;

async function gameCmd(i, sub) {
  if (sub === '新增') {
    const p = gamePatch(i);
    const g = await q(sb.from('games').insert({ guild_id: i.guildId, ...p }).select().single());
    return i.reply({ content: `✅ 已新增\n${gameSummary(g)}\n\n下一步：用 \`/團員 匯入\` 或 \`/團員 管理\` 設定這款遊戲的團員。`, flags: E });
  }
  if (sub === '編輯') {
    const target = await pickGame(i);
    if (!target) return i.reply({ content: NO_GAME, flags: E });
    const p = gamePatch(i);
    if (!Object.keys(p).length) return i.reply({ content: '沒有要改的項目。', flags: E });
    const g = await q(sb.from('games').update(p).eq('id', target.id).select().single());
    return i.reply({ content: `✅ 已更新\n${gameSummary(g)}`, flags: E });
  }
  if (sub === '刪除') {
    const g = await pickGame(i);
    if (!g) return i.reply({ content: NO_GAME, flags: E });
    return i.reply({
      content: `確定要刪除 **${g.name}** 嗎？它的團員名單和所有場次都會一起刪掉，不能復原。`, flags: E,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gdel:${g.id}`).setLabel('確定刪除').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('gdel:no').setLabel('取消').setStyle(ButtonStyle.Secondary),
      )],
    });
  }
}
async function listGames(i) {
  const games = await getGames(i.guildId);
  if (!games.length) return i.reply({ content: '還沒有任何遊戲，管理員可以用 `/遊戲 新增` 加入。', flags: E });
  const mem = await q(sb.from('game_members').select('*').in('game_id', games.map((g) => g.id)));
  const lines = games.map((g) => {
    const ms = mem.filter((m) => m.game_id === g.id);
    const req = ms.filter((m) => m.required).map((m) => `<@${m.user_id}>`);
    return `${gameSummary(g, ms.length)}${req.length ? `\n必到：${req.join('、')}` : ''}`;
  });
  return i.reply({ embeds: [new EmbedBuilder().setColor(SKY).setTitle('🎮 遊戲列表').setDescription(lines.join('\n\n'))], flags: E });
}

// ── /團員 ──
async function rosterCmd(i, sub) {
  const g = await pickGame(i);
  if (!g) return i.reply({ content: NO_GAME, flags: E });
  const cur = await q(sb.from('game_members').select('*').eq('game_id', g.id));
  if (sub === '匯入') {
    const role = i.options.getRole('身分組');
    await i.deferReply({ flags: E });
    await i.guild.members.fetch();
    const ids = [...i.guild.roles.cache.get(role.id).members.values()].filter((m) => !m.user.bot).map((m) => m.id);
    const add = ids.filter((id) => !cur.some((c) => c.user_id === id));
    if (add.length) await q(sb.from('game_members').insert(add.map((user_id) => ({ game_id: g.id, user_id }))));
    const warn = await syncRole(i.client, i.guildId);
    return i.editReply(`✅ 從 ${role} 匯入 ${add.length} 人到 **${g.name}**，現在共 ${cur.length + add.length} 人。${warn}\n要調整用 \`/團員 管理\`，設定房主用 \`/團員 必到\`。`);
  }
  if (sub === '管理') {
    const menu = new UserSelectMenuBuilder().setCustomId(`roster:${g.id}`).setPlaceholder('勾選這款遊戲的團員').setMinValues(0).setMaxValues(25);
    if (cur.length) menu.setDefaultUsers(cur.slice(0, 25).map((c) => c.user_id));
    return i.reply({ content: `**${g.name}** 的團員（目前 ${cur.length} 人）。勾選完選單會自動儲存。`, components: [new ActionRowBuilder().addComponents(menu)], flags: E });
  }
  if (sub === '必到') {
    if (!cur.length) return i.reply({ content: '這款遊戲還沒有團員，先用 `/團員 管理` 設定。', flags: E });
    const menu = new UserSelectMenuBuilder().setCustomId(`req:${g.id}`).setPlaceholder('勾選必到成員').setMinValues(0).setMaxValues(Math.min(25, cur.length));
    const req = cur.filter((c) => c.required).map((c) => c.user_id);
    if (req.length) menu.setDefaultUsers(req);
    return i.reply({ content: `**${g.name}** 的必到成員：這些人不能來的日子，這款遊戲就不會排。`, components: [new ActionRowBuilder().addComponents(menu)], flags: E });
  }
}

// ── /開團 ──
async function pollCmd(i, sub, settings) {
  if (sub === '發起') {
    if (!settings.channel_id) return i.reply({ content: '請先用 `/設定 頻道` 指定開團頻道。', flags: E });
    const games = await getGames(i.guildId);
    if (!games.length) return i.reply({ content: '還沒有遊戲，先用 `/遊戲 新增`。', flags: E });
    const draft = { guildId: i.guildId, games: games.length === 1 ? [games[0].id] : [], dates: [], times: {}, dl: 'first-1' };
    drafts.set(i.user.id, draft);
    return i.reply({ ...draftView(draft, games, settings), flags: E });
  }
  if (sub === '催填') {
    const poll = await latestPoll(i.guildId, ['open']);
    if (!poll) return i.reply({ content: '目前沒有進行中的投票。', flags: E });
    await i.deferReply({ flags: E });
    const { sent, failed } = await nudge(i.client, await loadPoll(poll.id));
    if (!sent.length && !failed.length) return i.editReply('所有人都填完了 👍');
    return i.editReply(`✅ 已私訊提醒 ${sent.length} 人：${sent.map((u) => `<@${u}>`).join('、') || '—'}${failed.length ? `\n⚠️ 這些人關閉了私訊，私訊不到：${failed.map((u) => `<@${u}>`).join('、')}` : ''}`);
  }
  if (sub === '截止') {
    const poll = await latestPoll(i.guildId, ['open']);
    if (!poll) return i.reply({ content: '目前沒有進行中的投票。', flags: E });
    await i.deferReply({ flags: E });
    await closePoll(i.client, poll.id);
    return i.editReply(`✅ 投票已截止，排程清單已私訊給 <@${poll.created_by}>。也可以用 \`/開團 排程\` 在這裡叫出來。`);
  }
  if (sub === '排程') {
    const poll = await latestPoll(i.guildId, ['open', 'closed']);
    if (!poll) return i.reply({ content: '目前沒有等待排程的投票。', flags: E });
    if (poll.status === 'open') return i.reply({ content: '投票還沒截止，要提前結束請用 `/開團 截止`。', flags: E });
    return i.reply({ ...planPanel(await loadPoll(poll.id)), flags: E });
  }
  if (sub === '作廢') {
    const poll = await latestPoll(i.guildId, ['open', 'closed']);
    if (!poll) return i.reply({ content: '目前沒有可以作廢的投票。', flags: E });
    await q(sb.from('polls').update({ status: 'cancelled' }).eq('id', poll.id));
    await refreshPollMessage(i.client, await loadPoll(poll.id));
    return i.reply({ content: '✅ 已作廢這次投票。', flags: E });
  }
}

function draftView(draft, games, settings, note = '') {
  const start = todayStart();
  const dayOpts = [];
  for (let k = 0; k < 25; k++) {
    const d = addDays(start, k), key = ymd(d), w = tp(d).wd;
    dayOpts.push({ label: `${dayLabel(d)}${k === 0 ? ' 今天' : ''}`, value: key, description: `預設 ${draft.times[key] || settings.default_times[String(w)] || '21:00'}`, default: draft.dates.includes(key) });
  }
  const dlOpts = [
    ['first-1', '第一場的前一天 23:59（建議）'], ['today', '今天 23:59'], ['tomorrow', '明天 23:59'], ['h3', '第一場開始前 3 小時'],
  ].map(([value, label]) => ({ label, value, default: draft.dl === value }));
  const sorted = [...draft.dates].sort();
  const slotLines = sorted.map((k) => `・${dayLabel(fromYmd(k))} ${timeOf(draft, k, settings)}`);
  const embed = new EmbedBuilder().setColor(SKY).setTitle('🗓️ 發起開團投票').setDescription([
    `**遊戲：**${draft.games.length ? draft.games.map((id) => games.find((g) => g.id === id)?.name).join('、') : '（還沒選）'}`,
    `**日期：**${sorted.length ? `${sorted.length} 天` : '（還沒選）'}`,
    slotLines.join('\n'),
    '',
    '時間要改的話按「調整時間」。都選好就按「送出投票」。',
    note,
  ].filter((x) => x !== '').join('\n'));
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:games').setPlaceholder('選擇遊戲（可複選）')
        .setMinValues(1).setMaxValues(Math.min(25, games.length))
        .addOptions(games.slice(0, 25).map((g) => ({ label: g.name.slice(0, 100), value: g.id, description: gameLabel(g).slice(0, 100), default: draft.games.includes(g.id) })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:dates').setPlaceholder('選擇要問的日期（可複選，可以跨週）')
        .setMinValues(1).setMaxValues(25).addOptions(dayOpts)),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:dl').setPlaceholder('投票截止時間').addOptions(dlOpts)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('draft:time').setLabel('調整時間').setEmoji('🕘').setStyle(ButtonStyle.Secondary).setDisabled(!draft.dates.length),
        new ButtonBuilder().setCustomId('draft:send').setLabel('送出投票').setStyle(ButtonStyle.Success).setDisabled(!draft.dates.length || !draft.games.length),
        new ButtonBuilder().setCustomId('draft:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
const timeOf = (draft, k, settings) => draft.times[k] || settings.default_times[String(tp(fromYmd(k)).wd)] || '21:00';

async function sendDraft(i, draft, settings) {
  const games = (await getGames(draft.guildId)).filter((g) => draft.games.includes(g.id));
  const mem = await q(sb.from('game_members').select('user_id').in('game_id', games.map((g) => g.id)));
  const members = [...new Set(mem.map((m) => m.user_id))];
  if (!members.length) return i.update({ ...draftView(draft, await getGames(draft.guildId), settings, '⚠️ 選的遊戲還沒有團員，先用 `/團員 匯入` 或 `/團員 管理`。') });
  const slots = [...draft.dates].sort().map((k) => withTime(fromYmd(k), parseHM(timeOf(draft, k, settings))));
  const now = Date.now();
  if (slots.some((s) => s.getTime() <= now)) return i.update({ ...draftView(draft, await getGames(draft.guildId), settings, '⚠️ 有日期的開打時間已經過了，請取消勾選或調整時間。') });
  const first = slots[0];
  let deadline;
  const t0 = todayStart();
  if (draft.dl === 'today') deadline = mk(tp(t0).y, tp(t0).m, tp(t0).d, 23, 59);
  else if (draft.dl === 'tomorrow') { const t = addDays(t0, 1); deadline = mk(tp(t).y, tp(t).m, tp(t).d, 23, 59); }
  else if (draft.dl === 'h3') deadline = new Date(first.getTime() - 3 * 3600 * 1000);
  else { const t = addDays(first, -1); deadline = mk(tp(t).y, tp(t).m, tp(t).d, 23, 59); }
  if (deadline >= first) deadline = new Date(first.getTime() - 3600 * 1000);
  if (deadline.getTime() <= now + 5 * 60000) deadline = new Date(first.getTime() - 30 * 60000);
  if (deadline.getTime() <= now + 60000) return i.update({ ...draftView(draft, await getGames(draft.guildId), settings, '⚠️ 第一場太近了，來不及投票。請改用 `/場次 直接開`。') });

  await i.deferUpdate();
  const poll = await q(sb.from('polls').insert({
    guild_id: draft.guildId, channel_id: settings.channel_id, game_ids: draft.games, member_ids: members,
    deadline: deadline.toISOString(), created_by: i.user.id,
  }).select().single());
  await q(sb.from('poll_slots').insert(slots.map((s) => ({ poll_id: poll.id, starts_at: s.toISOString() }))));
  const d = await loadPoll(poll.id);
  const ch = await i.client.channels.fetch(settings.channel_id);
  const msg = await ch.send({
    content: `${members.map((u) => `<@${u}>`).join(' ')}\n下面哪幾天可以玩？按「填寫我的時間」勾一勾就好 🙏`,
    ...pollMessage(d), allowedMentions: { users: members },
  });
  let threadId = null;
  try {
    const th = await msg.startThread({ name: `開團時間討論｜${dayLabel(slots[0])}${slots.length > 1 ? `～${dayLabel(slots[slots.length - 1])}` : ''}`.slice(0, 100), autoArchiveDuration: 10080 });
    threadId = th.id;
  } catch (e) { console.warn('建立討論串失敗', e.message); }
  await q(sb.from('polls').update({ message_id: msg.id, thread_id: threadId }).eq('id', poll.id));
  drafts.delete(i.user.id);
  return i.editReply({ content: `✅ 已發出時間表：${msgLink(draft.guildId, settings.channel_id, msg.id)}\n截止時間 ${ts(deadline, 'f')}。截止後我會私訊排程清單給你。`, embeds: [], components: [] });
}

// ── /場次 ──
async function eventCmd(i, sub, settings) {
  if (sub === '直接開') {
    if (!settings.channel_id) return i.reply({ content: '請先用 `/設定 頻道` 指定開團頻道。', flags: E });
    const g = await pickGame(i);
    if (!g) return i.reply({ content: NO_GAME, flags: E });
    const date = parseMD(i.options.getString('日期')); const t = parseHM(i.options.getString('時間'));
    if (!date || !t) return i.reply({ content: '日期或時間格式不對，例如日期 `11/22`、時間 `21:00`。', flags: E });
    const when = withTime(date, t);
    if (when.getTime() < Date.now()) return i.reply({ content: '這個時間已經過了。', flags: E });
    await i.deferReply({ flags: E });
    const ev = await q(sb.from('events').insert({ guild_id: i.guildId, channel_id: settings.channel_id, game_id: g.id, starts_at: when.toISOString(), created_by: i.user.id }).select().single());
    const mem = (await q(sb.from('game_members').select('user_id').eq('game_id', g.id))).map((m) => m.user_id);
    await postEvent(i.client, ev, g, settings, `${mem.map((u) => `<@${u}>`).join(' ')} 新場次！要來的按「參加」。`, mem);
    await refreshOverview(i.client, i.guildId);
    return i.editReply(`✅ 已開 **${g.name}** ${full(when)}`);
  }
  const ev = await pickEvent(i);
  if (!ev) return i.reply({ content: '找不到這個場次，請從選單裡點選。', flags: E });
  const g = await getGame(ev.game_id);
  if (sub === '改時間') {
    const t = parseHM(i.options.getString('時間'));
    const ds = i.options.getString('日期');
    const date = ds ? parseMD(ds) : new Date(ev.starts_at);
    if (!t || !date) return i.reply({ content: '日期或時間格式不對，例如日期 `11/22`、時間 `21:30`。', flags: E });
    const when = withTime(date, t);
    await i.deferReply({ flags: E });
    const upd = await q(sb.from('events').update({ starts_at: when.toISOString(), reminded: false }).eq('id', ev.id).select().single());
    await refreshEventMessage(i.client, upd);
    if (upd.thread_id) { const th = await i.client.channels.fetch(upd.thread_id).catch(() => null); await th?.setName(`${g.name} | ${full(when)}`.slice(0, 100)).catch(() => {}); }
    await postInThread(i.client, upd, { content: `🕘 ${upd.players.map((u) => `<@${u}>`).join(' ')}\n**${g.name}** 改時間了：${full(ev.starts_at)} → **${full(when)}**`, allowedMentions: { users: upd.players } });
    await refreshOverview(i.client, i.guildId);
    return i.editReply(`✅ 已改成 ${full(when)}，並通知了參加的人。`);
  }
  if (sub === '取消') {
    await i.deferReply({ flags: E });
    const upd = await q(sb.from('events').update({ status: 'cancelled' }).eq('id', ev.id).select().single());
    await refreshEventMessage(i.client, upd);
    await postInThread(i.client, upd, { content: `❌ ${upd.players.map((u) => `<@${u}>`).join(' ')}\n**${g.name}** ${full(ev.starts_at)} 這場取消了。`, allowedMentions: { users: upd.players } });
    await refreshOverview(i.client, i.guildId);
    return i.editReply('✅ 已取消，並通知了參加的人。');
  }
}

// ── /我的場次 ──
async function myEvents(i) {
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const evs = await q(sb.from('events').select('*').eq('guild_id', i.guildId).eq('status', 'active').gte('starts_at', since).order('starts_at'));
  const games = Object.fromEntries((await getGames(i.guildId)).map((g) => [g.id, g]));
  const me = i.user.id;
  const lines = evs.filter((e) => e.players.includes(me) || e.bench.includes(me)).map((e) =>
    `**${full(e.starts_at)}**　${games[e.game_id]?.name ?? ''}${e.bench.includes(me) ? '　（候補）' : ''}　${ts(e.starts_at, 'R')}${e.message_id ? `　[查看](${msgLink(e.guild_id, e.channel_id, e.message_id)})` : ''}`);
  return i.reply({ embeds: [new EmbedBuilder().setColor(SKY).setTitle('🎮 我的場次').setDescription(lines.join('\n') || '接下來沒有你參加的場次。')], flags: E });
}

// ── /月曆 ──
async function calendarCmd(i) {
  const now = tp(new Date());
  let m = i.options.getInteger('月份') ?? now.m, y = now.y;
  if (i.options.getInteger('月份') && m < now.m - 2) y += 1;
  await i.deferReply({ flags: E });
  return i.editReply(await calendarPayload(i.guildId, y, m));
}
async function calendarPayload(guildId, y, m, selDay = null) {
  const startM = mk(y, m, 1), endM = m === 12 ? mk(y + 1, 1, 1) : mk(y, m + 1, 1);
  const games = await getGames(guildId);
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const evs = (await q(sb.from('events').select('*').eq('guild_id', guildId).eq('status', 'active')
    .gte('starts_at', startM.toISOString()).lt('starts_at', endM.toISOString()).order('starts_at'))).filter((e) => byId[e.game_id]);
  const openPolls = await q(sb.from('polls').select('id').eq('guild_id', guildId).eq('status', 'open'));
  const pollingDays = new Set();
  if (openPolls.length) {
    const slots = await q(sb.from('poll_slots').select('starts_at').in('poll_id', openPolls.map((p) => p.id)).gte('starts_at', startM.toISOString()).lt('starts_at', endM.toISOString()));
    slots.forEach((s) => pollingDays.add(tp(s.starts_at).d));
  }
  const png = await renderMonth(y, m, evs.map((e) => ({ starts_at: e.starts_at, game: byId[e.game_id] })), pollingDays, games);
  const file = new AttachmentBuilder(png, { name: `calendar-${monthKey(y, m)}.png` });
  const prev = m === 1 ? monthKey(y - 1, 12) : monthKey(y, m - 1);
  const next = m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
  const days = [...new Set(evs.map((e) => tp(e.starts_at).d))];
  const comps = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cal:go:${prev}`).setLabel('上個月').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cal:go:now').setLabel('本月').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cal:go:${next}`).setLabel('下個月').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
  )];
  if (days.length) {
    comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`cal:day:${monthKey(y, m)}`).setPlaceholder('📋 查看某天的參加名單…')
      .addOptions(days.slice(0, 25).map((d) => {
        const n = evs.filter((e) => tp(e.starts_at).d === d).length;
        return { label: `${dayLabel(mk(y, m, d))}　${n} 場`, value: String(d), default: d === selDay };
      }))));
  }
  const embeds = [];
  if (selDay) {
    const list = evs.filter((e) => tp(e.starts_at).d === selDay);
    embeds.push(new EmbedBuilder().setColor(SKY).setTitle(dayLabel(mk(y, m, selDay))).setDescription(list.map((e) =>
      `**${hm(e.starts_at)}　${byId[e.game_id].name}**　${e.players.length} 人\n${e.players.map((u) => `<@${u}>`).join('、') || '—'}${e.bench.length ? `\n候補：${e.bench.map((u) => `<@${u}>`).join('、')}` : ''}${e.note ? `\n⚠️ ${e.note}` : ''}`).join('\n\n')));
  }
  return { files: [file], attachments: [], embeds, components: comps };
}

// ─── 表單送出 ───
async function modal(i) {
  const id = i.customId;
  if (id === 'settime') {
    const settings = await getSettings(i.guildId);
    const times = { ...settings.default_times };
    for (const line of i.fields.getTextInputValue('t').split('\n')) {
      const w = WD.indexOf((/週(.)/.exec(line) || [])[1]);
      const t = parseHM(line.replace(/週./, ''));
      if (w >= 0 && t) times[String(w)] = `${pad(t[0])}:${pad(t[1])}`;
    }
    await setSettings(i.guildId, { default_times: times });
    return i.reply({ content: `✅ 已更新：${WD_ORDER.map((w) => `週${WD[w]} ${times[String(w)]}`).join('　')}`, flags: E });
  }
  if (id === 'drafttime') {
    const draft = drafts.get(i.user.id);
    if (!draft) return i.reply({ content: '這個設定已經過期了，請重新 `/開團 發起`。', flags: E });
    const settings = await getSettings(draft.guildId);
    for (const line of i.fields.getTextInputValue('t').split('\n')) {
      const d = parseMD(line); const t = parseHM(line.replace(/^\s*[\d/-]+/, ''));
      if (d && t && draft.dates.includes(ymd(d))) draft.times[ymd(d)] = `${pad(t[0])}:${pad(t[1])}`;
    }
    return i.update(draftView(draft, await getGames(draft.guildId), settings));
  }
  if (id.startsWith('plantime:')) {
    const pollId = id.split(':')[1];
    const d = await loadPoll(pollId);
    if (!d || !(await canManagePoll(i, d.poll))) return i.reply({ content: '你沒有權限調整這份排程。', flags: E });
    const picks = sortedPicks(d);
    const lines = i.fields.getTextInputValue('t').split('\n').filter((l) => l.trim());
    for (let k = 0; k < picks.length && k < lines.length; k++) {
      const t = parseHM((lines[k].match(/(\d{1,2}\s*[:：]\s*\d{2})\s*$/) || [])[1]);
      if (!t) continue;
      const when = withTime(new Date(picks[k].starts_at), t);
      await q(sb.from('plan_picks').update({ starts_at: when.toISOString() }).eq('poll_id', pollId).eq('slot_id', picks[k].slot_id).eq('game_id', picks[k].game_id));
    }
    return i.update(planPanel(await loadPoll(pollId), '🕘 時間已更新'));
  }
}
const sortedPicks = (d) => [...d.picks].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

// ─── 按鈕與選單 ───
async function component(i) {
  const [kind, act, arg, extra] = i.customId.split(':');

  // 開團 發起 的暫存設定
  if (kind === 'draft') {
    const draft = drafts.get(i.user.id);
    if (!draft) return i.update({ content: '這個設定已經過期了，請重新 `/開團 發起`。', embeds: [], components: [] });
    const settings = await getSettings(draft.guildId);
    const games = await getGames(draft.guildId);
    if (act === 'games') draft.games = i.values;
    if (act === 'dates') draft.dates = i.values;
    if (act === 'dl') draft.dl = i.values[0];
    if (act === 'cancel') { drafts.delete(i.user.id); return i.update({ content: '已取消。', embeds: [], components: [] }); }
    if (act === 'time') {
      const lines = [...draft.dates].sort().map((k) => { const p = tp(fromYmd(k)); return `${p.m}/${p.d}（${WD[p.wd]}） ${timeOf(draft, k, settings)}`; }).join('\n');
      return i.showModal(new ModalBuilder().setCustomId('drafttime').setTitle('調整每天的開打時間').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('只改後面的時間，例如 22:00').setStyle(TextInputStyle.Paragraph).setValue(lines)),
      ));
    }
    if (act === 'send') return sendDraft(i, draft, settings);
    return i.update(draftView(draft, games, settings));
  }

  // 投票
  if (kind === 'vote') {
    const d = await loadPoll(arg);
    if (!d) return i.reply({ content: '找不到這次投票。', flags: E });
    if (d.poll.status !== 'open') return act === 'open' ? i.reply({ content: '🔒 投票已經截止了。', flags: E }) : i.update({ content: '🔒 投票已經截止了。', embeds: [], components: [] });
    if (!d.poll.member_ids.includes(i.user.id)) return i.reply({ content: '你不在這次的團員名單裡，有需要請找開團人。', flags: E });
    if (act === 'open') return i.reply({ ...votePanel(d, i.user.id), flags: E });
    const yes = act === 'pick' ? new Set(i.values) : new Set();
    await q(sb.from('votes').upsert(d.slots.map((s) => ({ slot_id: s.id, user_id: i.user.id, value: yes.has(s.id) ? 'y' : 'n' }))));
    const d2 = await loadPoll(arg);
    await i.update(votePanel(d2, i.user.id, true));
    return refreshPollMessage(i.client, d2);
  }

  // 排程清單
  if (kind === 'plan') {
    const d = await loadPoll(arg);
    if (!d) return i.reply({ content: '找不到這份排程。', flags: E });
    if (!(await canManagePoll(i, d.poll))) return i.reply({ content: '只有開團人或管理員能調整排程。', flags: E });
    if (d.poll.status === 'done') return i.update(planPanel(d));
    if (act === 'refresh') return i.update(planPanel(d));
    if (act === 'pick') {
      const want = new Set(i.values);
      const keep = d.picks.filter((p) => want.has(`${p.slot_id}|${p.game_id}`));
      for (const p of d.picks) if (!want.has(`${p.slot_id}|${p.game_id}`)) {
        await q(sb.from('plan_picks').delete().eq('poll_id', arg).eq('slot_id', p.slot_id).eq('game_id', p.game_id));
      }
      for (const v of want) {
        const [slot_id, game_id] = v.split('|');
        if (keep.some((p) => p.slot_id === slot_id && p.game_id === game_id)) continue;
        const starts_at = defaultPickTime(d, slot_id, keep);
        const row = { poll_id: arg, slot_id, game_id, starts_at };
        await q(sb.from('plan_picks').insert(row));
        keep.push(row);
      }
      return i.update(planPanel(await loadPoll(arg)));
    }
    if (act === 'ask') {
      const [slotId, gameId] = i.values[0].split('|');
      const g = d.games.find((x) => x.id === gameId), slot = d.slots.find((s) => s.id === slotId);
      const st = status(d, g, slotId);
      const link = msgLink(d.poll.guild_id, d.poll.channel_id, d.poll.message_id);
      const asked = [], failed = [];
      for (const u of st.missing) {
        const ask = await q(sb.from('asks').insert({ poll_id: arg, slot_id: slotId, game_id: gameId, user_id: u }).select().single());
        const ok = await dm(i.client, u, {
          content: `${dayLabel(slot.starts_at)} ${hm(slot.starts_at)} 的 **${g.name}** 差你就全員到齊了～那天有辦法調整嗎？\n沒辦法也完全沒關係，按一下就好 🙏`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ask:y:${ask.id}`).setLabel('可以，我來').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`ask:n:${ask.id}`).setLabel('真的不行').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel('↗ 看時間表'),
          )],
        });
        (ok ? asked : failed).push(u);
      }
      const note = `💬 已私訊追問 ${asked.map((u) => `<@${u}>`).join('、') || '—'}（${dayLabel(slot.starts_at)} ${g.name}），有回覆會通知你。${failed.length ? `\n⚠️ 私訊不到：${failed.map((u) => `<@${u}>`).join('、')}` : ''}`;
      return i.update(planPanel(d, note));
    }
    if (act === 'time') {
      const picks = sortedPicks(d);
      const lines = picks.map((p) => `${dayLabel(p.starts_at)} ${d.games.find((g) => g.id === p.game_id)?.name} ${hm(p.starts_at)}`).join('\n');
      return i.showModal(new ModalBuilder().setCustomId(`plantime:${arg}`).setTitle('調整開打時間').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('只改每行最後的時間，不要刪行').setStyle(TextInputStyle.Paragraph).setValue(lines.slice(0, 4000))),
      ));
    }
    if (act === 'ok') {
      await i.deferUpdate();
      const created = await createEventsFromPlan(i.client, d);
      const d2 = await loadPoll(arg);
      return i.editReply(planPanel(d2, `✅ 已發布 ${created.length} 場，場次卡已貼到 <#${d.poll.channel_id}>。`));
    }
  }

  // 追問的回覆
  if (kind === 'ask') {
    const ask = await q(sb.from('asks').select('*').eq('id', arg).maybeSingle());
    if (!ask || ask.user_id !== i.user.id) return i.reply({ content: '這個問題不是問你的喔。', flags: E });
    if (ask.answer) return i.update({ components: [] });
    await q(sb.from('asks').update({ answer: act }).eq('id', ask.id));
    if (act === 'y') await q(sb.from('votes').upsert({ slot_id: ask.slot_id, user_id: ask.user_id, value: 'y' }));
    await i.update({ content: `${i.message.content}\n\n${act === 'y' ? '✅ 你回覆了：可以，謝謝！' : '👌 你回覆了：不行，沒關係！'}`, components: [] });
    const d = await loadPoll(ask.poll_id);
    const g = d.games.find((x) => x.id === ask.game_id), slot = d.slots.find((s) => s.id === ask.slot_id);
    const st = status(d, g, ask.slot_id);
    await dm(i.client, d.poll.created_by, {
      content: `💬 <@${ask.user_id}> 回覆 ${dayLabel(slot.starts_at)} **${g.name}**：${act === 'y' ? '**可以**' : '真的不行'}${st.s === 'ok' ? '\n🎉 這天已經全員到齊了！到排程清單按「重新整理」就會看到。' : ''}`,
    });
    if (d.poll.status === 'open') await refreshPollMessage(i.client, d);
    return;
  }

  // 場次卡的參加／取消
  if (kind === 'ev') {
    const ev = await getEvent(arg);
    if (!ev || ev.status !== 'active') return i.reply({ content: '這個場次已經取消了。', flags: E });
    const g = await getGame(ev.game_id);
    const settings = await getSettings(ev.guild_id);
    const me = i.user.id;
    if (act === 'join') {
      if (ev.players.includes(me) || ev.bench.includes(me)) return i.reply({ content: '你已經在名單裡了 👍', flags: E });
      const toBench = ev.players.length >= g.cap;
      const upd = await q(sb.from('events').update(toBench ? { bench: [...ev.bench, me] } : { players: [...ev.players, me] }).eq('id', ev.id).select().single());
      await i.update(eventMessage(upd, g, settings));
      if (toBench) await i.followUp({ content: '人數已滿，你先排進候補，有人取消會自動遞補並私訊你。', flags: E });
      return refreshOverview(i.client, ev.guild_id);
    }
    if (act === 'leave') {
      const wasPlayer = ev.players.includes(me);
      if (!wasPlayer && !ev.bench.includes(me)) return i.reply({ content: '你不在這場的名單裡。', flags: E });
      let players = ev.players.filter((u) => u !== me), bench = ev.bench.filter((u) => u !== me);
      let promoted = null;
      if (wasPlayer && bench.length) { promoted = bench.shift(); players.push(promoted); }
      const upd = await q(sb.from('events').update({ players, bench }).eq('id', ev.id).select().single());
      await i.update(eventMessage(upd, g, settings));
      if (promoted) await dm(i.client, promoted, { content: `有人取消了，你已經從候補遞補進 **${g.name}** ${full(ev.starts_at)} 🎉` });
      if (wasPlayer && g.mode === 'all' && ev.created_by !== me) {
        await dm(i.client, ev.created_by, { content: `⚠️ <@${me}> 取消了 **${g.name}** ${full(ev.starts_at)}，全員制遊戲現在人不齊了（${players.length} 人）。` });
      }
      return refreshOverview(i.client, ev.guild_id);
    }
  }

  // 團員名單
  if (kind === 'roster' || kind === 'req') {
    const settings = await getSettings(i.guildId);
    if (!isAdminMember(i.member, i.memberPermissions, settings)) return i.reply({ content: '🔒 只有管理員能改團員。', flags: E });
    const g = await getGame(act);
    const cur = await q(sb.from('game_members').select('*').eq('game_id', act));
    if (kind === 'roster') {
      const want = new Set(i.values);
      const remove = cur.filter((c) => !want.has(c.user_id)).map((c) => c.user_id);
      const add = [...want].filter((u) => !cur.some((c) => c.user_id === u));
      if (remove.length) await q(sb.from('game_members').delete().eq('game_id', act).in('user_id', remove));
      if (add.length) await q(sb.from('game_members').insert(add.map((user_id) => ({ game_id: act, user_id }))));
      await i.update({ content: `✅ **${g.name}** 團員已儲存，共 ${want.size} 人。（加入 ${add.length}、移除 ${remove.length}）` });
      const warn = await syncRole(i.client, i.guildId);
      if (warn) await i.followUp({ content: warn, flags: E });
      return;
    }
    const want = new Set(i.values);
    const notMember = [...want].filter((u) => !cur.some((c) => c.user_id === u));
    await q(sb.from('game_members').update({ required: false }).eq('game_id', act));
    const reqIds = [...want].filter((u) => !notMember.includes(u));
    if (reqIds.length) await q(sb.from('game_members').update({ required: true }).eq('game_id', act).in('user_id', reqIds));
    return i.update({ content: `✅ **${g.name}** 必到成員：${reqIds.map((u) => `<@${u}>`).join('、') || '無'}${notMember.length ? `\n⚠️ ${notMember.map((u) => `<@${u}>`).join('、')} 不是團員，已略過。` : ''}` });
  }

  // 刪除遊戲
  if (kind === 'gdel') {
    if (act === 'no') return i.update({ content: '已取消。', components: [] });
    const settings = await getSettings(i.guildId);
    if (!isAdminMember(i.member, i.memberPermissions, settings)) return i.reply({ content: '🔒 只有管理員能刪除。', flags: E });
    const g = await getGame(act);
    await q(sb.from('games').delete().eq('id', act));
    await i.update({ content: `🗑️ 已刪除 **${g?.name ?? '遊戲'}**。`, components: [] });
    await syncRole(i.client, i.guildId);
    return refreshOverview(i.client, i.guildId);
  }

  // 月曆
  if (kind === 'cal') {
    await i.deferUpdate();
    if (act === 'go') {
      let y, m;
      if (arg === 'now') { const p = tp(new Date()); y = p.y; m = p.m; } else [y, m] = arg.split('-').map(Number);
      return i.editReply(await calendarPayload(i.guildId, y, m));
    }
    if (act === 'day') {
      const [y, m] = arg.split('-').map(Number);
      return i.editReply(await calendarPayload(i.guildId, y, m, Number(i.values[0])));
    }
  }
}
