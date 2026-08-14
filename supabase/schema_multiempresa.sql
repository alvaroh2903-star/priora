-- Priora — Schema multi-empresa (workspaces) — ETAPA A
-- ============================================================================
-- Rode DEPOIS do supabase/schema.sql. Aditivo e idempotente (pode rodar de novo).
-- Modelo (ver docs/ARQUITETURA_MULTIEMPRESA.md): a conta operacional pertence ao
-- workspace da empresa. Admin cria/gerencia; analistas são convidados. Dados
-- carregam company_id + user_id. RLS: analista vê user_id; admin vê company_id.
-- ============================================================================

-- Empresas (organizações) ----------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  seat_limit int not null default 3,        -- limite de assentos do plano
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- Tipo da empresa (operador logístico x cliente importador), vindo do cadastro.
alter table public.organizations
  add column if not exists type text not null default 'operador'
  check (type in ('operador', 'cliente'));

-- Membros: user ↔ empresa (1 empresa por usuário no modelo operacional) -------
create table if not exists public.memberships (
  user_id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  role text not null default 'analyst' check (role in ('admin', 'analyst')),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now()
);
create index if not exists idx_memberships_org on public.memberships (org_id);

-- Convites (analista define a própria senha via token) ------------------------
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role text not null default 'analyst' check (role in ('admin', 'analyst')),
  token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired')),
  invited_by uuid references auth.users (id),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_invitations_org on public.invitations (org_id);
create index if not exists idx_invitations_email on public.invitations (email);

-- profiles: aponta para a empresa e guarda o nome -----------------------------
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists org_id uuid references public.organizations (id);

-- microsoft_connections: tipo (USER/CORPORATE) + empresa ----------------------
alter table public.microsoft_connections add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.microsoft_connections add column if not exists kind text not null default 'USER' check (kind in ('USER', 'CORPORATE'));

-- Dados operacionais: company_id além do user_id ------------------------------
alter table public.demurrage_minutas     add column if not exists company_id uuid references public.organizations (id) on delete cascade;
alter table public.demurrage_atividades  add column if not exists company_id uuid references public.organizations (id) on delete cascade;
alter table public.demurrage_bot_results add column if not exists company_id uuid references public.organizations (id) on delete cascade;
alter table public.courier_estados       add column if not exists company_id uuid references public.organizations (id) on delete cascade;
alter table public.courier_conferencia   add column if not exists company_id uuid references public.organizations (id) on delete cascade;
alter table public.courier_followups     add column if not exists company_id uuid references public.organizations (id) on delete cascade;

-- Helpers para RLS ------------------------------------------------------------
create or replace function public.current_org()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid();
$$;

create or replace function public.is_org_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- RLS das tabelas novas -------------------------------------------------------
alter table public.organizations enable row level security;
drop policy if exists org_read on public.organizations;
create policy org_read on public.organizations for select to authenticated
  using (id = public.current_org());
drop policy if exists org_admin_update on public.organizations;
create policy org_admin_update on public.organizations for update to authenticated
  using (id = public.current_org() and public.is_org_admin());

alter table public.memberships enable row level security;
drop policy if exists mem_read on public.memberships;
create policy mem_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or (org_id = public.current_org() and public.is_org_admin()));

alter table public.invitations enable row level security;
drop policy if exists inv_admin on public.invitations;
create policy inv_admin on public.invitations for all to authenticated
  using (org_id = public.current_org() and public.is_org_admin())
  with check (org_id = public.current_org() and public.is_org_admin());

-- RLS dos dados operacionais: analista vê os próprios; admin vê os da empresa.
do $$
declare
  t text;
  tables text[] := array[
    'demurrage_minutas', 'demurrage_atividades', 'demurrage_bot_results',
    'courier_estados', 'courier_conferencia', 'courier_followups'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists own_rows on public.%I;', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid() or (company_id = public.current_org() and public.is_org_admin())) with check (user_id = auth.uid());',
      t
    );
  end loop;
end $$;
