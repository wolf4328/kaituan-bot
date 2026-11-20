import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} from 'discord.js';
import { sb, q, getSettings, setSettings, getGames, getGame, latestPoll, getEvent } from './db.js';
import {
  dm, nudge, closePoll, sendPlan, createEventsFromPlan, postEvent, refreshEventMessage, refreshPollMessage,
  refreshOverview, postInThread, syncRole, fetchMessage, checkPerms,
} from './actions.js';
import { loadPoll, status, defaultPickTime, gameLabel, yesOn, pending } from './logic.js';
import { votePanel, planPanel, eventMessage, pollMessage, whoPanel, msgLink, SKY } from './render.js';
import {
  tp, mk, ymd, fromYmd, dayLabel, hm, full, ts, addDays, todayStart, parseHM, parseMD, withTime, pad, WD,
} from './time.js';
import { renderMonth, monthKey } from './calendar.js';
import { resolveCover, steamAppId } from './cover.js';

const E = MessageFlags.Ephemeral;
const drafts = new Map(); // 發起投票的暫存設定，key = userId
const outsiders = new Map(); // 不在名單裡的人按了幾次「填寫我的時間」

// ─── 權限 ───
function isAdminMember(member, perms, settings) {
  if (perms?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roles = member?.roles?.cache ?? (Array.isArray(member?.roles) ? new Map(member.roles.map((r) => [r, true])) : null);
  return !!(settings.admin_role_id && roles?.has(settings.admin_role_id));
}
// 能不能開團：管理員一定可以；「開團權限」設成所有人 → 大家都可以；設成某個身分組 → 有那個身分組的人可以
function isOrganizer(member, perms, settings) {
  if (isAdminMember(member, perms, settings)) return true;
  const r = settings.organizer_role_id;
  if (!r) return false;
  if (r === 'everyone') return true;
  const roles = member?.roles?.cache ?? (Array.isArray(member?.roles) ? new Map(member.roles.map((x) => [x, true])) : null);
  return !!roles?.has(r);
}
async function requireOrganizer(i) {
  const settings = await getSettings(i.guildId);
  if (isOrganizer(i.member, i.memberPermissions, settings)) return settings;
  await i.reply({ content: '🔒 你目前沒有開團權限，請找管理員開通。', flags: E });
  return null;
}
const isAdminI = async (i) => isAdminMember(i.member, i.memberPermissions, await getSettings(i.guildId));
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
    const opts = games.filter((g) => !kw || g.name.toLowerCase().includes(kw) || (g.short || '').toLowerCase().includes(kw))
      .slice(0, 24).map((g) => ({ name: g.name.slice(0, 100), value: g.id }));
    const typed = String(f.value || '').trim();
    const exact = games.some((g) => g.name.toLowerCase() === kw || (g.short || '').toLowerCase() === kw);
    if (i.commandName === '開團' && typed && !exact) opts.push({ name: `＋ 新遊戲：${typed}`.slice(0, 100), value: typed.slice(0, 100) });
    return i.respond(opts.slice(0, 25));
  }
  if (f.name === '投票') {
    const sub = i.options.getSubcommand(false);
    const st = sub === '修改' || sub === '催填' ? ['open'] : ['open', 'closed'];
    return i.respond((await pollChoices(i.guildId, st, (await isAdminI(i)) ? null : i.user.id)).filter((o) => !kw || o.name.toLowerCase().includes(kw)).slice(0, 25));
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

  if (name === '開團' || name === '場次') {
    const settings = await requireOrganizer(i);
    if (!settings) return;
    return name === '開團' ? pollCmd(i, sub, settings) : eventCmd(i, sub, settings);
  }
  const settings = await requireAdmin(i);
  if (!settings) return;
  if (name === '設定') return i.reply({ ...settingsPanel(settings), flags: E });
  if (name === '遊戲') return gameCmd(i, sub);
}

// ── /設定 ──
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
function settingsView(s) {
  return new EmbedBuilder().setColor(SKY).setTitle('⚙️ 開團排程機器人設定').addFields(
    { name: '📍 開團頻道', value: s.channel_id ? `<#${s.channel_id}>` : '⚠️ 還沒設定' },
    { name: '🛡️ 管理員身分組', value: s.admin_role_id ? `<@&${s.admin_role_id}>` : '只有伺服器管理員', inline: true },
    { name: '🔔 提醒', value: `開打前 ${s.remind_minutes} 分鐘\n截止前 ${s.nudge_hours ? `${s.nudge_hours} 小時催填` : '不自動催填'}`, inline: true },
    { name: '🕘 預設開打時間', value: WD_ORDER.map((w) => `週${WD[w]} ${s.default_times[String(w)] || '21:00'}`).join('　') },
    { name: '🎮 誰可以開團', value: s.organizer_role_id === 'everyone' ? '所有人' : s.organizer_role_id ? `<@&${s.organizer_role_id}> 和管理員` : '只有管理員' },
    { name: '🏷️ 固定團身分組（進階）', value: s.member_role_id ? `<@&${s.member_role_id}>` : '不使用' },
  );
}
function settingsPanel(s, note = '') {
  return {
    content: note, embeds: [settingsView(s)],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('set:menu').setPlaceholder('選擇要設定的項目…').addOptions(
      { label: '開團頻道', value: 'channel', emoji: '📍', description: '時間表和場次卡要發在哪個頻道' },
      { label: '誰可以開團', value: 'organizer', emoji: '🎮', description: '讓一般成員也能發起投票、開場次（不能改設定）' },
      { label: '管理員身分組', value: 'admin', emoji: '🛡️', description: '這個身分組可以改設定、管理所有人的開團' },
      { label: '預設開打時間', value: 'time', emoji: '🕘', description: '週一到週日各自的預設時間' },
      { label: '提醒時間', value: 'remind', emoji: '🔔', description: '開打前幾分鐘提醒、截止前幾小時催填' },
      { label: '遊戲列表', value: 'games', emoji: '🎮', description: '看所有遊戲、團員和規則' },
      { label: '固定團身分組（進階）', value: 'role', emoji: '🏷️', description: '把團員自動加上某個身分組，通常不需要' },
    ))],
  };
}
const backRow = () => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('set:back').setLabel('返回設定').setStyle(ButtonStyle.Secondary));

