-- Demurrage Engine V2 — migration ADITIVA (Produção P1, armazenamento
-- definitivo dos arquivos das minutas). 0001-0052 não são reescritas; nenhuma
-- linha existente de `documentos`, `minutas` ou `fechamentos` é alterada.
--
-- Ver docs/demurrage-producao-p1-arquivos-minuta.md. Resumo:
--  - o BINÁRIO do arquivo da minuta vive no armazenamento de objetos privado
--    (S3 compatível); o PostgreSQL guarda só metadados, estado e vínculos.
--    Nenhum byte do arquivo vai para o banco;
--  - CADA tentativa de envio grava numa chave NOVA, gerada pelo servidor
--    (`doc/v1/` + 128 bits aleatórios em hex — nada de organização, processo,
--    contêiner ou nome) e registrada em `documentos_armazenados_envios` ANTES
--    do primeiro byte. A chave do documento é a da tentativa ACEITA, gravada
--    uma vez. Uma tentativa atrasada ou perdedora só toca a PRÓPRIA chave:
--    nunca sobrescreve nem apaga o arquivo de um documento confirmado;
--  - um documento confirmado nunca é apagado (DELETE proibido); substituir a
--    minuta cria um documento novo e marca o anterior SUBSTITUIDO, que
--    continua baixável. Só objetos NUNCA vinculados (tentativa descartada,
--    upload expirado ou recusado) podem ser removidos — as linhas ficam;
--  - `documentos` (0016/0048) continua sendo o vínculo de evidência 1:1 da
--    minuta. Linhas legadas (só referência + hash informado) ficam como
--    estão; linhas novas usam a origem `armazenamento_interno` e apontam para
--    `documentos_armazenados` com o MESMO id.

