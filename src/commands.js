import { SlashCommandBuilder, ChannelType } from 'discord.js';

const gameOpt = (o, required = true) => o.setName('遊戲').setDescription('選一款遊戲').setRequired(required).setAutocomplete(true);
const eventOpt = (o) => o.setName('場次').setDescription('選一個場次').setRequired(true).setAutocomplete(true);
const gameFields = (s, isNew) => {
  if (isNew) {
    s.addStringOption((o) => o.setName('名稱').setDescription('遊戲名稱').setRequired(true).setMaxLength(60))
      .addStringOption((o) => o.setName('模式').setDescription('成團模式').setRequired(true)
        .addChoices({ name: '全員到齊才開', value: 'all' }, { name: '達到門檻人數就開', value: 'min' }));
  } else {
    s.addStringOption((o) => gameOpt(o))
      .addStringOption((o) => o.setName('名稱').setDescription('改名').setMaxLength(60))
      .addStringOption((o) => o.setName('模式').setDescription('成團模式')
        .addChoices({ name: '全員到齊才開', value: 'all' }, { name: '達到門檻人數就開', value: 'min' }));
  }
  return s
    .addIntegerOption((o) => o.setName('門檻').setDescription('達門檻模式：幾人以上就開').setMinValue(1).setMaxValue(50))
    .addIntegerOption((o) => o.setName('人數上限').setDescription('超過的人進候補').setMinValue(1).setMaxValue(100))
    .addIntegerOption((o) => o.setName('每週場數').setDescription('排程時建議開幾場').setMinValue(0).setMaxValue(14))
    .addStringOption((o) => o.setName('簡稱').setDescription('月曆上顯示的短名，例如：森林之子').setMaxLength(12))
    .addStringOption((o) => o.setName('介紹').setDescription('場次卡上的一句話介紹').setMaxLength(300))
    .addStringOption((o) => o.setName('圖片網址').setDescription('場次卡的封面圖網址（例如 Steam 商店頁的封面圖）').setMaxLength(500));
};

export const commands = [
  new SlashCommandBuilder().setName('設定').setDescription('機器人設定（管理員）')
    .addSubcommand((s) => s.setName('頻道').setDescription('指定發時間表和場次卡的頻道')
      .addChannelOption((o) => o.setName('頻道').setDescription('例如 #開團排程').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('管理員').setDescription('指定誰能用管理指令（伺服器管理員本來就能用）')
      .addRoleOption((o) => o.setName('身分組').setDescription('管理員身分組').setRequired(true)))
    .addSubcommand((s) => s.setName('預設時間').setDescription('設定星期一到日各自的預設開打時間'))
    .addSubcommand((s) => s.setName('提醒').setDescription('設定提醒時間')
      .addIntegerOption((o) => o.setName('開打前分鐘').setDescription('開打前幾分鐘提醒，預設 30').setMinValue(5).setMaxValue(240))
      .addIntegerOption((o) => o.setName('截止前催填小時').setDescription('投票截止前幾小時私訊沒填的人，0 = 不自動催，預設 6').setMinValue(0).setMaxValue(72)))
    .addSubcommand((s) => s.setName('固定團身分組').setDescription('把團員自動加上這個身分組（只加不拿掉；不填 = 關閉）')
      .addRoleOption((o) => o.setName('身分組').setDescription('例如 @固定團')))
    .addSubcommand((s) => s.setName('查看').setDescription('看目前的設定')),

  new SlashCommandBuilder().setName('遊戲').setDescription('管理遊戲和成團規則')
    .addSubcommand((s) => gameFields(s.setName('新增').setDescription('新增一款遊戲（管理員）'), true))
    .addSubcommand((s) => gameFields(s.setName('編輯').setDescription('修改遊戲規則（管理員）'), false))
    .addSubcommand((s) => s.setName('列表').setDescription('列出所有遊戲和規則'))
    .addSubcommand((s) => s.setName('刪除').setDescription('刪除遊戲（管理員）').addStringOption((o) => gameOpt(o))),

  new SlashCommandBuilder().setName('團員').setDescription('管理每款遊戲的團員名單（管理員）')
    .addSubcommand((s) => s.setName('匯入').setDescription('把某個身分組的人整批加進遊戲團員')
      .addRoleOption((o) => o.setName('身分組').setDescription('例如 @固定團').setRequired(true))
      .addStringOption((o) => gameOpt(o)))
    .addSubcommand((s) => s.setName('管理').setDescription('用選單勾選團員').addStringOption((o) => gameOpt(o)))
    .addSubcommand((s) => s.setName('必到').setDescription('勾選必到成員（例如存檔在他電腦上的房主）').addStringOption((o) => gameOpt(o))),

  new SlashCommandBuilder().setName('開團').setDescription('投票與排程（管理員）')
    .addSubcommand((s) => s.setName('發起').setDescription('挑日期，發出開團時間表'))
    .addSubcommand((s) => s.setName('催填').setDescription('立刻私訊還沒填完的人'))
    .addSubcommand((s) => s.setName('截止').setDescription('提前結束投票，私訊排程清單給你'))
    .addSubcommand((s) => s.setName('排程').setDescription('重新叫出排程清單'))
    .addSubcommand((s) => s.setName('作廢').setDescription('作廢目前的投票（不會開任何場次）')),

  new SlashCommandBuilder().setName('場次').setDescription('調整場次（管理員）')
    .addSubcommand((s) => s.setName('改時間').setDescription('修改場次時間，會通知參加的人')
      .addStringOption((o) => eventOpt(o))
      .addStringOption((o) => o.setName('時間').setDescription('例如 21:30').setRequired(true))
      .addStringOption((o) => o.setName('日期').setDescription('要改日期才填，例如 11/22')))
    .addSubcommand((s) => s.setName('取消').setDescription('取消場次，會通知參加的人').addStringOption((o) => eventOpt(o)))
    .addSubcommand((s) => s.setName('直接開').setDescription('跳過投票直接開一場')
      .addStringOption((o) => gameOpt(o))
      .addStringOption((o) => o.setName('日期').setDescription('例如 11/22').setRequired(true))
      .addStringOption((o) => o.setName('時間').setDescription('例如 21:00').setRequired(true))),

  new SlashCommandBuilder().setName('我的場次').setDescription('看自己接下來參加的場次'),
  new SlashCommandBuilder().setName('月曆').setDescription('叫出開團月曆（只有你看得到）')
    .addIntegerOption((o) => o.setName('月份').setDescription('不填 = 這個月').setMinValue(1).setMaxValue(12)),
].map((c) => c.toJSON());
