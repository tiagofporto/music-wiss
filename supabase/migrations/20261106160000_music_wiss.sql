-- Music Wiss: partituras na nuvem, compartilhamento por link e colaboração.
--
-- scores          partitura (JSON do editor) com dono e versão (para detectar edição simultânea)
-- score_shares    links de compartilhamento (token secreto, papel "ver" ou "editar")
-- score_members   quem entrou por um link (papel herdado do link)
--
-- Toda tabela tem RLS. As checagens que precisam ler outra tabela usam funções
-- SECURITY DEFINER no esquema "private" (não exposto pela API), para não haver
-- recursão entre políticas e para o token do link não ficar legível por ninguém.

create schema if not exists private;

create table public.scores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Sem título' check (char_length(title) <= 200),
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scores_owner_updated_idx on public.scores (owner_id, updated_at desc);

create table public.score_shares (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references public.scores (id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  role text not null check (role in ('view', 'edit')),
  created_at timestamptz not null default now()
);
create index score_shares_score_idx on public.score_shares (score_id);

create table public.score_members (
  score_id uuid not null references public.scores (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('view', 'edit')),
  -- token do link usado para entrar (conferido na política de insert)
  via_token text not null,
  joined_at timestamptz not null default now(),
  primary key (score_id, user_id)
);
create index score_members_user_idx on public.score_members (user_id);

-- ---------------------------------------------------------------- funções auxiliares

create or replace function private.is_owner(p_score uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.scores s where s.id = p_score and s.owner_id = (select auth.uid()));
$$;

-- papel do usuário atual numa partitura: 'owner', 'edit', 'view' ou null
create or replace function private.score_role(p_score uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from public.scores s where s.id = p_score and s.owner_id = (select auth.uid())) then 'owner'
    else (select m.role from public.score_members m where m.score_id = p_score and m.user_id = (select auth.uid()))
  end;
$$;

-- o link existe, é desta partitura e dá este papel?
create or replace function private.share_matches(p_score uuid, p_token text, p_role text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.score_shares sh
    where sh.score_id = p_score and sh.token = p_token and sh.role = p_role
  );
$$;

revoke all on function private.is_owner(uuid), private.score_role(uuid), private.share_matches(uuid, text, text) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_owner(uuid), private.score_role(uuid), private.share_matches(uuid, text, text) to authenticated;

-- updated_at e versão mantidos pelo banco
create or replace function private.touch_score()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  new.owner_id := old.owner_id; -- o dono nunca muda por update
  return new;
end;
$$;
create trigger scores_touch before update on public.scores
  for each row execute function private.touch_score();

-- ---------------------------------------------------------------- RLS: scores

alter table public.scores enable row level security;

create policy "ler partituras próprias ou compartilhadas" on public.scores
  for select to authenticated
  using (owner_id = (select auth.uid()) or private.score_role(id) is not null);

create policy "criar partituras próprias" on public.scores
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "editar partituras próprias ou com link de edição" on public.scores
  for update to authenticated
  using (owner_id = (select auth.uid()) or private.score_role(id) = 'edit')
  with check (owner_id = (select auth.uid()) or private.score_role(id) = 'edit');

create policy "apagar só as próprias" on public.scores
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------- RLS: score_shares

alter table public.score_shares enable row level security;

create policy "dono vê os links" on public.score_shares
  for select to authenticated
  using (private.is_owner(score_id));

create policy "dono cria links" on public.score_shares
  for insert to authenticated
  with check (private.is_owner(score_id));

create policy "dono apaga links" on public.score_shares
  for delete to authenticated
  using (private.is_owner(score_id));

-- ---------------------------------------------------------------- RLS: score_members

alter table public.score_members enable row level security;

create policy "membro se vê; dono vê todos" on public.score_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_owner(score_id));

create policy "entrar com um link válido" on public.score_members
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.share_matches(score_id, via_token, role)
  );

create policy "trocar de papel com outro link válido" on public.score_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.share_matches(score_id, via_token, role));

create policy "sair; dono remove" on public.score_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_owner(score_id));

-- ---------------------------------------------------------------- acesso pela API

grant select, insert, delete on public.scores to authenticated;
grant update (title, data) on public.scores to authenticated;
grant select, insert, delete on public.score_shares to authenticated;
grant select, insert, update, delete on public.score_members to authenticated;
revoke all on public.scores, public.score_shares, public.score_members from anon;

-- tempo real: avisos de mudança nas partituras (respeitam a RLS)
alter publication supabase_realtime add table public.scores;