-- ---------------------------------------------------------------------------
-- 1) documentos_armazenados: um arquivo real enviado, uma linha.
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_armazenados (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  container_id UUID NOT NULL,
  finalidade TEXT NOT NULL CHECK (finalidade = 'minuta_devolucao'),

  -- Objeto no armazenamento (opaco; nunca exposto): a chave da tentativa
  -- aceita. NULL até o conteúdo ser recebido.
  chave_objeto TEXT CHECK (chave_objeto IS NULL OR chave_objeto ~ '^doc/v1/[0-9a-f]{32}$'),

  -- Declarado por quem enviou (nunca confiado) e conferido pelo servidor.
  nome_original TEXT NOT NULL CHECK (char_length(nome_original) BETWEEN 1 AND 255),
  tipo_declarado TEXT NOT NULL CHECK (tipo_declarado IN ('application/pdf', 'image/png', 'image/jpeg')),
  tamanho_declarado BIGINT NOT NULL CHECK (tamanho_declarado BETWEEN 1 AND 52428800),
  sha256_declarado TEXT CHECK (sha256_declarado IS NULL OR sha256_declarado ~ '^[0-9a-f]{64}$'),
  tipo_detectado TEXT CHECK (tipo_detectado IS NULL OR tipo_detectado IN ('application/pdf', 'image/png', 'image/jpeg')),
  tamanho_bytes BIGINT CHECK (tamanho_bytes IS NULL OR tamanho_bytes BETWEEN 1 AND 52428800),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),

  estado TEXT NOT NULL CHECK (estado IN ('PENDENTE', 'DISPONIVEL', 'FALHOU', 'QUARENTENA', 'SUBSTITUIDO')),
  motivo_falha TEXT CHECK (motivo_falha IS NULL OR motivo_falha IN (
    'formato_proibido', 'tipo_divergente', 'conteudo_incompativel', 'hash_divergente',
    'objeto_nao_confirmado', 'upload_abandonado', 'inspecao_reprovada')),
  -- Inspeção de conteúdo malicioso: NÃO existe inspetor no sistema; todo
  -- documento fica NAO_REALIZADA (risco registrado). Ponto de integração
  -- futuro: a inspeção pode evoluir também em documento já DISPONIVEL ou
  -- SUBSTITUIDO (o download recusa REPROVADA).
  inspecao TEXT NOT NULL DEFAULT 'NAO_REALIZADA'
    CHECK (inspecao IN ('NAO_REALIZADA', 'PENDENTE', 'APROVADA', 'REPROVADA')),

  -- Vínculo com a minuta (uma única vez, só quando DISPONIVEL).
  minuta_id UUID REFERENCES minutas(id),
  versao INTEGER CHECK (versao IS NULL OR versao >= 1),
  vinculado_em TIMESTAMPTZ,
  -- Versões: o documento da minuta que esta substituiu, e quem o substituiu.
  substitui_id UUID,
  substituido_por_id UUID,
  substituido_em TIMESTAMPTZ,

  -- Autor: SEMPRE o membership da sessão (nunca dado do cliente).
  autor_membership_id UUID NOT NULL,
  autor_usuario_id UUID NOT NULL REFERENCES usuarios(id),

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Upload nunca concluído expira (limpeza de abandonados).
  expira_em TIMESTAMPTZ NOT NULL,
  recebido_em TIMESTAMPTZ,
  disponivel_em TIMESTAMPTZ,
  falhou_em TIMESTAMPTZ,
  -- Só documento nunca vinculado (FALHOU): o objeto foi apagado do armazenamento.
  objeto_removido_em TIMESTAMPTZ,
  -- Reconciliação: registro confirmado cujo objeto não foi encontrado (reversível pela reconciliação).
  objeto_ausente_em TIMESTAMPTZ,

  correlacao_id UUID NOT NULL,
  idempotencia_chave TEXT NOT NULL CHECK (char_length(idempotencia_chave) BETWEEN 1 AND 200),
  idempotencia_hash TEXT NOT NULL CHECK (idempotencia_hash ~ '^[0-9a-f]{64}$'),
  -- Posse do envio do conteúdo: um PUT por vez (coluna, nunca lock).
  envio_token UUID,
  envio_posse_ate TIMESTAMPTZ,

  CONSTRAINT documentos_armazenados_chave_unica UNIQUE (chave_objeto),
  CONSTRAINT documentos_armazenados_id_org_unica UNIQUE (id, organization_id),
  CONSTRAINT documentos_armazenados_idempotencia_unica UNIQUE (organization_id, idempotencia_chave),
  CONSTRAINT documentos_armazenados_minuta_unica UNIQUE (minuta_id),
  CONSTRAINT documentos_armazenados_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT documentos_armazenados_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id),
  CONSTRAINT documentos_armazenados_autor_org_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_armazenados_substitui_org_fk FOREIGN KEY (substitui_id, organization_id)
    REFERENCES documentos_armazenados (id, organization_id),
  CONSTRAINT documentos_armazenados_substituido_por_org_fk FOREIGN KEY (substituido_por_id, organization_id)
    REFERENCES documentos_armazenados (id, organization_id),

  -- Conteúdo recebido: tudo junto (o servidor calcula; nunca parcial).
  CONSTRAINT documentos_armazenados_recebimento_coerente CHECK (
    (recebido_em IS NULL) = (sha256 IS NULL)
    AND (recebido_em IS NULL) = (tamanho_bytes IS NULL)
    AND (recebido_em IS NULL) = (tipo_detectado IS NULL)
    AND (recebido_em IS NULL) = (chave_objeto IS NULL)
    AND (recebido_em IS NULL OR (tamanho_bytes = tamanho_declarado AND tipo_detectado = tipo_declarado
      AND (sha256_declarado IS NULL OR sha256_declarado = sha256)))
  ),
  CONSTRAINT documentos_armazenados_estado_coerente CHECK (
    CASE estado
      WHEN 'PENDENTE' THEN disponivel_em IS NULL AND falhou_em IS NULL AND motivo_falha IS NULL
        AND minuta_id IS NULL AND substituido_em IS NULL AND objeto_removido_em IS NULL
      WHEN 'QUARENTENA' THEN recebido_em IS NOT NULL AND disponivel_em IS NULL AND falhou_em IS NULL
        AND motivo_falha IS NULL AND minuta_id IS NULL AND substituido_em IS NULL AND objeto_removido_em IS NULL
        AND inspecao = 'PENDENTE'
      WHEN 'DISPONIVEL' THEN recebido_em IS NOT NULL AND disponivel_em IS NOT NULL AND falhou_em IS NULL
        AND motivo_falha IS NULL AND substituido_em IS NULL AND objeto_removido_em IS NULL
      WHEN 'SUBSTITUIDO' THEN recebido_em IS NOT NULL AND disponivel_em IS NOT NULL AND falhou_em IS NULL
        AND motivo_falha IS NULL AND minuta_id IS NOT NULL AND substituido_em IS NOT NULL
        AND objeto_removido_em IS NULL
      WHEN 'FALHOU' THEN falhou_em IS NOT NULL AND motivo_falha IS NOT NULL
        AND minuta_id IS NULL AND substituido_em IS NULL
    END
  ),
  CONSTRAINT documentos_armazenados_vinculo_coerente CHECK (
    (minuta_id IS NULL) = (versao IS NULL) AND (minuta_id IS NULL) = (vinculado_em IS NULL)
    AND (substitui_id IS NULL OR minuta_id IS NOT NULL)
    AND (substitui_id IS NULL OR substitui_id <> id)
  ),
  CONSTRAINT documentos_armazenados_substituicao_coerente CHECK (
    (substituido_por_id IS NULL) = (substituido_em IS NULL)
    AND (substituido_por_id IS NULL) = (estado <> 'SUBSTITUIDO')
    AND (substituido_por_id IS NULL OR substituido_por_id <> id)
  ),
  CONSTRAINT documentos_armazenados_posse_coerente CHECK ((envio_token IS NULL) = (envio_posse_ate IS NULL))
);
CREATE INDEX documentos_armazenados_container_idx ON documentos_armazenados (container_id, criado_em, id);
CREATE INDEX documentos_armazenados_processo_idx ON documentos_armazenados (processo_id);
-- Varredura de uploads abandonados (etapa do tick e reconciliação).
CREATE INDEX documentos_armazenados_pendentes_idx ON documentos_armazenados (expira_em, id) WHERE estado = 'PENDENTE';
CREATE INDEX documentos_armazenados_nao_vinculados_idx ON documentos_armazenados (disponivel_em, id)
  WHERE estado = 'DISPONIVEL' AND minuta_id IS NULL;
