-- Fase D15-C v1.1 (corretiva) — publicação tarifária e seleção determinística
-- (migration ADITIVA; 0001-0037 não são reescritas — a 0037 já foi entregue
-- como candidata e pode já ter sido aplicada fora dos bancos de teste
-- descartáveis desta sessão, então a correção abaixo é um degrau novo).
--
-- Achado bloqueante #1 (rascunho selecionável): até a 0037, `ativada_em`
-- era só um controle de MUTABILIDADE — `selecionarVigente` nunca o filtrava,
-- então um rascunho (`ativada_em IS NULL`) já entrava em cálculos reais
-- desde a criação e só ficava imutável por TER SIDO USADO, sem nunca ter
-- passado por uma ativação explícita/revisão. A correção (camada de
-- aplicação, `tariffTableRepository.selecionarVigente`) exige agora
-- `ativada_em IS NOT NULL` — nenhuma alteração de schema é necessária para
-- essa parte: a coluna já existe desde a 0037.
--
-- O que ESTA migration precisa resolver é só a consequência sobre dados que
-- a 0037 possa já ter produzido em algum ambiente real (não descartável):
-- uma versão que já foi USADA por um ValorApurado (`tabela_id` a referencia)
-- é imutável há MUITO — mas se nunca passou por `ativar()` explicitamente,
-- `ativada_em` permanece NULL. Sob a correção de `selecionarVigente`, essa
-- versão — já comprovadamente em uso, já travada contra edição — se tornaria
-- de repente INVISÍVEL à seleção por data, podendo quebrar o próximo
-- recálculo autorizado de um processo ainda OPEN que dependa exatamente
-- dela. Isso teria sido uma regressão introduzida pela PRÓPRIA correção, não
-- um comportamento legado a preservar.
--
-- Fix: publica (ativa) toda versão que já está em uso mas nunca foi
-- explicitamente ativada. A data registrada é o momento em que ESTA
-- migration corre (`now()`) — nunca uma data histórica inventada (não há
-- como saber, com certeza, QUANDO ela deveria ter sido "ativada": o único
-- fato real e já registrado é que ela está em uso). Uma versão que NUNCA
-- foi usada e nunca foi ativada (um rascunho genuíno, nunca tocado por
-- nenhum cálculo) NÃO é afetada — continua, corretamente, invisível à
-- seleção até alguém revisá-la e ativá-la de verdade.
--
-- Pré-requisito descoberto por esta própria correção: o trigger
-- `forbid_tariff_table_mutation` (0037) barra UPDATE sobre qualquer linha
-- já "congelada" — e `tariff_table_esta_congelada` já era verdadeira para
-- uma versão USADA mesmo com `ativada_em` ainda NULL. O comentário original
-- da 0037 assumia (incorretamente) que a única forma de chegar congelada
-- era por `ativada_em` já preenchido — por isso o `UPDATE` de publicação
-- abaixo, sobre uma linha usada-mas-nunca-ativada, seria rejeitado pelo
-- PRÓPRIO trigger que deveria permiti-lo. Corrigido primeiro (mesma função,
-- `CREATE OR REPLACE`, nenhuma reescrita do arquivo 0037): a transição
-- `ativada_em NULL -> preenchido`, SOZINHA (nenhuma outra coluna mudando na
-- mesma instrução), passa a ser permitida mesmo sobre uma linha congelada
-- só por uso — nunca uma porta para editar conteúdo sob o pretexto de "só
-- estou ativando"; qualquer outra coluna junto reverte à rejeição normal.
CREATE OR REPLACE FUNCTION forbid_tariff_table_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tariff_table_esta_congelada(OLD.id) THEN
      RAISE EXCEPTION 'tariff_tables %: versao ativada ou usada em calculo e imutavel — DELETE barrado; crie uma nova versao (tariffTableService.criarVersaoCorrigida) para corrigir', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- Publicação (ativação) de uma versão já USADA mas nunca ativada
  -- explicitamente: a ÚNICA coluna que muda é ativada_em (NULL -> now());
  -- qualquer outra coluna mudando junto desqualifica a exceção.
  IF OLD.ativada_em IS NULL AND NEW.ativada_em IS NOT NULL
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.tipo IS NOT DISTINCT FROM OLD.tipo
     AND NEW.armador_id IS NOT DISTINCT FROM OLD.armador_id
     AND NEW.termo_comercial IS NOT DISTINCT FROM OLD.termo_comercial
     AND NEW.versao IS NOT DISTINCT FROM OLD.versao
     AND NEW.vigencia_inicio IS NOT DISTINCT FROM OLD.vigencia_inicio
     AND NEW.vigencia_fim IS NOT DISTINCT FROM OLD.vigencia_fim
     AND NEW.qualidade_fonte IS NOT DISTINCT FROM OLD.qualidade_fonte
     AND NEW.day_count_basis IS NOT DISTINCT FROM OLD.day_count_basis
     AND NEW.fonte IS NOT DISTINCT FROM OLD.fonte
     AND NEW.verificada_em IS NOT DISTINCT FROM OLD.verificada_em
  THEN
    RETURN NEW;
  END IF;

  IF tariff_table_esta_congelada(OLD.id) THEN
    RAISE EXCEPTION 'tariff_tables %: versao ativada ou usada em calculo e imutavel — UPDATE barrado; crie uma nova versao (tariffTableService.criarVersaoCorrigida) para corrigir', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  publicadas INTEGER;
BEGIN
  UPDATE tariff_tables t
     SET ativada_em = now()
   WHERE t.ativada_em IS NULL
     AND EXISTS (SELECT 1 FROM valores_apurados v WHERE v.tabela_id = t.id);
  GET DIAGNOSTICS publicadas = ROW_COUNT;
  IF publicadas > 0 THEN
    RAISE NOTICE 'migration 0038: % versao(oes) tarifaria(s) ja em uso, nunca ativada(s) explicitamente, publicada(s) agora (ativada_em = now() desta migration, nunca uma data historica inventada).', publicadas;
  END IF;
END $$;
