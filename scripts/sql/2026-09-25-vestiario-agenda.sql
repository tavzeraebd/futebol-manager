-- Vestiário, caixa de entrada, jogos em horário marcado, bolão, missões, base, troféus e notificações no celular.
-- Só acrescenta colunas e tabelas (o servidor antigo continua funcionando com elas). Aplicar ANTES de publicar o servidor novo.

-- clubs.extra: { locker (moral e vestiário), talk (preleção), missions, academy, trophies }
alter table public.clubs add column if not exists extra jsonb not null default '{}'::jsonb;
-- leagues.extra: { schedule (dias e horário), goals (metas da diretoria), awards (prêmios da temporada) }
alter table public.leagues add column if not exists extra jsonb not null default '{}'::jsonb;
-- league_fixtures: horário marcado e extra { bets (bolão), wo, pre, remind }
alter table public.league_fixtures add column if not exists kickoff_at timestamptz;
alter table public.league_fixtures add column if not exists extra jsonb not null default '{}'::jsonb;
create index if not exists league_fixtures_kickoff_idx on public.league_fixtures (kickoff_at) where score is null;

-- Caixa de entrada: relatórios de partida, vestiário, auxiliar, diretoria e conversas entre técnicos
create table if not exists public.messages (
  id uuid primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  kind text not null check (kind in ('report', 'locker', 'aux', 'board', 'dm')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_club_idx on public.messages (club_id, created_at desc);
alter table public.messages enable row level security;
comment on table public.messages is 'Caixa de entrada de cada clube (server/inbox.js). Só o servidor acessa.';

-- Notificações no celular (Web Push): uma linha por aparelho inscrito
create table if not exists public.push_subs (
  endpoint text primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
comment on table public.push_subs is 'Aparelhos inscritos para notificações (server/push.js). Só o servidor acessa.';

-- Chaves do servidor (ex.: par VAPID das notificações, se não vier por variável de ambiente)
create table if not exists public.app_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_kv enable row level security;
comment on table public.app_kv is 'Configuração gerada pelo servidor (ex.: chaves VAPID). Só o servidor acessa.';