async function settingsComponent(i, act) {
  const s = await getSettings(i.guildId);
  if (!isAdminMember(i.member, i.memberPermissions, s)) return i.reply({ content: '🔒 只有管理員能改設定。', flags: E });
  if (act === 'back') return i.update(settingsPanel(s));
  if (act === 'menu') {
    const v = i.values[0];
    if (v === 'channel') return i.update({ content: '選擇開團頻道：', embeds: [], components: [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('set:channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('選擇頻道')), backRow()] });
    if (v === 'organizer') return i.update({ content: '**誰可以開團**\n開團的人可以發起投票、直接開場次，並管理**自己開的**投票和場次。不能改設定，也不能動別人的團。', embeds: [], components: [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('set:organizer').setPlaceholder('選一個身分組（例如 @固定團）')),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set:orgall').setLabel('所有人都可以開團').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set:orgoff').setLabel('只有管理員').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set:back').setLabel('返回設定').setStyle(ButtonStyle.Secondary))] });
    if (v === 'admin') return i.update({ content: '選擇管理員身分組（這個身分組的人可以改設定、管理所有人的開團）：', embeds: [], components: [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('set:admin').setPlaceholder('選擇身分組')), backRow()] });
    if (v === 'role') return i.update({ content: '**固定團身分組（進階）**\n被加進任何遊戲團員名單的人，會自動拿到這個身分組。只會加，不會拿掉任何人的身分組。\n機器人的身分組要排在它上面才改得動。', embeds: [], components: [
      new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('set:role').setPlaceholder('選擇身分組')),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('set:roleoff').setLabel('不使用這個功能').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('set:back').setLabel('返回設定').setStyle(ButtonStyle.Secondary))] });
    if (v === 'time') {
      const lines = WD_ORDER.map((w) => `週${WD[w]} ${s.default_times[String(w)] || '21:00'}`).join('\n');
      return i.showModal(new ModalBuilder().setCustomId('settime').setTitle('每天的預設開打時間').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('只改後面的時間就好').setStyle(TextInputStyle.Paragraph).setValue(lines)),
      ));
    }
    if (v === 'remind') {
      return i.showModal(new ModalBuilder().setCustomId('setremind').setTitle('提醒時間').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a').setLabel('開打前幾分鐘提醒（5～240）').setStyle(TextInputStyle.Short).setValue(String(s.remind_minutes))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('b').setLabel('截止前幾小時私訊沒填的人（0 = 不催）').setStyle(TextInputStyle.Short).setValue(String(s.nudge_hours))),
      ));
    }
    if (v === 'games') return i.update({ content: '', embeds: [await gamesEmbed(i.guildId)], components: [backRow()] });
  }
  if (act === 'channel') {
    const id = i.values[0];
    const ns = await setSettings(i.guildId, { channel_id: id, overview_message_id: null });
    await i.update(settingsPanel(ns, `✅ 開團頻道改成 <#${id}>。我會在那裡貼一則「📅 場次總覽」，記得把它釘選。`));
    return refreshOverview(i.client, i.guildId);
  }
  if (act === 'organizer' || act === 'orgall' || act === 'orgoff') {
    const val = act === 'organizer' ? i.values[0] : act === 'orgall' ? 'everyone' : null;
    try {
      const ns = await setSettings(i.guildId, { organizer_role_id: val });
      return i.update(settingsPanel(ns, `✅ ${val === 'everyone' ? '所有人都可以開團了。' : val ? `<@&${val}> 的成員可以開團了。` : '現在只有管理員可以開團。'}`));
    } catch (e) {
      return i.update({ content: '⚠️ 資料庫還沒有這個欄位。請到 Supabase → SQL Editor 執行這行，再回來設定一次：\n```sql\nalter table settings add column if not exists organizer_role_id text;\n```', embeds: [], components: [backRow()] });
    }
  }
  if (act === 'admin') return i.update(settingsPanel(await setSettings(i.guildId, { admin_role_id: i.values[0] }), `✅ <@&${i.values[0]}> 現在可以開團和改設定了。`));
  if (act === 'roleoff') return i.update(settingsPanel(await setSettings(i.guildId, { member_role_id: null }), '✅ 已關閉固定團身分組。'));
  if (act === 'role') {
    const ns = await setSettings(i.guildId, { member_role_id: i.values[0] });
    await i.update(settingsPanel(ns, '⏳ 正在幫團員加上身分組…'));
    const warn = await syncRole(i.client, i.guildId);
    return i.editReply(settingsPanel(ns, `✅ 團員會自動拿到 <@&${i.values[0]}>（不會拿掉任何人的）。${warn}`));
  }
}