CREATE INDEX documentos_armazenados_remocao_pendente_idx ON documentos_armazenados (falhou_em, id)
  WHERE estado = 'FALHOU' AND chave_objeto IS NOT NULL AND objeto_removido_em IS NULL;
-- No máximo UM documento vigente vinculado por contêiner.
CREATE UNIQUE INDEX documentos_armazenados_vigente_unico ON documentos_armazenados (container_id)
  WHERE estado = 'DISPONIVEL' AND minuta_id IS NOT NULL;

-- Ciclo de vida: transições, imutabilidade do conteúdo e do vínculo.
CREATE OR REPLACE FUNCTION documentos_armazenados_guarda() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documentos_armazenados %: documento nunca e apagado (retencao)', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.processo_id IS DISTINCT FROM OLD.processo_id
     OR NEW.container_id IS DISTINCT FROM OLD.container_id OR NEW.finalidade IS DISTINCT FROM OLD.finalidade
     OR NEW.nome_original IS DISTINCT FROM OLD.nome_original
     OR NEW.tipo_declarado IS DISTINCT FROM OLD.tipo_declarado OR NEW.tamanho_declarado IS DISTINCT FROM OLD.tamanho_declarado
     OR NEW.sha256_declarado IS DISTINCT FROM OLD.sha256_declarado
     OR NEW.autor_membership_id IS DISTINCT FROM OLD.autor_membership_id
     OR NEW.autor_usuario_id IS DISTINCT FROM OLD.autor_usuario_id OR NEW.criado_em IS DISTINCT FROM OLD.criado_em
     OR NEW.expira_em IS DISTINCT FROM OLD.expira_em OR NEW.correlacao_id IS DISTINCT FROM OLD.correlacao_id
     OR NEW.idempotencia_chave IS DISTINCT FROM OLD.idempotencia_chave
     OR NEW.idempotencia_hash IS DISTINCT FROM OLD.idempotencia_hash THEN
    RAISE EXCEPTION 'documentos_armazenados %: identidade e declaracao sao imutaveis', OLD.id;
  END IF;
  -- Transições permitidas. DISPONIVEL → FALHOU só para upload NUNCA vinculado
  -- (expiração de abandonado); vinculado só segue para SUBSTITUIDO.
  IF NOT (
       (OLD.estado = 'PENDENTE' AND NEW.estado IN ('PENDENTE', 'DISPONIVEL', 'QUARENTENA', 'FALHOU'))
    OR (OLD.estado = 'QUARENTENA' AND NEW.estado IN ('QUARENTENA', 'DISPONIVEL', 'FALHOU'))
    OR (OLD.estado = 'DISPONIVEL' AND NEW.estado IN ('DISPONIVEL', 'SUBSTITUIDO'))
    OR (OLD.estado = 'DISPONIVEL' AND NEW.estado = 'FALHOU' AND OLD.minuta_id IS NULL AND NEW.motivo_falha IN ('upload_abandonado', 'inspecao_reprovada'))
    OR (OLD.estado = 'SUBSTITUIDO' AND NEW.estado = 'SUBSTITUIDO')
    OR (OLD.estado = 'FALHOU' AND NEW.estado = 'FALHOU')
  ) THEN
    RAISE EXCEPTION 'documentos_armazenados %: transicao % -> % proibida', OLD.id, OLD.estado, NEW.estado;
  END IF;
  -- Conteúdo recebido (chave inclusive) é gravado uma vez, em PENDENTE, e nunca muda.
  IF OLD.recebido_em IS NOT NULL AND (NEW.recebido_em IS DISTINCT FROM OLD.recebido_em
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.tamanho_bytes IS DISTINCT FROM OLD.tamanho_bytes
     OR NEW.tipo_detectado IS DISTINCT FROM OLD.tipo_detectado OR NEW.chave_objeto IS DISTINCT FROM OLD.chave_objeto) THEN
    RAISE EXCEPTION 'documentos_armazenados %: conteudo recebido e imutavel', OLD.id;
  END IF;
  IF OLD.recebido_em IS NULL AND NEW.recebido_em IS NOT NULL AND OLD.estado <> 'PENDENTE' THEN
    RAISE EXCEPTION 'documentos_armazenados %: conteudo so e recebido em PENDENTE', OLD.id;
  END IF;
  -- Vínculo com a minuta: uma vez, com o documento DISPONIVEL, e nunca muda.
  IF OLD.minuta_id IS NOT NULL AND (NEW.minuta_id IS DISTINCT FROM OLD.minuta_id OR NEW.versao IS DISTINCT FROM OLD.versao
     OR NEW.vinculado_em IS DISTINCT FROM OLD.vinculado_em OR NEW.substitui_id IS DISTINCT FROM OLD.substitui_id) THEN
    RAISE EXCEPTION 'documentos_armazenados %: vinculo com a minuta e imutavel', OLD.id;
  END IF;
  IF OLD.minuta_id IS NULL AND NEW.minuta_id IS NOT NULL AND NOT (OLD.estado = 'DISPONIVEL' AND NEW.estado = 'DISPONIVEL') THEN
    RAISE EXCEPTION 'documentos_armazenados %: so documento DISPONIVEL e vinculado', OLD.id;
  END IF;
  IF OLD.minuta_id IS NULL AND NEW.minuta_id IS NULL AND (NEW.substitui_id IS DISTINCT FROM OLD.substitui_id) THEN
    RAISE EXCEPTION 'documentos_armazenados %: substituicao so no vinculo', OLD.id;
  END IF;
  -- Datas de estado: gravadas uma vez.
  IF (OLD.disponivel_em IS NOT NULL AND NEW.disponivel_em IS DISTINCT FROM OLD.disponivel_em)
     OR (OLD.falhou_em IS NOT NULL AND (NEW.falhou_em IS DISTINCT FROM OLD.falhou_em OR NEW.motivo_falha IS DISTINCT FROM OLD.motivo_falha))
     OR (OLD.substituido_em IS NOT NULL AND (NEW.substituido_em IS DISTINCT FROM OLD.substituido_em
         OR NEW.substituido_por_id IS DISTINCT FROM OLD.substituido_por_id))
     OR (OLD.objeto_removido_em IS NOT NULL AND NEW.objeto_removido_em IS DISTINCT FROM OLD.objeto_removido_em) THEN
    RAISE EXCEPTION 'documentos_armazenados %: historico de estado e imutavel', OLD.id;
  END IF;
  -- Objeto só é removido de documento FALHOU (nunca vinculado).
  IF NEW.objeto_removido_em IS NOT NULL AND OLD.objeto_removido_em IS NULL AND NEW.estado <> 'FALHOU' THEN
    RAISE EXCEPTION 'documentos_armazenados %: objeto so e removido de documento falho nunca vinculado', OLD.id;
  END IF;
  -- Inspeção: só avança (NAO_REALIZADA → PENDENTE → APROVADA|REPROVADA); nunca volta.
  IF NEW.inspecao IS DISTINCT FROM OLD.inspecao AND NOT (
       (OLD.inspecao = 'NAO_REALIZADA' AND NEW.inspecao IN ('PENDENTE', 'APROVADA', 'REPROVADA'))
    OR (OLD.inspecao = 'PENDENTE' AND NEW.inspecao IN ('APROVADA', 'REPROVADA'))
  ) THEN
    RAISE EXCEPTION 'documentos_armazenados %: inspecao % -> % proibida', OLD.id, OLD.inspecao, NEW.inspecao;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_armazenados_guarda
  BEFORE UPDATE OR DELETE ON documentos_armazenados
  FOR EACH ROW EXECUTE FUNCTION documentos_armazenados_guarda();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_armazenados
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- O contêiner pertence ao processo do documento (nunca vínculo cruzado).
CREATE OR REPLACE FUNCTION documentos_armazenados_container_do_processo() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = NEW.container_id AND c.processo_id = NEW.processo_id
                   AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'documentos_armazenados %: conteiner fora do processo', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER documentos_armazenados_container_do_processo
  BEFORE INSERT ON documentos_armazenados
  FOR EACH ROW EXECUTE FUNCTION documentos_armazenados_container_do_processo();

