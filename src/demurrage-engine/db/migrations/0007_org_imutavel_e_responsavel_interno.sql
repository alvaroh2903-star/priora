-- Demurrage Engine V2 — migration ADITIVA (revisão 6 do plano). 0001-0006 não
-- são reescritas.
--
-- Decisão 1 — organization_id imutável.
--   Os triggers de consistência de 0003/0004 só validam a escrita da linha
--   filha; mover uma linha pai para outra organização deixava vínculos entre
--   organizações sem erro. A regra agora é: a organização dona de um registro
--   nunca muda. Uma única função de trigger, reutilizada por todas as tabelas
--   de tenant, rejeita qualquer UPDATE em que OLD.organization_id difira de
--   NEW.organization_id; UPDATEs que não mudam a organização seguem permitidos.
--   Toda tabela de tenant futura com organization_id deve receber o mesmo
--   trigger (organization_id_immutable), salvo decisão funcional explícita —
--   um teste de catálogo verifica isso para todas as tabelas.
--
-- Decisão 3 — responsável operacional só com papel interno.
--   responsavel_operacional_membership_id só aponta para membership ANALYST,
--   MANAGER ou ADMIN; CLIENT nunca. Garantido nos dois sentidos:
--     (1) atribuir um membership CLIENT como responsável -> rejeitado;
--     (2) mudar para CLIENT o papel de um membership que é responsável por
--         algum processo -> rejeitado enquanto estiver atribuído.
--   Responsável NULL continua válido; não há reatribuição automática.
--   Concorrência: o trigger do processo lê o papel com FOR SHARE, o que
--   conflita com o UPDATE do membership — as duas operações se serializam e a
--   segunda sempre enxerga o efeito da primeira.

-- ---------------------------------------------------------------------------
-- Decisão 1
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_organization_change() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '%.organization_id e imutavel: registro % nao pode mudar da organizacao % para %',
    TG_TABLE_NAME, OLD.id, OLD.organization_id, NEW.organization_id;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tabela TEXT;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'organization_memberships', 'clientes', 'condicoes_comerciais', 'processos',
    'containers', 'field_observations', 'snapshots', 'backfill_runs'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'organization_id_immutable' AND tgrelid = tabela::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER organization_id_immutable BEFORE UPDATE ON %I
           FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
           EXECUTE FUNCTION forbid_organization_change()',
        tabela
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Decisão 3
-- ---------------------------------------------------------------------------

-- Dados existentes: não reclassifica nem remove atribuições em silêncio.
DO $$
DECLARE
  invalidos INTEGER;
BEGIN
  SELECT count(*) INTO invalidos
    FROM processos p
    JOIN organization_memberships m ON m.id = p.responsavel_operacional_membership_id
   WHERE m.papel = 'CLIENT';
  IF invalidos > 0 THEN
    RAISE EXCEPTION
      'Migration 0007 abortada: % processo(s) tem responsavel operacional com papel CLIENT. Reatribua manualmente antes de reaplicar.',
      invalidos;
  END IF;
END $$;

-- (1) Atribuição: o membership responsável precisa ter papel interno.
CREATE OR REPLACE FUNCTION check_processo_responsavel_interno() RETURNS TRIGGER AS $$
DECLARE
  papel_atual organization_role;
BEGIN
  IF NEW.responsavel_operacional_membership_id IS NOT NULL THEN
    SELECT papel INTO papel_atual
      FROM organization_memberships
     WHERE id = NEW.responsavel_operacional_membership_id
       FOR SHARE;
    IF papel_atual = 'CLIENT' THEN
      RAISE EXCEPTION
        'Responsavel operacional nao pode ter papel CLIENT (membership %)',
        NEW.responsavel_operacional_membership_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS processos_responsavel_interno_check ON processos;
CREATE TRIGGER processos_responsavel_interno_check
  BEFORE INSERT OR UPDATE OF responsavel_operacional_membership_id ON processos
  FOR EACH ROW EXECUTE FUNCTION check_processo_responsavel_interno();

-- (2) Sentido inverso: um membership responsável não pode virar CLIENT.
CREATE OR REPLACE FUNCTION check_membership_responsavel_nao_vira_client() RETURNS TRIGGER AS $$
DECLARE
  atribuidos INTEGER;
BEGIN
  SELECT count(*) INTO atribuidos
    FROM processos
   WHERE responsavel_operacional_membership_id = NEW.id;
  IF atribuidos > 0 THEN
    RAISE EXCEPTION
      'Membership % e responsavel operacional de % processo(s) e nao pode passar a CLIENT enquanto estiver atribuido',
      NEW.id, atribuidos;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_memberships_responsavel_papel_check ON organization_memberships;
CREATE TRIGGER organization_memberships_responsavel_papel_check
  BEFORE UPDATE OF papel ON organization_memberships
  FOR EACH ROW WHEN (NEW.papel = 'CLIENT' AND OLD.papel IS DISTINCT FROM 'CLIENT')
  EXECUTE FUNCTION check_membership_responsavel_nao_vira_client();
