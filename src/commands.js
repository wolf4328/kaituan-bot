import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
const ADMIN = PermissionFlagsBits.ManageGuild;

const gameOpt = (o, required = true) => o.setName('遊戲').setDescription('選一款遊戲').setRequired(required).setAutocomplete(true);
const pollOpt = (o) => o.setName('投票').setDescription('選哪一個投票（只有一個的話可以不填）').setAutocomplete(true);
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
    .addStringOption((o) => o.setName('圖片網址').setDescription('Steam 商店網址或圖片網址').setMaxLength(500));
};

export const commands = [
  new SlashCommandBuilder().setName('設定').setDescription('打開設定面板：頻道、管理員、預設時間、提醒、遊戲列表').setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder().setName('遊戲').setDescription('修改或刪除遊戲（管理員）').setDefaultMemberPermissions(ADMIN)
    .addSubcommand((s) => gameFields(s.setName('編輯').setDescription('改名稱、成團規則、封面'), false))
    .addSubcommand((s) => s.setName('刪除').setDescription('刪除遊戲').addStringOption((o) => gameOpt(o))),

  new SlashCommandBuilder().setName('開團').setDescription('投票與排程（管理員）').setDefaultMemberPermissions(ADMIN)
    .addSubcommand((s) => s.setName('發起').setDescription('選遊戲、勾團員、挑日期，一次發出時間表')
      .addStringOption((o) => o.setName('遊戲').setDescription('從選單選，或直接打新遊戲名稱').setRequired(true).setAutocomplete(true).setMaxLength(60))
      .addStringOption((o) => o.setName('封面').setDescription('選填：貼 Steam 商店網址當封面（不填會自動用名稱找）').setMaxLength(500)))
    .addSubcommand((s) => s.setName('修改').setDescription('修改進行中的投票：日期、時間、團員、截止時間').addStringOption(pollOpt))
    .addSubcommand((s) => s.setName('催填').setDescription('立刻私訊還沒填完的人').addStringOption(pollOpt))
    .addSubcommand((s) => s.setName('排程').setDescription('叫出排程清單（投票還沒截止的話，可以在這裡截止）').addStringOption(pollOpt))
    .addSubcommand((s) => s.setName('作廢').setDescription('作廢一個投票（不會開任何場次）').addStringOption(pollOpt)),

  new SlashCommandBuilder().setName('場次').setDescription('調整場次（管理員）').setDefaultMemberPermissions(ADMIN)
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