-- Substituição coerente com a cadeia de minutas (conferida no COMMIT): um
-- documento SUBSTITUIDO é o da minuta que foi substituída, e o substituto é
-- o documento da minuta que a substituiu.
CREATE OR REPLACE FUNCTION documentos_armazenados_substituicao_da_minuta() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM minutas m JOIN documentos_armazenados novo ON novo.minuta_id = m.substituida_por_id
     WHERE m.id = NEW.minuta_id AND novo.id = NEW.substituido_por_id AND novo.substitui_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'documentos_armazenados %: substituicao incoerente com a cadeia de minutas', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER documentos_armazenados_substituicao_da_minuta
  AFTER UPDATE ON documentos_armazenados
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.estado = 'SUBSTITUIDO' AND OLD.estado IS DISTINCT FROM 'SUBSTITUIDO')
  EXECUTE FUNCTION documentos_armazenados_substituicao_da_minuta();

-- ---------------------------------------------------------------------------
-- 2) Tentativas de envio do conteúdo (uma linha por PUT; chave própria,
--    registrada ANTES do primeiro byte). Só a tentativa ACEITA vira o objeto
--    do documento; a chave de uma tentativa DESCARTADA é removível.
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_armazenados_envios (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  documento_id UUID NOT NULL,
  chave_objeto TEXT NOT NULL CHECK (chave_objeto ~ '^doc/v1/[0-9a-f]{32}$'),
  token UUID NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('EM_ANDAMENTO', 'ACEITO', 'DESCARTADO')),
  motivo TEXT CHECK (motivo IS NULL OR motivo IN (
    'formato_proibido', 'tipo_divergente', 'conteudo_incompativel', 'hash_divergente', 'origem_interrompida',
    'armazenamento_falhou', 'banco_falhou', 'posse_perdida', 'nao_autorizado', 'abandonado')),
  idempotencia_chave TEXT NOT NULL CHECK (char_length(idempotencia_chave) BETWEEN 1 AND 200),
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em TIMESTAMPTZ,
  objeto_removido_em TIMESTAMPTZ,
  CONSTRAINT documentos_armazenados_envios_chave_unica UNIQUE (chave_objeto),
  CONSTRAINT documentos_armazenados_envios_documento_org_fk FOREIGN KEY (documento_id, organization_id)
    REFERENCES documentos_armazenados (id, organization_id),
  CONSTRAINT documentos_armazenados_envios_estado_coerente CHECK (
    CASE estado
      WHEN 'EM_ANDAMENTO' THEN encerrado_em IS NULL AND motivo IS NULL AND objeto_removido_em IS NULL
      WHEN 'ACEITO' THEN encerrado_em IS NOT NULL AND motivo IS NULL AND objeto_removido_em IS NULL
      WHEN 'DESCARTADO' THEN encerrado_em IS NOT NULL AND motivo IS NOT NULL
    END
  )
);
CREATE UNIQUE INDEX documentos_armazenados_envios_um_aceito ON documentos_armazenados_envios (documento_id) WHERE estado = 'ACEITO';
CREATE INDEX documentos_armazenados_envios_documento_idx ON documentos_armazenados_envios (documento_id, iniciado_em);
CREATE INDEX documentos_armazenados_envios_em_andamento_idx ON documentos_armazenados_envios (iniciado_em, id) WHERE estado = 'EM_ANDAMENTO';
CREATE INDEX documentos_armazenados_envios_remocao_pendente_idx ON documentos_armazenados_envios (encerrado_em, id)
  WHERE estado = 'DESCARTADO' AND objeto_removido_em IS NULL;

