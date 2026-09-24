-- Demurrage Engine V2 — Fase 1, migration CORRETIVA/ADITIVA (revisão 5 do plano).
--
-- O responsável operacional deixa de ser um Usuario (identidade global, que
-- pode pertencer a várias organizações) e passa a ser um OrganizationMembership
-- — o único vínculo que diz "em qual organização, com qual papel". O
-- responsável precisa necessariamente pertencer à MESMA Organization do
-- Processo, e isso é garantido pelo PostgreSQL, não só pela aplicação.
--
-- As migrations 0001-0005 já foram aplicadas e commitadas e NÃO são
-- reescritas. Esta migration:
--   1. cria a chave candidata (id, organization_id) em organization_memberships;
--   2. adiciona processos.responsavel_operacional_membership_id;
--   3. migra registros existentes do vínculo antigo para o novo, usando o
--      membership do MESMO usuário na MESMA organização do processo — nunca
--      cria um membership (isso seria inventar uma concessão de acesso);
--   4. ABORTA (a transação inteira é desfeita pelo runner) se algum vínculo
--      antigo não tiver membership correspondente, em vez de descartar
--      silenciosamente uma atribuição existente;
--   5. garante a mesma organização por FOREIGN KEY COMPOSTA;
--   6. remove o vínculo antigo direto com usuarios.
--
-- Por que FK composta e não trigger (como em 0003/0004): a FK
--   (responsavel_operacional_membership_id, organization_id)
--     -> organization_memberships (id, organization_id)
-- é declarativa e vale nos DOIS sentidos — rejeita apontar para um membership
-- de outra organização E rejeita mover para outra organização um membership
-- que já é responsável por algum processo. Um trigger só no lado do processo
-- não pegaria o segundo caso. Com MATCH SIMPLE (padrão), responsável NULL não
-- é verificado: processo sem responsável continua permitido.
--
-- Exclusão de um membership que é responsável por algum processo: bloqueada
-- (NO ACTION, padrão). O Blueprint não define reatribuição automática, então
-- a migration não inventa uma (nem SET NULL silencioso).
--
-- Idempotente: além do controle por schema_migrations, cada passo verifica o
-- estado atual antes de agir — seguro também para reexecução manual.
--
-- Nota de registro (revisão 5): o comentário da migration 0004 que menciona
-- "tracking_target_id (Fase 5)" em containers está superado. Pelo desenho
-- aprovado, Contêiner não terá coluna de target; o vínculo será a tabela N:N
-- container_tracking_targets, criada na Fase 5. A 0004 não é editada porque já
-- foi aplicada — a correção fica registrada aqui.

-- 1. Chave candidata exigida pela FK composta.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_memberships_id_org_unique'
      AND conrelid = 'organization_memberships'::regclass
  ) THEN
    ALTER TABLE organization_memberships
      ADD CONSTRAINT organization_memberships_id_org_unique UNIQUE (id, organization_id);
  END IF;
END $$;

-- 2. Nova coluna (nullable: processo sem responsável é um estado válido).
ALTER TABLE processos ADD COLUMN IF NOT EXISTS responsavel_operacional_membership_id UUID;

-- 3 e 4. Migra o vínculo antigo, se a coluna antiga ainda existir.
DO $$
DECLARE
  sem_membership INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'processos'
      AND column_name = 'responsavel_operacional_id'
  ) THEN
    UPDATE processos p
       SET responsavel_operacional_membership_id = m.id
      FROM organization_memberships m
     WHERE p.responsavel_operacional_id IS NOT NULL
       AND p.responsavel_operacional_membership_id IS NULL
       AND m.usuario_id = p.responsavel_operacional_id
       AND m.organization_id = p.organization_id;

    SELECT count(*) INTO sem_membership
      FROM processos
     WHERE responsavel_operacional_id IS NOT NULL
       AND responsavel_operacional_membership_id IS NULL;

    IF sem_membership > 0 THEN
      RAISE EXCEPTION
        'Migration 0006 abortada: % processo(s) com responsavel_operacional_id apontando para Usuario sem OrganizationMembership na organizacao do processo. Crie o membership correto ou limpe o vinculo antes de reaplicar - a migration nao inventa concessao de acesso nem descarta a atribuicao.',
        sem_membership;
    END IF;
  END IF;
END $$;

-- 5. Integridade: responsável operacional da MESMA organização do processo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processos_responsavel_membership_same_org_fk'
      AND conrelid = 'processos'::regclass
  ) THEN
    ALTER TABLE processos
      ADD CONSTRAINT processos_responsavel_membership_same_org_fk
      FOREIGN KEY (responsavel_operacional_membership_id, organization_id)
      REFERENCES organization_memberships (id, organization_id);
  END IF;
END $$;

-- 6. Remove o vínculo antigo direto com usuarios (a FK
--    processos_responsavel_operacional_id_fkey cai junto com a coluna).
ALTER TABLE processos DROP COLUMN IF EXISTS responsavel_operacional_id;

-- Índice parcial: serve à verificação da FK (exclusão/alteração de
-- membership) e às consultas "processos do responsável X" sem indexar os
-- processos que ainda não têm responsável.
CREATE INDEX IF NOT EXISTS processos_responsavel_membership_idx
  ON processos (responsavel_operacional_membership_id, organization_id)
  WHERE responsavel_operacional_membership_id IS NOT NULL;
