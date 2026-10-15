-- Demurrage Engine V2 — migration ADITIVA (Produção P1, Entrega 2 v1.1 —
-- corretiva #2, achado #2 da auditoria). 0001-0042 NÃO são reescritas.
--
-- Achado: o desenho anterior (migration 0042, `acoes/idempotencia.ts`'s
-- `comIdempotencia()`) separava a ESCRITA DE NEGÓCIO (INSERT em `minutas`,
-- dentro de `ClosingService.registrarMinuta`, pelo pool compartilhado) da
-- ESCRITA DA IDENTIDADE DE IDEMPOTÊNCIA (INSERT em
-- `demurrage_acoes_idempotencia`, por uma conexão dedicada, SÓ DEPOIS de o
-- serviço já ter retornado) — duas transações distintas, com uma janela de
-- falha real entre elas: se o processo morresse (ou o INSERT da identidade
-- falhasse) depois do COMMIT da minuta e antes do COMMIT da identidade, a
-- minuta ficava PERSISTIDA sem nenhuma chave de idempotência associada — um
-- retry com a MESMA chave não encontrava nada e criava uma SEGUNDA minuta
-- (dual-write). Além disso, a chave `(organization_id, rota, chave)` sozinha
-- não amarrava a NENHUM contêiner nem ao conteúdo do pedido: a mesma chave
-- reaproveitada com outro contêiner, outro número informado, outra data ou
-- outra evidência devolvia o resultado antigo sem nenhuma verificação.
--
-- Correção: a identidade de idempotência passa a viver nas MESMAS colunas
-- da própria linha de negócio que ela protege. Quatro colunas NOVAS e
-- NULÁVEIS em `minutas` — `container_id` já existe na tabela, então a
-- amarração ao contêiner-alvo é automática, pela própria linha, sem
-- precisar repeti-la. Um ÚNICO `INSERT ... ON CONFLICT (...) DO NOTHING
-- RETURNING *` (ver `acoes/minutaIdempotencia.ts`) faz a escrita de negócio
-- E a reivindicação da idempotência no MESMO statement atômico — não há
-- duas transações, não há janela de falha entre elas (prova estrutural:
-- não um teste de corrida que PODE nunca pegar a janela, mas a ausência da
-- própria janela, por construção). Minutas que NÃO usam idempotência (todo
-- chamador pré-existente — D15-A, D16, testes — que chama
-- `MinutaRepository.criarRecebida`/`ClosingService.registrarMinuta`
-- diretamente, sem cabeçalho `Idempotency-Key`) continuam com essas quatro
-- colunas NULL, sem nenhuma restrição nova sobre elas: o índice único
-- abaixo é PARCIAL, só sobre linhas com `idempotencia_chave` não-nula.
--
-- `demurrage_acoes_idempotencia` (0042) permanece intacta e no lugar —
-- continua disponível para qualquer AÇÃO FUTURA desta mesma família que não
-- precise amarrar a identidade a uma linha de negócio específica. O
-- registro de minuta simplesmente deixa de ser cliente dela: a rota de
-- minuta passa a chamar só `acoes/minutaIdempotencia.ts`. Uma chave antiga
-- (gravada ali por uma chamada ANTERIOR a esta corretiva, sob
-- `rota = 'registrar_minuta'`) nunca é confiada silenciosamente — não tem
-- hash de pedido nem amarração a contêiner, então não há como provar
-- identidade; `acoes/minutaIdempotencia.ts` detecta essa chave legada
-- explicitamente e rejeita a reutilização com um código fechado
-- (`idempotency_key_legado_sem_hash`), nunca "adivinhando" o contêiner ou o
-- conteúdo de um pedido antigo.
ALTER TABLE minutas
  ADD COLUMN idempotencia_organizacao_id UUID REFERENCES organizations(id),
  ADD COLUMN idempotencia_rota TEXT,
  ADD COLUMN idempotencia_chave TEXT,
  ADD COLUMN idempotencia_hash TEXT;

-- As quatro colunas são preenchidas juntas ou nenhuma delas é.
ALTER TABLE minutas ADD CONSTRAINT minutas_idempotencia_coerente CHECK (
  (idempotencia_organizacao_id IS NULL) = (idempotencia_rota IS NULL)
  AND (idempotencia_rota IS NULL) = (idempotencia_chave IS NULL)
  AND (idempotencia_chave IS NULL) = (idempotencia_hash IS NULL)
);

-- Índice único PARCIAL: a identidade de idempotência (org+rota+chave) nunca
-- se repete entre DUAS linhas de minuta — mas só é exigida de quem a usa.
-- Mesma chave textual em OUTRA organização é uma chave INDEPENDENTE (nunca
-- cruza organização, mesmo padrão já estabelecido em
-- `demurrage_acoes_idempotencia`, 0042).
CREATE UNIQUE INDEX minutas_idempotencia_unica
  ON minutas (idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave)
  WHERE idempotencia_chave IS NOT NULL;

-- Append-only na IDENTIDADE de idempotência (nunca no resto da linha —
-- `estado_minuta`/`data_validada`/etc. continuam mutáveis pelo ciclo normal
-- de validação): depois de reivindicada, a identidade nunca muda — nenhum
-- código, presente ou futuro, pode "mover" uma chave já comprometida para
-- outro contêiner/hash. Mesma convenção e mesmo desenho de
-- `forbid_handoff_evento_identidade_change` (migration 0040).
CREATE OR REPLACE FUNCTION forbid_minuta_idempotencia_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.idempotencia_chave IS NOT NULL AND (
       NEW.idempotencia_organizacao_id IS DISTINCT FROM OLD.idempotencia_organizacao_id
    OR NEW.idempotencia_rota IS DISTINCT FROM OLD.idempotencia_rota
    OR NEW.idempotencia_chave IS DISTINCT FROM OLD.idempotencia_chave
    OR NEW.idempotencia_hash IS DISTINCT FROM OLD.idempotencia_hash
  ) THEN
    RAISE EXCEPTION 'minutas %: identidade de idempotencia e imutavel apos criada', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER minutas_idempotencia_imutavel
  BEFORE UPDATE ON minutas
  FOR EACH ROW EXECUTE FUNCTION forbid_minuta_idempotencia_change();
