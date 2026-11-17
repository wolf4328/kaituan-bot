import { readFileSync, existsSync } from 'node:fs';

// 讀取 .env（不用另外裝套件）
const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Client, GatewayIntentBits, Events, Partials } = await import('discord.js');
const { commands } = await import('./commands.js');
const { onInteraction } = await import('./handlers.js');
const { sb, q, getSettings, getGame } = await import('./db.js');
const { closePoll, nudge, loadPoll, postInThread, refreshOverview } = await import('./actions.js');

if (!process.env.DISCORD_TOKEN) { console.error('缺少 DISCORD_TOKEN，請檢查 .env'); process.exit(1); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    await guild.members.fetch().catch(() => {});
    console.log(`已在「${guild.name}」註冊指令`);
  } catch (e) { console.error(`註冊指令失敗（${guild.name}）`, e.message); }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 已上線：${c.user.tag}`);
  for (const g of c.guilds.cache.values()) await registerCommands(g);
  setInterval(() => tick().catch((e) => console.error('排程檢查失敗', e)), 60 * 1000);
  tick().catch((e) => console.error('排程檢查失敗', e));
});
client.on(Events.GuildCreate, registerCommands);
client.on(Events.InteractionCreate, onInteraction);
client.on(Events.Error, (e) => console.error('Discord 錯誤', e));

// ─── 每分鐘檢查一次：截止投票、催填、開打前提醒 ───
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const open = await q(sb.from('polls').select('*').eq('status', 'open'));
    for (const p of open) {
      if (new Date(p.deadline) <= now) { await closePoll(client, p.id); continue; }
      if (p.nudged) continue;
      const s = await getSettings(p.guild_id);
      if (s.nudge_hours > 0 && new Date(p.deadline).getTime() - s.nudge_hours * 3600 * 1000 <= now.getTime()) {
        await nudge(client, await loadPoll(p.id));
      }
    }
    // 開打前提醒：取未來 4 小時內、還沒提醒的場次
    const soon = new Date(now.getTime() + 4 * 3600 * 1000).toISOString();
    const recent = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const evs = await q(sb.from('events').select('*').eq('status', 'active').eq('reminded', false).lte('starts_at', soon).gte('starts_at', recent));
    for (const ev of evs) {
      const s = await getSettings(ev.guild_id);
      const start = new Date(ev.starts_at).getTime();
      if (start - s.remind_minutes * 60000 > now.getTime()) continue;
      // 先標記再發，避免重開機時重複提醒
      const marked = await q(sb.from('events').update({ reminded: true }).eq('id', ev.id).eq('reminded', false).select());
      if (!marked.length) continue;
      const g = await getGame(ev.game_id);
      if (!g) continue;
      const mins = Math.max(0, Math.round((start - now.getTime()) / 60000));
      const ids = [...ev.players];
      const ch = await client.channels.fetch(ev.channel_id).catch(() => null);
      const payload = {
        content: `⏰ ${ids.map((u) => `<@${u}>`).join(' ')}\n**${g.name}** ${mins > 0 ? `再 ${mins} 分鐘開打` : '現在開打'}（<t:${Math.floor(start / 1000)}:t>）！`,
        allowedMentions: { users: ids },
      };
      if (ch && ev.message_id) await ch.send({ ...payload, reply: { messageReference: ev.message_id, failIfNotExists: false } }).catch(() => postInThread(client, ev, payload));
      else await postInThread(client, ev, payload);
    }
    // 每小時更新一次總覽，讓過期的場次自動消失
    if (now.getMinutes() === 0) {
      for (const g of client.guilds.cache.values()) await refreshOverview(client, g.id).catch(() => {});
    }
  } finally {
    running = false;
  }
}

process.on('unhandledRejection', (e) => console.error('未處理的錯誤', e));
client.login(process.env.DISCORD_TOKEN);