// ── /遊戲 ──
function gamePatch(i) {
  const p = {};
  const map = { 名稱: 'name', 模式: 'mode', 簡稱: 'short', 介紹: 'description', 圖片網址: 'image_url' };
  for (const [k, v] of Object.entries(map)) { const x = i.options.getString(k); if (x != null) p[v] = x.trim(); }
  const ints = { 門檻: 'min_players', 人數上限: 'cap', 每週場數: 'weekly_target' };
  for (const [k, v] of Object.entries(ints)) { const x = i.options.getInteger(k); if (x != null) p[v] = x; }
  if (p.image_url) {
    const appid = steamAppId(p.image_url);
    if (appid) p.image_url = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
    else if (!/^https?:\/\//.test(p.image_url)) throw new Error('圖片網址要用 http 或 https 開頭');
  }
  return p;
}
const gameSummary = (g, n) => `**${g.name}**${g.short ? `（${g.short}）` : ''}\n${g.mode === 'all' ? '全員到齊才開' : `${g.min_players} 人以上就開`}・上限 ${g.cap} 人・每週建議 ${g.weekly_target} 場${n != null ? `・團員 ${n} 人` : ''}`;

async function gameCmd(i, sub) {
  if (sub === '新增') {
    const p = gamePatch(i);
    await i.deferReply({ flags: E });
    const g = await q(sb.from('games').insert({ guild_id: i.guildId, ...p }).select().single());
    if (!g.image_url) {
      try { g.image_url = await resolveCover(g); await q(sb.from('games').update({ image_url: g.image_url }).eq('id', g.id)); } catch (e) { console.warn('封面處理失敗', e.message); }
    }
    return i.editReply({ content: `✅ 已新增\n${gameSummary(g)}\n\n直接用 \`/開團 發起\` 就能勾團員、開投票。` });
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
async function gamesEmbed(guildId) {
  const games = await getGames(guildId);
  if (!games.length) return new EmbedBuilder().setColor(SKY).setTitle('🎮 遊戲列表').setDescription('還沒有遊戲。用 `/開團 發起` 打新遊戲名稱就會自動建立。');
  const mem = await q(sb.from('game_members').select('*').in('game_id', games.map((g) => g.id)));
  const lines = games.map((g) => {
    const ms = mem.filter((m) => m.game_id === g.id);
    const req = ms.filter((m) => m.required).map((m) => `<@${m.user_id}>`);
    return `${gameSummary(g, ms.length)}${req.length ? `\n必到：${req.join('、')}` : ''}`;
  });
  return new EmbedBuilder().setColor(SKY).setTitle('🎮 遊戲列表').setDescription(lines.join('\n\n').slice(0, 4000)).setFooter({ text: '改規則或封面：/遊戲 編輯　刪除：/遊戲 刪除' });
}

// ── /開團 ──
async function pollCmd(i, sub, settings) {
  if (sub === '發起') {
    if (!settings.channel_id) return i.reply({ content: '請先用 `/設定 頻道` 指定開團頻道。', flags: E });
    await i.deferReply({ flags: E });
    const game = await pickOrCreateGame(i);
    const coverIn = i.options.getString('封面');
    if (coverIn || !game.image_url) {
      try {
        game.image_url = await resolveCover(game, coverIn);
        await q(sb.from('games').update({ image_url: game.image_url }).eq('id', game.id));
      } catch (e) { console.warn('封面處理失敗', e.message); }
    }
    const roster = await q(sb.from('game_members').select('*').eq('game_id', game.id));
    const draft = {
      guildId: i.guildId, gameId: game.id,
      members: roster.map((r) => r.user_id), required: roster.filter((r) => r.required).map((r) => r.user_id),
      rule: game.mode === 'all' ? 'all' : String(game.min_players), dates: [], times: {}, dl: 'first-1',
    };
    draft.panel = i;
    drafts.set(i.user.id, draft);
    return i.editReply(draftView(draft, game, settings));
  }
  if (sub === '修改') {
    const poll = await pickPoll(i, ['open']);
    if (!poll) return;
    const d = await loadPoll(poll.id);
    const game = d.games[0];
    if (!game) return i.reply({ content: '找不到這次投票的遊戲。', flags: E });
    const draft = {
      edit: true, pollId: poll.id, guildId: i.guildId, gameId: game.id, oldDeadline: poll.deadline,
      members: [...poll.member_ids], required: (d.roster[game.id]?.required || []).filter((u) => poll.member_ids.includes(u)),
      rule: game.mode === 'all' ? 'all' : String(game.min_players),
      dates: d.slots.map((s) => ymd(s.starts_at)), times: Object.fromEntries(d.slots.map((s) => [ymd(s.starts_at), hm(s.starts_at)])), dl: 'keep',
    };
    await i.reply({ ...draftView(draft, game, settings, '-# 已經填的日期，大家的回覆會保留。拿掉的日期，回覆會一起刪除。'), flags: E });
    draft.panel = i;
    drafts.set(i.user.id, draft);
    return;
  }
  if (sub === '催填') {
    const poll = await pickPoll(i, ['open']);
    if (!poll) return;
    await i.deferReply({ flags: E });
    const { sent, failed } = await nudge(i.client, await loadPoll(poll.id));
    if (!sent.length && !failed.length) return i.editReply('所有人都填完了 👍');
    return i.editReply(`✅ 已私訊提醒 ${sent.length} 人：${sent.map((u) => `<@${u}>`).join('、') || '—'}${failed.length ? `\n⚠️ 這些人關閉了私訊，私訊不到：${failed.map((u) => `<@${u}>`).join('、')}` : ''}`);
  }
  if (sub === '排程') {
    const poll = await pickPoll(i, ['open', 'closed']);
    if (!poll) return;
    if (poll.status === 'open') {
      const p = pending(await loadPoll(poll.id));
      return i.reply({
        content: `投票還沒截止。要現在截止並叫出排程清單嗎？${p.length ? `\n還有 ${p.length} 人沒填完：${p.map((u) => `<@${u}>`).join('、')}（沒填的日子會當作不能來）` : '\n全員都填完了 👍'}`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`vote:closeplan:${poll.id}`).setLabel('確定截止').setStyle(ButtonStyle.Danger),
        )], flags: E,
      });
    }
    return i.reply({ ...planPanel(await loadPoll(poll.id)), flags: E });
  }
  if (sub === '作廢') {
    const poll = await pickPoll(i, ['open', 'closed']);
    if (!poll) return;
    await q(sb.from('polls').update({ status: 'cancelled' }).eq('id', poll.id));
    await refreshPollMessage(i.client, await loadPoll(poll.id));
    return i.reply({ content: `✅ 已作廢這次投票：${msgLink(poll.guild_id, poll.channel_id, poll.message_id)}\n時間表會變灰色鎖定，要刪掉那則訊息的話可以手動刪。`, flags: E });
  }
}

async function pollChoices(guildId, statuses, onlyUser = null) {
  let qy = sb.from('polls').select('*').eq('guild_id', guildId).in('status', statuses);
  if (onlyUser) qy = qy.eq('created_by', onlyUser);
  const polls = await q(qy.order('created_at', { ascending: false }).limit(25));
  if (!polls.length) return [];
  const games = Object.fromEntries((await getGames(guildId)).map((g) => [g.id, g]));
  const slots = await q(sb.from('poll_slots').select('poll_id,starts_at').in('poll_id', polls.map((p) => p.id)).order('starts_at'));
  return polls.map((p) => {
    const ss = slots.filter((x) => x.poll_id === p.id);
    const range = ss.length ? `${dayLabel(ss[0].starts_at)}${ss.length > 1 ? `～${dayLabel(ss[ss.length - 1].starts_at)}` : ''}` : '';
    const name = p.game_ids.map((id) => games[id]?.name || '?').join('／');
    return { name: `${p.status === 'open' ? '🟢 投票中' : '📋 待排程'}｜${name}｜${range}`.slice(0, 100), value: p.id };
  });
}
// 取得指令要操作的投票：有選就用選的；沒選而且只有一個就用那個；有好幾個就請他選
async function pickPoll(i, statuses) {
  const v = i.options.getString('投票');
  if (v && UUID.test(v)) {
    const p = await q(sb.from('polls').select('*').eq('id', v).maybeSingle());
    if (p && p.guild_id === i.guildId && statuses.includes(p.status)) {
      if (p.created_by === i.user.id || await isAdminI(i)) return p;
      await i.reply({ content: '🔒 這不是你開的投票，只有開團人和管理員能操作。', flags: E }); return null;
    }
    await i.reply({ content: '找不到這個投票，或它已經截止／作廢了。', flags: E }); return null;
  }
  const admin = await isAdminI(i);
  const polls = (await q(sb.from('polls').select('*').eq('guild_id', i.guildId).in('status', statuses).order('created_at', { ascending: false })))
    .filter((p) => admin || p.created_by === i.user.id);
  if (polls.length === 1) return polls[0];
  if (!polls.length) { await i.reply({ content: '目前沒有符合的投票。', flags: E }); return null; }
  await i.reply({ content: `目前有 ${polls.length} 個投票，請在指令的「投票」欄位選一個。`, flags: E });
  return null;
}

