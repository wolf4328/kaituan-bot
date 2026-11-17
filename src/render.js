import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} from 'discord.js';
import { dayLabel, hm, full, ts } from './time.js';
import { status, pending, yesOn, gameLabel } from './logic.js';

export const SKY = 0x38bdf8;
export const SKY_DARK = 0x0284c7;
export const GOLD = 0xf0b232;
const at = (id) => `<@${id}>`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const msgLink = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// 10 人以內：一顆愛心 = 一個人；超過 10 人才按比例縮成 10 顆
function bar(n, total) {
  if (total <= 10) return '🩷'.repeat(n) + '🩶'.repeat(Math.max(0, total - n));
  const w = 10;
  const f = total ? Math.round((n / total) * w) : 0;
  return '🩷'.repeat(f) + '🩶'.repeat(w - f);
}
export const steamLink = (img) => { const m = /apps\/(\d+)/.exec(img || ''); return m ? `https://store.steampowered.com/app/${m[1]}/` : null; };

// ─── 開團時間表（頻道裡那則會一直更新的訊息）───
export function pollMessage(d) {
  const { poll, slots } = d;
  const total = poll.member_ids.length;
  const closed = poll.status !== 'open';
  const p = pending(d);
  const g0 = d.games[0];
  const ruleOf = (g) => (g.mode === 'all' ? '全員到齊才開' : `${g.min_players} 人以上就開`);
  const head = [
    `🎯 **成團條件**　${d.games.map(ruleOf).join('／')}`,
    closed ? '🔒 **投票狀態**　已截止，正在排場次' : `⏰ **截止時間**　${ts(poll.deadline, 'f')}（${ts(poll.deadline, 'R')}）`,
    `👥 **填寫人數**　${total - p.length} / ${total} 人`,
    '-# 大家只看得到人數，看不到你選了什麼',
  ];
  const days = slots.slice(0, 25).map((s) => {
    const y = yesOn(d, s.id).filter((u) => poll.member_ids.includes(u)).length;
    return `### 📅 ${dayLabel(s.starts_at)} ${hm(s.starts_at)}\n${bar(y, total)}　**${y}** / ${total} 人可以${y === total ? '　✨' : ''}`;
  });
  const names = d.games.map((g) => g.name).join('／');
  const link = steamLink(g0?.image_url);
  const titleLine = link ? `[${names}](${link})` : names;
  const embed = new EmbedBuilder()
    .setColor(closed ? 0x64748b : SKY)
    .setAuthor({ name: closed ? '🔒 開團時間表・已截止' : '🗓️ 開團時間表' })
    .setDescription([`## ${titleLine}`, head.join('\n'), '', days.join('\n')].join('\n').slice(0, 4096))
    .setFooter({ text: closed ? '感謝大家填寫！' : p.length ? `還有 ${p.length} 人沒填完 · 按下面的「填寫我的時間」` : '全員都填完了 ✅' });
  if (g0?.image_url) embed.setImage(g0.image_url);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote:open:${poll.id}`).setLabel('填寫我的時間').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(closed),
  );
  return { embeds: [embed], components: [row] };
}

// ─── 投票的私人面板（只有自己看得到）───
export function votePanel(d, userId, saved = false) {
  const mine = d.slots.filter((s) => (d.vote[s.id] || {})[userId] === 'y').map((s) => s.id);
  const answered = d.slots.every((s) => (d.vote[s.id] || {})[userId]);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`vote:pick:${d.poll.id}`)
    .setPlaceholder('勾選你「可以」的日子')
    .setMinValues(0)
    .setMaxValues(d.slots.length)
    .addOptions(d.slots.map((s) => ({
      label: `${dayLabel(s.starts_at)} ${hm(s.starts_at)}`,
      value: s.id,
      default: mine.includes(s.id),
    })));
  const desc = d.slots.map((s) => {
    const v = (d.vote[s.id] || {})[userId];
    return `${v === 'y' ? '✅' : v === 'n' ? '❌' : '⬜'}　${dayLabel(s.starts_at)} ${hm(s.starts_at)}`;
  }).join('\n');
  return {
    content: saved ? '✅ 已儲存！可以隨時回來改。' : '在下面勾選你**可以**的日子，沒勾的會算「不行」。只有你看得到。',
    embeds: [new EmbedBuilder().setColor(SKY).setTitle(answered ? '你的回覆' : '你的回覆（還沒填完）').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote:none:${d.poll.id}`).setLabel('這幾天都不行').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ─── 排程清單（截止後私訊給開團人）───
