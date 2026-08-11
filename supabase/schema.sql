-- Priora — Schema Supabase (multiusuário, contas isoladas)
-- ============================================================================
-- Como aplicar: no painel do Supabase → SQL Editor → cole TUDO isto → Run.
-- Idempotente: pode rodar de novo sem quebrar.
--
-- Modelo: a autenticação da CONTA PRIORA usa o Supabase Auth (auth.users). Cada
-- linha de dado pertence a um user_id (auth.users.id). O RLS garante que uma
-- conta NUNCA veja dados de outra. O backend usa a service role (ignora RLS),
-- então SEMPRE filtra por user_id no código — o RLS é a segunda linha de defesa.
-- ============================================================================

-- Perfil da conta Priora (1:1 com auth.users) ---------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now()
);

-- Cria o profile automaticamente quando um usuário se cadastra no Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Conexão Microsoft por conta Priora (tokens do MSAL isolados) -----------------
-- token_cache = cache serializado do MSAL (contém refresh token). Fica isolado
-- por RLS; opcionalmente criptografado em nível de app numa próxima etapa.
create table if not exists public.microsoft_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  home_account_id text,
  username text,
  token_cache jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dados derivados / ações do operador, por conta Priora ------------------------
create table if not exists public.demurrage_minutas (
  user_id uuid not null references auth.users (id) on delete cascade,
  processo text not null,
  via text not null check (via in ('draft', 'manual')),
  created_at timestamptz not null default now(),
  primary key (user_id, processo)
);

create table if not exists public.demurrage_atividades (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  tipo text not null,
  label text not null,
  sub text,
  created_at timestamptz not null default now()
);

create table if not exists public.demurrage_bot_results (
  user_id uuid not null references auth.users (id) on delete cascade,
  reference text not null,
  result jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, reference)
);

create table if not exists public.courier_estados (
  user_id uuid not null references auth.users (id) on delete cascade,
  tracking_key text not null,
  estado text not null,
  nota text,
  updated_at timestamptz not null default now(),
  primary key (user_id, tracking_key)
);

create table if not exists public.courier_conferencia (
  user_id uuid not null references auth.users (id) on delete cascade,
  tracking_key text not null,
  conferencia jsonb not null default '{}'::jsonb,
  primary key (user_id, tracking_key)
);

create table if not exists public.courier_followups (
  user_id uuid not null references auth.users (id) on delete cascade,
  tracking_key text not null,
  followups jsonb not null default '{}'::jsonb,
  primary key (user_id, tracking_key)
);

-- Índices úteis
create index if not exists idx_atividades_user_created
  on public.demurrage_atividades (user_id, created_at desc);

-- RLS: cada usuário só acessa as próprias linhas ------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'microsoft_connections', 'demurrage_minutas',
    'demurrage_atividades', 'demurrage_bot_results', 'courier_estados',
    'courier_conferencia', 'courier_followups'
  ];
  id_col text;
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security;', t);
    -- profiles usa a coluna id; as demais usam user_id.
    id_col := case when t = 'profiles' then 'id' else 'user_id' end;
    execute format('drop policy if exists own_rows on public.%I;', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated using (auth.uid() = %I) with check (auth.uid() = %I);',
      t, id_col, id_col
    );
  end loop;
end $$;