// ── /場次 直接開 的面板 ──
const quick = new Map();
function quickView(qd, game, note = '') {
  const sel = new UserSelectMenuBuilder().setCustomId('quick:members').setPlaceholder('👥 勾選要 @ 的人').setMinValues(0).setMaxValues(25);
  if (qd.players.length) sel.setDefaultUsers(qd.players.slice(0, 25));
  const embed = new EmbedBuilder().setColor(SKY).setTitle(`⚡ 直接開團｜${game.name}`).setDescription([
    `📅 **時間**　${full(qd.when)}`,
    `👥 **要 @ 的人 ${qd.players.length} 人**　${qd.players.map((u) => `<@${u}>`).join(' ') || '（不 @ 任何人）'}`,
    `✅ **自動加入參加**　${qd.autoJoin ? '是，勾選的人直接列入「已參加」，不用自己按' : '否，只 @ 通知，要來的人自己按「參加」'}`,
    '', '-# 預設帶入這款遊戲的團員。可以用「從身分組加人」一次加一整個身分組。', note,
  ].filter((x) => x !== '').join('\n'));
  if (game.image_url) embed.setThumbnail(game.image_url);
  return {
    content: '', embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(sel),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('quick:role').setLabel('從身分組加人').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('quick:auto').setLabel(qd.autoJoin ? '改成：只 @ 不自動加入' : '改成：自動加入參加').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('quick:ok').setLabel('確認開團').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('quick:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
async function quickComponent(i, act) {
  const qd = quick.get(i.user.id);
  if (!qd) return i.update({ content: '這個設定已經過期了，請重新 `/場次 直接開`。', embeds: [], components: [] });
  const game = await getGame(qd.gameId);
  const settings = await getSettings(qd.guildId);
  if (act === 'cancel') { quick.delete(i.user.id); return i.update({ content: '已取消。', embeds: [], components: [] }); }
  if (act === 'members') qd.players = i.values;
  if (act === 'auto') qd.autoJoin = !qd.autoJoin;
  if (act === 'role') {
    return i.reply({ content: '選一個身分組，裡面的人會**加進**名單（原本勾的人會保留）。', flags: E,
      components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('quick:rolesel').setPlaceholder('選擇身分組'))] });
  }
  if (act === 'rolesel') {
    const guild = i.client.guilds.cache.get(qd.guildId);
    await guild.members.fetch().catch(() => {});
    const ids = [...(guild.roles.cache.get(i.values[0])?.members.values() || [])].filter((m) => !m.user.bot).map((m) => m.id);
    const before = qd.players.length;
    qd.players = [...new Set([...qd.players, ...ids])].slice(0, 25);
    await i.update({ content: `✅ 從 <@&${i.values[0]}> 加入 ${qd.players.length - before} 人，上面的面板已經更新。${ids.length + before > 25 ? '\n⚠️ 最多 25 人，超過的沒有加入。' : ''}`, components: [] });
    return qd.panel?.editReply(quickView(qd, game)).catch(() => {});
  }
  if (act === 'ok') {
    if (new Date(qd.when).getTime() < Date.now()) return i.update(quickView(qd, game, '⚠️ 這個時間已經過了，請重新 `/場次 直接開`。'));
    const ch = await i.client.channels.fetch(settings.channel_id).catch(() => null);
    if (!ch) return i.update(quickView(qd, game, '⚠️ 找不到開團頻道，請用 `/設定` 重新選擇。'));
    try { checkPerms(ch); } catch (e) { return i.update(quickView(qd, game, `⚠️ ${e.message}`)); }
    await i.deferUpdate();
    const ids = [...new Set(qd.players)];
    const players = qd.autoJoin ? ids.slice(0, game.cap) : [];
    const bench = qd.autoJoin ? ids.slice(game.cap) : [];
    const ev = await q(sb.from('events').insert({ guild_id: qd.guildId, channel_id: settings.channel_id, game_id: game.id, starts_at: qd.when, created_by: i.user.id, players, bench }).select().single());
    const text = ids.length
      ? `${ids.map((u) => `<@${u}>`).join(' ')} ${qd.autoJoin ? '開團囉！已經幫大家報名了，不能來的按「取消」。' : '新場次！要來的按「參加」。'}`
      : '新場次！要來的按「參加」。';
    await postEvent(i.client, ev, game, settings, text, ids);
    await refreshOverview(i.client, qd.guildId);
    quick.delete(i.user.id);
    return i.editReply({ content: `✅ 已開 **${game.name}** ${full(qd.when)}${ids.length ? `，@ 了 ${ids.length} 人` : ''}。`, embeds: [], components: [] });
  }
  qd.panel = i;
  return i.update(quickView(qd, game));
}

async function pickOrCreateGame(i) {
  const v = (i.options.getString('遊戲') || '').trim();
  if (UUID.test(v)) { const g = await getGame(v); if (g && g.guild_id === i.guildId) return g; }
  const norm = (x) => (x || '').toLowerCase().replace(/[\s\-_]+/g, '');
  const games = await getGames(i.guildId);
  const hit = games.find((g) => norm(g.name) === norm(v) || norm(g.short) === norm(v));
  if (hit) return hit;
  if (!v) throw new Error('請輸入遊戲名稱');
  return q(sb.from('games').insert({ guild_id: i.guildId, name: v.slice(0, 60), mode: 'all', min_players: 4, cap: 25, weekly_target: 2 }).select().single());
}

const RULES = [['all', '全員到齊才開']].concat([2, 3, 4, 5, 6, 7, 8, 10].map((n) => [String(n), `${n} 人以上就開`]));
const ruleText = (r) => (RULES.find(([v]) => v === r) || RULES[0])[1];

function draftView(draft, game, settings, note = '') {
  const start = todayStart();
  const dayOpts = [];
  for (let k = 0; k < 25; k++) {
    const d = addDays(start, k), key = ymd(d), w = tp(d).wd;
    dayOpts.push({ label: `${dayLabel(d)}${k === 0 ? ' 今天' : ''}`, value: key, emoji: '📅', description: `預設 ${draft.times[key] || settings.default_times[String(w)] || '21:00'}`, default: draft.dates.includes(key) });
  }
  const dlOpts = [
    ...(draft.edit ? [['keep', `截止：維持原本 ${full(draft.oldDeadline)}`]] : []),
    ['first-1', '截止：第一場的前一天 23:59（建議）'], ['today', '截止：今天 23:59'], ['tomorrow', '截止：明天 23:59'], ['h3', '截止：第一場開始前 3 小時'],
    ['custom', draft.dl === 'custom' && draft.customDeadline ? `截止：自訂 ${full(draft.customDeadline)}` : '截止：自訂日期和時間…'],
  ].map(([value, label]) => ({ label, value, emoji: '⏰', default: draft.dl === value }));
  const sorted = [...draft.dates].sort();
  const embed = new EmbedBuilder().setColor(SKY).setTitle(`${draft.edit ? '✏️ 修改開團' : '🗓️ 發起開團'}｜${game.name}`).setDescription([
    `👥 **團員 ${draft.members.length} 人**　${draft.members.map((u) => `<@${u}>`).join(' ') || '（用第一個選單勾選）'}`,
    `🎯 **成團條件**　${ruleText(draft.rule)}`,
    `⭐ **必到**　${draft.required.map((u) => `<@${u}>`).join(' ') || '無'}`,
    `📅 **日期**　${sorted.length ? '' : '（用第三個選單選）'}`,
    sorted.map((k) => `・${dayLabel(fromYmd(k))} ${timeOf(draft, k, settings)}`).join('\n'),
    '',
    '-# 團員會記住，下次發起同款遊戲自動帶入。時間要改按「調整時間」。',
    note,
  ].filter((x) => x !== '').join('\n'));
  if (game.image_url) embed.setThumbnail(game.image_url);
  const memberSel = new UserSelectMenuBuilder().setCustomId('draft:members').setPlaceholder('👥 勾選團員').setMinValues(1).setMaxValues(25);
  if (draft.members.length) memberSel.setDefaultUsers(draft.members.slice(0, 25));
  return {
    content: '', embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(memberSel),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:rule').setPlaceholder('🎯 成團條件')
        .addOptions(RULES.map(([value, label]) => ({ label: `成團：${label}`, value, emoji: '🎯', default: draft.rule === value })))),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:dates').setPlaceholder('📅 選擇要問的日期（可複選，可以跨週）')
        .setMinValues(1).setMaxValues(25).addOptions(dayOpts)),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('draft:dl').setPlaceholder('⏰ 投票截止時間').addOptions(dlOpts)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('draft:time').setLabel('調整時間').setEmoji('🕘').setStyle(ButtonStyle.Secondary).setDisabled(!draft.dates.length),
        new ButtonBuilder().setCustomId('draft:role').setLabel('從身分組加人').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('draft:req').setLabel('必到成員').setEmoji('⭐').setStyle(ButtonStyle.Secondary).setDisabled(!draft.members.length),
        new ButtonBuilder().setCustomId('draft:send').setLabel(draft.edit ? '儲存修改' : '送出投票').setStyle(ButtonStyle.Success).setDisabled(!draft.dates.length || !draft.members.length),
        new ButtonBuilder().setCustomId('draft:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
const timeOf = (draft, k, settings) => draft.times[k] || settings.default_times[String(tp(fromYmd(k)).wd)] || '21:00';

function calcDeadline(dl, first, custom) {
  const now = Date.now();
  if (dl === 'custom') {
    const c = custom ? new Date(custom) : null;
    return c && c.getTime() > now + 60000 && c < first ? c : null;
  }
  let deadline;
  const t0 = todayStart();
  if (dl === 'today') deadline = mk(tp(t0).y, tp(t0).m, tp(t0).d, 23, 59);
  else if (dl === 'tomorrow') { const t = addDays(t0, 1); deadline = mk(tp(t).y, tp(t).m, tp(t).d, 23, 59); }
  else if (dl === 'h3') deadline = new Date(first.getTime() - 3 * 3600 * 1000);
  else { const t = addDays(first, -1); deadline = mk(tp(t).y, tp(t).m, tp(t).d, 23, 59); }
  if (deadline >= first) deadline = new Date(first.getTime() - 3600 * 1000);
  if (deadline.getTime() <= now + 5 * 60000) deadline = new Date(first.getTime() - 30 * 60000);
  return deadline.getTime() <= now + 60000 ? null : deadline;
}

// ── /開團 修改：儲存 ──
async function saveEdit(i, draft, settings) {
  const game = await getGame(draft.gameId);
  const d = await loadPoll(draft.pollId);
  const redo = (note) => i.update(draftView(draft, game, settings, note));
  if (!d || d.poll.status !== 'open') return i.update({ content: '這次投票已經截止或作廢，不能修改了。', embeds: [], components: [] });
  const members = [...new Set(draft.members)];
  if (!members.length) return redo('⚠️ 請至少勾選一位團員。');
  if (!draft.dates.length) return redo('⚠️ 請至少選一個日期。');
  const want = [...draft.dates].sort().map((k) => ({ k, at: withTime(fromYmd(k), parseHM(timeOf(draft, k, settings))) }));
  const now = Date.now();
  const existing = Object.fromEntries(d.slots.map((s) => [ymd(s.starts_at), s]));
  if (want.some((w) => w.at.getTime() <= now && !(existing[w.k] && new Date(existing[w.k].starts_at).getTime() === w.at.getTime()))) {
    return redo('⚠️ 有日期的開打時間已經過了，請取消勾選或調整時間。');
  }
  let deadline = new Date(d.poll.deadline);
  if (draft.dl !== 'keep') {
    deadline = calcDeadline(draft.dl, want[0].at, draft.customDeadline);
    if (!deadline) return redo('⚠️ 第一場太近了，這個截止選項來不及，請選「維持原本」或其他選項。');
  }
  await i.deferUpdate();
  // 日期：刪掉沒勾的、改時間、新增
  const wantKeys = new Set(want.map((w) => w.k));
  const removed = d.slots.filter((s) => !wantKeys.has(ymd(s.starts_at)));
  if (removed.length) await q(sb.from('poll_slots').delete().in('id', removed.map((s) => s.id)));
  const added = [];
  for (const w of want) {
    const s = existing[w.k];
    if (!s) added.push(w);
    else if (new Date(s.starts_at).getTime() !== w.at.getTime()) await q(sb.from('poll_slots').update({ starts_at: w.at.toISOString() }).eq('id', s.id));
  }
  if (added.length) await q(sb.from('poll_slots').insert(added.map((w) => ({ poll_id: d.poll.id, starts_at: w.at.toISOString() }))));
  // 團員與規則
  const newMembers = members.filter((u) => !d.poll.member_ids.includes(u));
  await q(sb.from('game_members').delete().eq('game_id', game.id));
  await q(sb.from('game_members').insert(members.map((user_id) => ({ game_id: game.id, user_id, required: draft.required.includes(user_id) }))));
  await q(sb.from('games').update(draft.rule === 'all' ? { mode: 'all' } : { mode: 'min', min_players: Number(draft.rule) }).eq('id', game.id));
  const deadlineChanged = deadline.getTime() !== new Date(d.poll.deadline).getTime();
  await q(sb.from('polls').update({ member_ids: members, deadline: deadline.toISOString(), ...(deadlineChanged ? { nudged: false } : {}) }).eq('id', d.poll.id));
  const d2 = await loadPoll(d.poll.id);
  await refreshPollMessage(i.client, d2);
  // 只通知受影響的人
  const link = msgLink(d.poll.guild_id, d.poll.channel_id, d.poll.message_id);
  const lines = [];
  const ping = new Set();
  if (newMembers.length) { lines.push(`${newMembers.map((u) => `<@${u}>`).join(' ')} 你被加進這次開團了，麻煩填一下時間 🙏`); newMembers.forEach((u) => ping.add(u)); }
  if (added.length) {
    const old = members.filter((u) => !newMembers.includes(u));
    lines.push(`${old.map((u) => `<@${u}>`).join(' ')} 新增了 ${added.map((w) => full(w.at)).join('、')}，麻煩補填一下 🙏`);
    old.forEach((u) => ping.add(u));
  }
  const changes = [];
  if (removed.length) changes.push(`拿掉 ${removed.map((s) => dayLabel(s.starts_at)).join('、')}`);
  const retimed = want.filter((w) => existing[w.k] && new Date(existing[w.k].starts_at).getTime() !== w.at.getTime());
  if (retimed.length) changes.push(`${retimed.map((w) => full(w.at)).join('、')} 改了時間`);
  if (deadlineChanged) changes.push(`截止改成 ${ts(deadline, 'f')}`);
  if (changes.length) lines.push(`📝 時間表更新：${changes.join('；')}`);
  if (lines.length) {
    const target = d.poll.thread_id ? await i.client.channels.fetch(d.poll.thread_id).catch(() => null) : null;
    const ch = target || await i.client.channels.fetch(d.poll.channel_id).catch(() => null);
    await ch?.send({ content: `${lines.join('\n')}\n${link}`, allowedMentions: { users: [...ping] } }).catch(() => {});
  }
  drafts.delete(i.user.id);
  return i.editReply({ content: `✅ 已儲存修改：${link}${lines.length ? '\n已在討論串通知受影響的人。' : ''}`, embeds: [], components: [] });
}

async function sendDraft(i, draft, settings) {
  const game = await getGame(draft.gameId);
  if (!game) return i.update({ content: '這款遊戲已經被刪除了，請重新 `/開團 發起`。', embeds: [], components: [] });
  const members = [...new Set(draft.members)];
  const redo = (note) => i.update(draftView(draft, game, settings, note));
  if (!members.length) return redo('⚠️ 請先勾選團員。');
  const slots = [...draft.dates].sort().map((k) => withTime(fromYmd(k), parseHM(timeOf(draft, k, settings))));
  const now = Date.now();
  if (slots.some((s) => s.getTime() <= now)) return redo('⚠️ 有日期的開打時間已經過了，請取消勾選或調整時間。');
  const deadline = calcDeadline(draft.dl, slots[0], draft.customDeadline);
  if (!deadline) return redo(draft.dl === 'custom' ? '⚠️ 自訂的截止時間要在現在之後、第一場開始之前，請重新選。' : '⚠️ 第一場太近了，來不及投票。請改用 `/場次 直接開`。');

  const ch = await i.client.channels.fetch(settings.channel_id).catch(() => null);
  if (!ch) return redo('⚠️ 找不到開團頻道，請用 `/設定` 重新選擇。');
  try { checkPerms(ch); } catch (e) { return redo(`⚠️ ${e.message}`); }
  await i.deferUpdate();
  // 記住這次的團員和規則
  await q(sb.from('game_members').delete().eq('game_id', game.id));
  await q(sb.from('game_members').insert(members.map((user_id) => ({ game_id: game.id, user_id, required: draft.required.includes(user_id) }))));
  await q(sb.from('games').update(draft.rule === 'all' ? { mode: 'all' } : { mode: 'min', min_players: Number(draft.rule) }).eq('id', game.id));
  await syncRole(i.client, draft.guildId);

  const poll = await q(sb.from('polls').insert({
    guild_id: draft.guildId, channel_id: settings.channel_id, game_ids: [game.id], member_ids: members,
    deadline: deadline.toISOString(), created_by: i.user.id,
  }).select().single());
  await q(sb.from('poll_slots').insert(slots.map((s) => ({ poll_id: poll.id, starts_at: s.toISOString() }))));
  const d = await loadPoll(poll.id);
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
    if (!settings.channel_id) return i.reply({ content: '請先用 `/設定` 指定開團頻道。', flags: E });
    const g = await pickGame(i);
    if (!g) return i.reply({ content: NO_GAME, flags: E });
    const date = parseMD(i.options.getString('日期')); const t = parseHM(i.options.getString('時間'));
    if (!date || !t) return i.reply({ content: '日期或時間格式不對，例如日期 `11/22`、時間 `21:00`。', flags: E });
    const when = withTime(date, t);
    if (when.getTime() < Date.now()) return i.reply({ content: '這個時間已經過了。', flags: E });
    const mem = (await q(sb.from('game_members').select('user_id').eq('game_id', g.id))).map((m) => m.user_id);
    const qd = { guildId: i.guildId, gameId: g.id, when: when.toISOString(), players: mem.slice(0, 25), autoJoin: true };
    await i.reply({ ...quickView(qd, g), flags: E });
    qd.panel = i;
    quick.set(i.user.id, qd);
    return;
  }
  const ev = await pickEvent(i);
  if (!ev) return i.reply({ content: '找不到這個場次，請從選單裡點選。', flags: E });
  if (ev.created_by !== i.user.id && !(await isAdminI(i))) return i.reply({ content: '🔒 這不是你開的場次，只有開團人和管理員能修改。', flags: E });
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
  const openPolls = await q(sb.from('polls').select('*').eq('guild_id', guildId).eq('status', 'open'));
  let pollItems = [];
  if (openPolls.length) {
    const slots = await q(sb.from('poll_slots').select('*').in('poll_id', openPolls.map((p) => p.id)).gte('starts_at', startM.toISOString()).lt('starts_at', endM.toISOString()).order('starts_at'));
    const votes = slots.length ? await q(sb.from('votes').select('*').in('slot_id', slots.map((s) => s.id))) : [];
    for (const sl of slots) {
      const p = openPolls.find((x) => x.id === sl.poll_id);
      const g = byId[p?.game_ids?.[0]];
      if (!g) continue;
      const yes = votes.filter((v) => v.slot_id === sl.id && v.value === 'y' && p.member_ids.includes(v.user_id)).length;
      pollItems.push({ starts_at: sl.starts_at, game: g, pollId: p.id, poll: p, yes, total: p.member_ids.length });
    }
  }
  const png = await renderMonth(y, m, evs.map((e) => ({ starts_at: e.starts_at, game: byId[e.game_id] })), pollItems, games);
  const file = new AttachmentBuilder(png, { name: `calendar-${monthKey(y, m)}.png` });
  const prev = m === 1 ? monthKey(y - 1, 12) : monthKey(y, m - 1);
  const next = m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
  const days = [...new Set([...evs, ...pollItems].map((e) => tp(e.starts_at).d))].sort((a, b) => a - b);
  const comps = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cal:go:${prev}`).setLabel('上個月').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cal:go:now').setLabel('本月').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cal:go:${next}`).setLabel('下個月').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
  )];
  if (days.length) {
    comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`cal:day:${monthKey(y, m)}`).setPlaceholder('📋 查看某天的詳細內容…')
      .addOptions(days.slice(0, 25).map((d) => {
        const n = evs.filter((e) => tp(e.starts_at).d === d).length, pn = pollItems.filter((e) => tp(e.starts_at).d === d).length;
        return { label: `${dayLabel(mk(y, m, d))}　${[n ? `成團 ${n}` : '', pn ? `投票中 ${pn}` : ''].filter(Boolean).join('・')}`, value: String(d), default: d === selDay };
      }))));
  }
  const embeds = [];
  if (selDay) {
    const list = evs.filter((e) => tp(e.starts_at).d === selDay).map((e) =>
      `**✅ ${hm(e.starts_at)}　${byId[e.game_id].name}**　${e.players.length} 人・開團 <@${e.created_by}>\n${e.players.map((u) => `<@${u}>`).join('、') || '—'}${e.bench.length ? `\n候補：${e.bench.map((u) => `<@${u}>`).join('、')}` : ''}${e.note ? `\n⚠️ ${e.note}` : ''}`);
    const pl = pollItems.filter((e) => tp(e.starts_at).d === selDay).map((e) =>
      `**🗳️ ${hm(e.starts_at)}　${e.game.name}**（投票中）\n${e.yes}/${e.total} 人可以・開團 <@${e.poll.created_by}>${e.poll.message_id ? `・[看時間表](${msgLink(e.poll.guild_id, e.poll.channel_id, e.poll.message_id)})` : ''}`);
    embeds.push(new EmbedBuilder().setColor(SKY).setTitle(dayLabel(mk(y, m, selDay))).setDescription([...list, ...pl].join('\n\n').slice(0, 4096) || '—'));
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
    const ns = await setSettings(i.guildId, { default_times: times });
    return i.update(settingsPanel(ns, '✅ 預設開打時間已更新。'));
  }
  if (id === 'setremind') {
    const a = parseInt(i.fields.getTextInputValue('a'), 10), b = parseInt(i.fields.getTextInputValue('b'), 10);
    const patch = {};
    if (a >= 5 && a <= 240) patch.remind_minutes = a;
    if (b >= 0 && b <= 72) patch.nudge_hours = b;
    const ns = Object.keys(patch).length ? await setSettings(i.guildId, patch) : await getSettings(i.guildId);
    return i.update(settingsPanel(ns, Object.keys(patch).length === 2 ? '✅ 提醒時間已更新。' : '⚠️ 有數字超出範圍，那一項沒有改。'));
  }
  if (id === 'draftdl') {
    const draft = drafts.get(i.user.id);
    if (!draft) return i.reply({ content: '這個設定已經過期了，請重新 `/開團 發起`。', flags: E });
    const settings = await getSettings(draft.guildId);
    const game = await getGame(draft.gameId);
    const v = i.fields.getTextInputValue('t');
    const date = parseMD(v), t = parseHM(v.replace(/^\s*[\d/-]+/, ''));
    draft.panel = i;
    if (!date || !t) return i.update(draftView(draft, game, settings, '⚠️ 截止時間格式不對，例如 `11/19 20:00`。'));
    const when = withTime(date, t);
    if (when.getTime() <= Date.now() + 60000) return i.update(draftView(draft, game, settings, '⚠️ 截止時間要在現在之後。'));
    draft.dl = 'custom'; draft.customDeadline = when.toISOString();
    return i.update(draftView(draft, game, settings, `✅ 截止時間設成 ${full(when)}`));
  }
  if (id === 'drafttime') {
    const draft = drafts.get(i.user.id);
    if (!draft) return i.reply({ content: '這個設定已經過期了，請重新 `/開團 發起`。', flags: E });
    const settings = await getSettings(draft.guildId);
    for (const line of i.fields.getTextInputValue('t').split('\n')) {
      const d = parseMD(line); const t = parseHM(line.replace(/^\s*[\d/-]+/, ''));
      if (d && t && draft.dates.includes(ymd(d))) draft.times[ymd(d)] = `${pad(t[0])}:${pad(t[1])}`;
    }
    draft.panel = i;
    return i.update(draftView(draft, await getGame(draft.gameId), settings));
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

  // 要查資料庫的按鈕先回覆 Discord「處理中」，避免超過 3 秒顯示「未及時回應」
  const slow = (kind === 'vote' && ['pick', 'none', 'closeok', 'cancelok', 'closeplan'].includes(act))
    || (kind === 'plan' && act !== 'time') || kind === 'ev' || kind === 'ask' || kind === 'cal';
  if (slow) {
    await i.deferUpdate();
    i.update = (p) => i.editReply(p);
    i.reply = (p) => i.followUp(p);
    i.deferUpdate = async () => {};
  }

  if (kind === 'set') return settingsComponent(i, act);
  if (kind === 'quick') return quickComponent(i, act);

  // 開團 發起 的暫存設定
  if (kind === 'draft') {
    const draft = drafts.get(i.user.id);
    if (!draft) return i.update({ content: '這個設定已經過期了，請重新 `/開團 發起`。', embeds: [], components: [] });
    const settings = await getSettings(draft.guildId);
    const game = await getGame(draft.gameId);
    if (act === 'members') { draft.members = i.values; draft.required = draft.required.filter((u) => i.values.includes(u)); }
    if (act === 'rule') draft.rule = i.values[0];
    if (act === 'dates') {
      const win = new Set(Array.from({ length: 25 }, (_, k) => ymd(addDays(todayStart(), k))));
      draft.dates = [...new Set([...i.values, ...draft.dates.filter((k) => !win.has(k))])];
    }
    if (act === 'dl') {
      if (i.values[0] === 'custom') {
        const base = draft.customDeadline ? new Date(draft.customDeadline) : addDays(todayStart(), 1);
        const p = tp(base);
        return i.showModal(new ModalBuilder().setCustomId('draftdl').setTitle('自訂截止時間').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('日期和時間，例如 11/19 20:00').setStyle(TextInputStyle.Short)
            .setValue(`${p.m}/${p.d} ${draft.customDeadline ? hm(base) : '23:59'}`)),
        ));
      }
      draft.dl = i.values[0];
    }
    if (act === 'cancel') { drafts.delete(i.user.id); return i.update({ content: '已取消。', embeds: [], components: [] }); }
    if (act === 'time') {
      const lines = [...draft.dates].sort().map((k) => { const p = tp(fromYmd(k)); return `${p.m}/${p.d}（${WD[p.wd]}） ${timeOf(draft, k, settings)}`; }).join('\n');
      return i.showModal(new ModalBuilder().setCustomId('drafttime').setTitle('調整每天的開打時間').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('t').setLabel('只改後面的時間，例如 22:00').setStyle(TextInputStyle.Paragraph).setValue(lines)),
      ));
    }
    if (act === 'req') {
      const sel = new UserSelectMenuBuilder().setCustomId('draft:reqsel').setPlaceholder('⭐ 勾選必到成員（可以不選）').setMinValues(0).setMaxValues(Math.min(25, draft.members.length));
      if (draft.required.length) sel.setDefaultUsers(draft.required);
      return i.reply({ content: '勾選**必到成員**：這些人不能來的日子就不排（例如存檔在他電腦上的房主）。選完回到上面的面板繼續。', components: [new ActionRowBuilder().addComponents(sel)], flags: E });
    }
    if (act === 'role') {
      return i.reply({ content: '選一個身分組，裡面的人會**加進**團員名單（原本勾的人會保留）。', flags: E,
        components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('draft:rolesel').setPlaceholder('選擇身分組'))] });
    }
    if (act === 'rolesel') {
      const guild = i.client.guilds.cache.get(draft.guildId);
      await guild.members.fetch().catch(() => {});
      const ids = [...(guild.roles.cache.get(i.values[0])?.members.values() || [])].filter((m) => !m.user.bot).map((m) => m.id);
      const before = draft.members.length;
      draft.members = [...new Set([...draft.members, ...ids])].slice(0, 25);
      const added = draft.members.length - before;
      await i.update({ content: `✅ 從 <@&${i.values[0]}> 加入 ${added} 人，團員現在共 ${draft.members.length} 人。上面的面板已經更新。${ids.length + before > 25 ? '\n⚠️ 團員最多 25 人，超過的沒有加入。' : ''}`, components: [] });
      return draft.panel?.editReply(draftView(draft, game, settings)).catch(() => {});
    }
    if (act === 'reqsel') {
      const bad = i.values.filter((u) => !draft.members.includes(u));
      draft.required = i.values.filter((u) => draft.members.includes(u));
      await i.update({ content: `✅ 必到成員：${draft.required.map((u) => `<@${u}>`).join('、') || '無'}${bad.length ? `\n⚠️ ${bad.map((u) => `<@${u}>`).join('、')} 不在團員裡，已略過。` : ''}\n上面的面板已經更新。`, components: [] });
      return draft.panel?.editReply(draftView(draft, game, settings)).catch(() => {});
    }
    if (act === 'send') return draft.edit ? saveEdit(i, draft, settings) : sendDraft(i, draft, settings);
    draft.panel = i;
    return i.update(draftView(draft, game, settings));
  }

  // 投票
  if (kind === 'vote') {
    const d = await loadPoll(arg);
    if (!d) return i.reply({ content: '找不到這次投票。', flags: E });
    if (act === 'cancel' || act === 'cancelok') {
      if (!(await canManagePoll(i, d.poll))) return i.reply({ content: '🔒 只有開團人和管理員可以作廢投票。', flags: E });
      if (!['open', 'closed'].includes(d.poll.status)) return act === 'cancelok' ? i.update({ content: '這次投票已經結束了。', components: [] }) : i.reply({ content: '這次投票已經結束了。', flags: E });
      if (act === 'cancel') {
        return i.reply({ content: '確定要作廢這次投票嗎？作廢後不會開任何場次，也不能復原。', flags: E,
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote:cancelok:${d.poll.id}`).setLabel('確定作廢').setStyle(ButtonStyle.Danger))] });
      }
      await q(sb.from('polls').update({ status: 'cancelled' }).eq('id', d.poll.id));
      await refreshPollMessage(i.client, await loadPoll(d.poll.id));
      return i.update({ content: '✅ 已作廢這次投票。', components: [] });
    }
    if (act === 'closeplan') {
      if (!(await canManagePoll(i, d.poll))) return i.reply({ content: '🔒 只有開團人和管理員可以截止投票。', flags: E });
      if (d.poll.status === 'open') {
        await i.update({ content: '⏳ 截止中…', components: [] });
        await closePoll(i.client, d.poll.id);
      } else await i.deferUpdate();
      return i.editReply({ content: '', ...planPanel(await loadPoll(d.poll.id), '✅ 投票已截止。') });
    }
    if (act === 'close' || act === 'closeok') {
      if (!(await canManagePoll(i, d.poll))) return i.reply({ content: '🔒 只有開團人和管理員可以截止投票。', flags: E });
      if (d.poll.status !== 'open') return act === 'closeok' ? i.update({ content: '這次投票已經截止了。', components: [] }) : i.reply({ content: '這次投票已經截止了。', flags: E });
      if (act === 'close') {
        const p = pending(d);
        return i.reply({
          content: `確定要現在截止投票嗎？${p.length ? `\n還有 ${p.length} 人沒填完：${p.map((u) => `<@${u}>`).join('、')}（沒填的日子會當作不能來）` : '\n全員都填完了 👍'}`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vote:closeok:${d.poll.id}`).setLabel('確定截止').setStyle(ButtonStyle.Danger),
          )], flags: E,
        });
      }
      await i.update({ content: '⏳ 截止中…', components: [] });
      await closePoll(i.client, d.poll.id);
      return i.editReply({ content: `✅ 投票已截止，排程清單已私訊給 <@${d.poll.created_by}>。萬一私訊不見，用 \`/開團 排程\` 也能叫出來。` });
    }
    if (act === 'who') {
      if (!(await canManagePoll(i, d.poll))) return i.reply({ content: '🔒 只有開團人和管理員看得到誰可以哪天，其他人只看得到人數。', flags: E });
      if (d.poll.status === 'open') refreshPollMessage(i.client, d).catch(() => {});
      return i.reply({ ...whoPanel(d), flags: E });
    }
    if (d.poll.status !== 'open') return act === 'open' ? i.reply({ content: '🔒 投票已經截止了。', flags: E }) : i.update({ content: '🔒 投票已經截止了。', embeds: [], components: [] });
    if (!d.poll.member_ids.includes(i.user.id)) {
      const key = `${d.poll.id}:${i.user.id}`;
      const n = (outsiders.get(key) || 0) + 1;
      outsiders.set(key, n);
      const lines = ['關你什麼事，你只是大便。', '是按夠沒，老人早點睡。', '再按就把按鈕插到你頭上(#`Д´)ﾉ', '你頭上現在有按鈕了(=｀ω´=) (按)(按)(按)', '懶得理你了＝"＝凸'];
      return i.reply({ content: lines[Math.min(n, lines.length) - 1], flags: E });
    }
    if (act === 'open') return i.reply({ ...votePanel(d, i.user.id), flags: E });
    const yes = act === 'pick' ? new Set(i.values) : new Set();
    await q(sb.from('votes').upsert(d.slots.map((s) => ({ slot_id: s.id, user_id: i.user.id, value: yes.has(s.id) ? 'y' : 'n' }))));
    for (const s of d.slots) (d.vote[s.id] ||= {})[i.user.id] = yes.has(s.id) ? 'y' : 'n';
    // 先更新頻道裡的時間表，就算回覆失敗，人數也不會跟實際投票對不上
    await refreshPollMessage(i.client, d).catch(() => {});
    return i.update(votePanel(d, i.user.id, true));
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
export { draftView as _draftView, settingsPanel as _settingsPanel, quickView as _quickView };
