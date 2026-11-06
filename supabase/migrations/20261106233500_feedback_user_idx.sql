-- Índice para a chave estrangeira feedback.user_id (aviso do Supabase Advisor).
create index if not exists feedback_user_idx on public.feedback (user_id);
