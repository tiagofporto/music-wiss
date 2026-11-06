-- Sugestões e avaliações dos usuários (aba Tocar e outros pontos do app).
-- Qualquer pessoa conectada pode ENVIAR; ninguém lê pela API (só a equipe, pelo painel/SQL).

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  rating smallint check (rating between 1 and 5),
  message text not null default '' check (char_length(message) <= 2000),
  context text not null default '' check (char_length(context) <= 60),
  app_version text not null default '' check (char_length(app_version) <= 40),
  created_at timestamptz not null default now(),
  check (rating is not null or char_length(trim(message)) > 0)
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

create policy "enviar sugestão em nome próprio" on public.feedback
  for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on public.feedback from anon, authenticated;
grant insert (rating, message, context, app_version) on public.feedback to authenticated;
