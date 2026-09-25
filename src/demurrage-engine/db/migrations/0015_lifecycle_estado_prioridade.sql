-- Demurrage Engine V2 — migration ADITIVA (Fase 7: Estados e Prioridades, v4).
-- 0001-0014 não são reescritas.
--
-- Materializa (cache regenerável) os derivados do ciclo operacional do Cap. 21/22:
-- estado por contêiner, badges, estado documental, prioridade e motivo; e a
-- consolidação por processo (Cap. 21.10/28.3). Nada aqui é fonte da verdade —
-- é 100% recomputável pelas engines puras (containerState/priorityEngine/
-- processConsolidation) a partir dos fatos das Fases 1–6. Todas as colunas são
-- NULLABLE (um contêiner/processo ainda não derivado fica NULL).
--
-- `prazoProximoThresholdDias` NÃO entra como coluna: é configuração da engine
-- (TBD), nunca um valor hardcodado no schema.

-- 1) Contêiner: estado operacional + badges + documental + prioridade + motivo.
ALTER TABLE containers
  ADD COLUMN estado TEXT
    CHECK (estado IS NULL OR estado IN (
      'MONITORAMENTO_SILENCIOSO', 'PRAZO_PROXIMO',
      'EM_DEMURRAGE_ATENCAO', 'EM_DEMURRAGE_CRITICO',
      'PENDENCIA_DE_DADOS', 'TRACKING_DESATUALIZADO',
      'DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'CONCLUIDO_PARA_ROCKET'
    )),
  ADD COLUMN estado_badges TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN documentary_status TEXT
    CHECK (documentary_status IS NULL OR documentary_status IN (
      'MINUTA_PENDENTE', 'MINUTA_RECEBIDA', 'NAO_APLICAVEL'
    )),
  ADD COLUMN escalation_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN severidade_dias INTEGER,
  ADD COLUMN prioridade_balde TEXT
    CHECK (prioridade_balde IS NULL OR prioridade_balde IN (
      'CRITICA_15', 'CRITICA_7_14', 'ATENCAO_1_6',
      'DEVOLVIDO_TRATAMENTO', 'PRAZO_PREVENTIVO', 'SILENCIOSO'
    )),
  ADD COLUMN prioridade_motivo TEXT,
  ADD COLUMN lifecycle_calculated_at TIMESTAMPTZ;

-- 2) Processo: estado mais relevante + prioridade + motivo + contêiner-líder.
ALTER TABLE processos
  ADD COLUMN estado_mais_relevante TEXT
    CHECK (estado_mais_relevante IS NULL OR estado_mais_relevante IN (
      'MONITORAMENTO_SILENCIOSO', 'PRAZO_PROXIMO',
      'EM_DEMURRAGE_ATENCAO', 'EM_DEMURRAGE_CRITICO',
      'PENDENCIA_DE_DADOS', 'TRACKING_DESATUALIZADO',
      'DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'CONCLUIDO_PARA_ROCKET'
    )),
  ADD COLUMN prioridade_balde TEXT
    CHECK (prioridade_balde IS NULL OR prioridade_balde IN (
      'CRITICA_15', 'CRITICA_7_14', 'ATENCAO_1_6',
      'DEVOLVIDO_TRATAMENTO', 'PRAZO_PREVENTIVO', 'SILENCIOSO'
    )),
  ADD COLUMN prioridade_motivo TEXT,
  ADD COLUMN container_lider_id UUID REFERENCES containers(id),
  ADD COLUMN lifecycle_calculated_at TIMESTAMPTZ;

-- Fila operacional: ordena por balde entre processos não silenciosos.
CREATE INDEX processos_prioridade_balde_idx ON processos (prioridade_balde);