export function planPanel(d, note = '') {
  const { poll, slots, games, picks } = d;
  const done = poll.status === 'done';
  const nameOf = (id) => at(id);
  const blocks = [];
  const options = [];
  const askOptions = [];
  for (const s of slots) {
    const lines = [`**${dayLabel(s.starts_at)}**　${yesOn(d, s.id).length}/${poll.member_ids.length} 人可以`];
    for (const g of games) {
      const st = status(d, g, s.id);
      const pick = picks.find((p) => p.slot_id === s.id && p.game_id === g.id);
      const icon = pick ? '☑️' : st.s === 'ok' ? '🟢' : st.s === 'near' ? '🟡' : '⚫';
      let info;
      if (st.s === 'ok') info = `可成團 ${st.yes.length}/${g.mode === 'all' ? st.need : g.cap}`;
      else if (st.s === 'near') info = `差 ${st.missing.length}：${st.missing.map(nameOf).join('、')}`;
      else info = st.reqMiss ? `${st.reqMiss.map(nameOf).join('、')} 不能來（必到）` : st.why;
      lines.push(`${icon} ${g.name}　${info}${pick ? `　→ **${hm(pick.starts_at)} 開**` : ''}`);
      if (st.s !== 'no' || pick) {
        options.push({
          label: clip(`${dayLabel(s.starts_at)} ${g.name}`, 100),
          description: clip(st.s === 'ok' ? `可成團 ${st.yes.length} 人` : st.s === 'near' ? `差 ${st.missing.length} 人，照開` : '條件不符，照開', 100),
          value: `${s.id}|${g.id}`,
          default: !!pick,
        });
      }
      if (st.s === 'near' && !done) {
        askOptions.push({
          label: clip(`${dayLabel(s.starts_at)} ${g.name}`, 100),
          description: `私訊問 ${st.missing.length} 個缺的人能不能來`,
          value: `${s.id}|${g.id}`,
        });
      }
    }
    blocks.push(lines.join('\n'));
  }
  const times = picks.map((p) => p.starts_at);
  const clash = new Set(times).size < times.length;
  let desc = [
    done ? '✅ **已發布，場次卡已經貼到頻道了。**' : '下面是建議的排程，已經先幫你選好。用第一個選單增減要開的場次，同一天可以開兩場。',
    '🟢 可成團　🟡 全員制還差幾個人　⚫ 不能開　☑️ 已選',
    clash ? '⚠️ 有兩場時間重疊，請按「調整時間」錯開。' : '',
    note ? `\n${note}` : '',
    '',
    blocks.join('\n\n'),
  ].filter((x) => x !== '').join('\n');
  if (desc.length > 4000) desc = desc.slice(0, 3990) + '\n…';
  const embed = new EmbedBuilder().setColor(done ? 0x23a55a : SKY).setTitle(done ? '✅ 排程已發布' : '📋 投票截止了！選擇要開的場次').setDescription(desc);
  const comps = [];
  if (!done) {
    if (options.length) {
      comps.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`plan:pick:${poll.id}`).setPlaceholder('選擇要開的場次（可複選）')
          .setMinValues(0).setMaxValues(Math.min(options.length, 25)).addOptions(options.slice(0, 25)),
      ));
    }
    if (askOptions.length) {
      comps.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`plan:ask:${poll.id}`).setPlaceholder('💬 私訊追問缺的人…').addOptions(askOptions.slice(0, 25)),
      ));
    }
    comps.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plan:time:${poll.id}`).setLabel('調整時間').setEmoji('🕘').setStyle(ButtonStyle.Secondary).setDisabled(!picks.length),
      new ButtonBuilder().setCustomId(`plan:ok:${poll.id}`).setLabel(`確認開這 ${picks.length} 場`).setStyle(ButtonStyle.Success).setDisabled(!picks.length),
      new ButtonBuilder().setCustomId(`plan:refresh:${poll.id}`).setLabel('重新整理').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
  }
  return { embeds: [embed], components: comps };
}

// ─── 場次卡 ───
export function eventMessage(ev, game, settings) {
  const cancelled = ev.status === 'cancelled';
  const need = game.mode === 'all' ? `${ev.players.length}（全員制）` : `${ev.players.length}/${game.cap}`;
  const embed = new EmbedBuilder()
    .setColor(cancelled ? 0x64748b : SKY_DARK)
    .setTitle(cancelled ? `❌ 已取消｜${game.name}` : game.name)
    .setDescription([game.description || '', ev.note ? `⚠️ ${ev.note}` : ''].filter(Boolean).join('\n\n') || null)
    .addFields(
      { name: '時間', value: `${ts(ev.starts_at, 'F')}（${ts(ev.starts_at, 'R')}）` },
      { name: '開團人', value: at(ev.created_by) },
      { name: '提前通知', value: `${settings.remind_minutes} 分鐘前`, inline: true },
      { name: '人數', value: need, inline: true },
      { name: '候補人數', value: String(ev.bench.length), inline: true },
      { name: '已參加用戶', value: ev.players.map(at).join('\n') || '—' },
      { name: '候補名單', value: ev.bench.map(at).join('\n') || '目前沒有候補' },
    )
    .setFooter({ text: full(ev.starts_at) });
  if (game.image_url) embed.setImage(game.image_url);
  const link = steamLink(game.image_url);
  if (link && !cancelled) embed.setURL(link);
  const comps = cancelled ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ev:join:${ev.id}`).setLabel('參加').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ev:leave:${ev.id}`).setLabel('取消').setStyle(ButtonStyle.Danger),
  )];
  return { embeds: [embed], components: comps };
}

// ─── 場次總覽（建議釘選）───
export function overviewMessage(events, gamesById) {
  const lines = events.map((e) => {
    const g = gamesById[e.game_id];
    if (!g) return null;
    const cnt = g.mode === 'all' ? `${e.players.length} 人` : `${e.players.length}/${g.cap}`;
    return `**${dayLabel(e.starts_at)} ${hm(e.starts_at)}**　${g.name}　${cnt}${e.note ? `\n　⚠️ ${e.note}` : ''}`;
  }).filter(Boolean);
  const embed = new EmbedBuilder().setColor(GOLD).setTitle('📅 場次總覽')
    .setDescription(lines.length ? lines.join('\n') : '目前沒有排定的場次')
    .setFooter({ text: '會自動更新 · 建議釘選這則訊息 · 用 /月曆 看整個月' });
  return { embeds: [embed] };
}
