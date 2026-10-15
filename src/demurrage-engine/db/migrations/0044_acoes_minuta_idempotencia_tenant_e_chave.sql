-- Demurrage Engine V2 — migration ADITIVA (Produção P1, Entrega 2 v1.2 —
-- corretiva final de integridade). 0001-0043 NÃO são reescritas.
--
-- Achado #1: a migration 0043 amarra a identidade de idempotência da minuta
-- (idempotencia_organizacao_id/idempotencia_rota/idempotencia_chave/
-- idempotencia_hash) à MESMA linha do contêiner-alvo (container_id), mas
-- NENHUMA restrição do banco provava que as duas organizações — a
-- organização da IDENTIDADE DE IDEMPOTÊNCIA e a organização REAL do
-- contêiner-alvo — eram a MESMA. A rota HTTP confere isso (`organizacaoDoContainer`,
-- em `demurrageAcoesRoutes.ts`) ANTES de chamar `registrarMinutaIdempotente`,
-- mas essa função é exportada de `acoes/minutaIdempotencia.ts` e qualquer
-- chamador direto (um job futuro, outra rota, um teste, um script de
-- migração de dados) podia gravar `idempotencia_organizacao_id = A` numa
-- minuta cujo `container_id` pertence à organização B — o banco aceitava.
--
-- Correção: a MESMA técnica já estabelecida em `demurrage_pendencias`,
-- `container_equipamento_original`, `cvc_container_org_fk` etc. (todas em
-- 0020/0028) — uma FK COMPOSTA `(container_id, idempotencia_organizacao_id)
-- REFERENCES containers (id, organization_id)`. A âncora já existe:
-- `containers_id_org_unique UNIQUE (id, organization_id)` foi criada na
-- migration 0020 — não precisa de nenhuma unique key nova.
--
-- Semântica MATCH SIMPLE (padrão do PostgreSQL para FK composta): a
-- restrição só é AVALIADA quando NENHUMA coluna referenciadora é NULL. Uma
-- minuta legada/sem idempotência (`idempotencia_organizacao_id IS NULL`) é
-- trivialmente satisfeita — nunca precisa combinar com `containers.id` nem
-- `containers.organization_id`. Isso preserva INTACTAS todas as linhas
-- gravadas antes desta migration (idempotentes ou não) e todo chamador que
-- nunca usa idempotência (D15-A, D16, testes — ver nota de cabeçalho da
-- 0043). Só a MINORIA de linhas que de fato carrega uma identidade de
-- idempotência (`idempotencia_chave IS NOT NULL`, o que pela CHECK
-- `minutas_idempotencia_coerente` da 0043 implica as quatro colunas
-- preenchidas) fica sujeita à nova FK — exatamente o universo onde o
-- achado #1 se aplica.
--
-- Esta é uma garantia de BANCO, não de rota: o mesmo padrão de defesa em
-- profundidade já usado em todo este módulo (ex.: `processos_responsavel_membership_same_org_fk`,
-- 0006) — correta mesmo que um chamador futuro esqueça a checagem de
-- organização que a rota faz hoje.
ALTER TABLE minutas
  ADD CONSTRAINT minutas_idempotencia_organizacao_do_container
  FOREIGN KEY (container_id, idempotencia_organizacao_id)
  REFERENCES containers (id, organization_id);

-- Achado #3 (parte de banco): `idempotencia_chave` é hoje um TEXT sem limite
-- — um cabeçalho `Idempotency-Key` arbitrariamente grande pode ultrapassar o
-- tamanho máximo de entrada de um índice B-tree do PostgreSQL (o índice
-- único PARCIAL `minutas_idempotencia_unica`, da 0043, indexa exatamente
-- esta coluna), produzindo um erro interno do Postgres em vez de uma
-- resposta de contrato fechada. Defesa em profundidade: a validação de
-- transporte (`acoes/idempotencyKey.ts`) já rejeita isso ANTES de chegar ao
-- banco (400 `idempotency_key_invalida`), mas o banco também passa a
-- recusar, por si só, qualquer linha cuja chave exceda o limite —
-- independente de qual caminho de código a escreveu. Chaves legadas (NULL)
-- continuam permitidas: a CHECK só se aplica quando a coluna não é nula.
ALTER TABLE minutas ADD CONSTRAINT minutas_idempotencia_chave_tamanho CHECK (
  idempotencia_chave IS NULL OR char_length(idempotencia_chave) <= 200
);
