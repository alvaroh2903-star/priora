-- Priora — LIMPEZA TOTAL do banco (contas + empresas + dados)
-- ============================================================================
-- ⚠️  IRREVERSÍVEL. Apaga TODAS as contas (auth.users) e TODOS os dados.
-- Use para zerar o ambiente de testes. Rode no Supabase → SQL Editor → Run.
-- A ORDEM respeita as chaves estrangeiras (apaga quem referencia antes).
-- ============================================================================

-- Vínculos e convites (referenciam usuários e empresas)
delete from public.memberships;
delete from public.invitations;

-- Dados operacionais (referenciam user_id e company_id)
delete from public.demurrage_minutas;
delete from public.demurrage_atividades;
delete from public.demurrage_bot_results;
delete from public.courier_estados;
delete from public.courier_conferencia;
delete from public.courier_followups;

-- Conexões Microsoft (por usuário/empresa)
delete from public.microsoft_connections;

-- Perfis (id → auth.users; org_id → organizations)
delete from public.profiles;

-- Empresas (created_by → auth.users)
delete from public.organizations;

-- Por último, as contas de autenticação
delete from auth.users;