CREATE OR REPLACE FUNCTION documentos_armazenados_envios_guarda() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documentos_armazenados_envios %: historico de envio nunca e apagado', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.documento_id IS DISTINCT FROM OLD.documento_id
     OR NEW.chave_objeto IS DISTINCT FROM OLD.chave_objeto OR NEW.token IS DISTINCT FROM OLD.token
     OR NEW.idempotencia_chave IS DISTINCT FROM OLD.idempotencia_chave OR NEW.iniciado_em IS DISTINCT FROM OLD.iniciado_em THEN
    RAISE EXCEPTION 'documentos_armazenados_envios %: identidade da tentativa e imutavel', OLD.id;
  END IF;
  IF NOT (
       (OLD.estado = 'EM_ANDAMENTO' AND NEW.estado IN ('ACEITO', 'DESCARTADO'))
    OR (OLD.estado = 'DESCARTADO' AND NEW.estado = 'DESCARTADO' AND NEW.motivo IS NOT DISTINCT FROM OLD.motivo
        AND NEW.encerrado_em IS NOT DISTINCT FROM OLD.encerrado_em
        AND OLD.objeto_removido_em IS NULL AND NEW.objeto_removido_em IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'documentos_armazenados_envios %: transicao % -> % proibida', OLD.id, OLD.estado, NEW.estado;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER documentos_armazenados_envios_guarda
  BEFORE UPDATE OR DELETE ON documentos_armazenados_envios
  FOR EACH ROW EXECUTE FUNCTION documentos_armazenados_envios_guarda();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_armazenados_envios
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- A chave do documento é sempre a da tentativa ACEITA do próprio documento.
ALTER TABLE documentos_armazenados
  ADD CONSTRAINT documentos_armazenados_chave_da_tentativa_fk FOREIGN KEY (chave_objeto)
    REFERENCES documentos_armazenados_envios (chave_objeto) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION documentos_armazenados_chave_aceita() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documentos_armazenados_envios e
                  WHERE e.chave_objeto = NEW.chave_objeto AND e.documento_id = NEW.id AND e.estado = 'ACEITO') THEN
    RAISE EXCEPTION 'documentos_armazenados %: chave do objeto nao e a da tentativa aceita', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER documentos_armazenados_chave_aceita
  AFTER UPDATE ON documentos_armazenados
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.chave_objeto IS NOT NULL AND OLD.chave_objeto IS NULL)
  EXECUTE FUNCTION documentos_armazenados_chave_aceita();

