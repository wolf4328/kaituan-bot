-- 開團排程機器人 資料表
-- 在 Supabase 的 SQL Editor 貼上整份，按 Run 執行一次即可。

create table if not exists settings (
  guild_id text primary key,
  channel_id text,
  admin_role_id text,
  member_role_id text,
  remind_minutes int not null default 30,
  nudge_hours int not null default 6,
  default_times jsonb not null default '{"0":"20:00","1":"21:00","2":"21:00","3":"21:00","4":"21:00","5":"22:00","6":"14:00"}',
  overview_message_id text
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  name text not null,
  short text,
  description text,
  mode text not null default 'min' check (mode in ('all','min')),
  min_players int not null default 4,
  cap int not null default 8,
  weekly_target int not null default 2,
  image_url text,
  created_at timestamptz not null default now()
);

create table if not exists game_members (
  game_id uuid not null references games(id) on delete cascade,
  user_id text not null,
  required boolean not null default false,
  primary key (game_id, user_id)
);

create table if not exists polls (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  message_id text,
  thread_id text,
  game_ids uuid[] not null,
  member_ids text[] not null,
  deadline timestamptz not null,
  status text not null default 'open' check (status in ('open','closed','done','cancelled')),
  nudged boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists poll_slots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  starts_at timestamptz not null
);

create table if not exists votes (
  slot_id uuid not null references poll_slots(id) on delete cascade,
  user_id text not null,
  value text not null check (value in ('y','n')),
  primary key (slot_id, user_id)
);

create table if not exists plan_picks (
  poll_id uuid not null references polls(id) on delete cascade,
  slot_id uuid not null references poll_slots(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  starts_at timestamptz not null,
  primary key (poll_id, slot_id, game_id)
);

create table if not exists asks (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  slot_id uuid not null references poll_slots(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  user_id text not null,
  answer text check (answer in ('y','n')),
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  poll_id uuid references polls(id) on delete set null,
  game_id uuid not null references games(id) on delete cascade,
  starts_at timestamptz not null,
  players text[] not null default '{}',
  bench text[] not null default '{}',
  note text,
  created_by text not null,
  message_id text,
  thread_id text,
  reminded boolean not null default false,
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists events_guild_time on events (guild_id, starts_at);
create index if not exists polls_status on polls (status);

-- 只允許用 service_role 金鑰存取（機器人用的就是這把），其他人一律擋掉
alter table settings enable row level security;
alter table games enable row level security;
alter table game_members enable row level security;
alter table polls enable row level security;
alter table poll_slots enable row level security;
alter table votes enable row level security;
alter table plan_picks enable row level security;
alter table asks enable row level security;
alter table events enable row level security;