-- ---------------------------------------------------------------------------
-- 3) Eventos do documento (auditoria append-only; sem chave, URL ou segredo).
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_armazenados_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  documento_id UUID NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'UPLOAD_INICIADO', 'ENVIO_INICIADO', 'CONTEUDO_RECEBIDO', 'CONTEUDO_RECUSADO', 'ENVIO_FALHOU',
    'DISPONIVEL', 'QUARENTENA', 'FALHOU', 'VINCULADO_MINUTA', 'SUBSTITUIDO', 'DOWNLOAD', 'DOWNLOAD_INTERROMPIDO',
    'INTEGRIDADE_DIVERGENTE', 'OBJETO_AUSENTE_DETECTADO', 'OBJETO_AUSENTE_CONFIRMADO', 'OBJETO_RESTABELECIDO',
    'UPLOAD_ABANDONADO_EXPIRADO', 'OBJETO_REMOVIDO')),
  -- Ator humano (sessão) ou automático (tick/reconciliação).
  ator_membership_id UUID,
  ator_usuario_id UUID REFERENCES usuarios(id),
  automatico BOOLEAN NOT NULL,
  -- Operador da reconciliação manual (informado na linha de comando).
  operador TEXT CHECK (operador IS NULL OR char_length(operador) BETWEEN 1 AND 200),
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlacao_id UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documentos_armazenados_eventos_documento_org_fk FOREIGN KEY (documento_id, organization_id)
    REFERENCES documentos_armazenados (id, organization_id),
  CONSTRAINT documentos_armazenados_eventos_ator_org_fk FOREIGN KEY (ator_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_armazenados_eventos_ator_coerente CHECK (
    automatico = (ator_membership_id IS NULL) AND (ator_membership_id IS NULL) = (ator_usuario_id IS NULL)
  )
);
CREATE INDEX documentos_armazenados_eventos_documento_idx ON documentos_armazenados_eventos (documento_id, criado_em, id);
CREATE TRIGGER documentos_armazenados_eventos_append_only
  BEFORE UPDATE OR DELETE ON documentos_armazenados_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_armazenados_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) documentos: vínculo de evidência da minuta com o arquivo armazenado.
--    O CHECK da 0048 é trocado por um que aceita as linhas legadas
--    (exatamente o ramo antigo) OU a origem nova `armazenamento_interno`
--    (sem referência — a chave interna nunca vai para a leitura —, só
--    PDF/PNG/JPEG, mesmo id do documento armazenado). Toda linha existente
--    satisfaz o ramo legado: o ADD CONSTRAINT valida e não reescreve nada.
-- ---------------------------------------------------------------------------
ALTER TABLE documentos ADD COLUMN armazenado_id UUID;
ALTER TABLE documentos
  ADD CONSTRAINT documentos_armazenado_fk FOREIGN KEY (armazenado_id, organization_id)
    REFERENCES documentos_armazenados (id, organization_id),
  ADD CONSTRAINT documentos_armazenado_unico UNIQUE (armazenado_id);

ALTER TABLE documentos DROP CONSTRAINT documentos_minuta_coerente;
ALTER TABLE documentos ADD CONSTRAINT documentos_minuta_coerente CHECK (
  minuta_id IS NULL OR (
    organization_id IS NOT NULL AND processo_id IS NOT NULL AND container_id IS NOT NULL
    AND tipo = 'minuta_devolucao'
    AND nome_arquivo IS NOT NULL AND char_length(nome_arquivo) BETWEEN 1 AND 255
    AND tamanho_bytes IS NOT NULL AND tamanho_bytes BETWEEN 1 AND 52428800
    AND hash_conteudo IS NOT NULL AND hash_conteudo ~ '^[0-9a-f]{64}$'
    AND versao_minuta IS NOT NULL AND versao_minuta >= 1
    AND incluido_por_membership_id IS NOT NULL AND incluido_por IS NOT NULL
    AND (
      -- Legado (0048): referência externa + hash informado. Só leitura.
      (origem IN ('email_anexo', 'referencia_externa')
        AND armazenado_id IS NULL
        AND referencia_armazenamento IS NOT NULL AND char_length(referencia_armazenamento) BETWEEN 1 AND 1000
        AND tipo_conteudo IN ('application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp', 'image/heic'))
      OR
      -- Produção P1: arquivo real no armazenamento interno.
      (origem = 'armazenamento_interno'
        AND armazenado_id IS NOT NULL AND armazenado_id = id
        AND referencia_armazenamento IS NULL
        AND tipo_conteudo IN ('application/pdf', 'image/png', 'image/jpeg'))
    )
  )
);
ALTER TABLE documentos ADD CONSTRAINT documentos_armazenado_so_interno CHECK (
  armazenado_id IS NULL OR (origem = 'armazenamento_interno' AND minuta_id IS NOT NULL)
);

-- Minuta NOVA exige arquivo armazenado — garantido pelo registro (que só
-- aceita `documento.documentoId` de um documento DISPONIVEL) e pelo gate de
-- encerramento (que não aceita evidência sem arquivo disponível). As linhas
-- legadas continuam válidas e legíveis; nada aqui as reescreve.

-- O vínculo `documentos` ↔ `documentos_armazenados` é coerente no COMMIT:
-- mesmo id, mesma minuta e versão, mesmo contêiner/organização, mesmo
-- conteúdo (hash/tamanho/tipo calculados pelo servidor), documento vinculado.
CREATE OR REPLACE FUNCTION documentos_armazenado_coerente() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM documentos_armazenados a
    WHERE a.id = NEW.armazenado_id AND a.organization_id = NEW.organization_id
      AND a.container_id = NEW.container_id AND a.processo_id = NEW.processo_id
      AND a.minuta_id = NEW.minuta_id AND a.versao = NEW.versao_minuta
      AND a.sha256 = NEW.hash_conteudo AND a.tamanho_bytes = NEW.tamanho_bytes
      AND a.tipo_detectado = NEW.tipo_conteudo AND a.nome_original = NEW.nome_arquivo
      AND a.estado IN ('DISPONIVEL', 'SUBSTITUIDO')
  ) THEN
    RAISE EXCEPTION 'documentos %: vinculo incoerente com o documento armazenado', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER documentos_armazenado_coerente
  AFTER INSERT ON documentos
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.armazenado_id IS NOT NULL)
  EXECUTE FUNCTION documentos_armazenado_coerente();
