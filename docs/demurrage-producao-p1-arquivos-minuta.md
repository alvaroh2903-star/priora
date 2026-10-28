# Produção P1 — Armazenamento definitivo dos arquivos das minutas

> **Entrega NÃO congelada.** Esta entrega não declara a Produção P1
> concluída. Frontend, HTML, CSS, JavaScript de apresentação e design **não**
> foram alterados (§16). Integração produtora da Liberação e
> multiorganização **não** foram iniciadas.

Motivo da entrega: até aqui a minuta guardava só uma REFERÊNCIA ao arquivo
(anexo do Graph ou chave externa) e um hash INFORMADO pelo cliente
(`documentos`, migration 0048). O arquivo real não era preservado nem
recuperável pela Priora. Esta entrega troca esse modelo por armazenamento
real, privado e auditável: o binário vai para um armazenamento de objetos
compatível com S3; o PostgreSQL guarda metadados, estados, tentativas, vínculos
e eventos.

Caminhos relativos a `src/demurrage-engine/` salvo indicação.

---

## 1. Baseline

- Branch `claude/practical-cerf-mnz7oj`, HEAD
  `2331eea01034ecad2a4a116a2c6394e1a9f29df5` ("congela formalmente a
  administração operacional de tarifas"), árvore limpa e igual ao remoto
  antes de qualquer edição.
- Entregas congeladas preservadas: Entregas 1/2/3, autenticação/identidade/
  atribuição/filas pessoais (`8266fba`), administração tarifária (`39fe34b`,
  congelamento em `2331eea` — não repetido aqui).
- Última migration no baseline: 0052. Esta entrega acrescenta só a **0053**
  (aditiva). 0001–0052 não foram alteradas.

---

## 2. Diagnóstico (antes de qualquer edição)

Feito com leitores paralelos, somente leitura (notas de trabalho fora do
repositório). Respostas aos oito itens pedidos:

1. **Armazenamento existente:** nenhum binário é armazenado em lugar nenhum
   (V1 ou V2). `documentos` (0016/0048) guarda referência + hash informado,
   append-only, 1:1 com a minuta. Anexos do Graph (auditoria, pré-alerta,
   Shipping Instructions) são lidos em memória e descartados. Arquivos JSON
   locais em `.data/` são estado da V1 (courier, bot, marcação de minuta
   solicitada), sem binário de documento.
2. **Provedores/abstrações reaproveitáveis:** nenhum provedor de objetos, SDK
   S3, assinatura SigV4, multipart ou upload. Reaproveitados: SHA-256/HMAC do
   `crypto`, classificação fechada de erros (`acoes/erros.ts`), CSRF por
   `Origin` (`auth/origemConfiavel.ts`), o normalizador de `Idempotency-Key`
   (`acoes/idempotencyKey.ts`), o protocolo de lock do processo
   (`lockProcesso`) e o harness de app real dos testes.
3. **Uso de `documentos`:** só o registro de minuta escreve (uma linha por
   minuta, mesma transação, trigger que exige o documento no COMMIT); leitura
   em `GET /v2/minutas/:id/documento` (contrato v1) e metadados no detalhe do
   contêiner. Toda linha existente é do fluxo 0048 (referência externa).
4. **Serviço compatível com S3:** nenhum configurado. O deploy é Render free
   (disco efêmero) com `NODE_VERSION 20`; o `undici` instalado exige Node ≥
   22.19, por isso o cliente usa `http`/`https` nativos.
5. **Configuração e segredos:** variáveis de ambiente lidas no boot; erros de
   configuração do handoff citavam o VALOR na mensagem — o padrão novo cita só
   o nome da variável.
6. **Limites e formatos:** o CHECK de `documentos` aceitava seis tipos
   (PDF, PNG, JPEG, TIFF, WEBP, HEIC) até 50 MiB, sem conferir o conteúdo;
   `express.json` global com 100 kB (não consome corpo binário).
7. **Inspeção de malware:** não existe antivírus nem integração de inspeção.
8. **Minutas legadas:** todas as linhas de `documentos` são categoria B
   (fluxo técnico 0048, referência + hash informado); minutas pré-0048
   aprovadas por gestor (categoria A, VALIDADA) não têm documento.

---

## 3. Provedor escolhido

Abstração pequena `documentos/armazenamento.ts` (`ArmazenamentoObjetos`:
`gravar` em streaming, `inspecionar`, `ler` em streaming, `apagar`,
`listar`, `verificarAcesso`). Erros só por classes com código fechado
(`ErroArmazenamento{INDISPONIVEL|NEGADO|TEMPO_ESGOTADO|RESPOSTA_INVALIDA|
ORIGEM_INTERROMPIDA}`, `ObjetoAusente`) — nunca mensagem, URL, chave, bucket
ou corpo do provedor.

Implementações:

| Provedor | Arquivo | Uso |
|---|---|---|
| **S3 compatível** | `documentos/armazenamentoS3.ts` | **Produção.** Cliente SigV4 mínimo sobre `http`/`https` nativos (sem dependência nova). PUT em streaming com `Content-Length` e `UNSIGNED-PAYLOAD`, HEAD, GET em streaming, DELETE, ListObjectsV2 paginado, HEAD do bucket. Funciona com AWS S3, Cloudflare R2, Backblaze B2 e MinIO. |
| Memória | `documentos/armazenamentoMemoria.ts` | **Só testes.** Falhas programáveis por operação, pausa no fim da gravação (concorrência), registro de chaves apagadas. A configuração de produção nunca o seleciona. |
| Filesystem de desenvolvimento | `documentos/armazenamentoFilesystemDev.ts` | **Só desenvolvimento**, com `DEMURRAGE_ARQUIVOS_PROVEDOR=filesystem-dev` explícito. Em produção o boot recusa. Nunca é fallback. |

Assinatura conferida com os vetores oficiais da documentação da AWS e com uma
requisição canônica path-style + `UNSIGNED-PAYLOAD` escrita à mão
(`arquivosMinutaP1S3.test.ts` S3#1/S3#2). Desambiguação de 404: um HEAD de
objeto que responde 404 é confirmado com HEAD do bucket; GET/DELETE leem só o
`<Code>` do XML de erro (em memória, nunca logado) — bucket ou endpoint
errado vira `INDISPONIVEL`, nunca "objeto ausente".

---

## 4. Configuração

| Variável | Padrão | Papel |
|---|---|---|
| `DEMURRAGE_ARQUIVOS_PROVEDOR` | — | `s3` (produção, obrigatório) ou `filesystem-dev` (só fora de produção). Vazio fora de produção = não configurado (rotas 503 `armazenamento_nao_configurado`; registro de minuta impossível). **Vazio em produção derruba o boot.** |
| `DEMURRAGE_ARQUIVOS_S3_ENDPOINT` | — | URL do serviço; **HTTPS obrigatório em produção**; recusado com credencial, query ou fragmento. |
| `DEMURRAGE_ARQUIVOS_S3_REGIAO` | — | Obrigatória (`auto` só vale para o Cloudflare R2). |
| `DEMURRAGE_ARQUIVOS_S3_BUCKET` | — | Nome do bucket privado. Com ponto, exige `PATH_STYLE=true`. |
| `DEMURRAGE_ARQUIVOS_S3_ACCESS_KEY_ID`, `DEMURRAGE_ARQUIVOS_S3_SECRET_ACCESS_KEY` | — | Credencial da aplicação (segredo). |
| `DEMURRAGE_ARQUIVOS_S3_PATH_STYLE` | `true` | Endereçamento `https://host/bucket/chave`; `false` = virtual-hosted. |
| `DEMURRAGE_ARQUIVOS_TAMANHO_MAXIMO_BYTES` | 26214400 (25 MiB) | Limite por arquivo; teto 50 MiB (CHECK). |
| `DEMURRAGE_ARQUIVOS_UPLOAD_EXPIRA_MIN` | 1440 | Prazo de um upload PENDENTE nunca concluído. |
| `DEMURRAGE_ARQUIVOS_ENVIO_POSSE_MIN` | 15 | Posse de um envio (PUT); também é o teto de duração de uma tentativa (posse − 10 s). |
| `DEMURRAGE_ARQUIVOS_NAO_VINCULADO_EXPIRA_DIAS` | 30 | Documento DISPONIVEL nunca vinculado a minuta expira (abandonado). |
| `DEMURRAGE_ARQUIVOS_REMOCAO_CARENCIA_DIAS` | 30 | Carência da remoção AUTOMÁTICA de objeto completo nunca vinculado (§10). |
| `DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA` | `true` | Etapa de limpeza do tick (desligar depois de restaurar o banco de um backup). |
| `DEMURRAGE_ARQUIVOS_TIMEOUT_MS` | 30000 | Ociosidade máxima de uma requisição ao provedor. |
| `DEMURRAGE_ARQUIVOS_DIR` | — | Só `filesystem-dev`. |

Configuração inválida derruba o boot com mensagem que cita só o **nome** da
variável (`documentos/configuracao.ts`). Uma sonda não fatal no boot
(`verificarArmazenamentoNoBoot`, `src/app.ts`) faz HEAD do bucket e loga só o
código fechado. O boot também exige o schema da 0053.

**Limite de tempo de upload:** o servidor HTTP do Node corta uma requisição em
300 s (`server.requestTimeout`, não alterado). Com o tamanho padrão de 25 MiB,
a vazão mínima do cliente é ~0,7 Mbit/s; arquivos maiores exigem vazão
proporcional.

---

## 5. Segurança

- **Privado:** nenhuma URL pública, assinada ou permanente é emitida. Upload
  e download passam pelo backend com a sessão. A chave do objeto nunca sai do
  backend (respostas, leituras e eventos não a carregam).
- **Isolamento:** a organização vem só da sessão (`autorizarInterno`).
  Leituras (metadados, versões, download) aplicam organização e escopo no
  próprio WHERE (`responsavelExigidoNaLeitura`): outra organização, ANALYST
  fora do processo atribuído e id inexistente recebem o MESMO `404
  nao_encontrado` — inclusive com id de documento legado, antes de qualquer
  resposta 409. Ações (iniciar, enviar, concluir) revalidam membership ativo,
  papel e responsável sob `lockProcesso` (o mesmo lock da atribuição): ANALYST
  só no processo atribuído (`403 ator_nao_responsavel`), MANAGER/ADMIN em
  qualquer processo da organização. Enviar e concluir só pelo AUTOR do upload
  (`403 ator_nao_autor`), revalidado também no UPDATE final do envio. CLIENT
  não obtém sessão interna.
- **Conteúdo:** o tipo é decidido pela ASSINATURA dos primeiros bytes
  (`documentos/formato.ts`), sem tolerância a lixo antes dela (poliglotas).
  Aceitos: PDF (`%PDF-`), PNG (8 bytes), JPEG (`FF D8 FF`). Recusados:
  executáveis (MZ, ELF, Mach-O, `#!`), compactados (ZIP, GZIP, RAR, 7z, BZ2,
  XZ, ZSTD), marcação (HTML, SVG, XML), texto e desconhecidos — com `415`. O
  tipo detectado precisa ser o declarado. O fim do arquivo é conferido (PDF
  `%%EOF`, PNG `IEND`) contra conteúdo truncado; para JPEG o marcador final só
  é registrado (fotos com dados após o `FFD9` são legítimas).
- **Sem inspeção de malware:** não existe inspetor no sistema e nenhuma
  verificação falsa foi criada. Risco registrado (§15): todo documento fica
  `inspecao = NAO_REALIZADA`. Mitigação: entrega SEMPRE como anexo
  (`Content-Disposition: attachment`), `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `X-Frame-Options: DENY`, `Cache-Control: private, no-store`,
  `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`,
  cabeçalho `X-Priora-Inspecao`. Ponto de integração futuro: a inspeção pode
  evoluir (NAO_REALIZADA → PENDENTE → APROVADA|REPROVADA) também em documento
  já DISPONIVEL; o download recusa PENDENTE/REPROVADA (`409
  documento_bloqueado`); o estado QUARENTENA existe no modelo para o upload
  com inspetor.
- **Nome do arquivo:** o nome original é sanitizado (NFC, sem caminho,
  controle, reservados ou controles bidirecionais) e guardado só como
  metadado. O nome de ENTREGA é gerado pelo servidor (`minuta-<contêiner>-v<n>`
  com a extensão do tipo detectado) — nenhuma injeção de parâmetro no
  `Content-Disposition`.
- **Download sob demanda do próprio site:** GET com efeito (auditoria) exige
  `Sec-Fetch-Site` same-origin/none, ou `Referer` da própria origem; senão
  `403 origem_nao_permitida` sem tocar o provedor. `HEAD` responde 405.
- **Integridade no download:** o SHA-256 e o tamanho são conferidos durante a
  transmissão; o último pedaço é retido até a conferência — conteúdo
  divergente nunca chega "completo" ao cliente (evento `INTEGRIDADE_DIVERGENTE`).
- **Logs:** só códigos fechados. Nenhum log contém chave do objeto, bucket,
  endpoint, credencial, cabeçalho assinado, nome de arquivo, conteúdo ou corpo
  do provedor (testes A#31 e S3#5 capturam o `console` com o provedor
  devolvendo XML que repete chave e id de acesso).
- **Fluxos:** nenhum `'error'` sem tratador; o envio ao provedor usa
  `stream.pipeline`; aborto do navegador ou do provedor nunca derruba o
  processo.

---

## 6. Estados

`documentos_armazenados.estado`:

| Estado | Significado |
|---|---|
| `PENDENTE` | Upload iniciado; conteúdo ainda não recebido, ou recebido e não confirmado. |
| `DISPONIVEL` | Objeto confirmado no armazenamento (existência e tamanho). Vinculável a uma minuta. |
| `QUARENTENA` | Reservado para inspetor futuro (aguardando veredito). |
| `FALHOU` | Conteúdo recusado, objeto não confirmado, ou upload abandonado (nunca vinculado). Terminal. |
| `SUBSTITUIDO` | Documento de uma minuta substituída por versão nova. Continua baixável. |

Transições permitidas (trigger `documentos_armazenados_guarda`): PENDENTE →
DISPONIVEL | QUARENTENA | FALHOU; QUARENTENA → DISPONIVEL | FALHOU;
DISPONIVEL → SUBSTITUIDO; DISPONIVEL → FALHOU só se nunca vinculado
(abandonado). DELETE proibido. Identidade, declaração, conteúdo recebido
(chave, hash, tamanho, tipo), vínculo com a minuta e datas de estado são
imutáveis depois de gravados. Tentativas de envio
(`documentos_armazenados_envios`): EM_ANDAMENTO → ACEITO | DESCARTADO.

---

## 7. Upload e download

Rotas (`src/routes/demurrageDocumentosRoutes.ts`, montadas em
`/api/demurrage/v2/documentos`; mutações exigem `Idempotency-Key`):

| Rota | Efeito |
|---|---|
| `POST /uploads` `{containerId, nomeOriginal, tipoDeclarado, tamanhoBytes, sha256?}` | Autoriza (sessão, membership ativo, organização, responsável), valida tamanho (413) e tipo (415), cria o documento PENDENTE com prazo. Resposta: o documento e `envio {metodo:'PUT', caminho, tamanhoBytes, tipoConteudo, expiraEm}` — caminho do próprio backend. Mesma chave + mesmo pedido = réplica (200); outro pedido = 409. |
| `PUT /uploads/:id/conteudo` (corpo binário) | Toma a posse (um envio por vez), registra a tentativa com chave NOVA, transmite ao provedor em streaming calculando SHA-256, tamanho, tipo pela assinatura e fim; grava o recebimento com UPDATE condicionado ao token e ao ator ainda autorizado. `Content-Length` obrigatório e igual ao declarado; `Content-Type` igual ao declarado. |
| `POST /uploads/:id/concluir` | HEAD da chave recebida (existência e tamanho) → DISPONIVEL (`inspecao NAO_REALIZADA`). Idempotente pelo estado. |
| `GET /:id` | Estado e metadados (interno ou legado). |
| `GET /:id/conteudo` | Download autenticado, transmitido pelo backend, sempre anexo, auditado (`DOWNLOAD`). |
| `GET /containers/:containerId/versoes` | Versões do contêiner (armazenadas e legadas). |

**Consistência do envio:** nenhuma transação, lock ou conexão do pool fica
retida durante a transmissão (a posse é coluna). Cada tentativa grava numa
chave nova registrada antes do primeiro byte; a chave do documento é a da
tentativa ACEITA. Uma tentativa atrasada (posse vencida) só toca a PRÓPRIA
chave — nunca sobrescreve nem apaga o arquivo de um documento confirmado
(teste A#28). Falha de origem, provedor ou banco mantém o upload PENDENTE e
libera a posse (retry seguro); conteúdo recusado leva a FALHOU. A remoção de
qualquer objeto acontece depois de o banco registrar a chave como
descartável — e só se a tentativa estiver DESCARTADA e nenhum documento usar
a chave (a tentativa ACEITA nunca é apagada, nem quando a confirmação do
COMMIT se perde; teste R1). Cliente que para de enviar no meio do corpo é
origem interrompida — `400 envio_interrompido`, tentativa
`origem_interrompida` — seja pelo nosso tempo ocioso
(`DEMURRAGE_ARQUIVOS_TIMEOUT_MS` sem nenhum byte à espera do provedor e com a
origem aberta), seja pelo do provedor quando vence antes (S3: `400
RequestTimeout` com a origem aberta e nada à espera dele); provedor parado com
bytes à espera dele continua `502 armazenamento_indisponivel` (testes
R4a/R4c/R4b). O teto da tentativa (posse − 10 s, decisão do servidor)
prevalece: `408 envio_excedeu_o_tempo`, tentativa `posse_perdida` (R8).

**Expiração:** não existe URL; o caminho de envio é recusado depois de
`expiraEm` (410); o download morre com a sessão (logout, revogação, vida
absoluta → 401) e com o membership: desativado o único vínculo interno, as
sessões do usuário são revogadas → 401 (teste A#13); se o usuário mantém outro
vínculo interno ativo, a organização desativada responde `403
membership_inativo` quando é a organização ativa escolhida, e o documento dela
some (404) quando a sessão passa à outra organização.

---

## 8. Integração com a minuta

`POST /api/demurrage/v2/acoes/containers/:containerId/minutas` — corpo
`{numeroInformado, dataInformada, evidenciaRef?, documento: {documentoId}}`.
A forma antiga (referência + hash informado) → `400 documento_invalido`
`{campo:'documentoId', detalhe:'referencia_externa_descontinuada'}`. Hash de
idempotência v3 (`acoes.registrar_minuta.v3`, com o `documentoId`).

Na transação única de `registrarMinutaTecnica` (`closing/minutaTecnica.ts`),
depois do lock, do ator/responsável e da réplica idempotente (a réplica não
reconsulta o documento — o retry com resposta perdida devolve 200 e a mesma
minuta), o documento armazenado é travado (`FOR UPDATE`): do mesmo contêiner e
organização (`404 documento_nao_encontrado`), DISPONIVEL, nunca vinculado
(`409 documento_ja_vinculado`), objeto não marcado ausente e inspeção não
reprovada (`409 documento_indisponivel {estado, detalhe}`). O documento da
minuta substituída vira SUBSTITUIDO (antes do vínculo do novo — índice de
vigente único), o novo é vinculado (`minuta_id`, `versao`, `substitui_id`) e a
linha de `documentos` é gravada com origem `armazenamento_interno`, o MESMO id
e o nome/tipo/tamanho/hash CALCULADOS pelo servidor. Triggers adiáveis
conferem no COMMIT a coerência do vínculo e da cadeia de substituição.
Verificação técnica, pendências (divergência/inconsistência) e encerramento
automático seguem como antes. **Nenhuma aprovação de gestor.**

**Encerramento** (`closing/closingService.ts`, gate): para contêiner COM
demurrage, o ÚLTIMO requisito é o arquivo real da minuta usada como
evidência — documento armazenado DISPONIVEL, objeto não marcado ausente,
inspeção não reprovada — senão `minuta_sem_arquivo_disponivel`. Usa só a
versão vigente (uma versão anterior disponível não conta). Vale para o
encerramento automático e para o acionamento administrativo. Contêiner sem
demurrage continua encerrando sem minuta (e sem arquivo). O motivo do bloqueio
aparece em `encerramento.bloqueio` da fila e do detalhe (leitura já
existente) — as filas não foram alteradas.

**Leituras (aditivas):** `GET /v2/minutas/:id/documento` passa ao contrato
`demurrage.leitura.documento-minuta.v2` (`armazenamento`, `arquivo {estado,
disponivel, inspecao, tipoDetectado, tamanhoBytes, sha256,
substituidoPorDocumentoId}`; `referencia` só para legado); o detalhe do
contêiner ganha `minutas[].documento.armazenamento` e `.disponivel`.

---

## 9. Reconciliação

`npm run demurrage:arquivos -- diagnosticar [--verificar-hash] [--sem-orfaos]`
(somente leitura) e `npm run demurrage:arquivos -- corrigir --operador "<nome>"
--motivo "<texto>" [--verificar-hash] [--limite-ausentes 0.2]`
(`documentos/cli.ts`, `documentos/reconciliacao.ts`). Saída JSON, sem chave.

- **Diagnóstico:** uploads abandonados, posses vencidas, tentativas
  abandonadas, remoções pendentes, não vinculados expirados, registros
  confirmados sem objeto ou com tamanho/hash divergente, marcados ausentes,
  objetos órfãos (por impressão — SHA-256 da chave, 16 hex), leitura anônima
  do bucket (precisa ser recusada) e, para contêiner com demurrage em
  processo OPEN, o que bloqueia o encerramento por falta de arquivo (mesmo
  predicado do gate): `legadoBloqueante` (evidência LEGADA — `categoria`
  `REFERENCIA_EXTERNA` ou `LEGADO_SEM_ARQUIVO`, e `devolucaoSoLegada`, §10) e
  `arquivoIndisponivelBloqueante` (arquivo INTERNO da minuta vigente
  indisponível — objeto marcado ausente, estado, inspeção: incidente, não
  legado; teste R3) + `bloqueadosSemArquivo`. Saída `3` (alerta) com problema
  de integridade, leitura anônima permitida ou arquivo interno indisponível
  bloqueando.
- **Correção controlada:** primeiro a sanidade, sem nenhuma escrita (bucket
  acessível; havendo documentos confirmados, ao menos um objeto encontrado —
  outro bucket aborta tudo); depois expira abandonados, remove objetos de
  chaves descartáveis, marca "objeto ausente" (aborta a marcação se a
  proporção passar do limite — sinal de configuração errada) e desmarca o que
  reapareceu íntegro (`OBJETO_RESTABELECIDO`). Tudo auditado com operador.
- **Nunca:** apaga órfão, apaga objeto de documento confirmado, apaga linha.
- **Etapa do tick** (última, isolada, com orçamento de tempo e interrompida
  na primeira falha do provedor): expira abandonados e remove objetos
  descartáveis; objeto completo nunca vinculado só depois da carência.
- O download nunca marca ausência: registra `OBJETO_AUSENTE_DETECTADO` e
  responde 409.

---

## 10. Legado

Linhas de `documentos` com origem `email_anexo`/`referencia_externa`
(categoria B) e minutas pré-0048 aprovadas por gestor (categoria A) ficam
exatamente como estão. Leitura: `armazenamento: 'REFERENCIA_EXTERNA'`,
`armazenadoInternamente: false`, `estado: 'NAO_ARMAZENADO'`, `disponivel:
false`, `hashInformado`; download → `409 arquivo_nao_armazenado` (isolamento
idêntico ao interno). Nenhum objeto é fabricado e nada é declarado
disponível. Fechamentos históricos (processos FINAL) não são tocados.

**Mudança de comportamento:** em processo OPEN, contêiner COM demurrage cuja
evidência é legada (B ou A) não encerra mais — `minuta_sem_arquivo_disponivel`.
Migração explícita: o analista envia o arquivo original e registra nova minuta
(nova versão), que substitui a legada; a linha legada permanece. Consulta de
pré-deploy: `diagnosticar` → `legadoBloqueante`.

**Atenção — `devolucaoSoLegada: true`** (legado A cuja devolução usada pelos
relógios existe só na validação humana antiga: tracking sem devolução ou com
outra data). A substituição de uma minuta legada limpa essa devolução efetiva
(regra congelada da correção de minuta/encerramento, risco 6 do relatório
`demurrage-producao-p1-correcao-minuta-encerramento.md`): os relógios voltam
ao tracking e a nova minuta fica aguardando a devolução do tracking (risco 10,
"armador sem tracking"). Para esses contêineres, registrar a nova versão só
quando o tracking trouxer a devolução — antes disso, nada encerra (nem pelo
acionamento administrativo, que usa o mesmo gate). Nenhuma devolução é
fabricada pela minuta. Volume esperado: zero (aquele relatório registra que o
fluxo antigo nunca rodou em produção); a consulta existe para confirmar.

---

## 11. Retenção

Documento confirmado nunca é apagado (DELETE proibido por trigger;
substituição não exclui; nenhuma limpeza de histórico). Só uploads nunca
vinculados expiram: PENDENTE depois de `UPLOAD_EXPIRA_MIN`, DISPONIVEL não
vinculado depois de `NAO_VINCULADO_EXPIRA_DIAS`. Objetos removíveis: de
tentativa DESCARTADA e de documento FALHOU (nunca vinculado). Remoção
automática imediata só de tentativa recusada ou incompleta; objeto completo
nunca vinculado, depois da carência (proteção para banco restaurado de
backup — numa linha do tempo perdida ele pode ter virado documento
confirmado). Recomendado no provedor: versionamento do bucket e credencial
sem `DeleteObjectVersion` (§14).

---

## 12. Migration 0053 (aditiva)

`db/migrations/0053_documentos_armazenados.sql`:
- `documentos_armazenados` (documento, organização, processo, contêiner,
  minuta, versão, chave opaca `doc/v1/<32 hex>`, nome sanitizado, tipo
  declarado e detectado, tamanho declarado e recebido, SHA-256 do servidor e
  declarado, autor, instantes, estado, motivo, inspeção, versão substituída e
  substituta, correlação, idempotência, posse); FKs compostas com a
  organização; CHECKs de coerência por estado; trigger de transições e
  imutabilidade; DELETE proibido; organização imutável; contêiner precisa
  pertencer ao processo;
- `documentos_armazenados_envios` (tentativas, chave única por tentativa,
  uma ACEITA por documento; append-only no que importa);
- `documentos_armazenados_eventos` (auditoria append-only);
- `documentos.armazenado_id` + CHECK `documentos_minuta_coerente` trocado por
  um que aceita o ramo legado (idêntico) OU a origem `armazenamento_interno`
  (sem referência, só PDF/PNG/JPEG, mesmo id). Toda linha existente satisfaz o
  ramo legado; nada é reescrito.
- Constraint triggers adiáveis: vínculo `documentos` ↔ armazenado coerente;
  chave do documento = tentativa ACEITA; substituição coerente com a cadeia
  de minutas.

Teste A#32: aplica sobre um banco na 0052 com minuta e documento legados;
nenhuma linha reescrita; legado legível; reexecução no-op.

---

## 13. Testes

Novos (PostgreSQL real, app real com sessão/CSRF/RBAC, armazenamento simulado
localmente, sem rede externa):

- `__tests__/arquivosMinutaP1.test.ts` — obrigatórios 1–19 e 27–32;
- `__tests__/arquivosMinutaP1Encerramento.test.ts` — obrigatórios 20–26;
- `__tests__/arquivosMinutaP1S3.test.ts` — provedor S3 (vetores SigV4,
  servidor S3 falso local, falhas, configuração, filesystem-dev, formato);
- `__tests__/arquivosMinutaP1Revisao.test.ts` — regressões e cobertura da
  revisão adversarial (R1–R8, com R4a–R4c; §17);
- apoio: `arquivosTestHelper.ts`, `s3FalsoServidor.ts`, `minutaTestHelper.ts`
  (`documentoArmazenadoDeTeste`, `minutaAceitaComArquivoDeTeste`).

| # | Obrigatório | Teste |
|---|---|---|
| 1 | PDF/PNG/JPEG válidos | A#1 |
| 2 | tipo declarado divergente | A#2 |
| 3 | formato proibido | A#3 |
| 4 | tamanho acima do limite | A#4 |
| 5 | hash correto | A#5 |
| 6 | idempotência | A#6 |
| 7 | analista responsável | A#7 |
| 8 | analista não responsável | A#8 |
| 9 | MANAGER/ADMIN | A#9 |
| 10 | CLIENT | A#10 |
| 11 | isolamento entre organizações | A#11 |
| 12 | chave opaca | A#12 |
| 13 | expiração da URL | A#13 |
| 14 | objeto ausente | A#14 |
| 15 | falha do storage | A#15 |
| 16 | falha do banco após upload | A#16 |
| 17 | upload abandonado | A#17 |
| 18 | reconciliação | A#18 |
| 19 | headers seguros | A#19 |
| 20 | substituição preservando histórico | A#20 |
| 21 | só a versão atual no encerramento | A#21/A#25 |
| 22 | divergência abrindo pendência | A#22 |
| 23 | sem aprovação de gestor | A#23 |
| 24 | processo com demurrage não encerra sem arquivo | A#24 |
| 25 | encerramento após arquivo disponível e minuta coerente | A#25, A#21/A#25 |
| 26 | contêiner sem demurrage encerra sem minuta | A#26 |
| 27 | legado legível | A#27 |
| 28 | concorrência | A#28 |
| 29 | sessão revogada | A#29 |
| 30 | troca de organização | A#30 |
| 31 | logs sem segredos | A#31, S3#5 |
| 32 | migration aditiva preservando dados | A#32 |

**Testes congelados alterados (inventário e justificativa):**

- *Listas de migrations* (a 0053 aditiva passa a ser a última, mesmo
  precedente das migrations anteriores): `migrate.test.ts`,
  `registroDemurrageV12.test.ts` (lista e última), `responsavelOperacional.test.ts`,
  `demurrageAcoesEntrega2V11.test.ts`, `demurrageAcoesEntrega2V12.test.ts`,
  `minutaEncerramentoP1.test.ts` (também nos dois itens abaixo), `responsabilidadeAuditoria.test.ts`,
  `responsabilidadeV12.test.ts`, `schedulerClaimFencing.test.ts`;
  `migration0007.test.ts` (as três tabelas novas no catálogo de tabelas com
  organização imutável); `testDb.truncateAll` (tabelas novas).
- *Documento da minuta* (a forma por referência não é mais aceita — o
  registro passa a usar um arquivo armazenado do contêiner, um por operação
  lógica, reaproveitado só no retry da mesma chave): `acoesPessoaisP1`,
  `closing`, `closingD15A`, `closingD15AV11`, `d16Vertical`,
  `demurrageAcoesEntrega2`, `demurrageAcoesEntrega2V11`,
  `demurrageAcoesEntrega2V12`, `leituraOperacionalEntrega3`, e todo teste que
  usa `registrarMinutaDeTeste` (o helper cria o arquivo). Nenhuma asserção de
  regra mudou nesses arquivos. Em `minutaEncerramentoP1.test.ts` mudaram
  asserções de CONTRATO do documento (não de regra): o helper `doc()` cria um
  arquivo armazenado; P1 #3/#4 conferem `armazenado_id = id` e o SHA-256
  calculado pelo servidor (antes, o hash informado); P1 #16 espera
  `referencia: null` e `armazenamento: 'INTERNO'` (contrato v2 da leitura);
  revisão #12 espera `campo: 'documentoId'` e recusa a forma por referência
  (`referencia_externa_descontinuada`).
- *Comprovação legada sem arquivo* (regra nova: contêiner com demurrage só
  encerra com o arquivo real): `apuracao.test.ts` (fixture `minutaValidada`
  passa a ser a minuta técnica ACEITA com arquivo), `apuracaoV13.test.ts`
  v1.3-3a (a comprovação legada continua correspondente, mas agora bloqueia
  com `minuta_sem_arquivo_disponivel`; com a minuta ACEITA e o arquivo, o mesmo
  processo encerra), `responsabilidadeDecisao.test.ts` casos 14 e G_final e
  `responsabilidadeV11.test.ts` "v1.1 #3 casos 1-6" e "migração 0032 → 0033"
  (fixture de comprovação com arquivo: `minutaAceitaComArquivoDeTeste` no lugar
  da minuta VALIDADA direta por SQL; as asserções de responsabilidade não
  mudaram), e `minutaEncerramentoP1.test.ts` P1 #18: a asserção exata do
  primeiro bloqueio (`divergencia_pendente` no contêiner `b`) passou a aceitar
  também `minuta_sem_arquivo_disponivel` no contêiner `a` — `a` só tem a
  comprovação legada sem arquivo e o gate percorre os contêineres em ordem de
  id (UUID aleatório), então qual bloqueio aparece primeiro varia; a regra
  antiga (`divergencia_pendente` em `b`) é reafirmada de forma exata logo
  depois (r2), com `a` resolvido.
- *Fixture de comprovação:* `minutaAceitaComArquivoDeTeste` grava
  `tracking_return_date` por SQL quando está vazia (simula a devolução do
  tracking — a minuta nunca fabrica devolução) e registra a minuta técnica
  pelo serviço real, com arquivo armazenado.

Resultados da validação: §18.

---

## 14. Checklist de deploy

Ordem: 1–5 antes de publicar o código; 6 ao publicar; 7 antes de liberar os
analistas.

- [ ] **1. Bucket privado** no provedor S3 compatível escolhido.
  - Nenhum acesso público: no Cloudflare R2, `r2.dev` desligado e nenhum
    domínio próprio conectado; na AWS/B2, Block Public Access ligado e sem
    política pública.
  - Recomendado: versionamento do bucket (objeto apagado ou sobrescrito por
    engano continua recuperável).
- [ ] **2. Credencial da aplicação** com o mínimo: `GetObject`, `PutObject`,
  `DeleteObject` e `ListBucket` no bucket. Sem `ListBucket` a AWS responde 403
  para objeto inexistente e o HEAD do bucket falha. Proibido: `PutBucketPolicy`,
  `PutObjectAcl`, `DeleteObjectVersion`, `BypassGovernanceRetention`.
- [ ] **3. Smoke test manual do provedor** com a credencial (PUT, HEAD, GET,
  LIST e DELETE de um objeto de teste fora de `doc/v1/`).
- [ ] **4. Migration 0053**: `npm run db:migrate:demurrage`; a última de
  `schema_migrations` deve ser `0053_documentos_armazenados.sql`.
- [ ] **5. Variáveis** (§4): `DEMURRAGE_ARQUIVOS_PROVEDOR=s3`, endpoint HTTPS,
  região, bucket, credencial. **Sem elas o boot de produção recusa subir.**
  - **Consulta de pré-deploy do legado:** `npm run demurrage:arquivos --
    diagnosticar --sem-orfaos` → `legadoBloqueante` lista os contêineres com
    demurrage em processo OPEN que deixam de encerrar sem o arquivo; planejar o
    reenvio dos originais com os analistas.
- [ ] **6. Ao publicar:** o log do boot deve trazer `[boot] armazenamento de
  documentos acessível (s3).` e nenhuma mensagem de schema 0053 ausente.
- [ ] **7. Depois de publicar:** `npm run demurrage:arquivos -- diagnosticar`
  deve sair com `leituraAnonima` = `recusada` (assim que houver o primeiro
  documento), sem `problemas` e sem `arquivoIndisponivelBloqueante` (código de
  saída 0); na linha do tick, o segmento `documentos:` sem
  `ERRO=`/`INTERROMPIDA=`.
- **Depois de restaurar o banco de um backup:**
  `DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA=false` até rodar `diagnosticar`.

---

## 15. Riscos registrados

1. **Sem inspeção de malware.** Mitigado por entrega sempre como anexo,
   `nosniff`, CSP sandbox e nome gerado pelo servidor; ponto de integração
   pronto (§5). Abrir um PDF malicioso baixado continua sendo risco do
   leitor de PDF de quem baixa.
2. **Proteção do provedor depende de configuração.** A aplicação nunca apaga
   objeto confirmado, mas a credencial tem `DeleteObject` (precisa remover
   tentativas). Mitigação: versionamento + credencial sem
   `DeleteObjectVersion` (§14). Prefixos separados com cópia no provedor e
   Object Lock ficam como evolução.
3. **Exposição pública do R2 não é verificável pelo endpoint S3** (r2.dev ou
   domínio próprio): conferência manual no checklist.
4. **Legado bloqueia encerramento** de contêiner com demurrage em processo
   OPEN até o reenvio do arquivo (§10). Visível em `encerramento.bloqueio` e
   no `diagnosticar`; as filas de ação não foram alteradas (restrição da
   entrega) — evolução natural na fase de frontend.
5. **Restauração de backup**: objetos de tentativas que viraram documento numa
   linha do tempo perdida podem ser removidos depois da carência; desligar a
   limpeza ao restaurar (§14).
6. **Tempo máximo de upload** limitado pelo `requestTimeout` de 300 s (§4).
7. **Órfãos** (objetos que o banco não conhece) só são relatados — limpeza
   manual, consciente.
8. **Classificação origem × provedor é heurística** (tempo ocioso: nada à
   espera do provedor e origem aberta → origem interrompida). Com cliente
   extremamente lento (≈ 4 KB/s ou menos) e o caminho até o provedor parado
   por ≥ o tempo ocioso dele, uma falha do provedor pode ser registrada como
   `origem_interrompida` (400) em vez de `armazenamento_falhou` (502). Só o
   motivo e o status mudam: nada é aceito, perdido ou duplicado, e o retry é
   seguro. O mesmo incidente aparece nas demais operações do provedor.

---

## 16. Frontend e design

Nenhum arquivo de frontend, HTML, CSS, JavaScript de apresentação ou design
foi alterado (`public/` intocado; o frontend atual só lê minutas e não chama
o registro). Autenticação, filas, tarifas, handoff e integração da Liberação
não foram alterados além do necessário para vincular o arquivo à minuta.

---

## 17. Revisão adversarial

Dimensões: isolamento, autorização, MIME spoofing, conteúdo malicioso, URLs,
banco × objeto, órfãos, concorrência, idempotência, legado, logs e segredos.
Cada achado foi contestado por verificadores independentes instruídos a
refutá-lo; só o que resistiu foi corrigido, com teste que falha no código
anterior.

**Rodada 1** (isolamento/autorização; conteúdo/cabeçalhos/URLs;
consistência/concorrência; logs/segredos/provedor): 3 achados, 2 confirmados.

1. **Descarte apagava o objeto do documento quando a confirmação do COMMIT do
   aceite se perdia** (`documentos/servico.ts`, `descartarTentativa`). O
   COMMIT aplicava, a conexão caía antes da resposta, o `catch` descartava a
   tentativa — que já era a ACEITA — e o `apagar` rodava sem condição: o
   documento ficava com conteúdo registrado e sem objeto. **Correção:** a
   remoção só acontece se o banco tem a tentativa como DESCARTADA e nenhuma
   linha usa a chave (`removerObjetoDeTentativa` confere antes do `apagar`;
   DESCARTADO é terminal e nunca vira chave de documento — sem corrida); o
   descarte trava o documento antes da tentativa. **Regressão R1:** o COMMIT do
   aceite é aplicado e a "conexão cai" (pool de teste que lança depois do
   COMMIT); o PUT responde 503, o objeto continua, o retry com a mesma
   `Idempotency-Key` é réplica, o `concluir` confirma e o download devolve os
   bytes. No código anterior: falha (`o objeto do documento continua no
   armazenamento`).
2. **Ordem de travas invertida na limpeza** (`documentos/reconciliacao.ts`,
   `expirarAbandonados`): travava a tentativa antes do documento e liberava a
   posse com um UPDATE global sem `SKIP LOCKED` — deadlock com um PUT em curso
   (ou com outra limpeza/CLI). **Correção:** primeiro os documentos (`FOR UPDATE
   SKIP LOCKED`, ordem de id), depois só as tentativas e a posse desses
   documentos; documento travado por um PUT fica para o PUT (que descarta a
   tentativa vencida) ou para o próximo ciclo. Ordem única em todo o módulo:
   documento → tentativa. **Regressão R2:** PUT pausado logo depois de travar o
   documento + limpeza concorrente; sem deadlock, a limpeza não toca o
   documento, o PUT conclui e descarta a tentativa vencida. No código anterior:
   falha (`limpeza falhou: 40P01`).

Refutado: "a reavaliação técnica leva a ACEITA uma minuta sem arquivo
disponível" — comportamento desenhado e testado (o aceite técnico compara
datas; o arquivo disponível é requisito adicional do encerramento, que bloqueia
com `minuta_sem_arquivo_disponivel`; o registro de minuta nova recusa arquivo
indisponível).

Efeito colateral verificado: a primeira versão da correção 1 removia o objeto
só quando a própria chamada fazia o descarte; o A#28 mostrou que a tentativa
atrasada (já descartada pelo PUT que assumiu a posse) deixava de apagar a
própria chave. A condição passou a ser o estado no banco, não quem descartou —
A#28 e R1 passam.

**Rodada 2** (verificação das correções e da ordem de travas; migration/SQL e
triggers; minuta/encerramento/legado; superfície HTTP; crítica de testes e
relatório), cada achado contestado por dois verificadores: 7 achados — 3
confirmados (2/2), 2 divididos (1/2), 2 refutados. Nenhum achado na ordem de
travas, nas correções da rodada 1, na migration ou na superfície HTTP além do
item 5.

3. **Diagnóstico rotulava incidente como legado** (`reconciliacao.ts`,
   `diagnosticar`): arquivo INTERNO da minuta vigente com objeto marcado
   ausente saía em `legadoBloqueante` como `REFERENCIA_EXTERNA` (e, depois da
   marcação, sumia de `problemas`). **Correção:** a categoria vem do documento
   da minuta vigente, com o mesmo predicado de arquivo do gate; arquivo
   interno indisponível vai para `arquivoIndisponivelBloqueante` (com o
   documento e o motivo) e leva a saída `3`. **Regressão R3** — no código
   anterior: falha (lista vazia).
4. **Inventário de testes congelados incompleto** (§13): faltavam as mudanças
   de asserção de `minutaEncerramentoP1.test.ts` (contrato do documento em P1
   #3/#4, #16 e revisão #12; o primeiro bloqueio do P1 #18). **Correção:**
   inventário completado, com a justificativa do P1 #18.
5. **"Desativado → 403" impreciso** (§7 e título do A#13): com um único
   vínculo interno as sessões são revogadas e o resultado é 401; o A#13
   aceitava 401 ou 403. **Correção:** texto preciso (401 / 403 / 404 conforme
   o caso) e A#13 fixa 401.
6. **(dividido) Cliente parado no meio do PUT registrado como falha do
   provedor** (`armazenamentoS3.ts`): o tempo de ociosidade da requisição ao
   provedor estourava e o envio virava `502 armazenamento_indisponivel` /
   `armazenamento_falhou`. **Correção:** sem nenhum byte à espera do provedor e
   com a origem aberta, o tempo esgotado é `ORIGEM_INTERROMPIDA` (`400
   envio_interrompido`, `origem_interrompida`). **Regressão R4a** (provedor S3
   real contra o S3 falso local, cliente que envia 200 bytes e para) — no
   código anterior: falha (502); **controle R4b** (provedor que nunca lê, 24 MB
   à espera dele) continua 502 nos dois.
7. **(dividido) Legado A com devolução só na validação antiga**: a migração
   documentada (nova versão) limpa a devolução efetiva legada (regra
   congelada) e o contêiner passa a esperar o tracking. Não é mudança de
   comportamento desta entrega e a minuta não fabrica devolução; **correção
   proporcional:** `legadoBloqueante[].devolucaoSoLegada` identifica esses
   contêineres e §10/runbook dizem o que fazer (R3 cobre o campo).

Refutados como defeito (o código se comporta como descrito; são lacunas de
cobertura, não falhas): "S3#5 não passa pelo caminho que lê o XML do provedor"
e "aborto do navegador no PUT e integridade no download sem teste". Cobertos
mesmo assim: **R5** (objeto com um byte trocado e o mesmo tamanho — o último
pedaço nunca sai, a resposta nunca termina completa, evento
`INTEGRIDADE_DIVERGENTE`), **R6** (navegador aborta no meio do PUT — tentativa
`origem_interrompida`, posse liberada, nada gravado, retry conclui) e **R7**
(provedor S3: 404 `NoSuchKey` → 409, 404 `NoSuchBucket` → 502; nem resposta nem
log carregam chave, id de acesso, segredo ou o corpo XML).

Infraestrutura de teste: o S3 falso local passou a tolerar envio abortado no
meio do corpo (antes, rejeição não tratada no próprio servidor falso).

**Rodada 3** (verificação focada nos deltas das correções das rodadas 1 e 2:
descarte/limpeza, diagnóstico, classificação do tempo ocioso), dois
verificadores por achado: 3 achados — 1 confirmado, 1 dividido, 1 refutado.
Nada nas correções de descarte/limpeza nem no diagnóstico.

8. **Cliente parado ainda virava 502 quando o tempo ocioso do PRÓPRIO
   provedor vence o nosso** (`armazenamentoS3.ts`, `gravar`): o AWS S3
   responde `400 RequestTimeout` ao corpo ocioso (≈ 20 s, observação empírica)
   antes dos 30 s padrão de `DEMURRAGE_ARQUIVOS_TIMEOUT_MS`; a resposta virava
   `RESPOSTA_INVALIDA` → 502. **Correção:** 400 com `<Code>RequestTimeout</Code>`
   (lido só em memória, nunca logado), origem aberta e nada à espera do
   provedor no instante da resposta → `ORIGEM_INTERROMPIDA`; outro 400 segue
   `RESPOSTA_INVALIDA`. **Regressão R4c** (S3 falso com tempo ocioso próprio de
   300 ms, o nosso de 5 s) — no código anterior: falha (502).
9. **(dividido; anterior a esta entrega) Teto da tentativa aparecia como
   origem interrompida com o provedor S3**: o teto destrói o corpo, o cliente
   S3 vê um erro do corpo e devolve `ORIGEM_INTERROMPIDA`, testado antes do
   teto em `enviarConteudo`. **Correção:** o teto é testado primeiro.
   **Regressão R8** (cliente que goteja sem parar, posse de 1 s) — no código
   anterior: falha (400 em vez de 408).

Refutado (2/2): "depois de marcar ausente um documento que não bloqueia
encerramento (processo FINAL, versão SUBSTITUIDO), o `diagnosticar` sai 0" — é
a semântica especificada: a marcação é o reconhecimento auditado
(`OBJETO_AUSENTE_CONFIRMADO` com operador e documento) de um incidente já
alertado; `marcadosAusentes` continua no diagnóstico e o objeto que reaparece
íntegro é desmarcado.

**Rodada 4** (verificação do delta da rodada 3): 1 achado, refutado (2/2):
"uma falha do provedor pode ser registrada como origem interrompida, porque
`readableLength === 0` não prova que a origem parou". Os verificadores
reproduziram a condição num namespace de rede isolado, com MTU de WAN e o
caminho até o provedor bloqueado: só acontece com cliente extremamente lento
(≈ 4 KB/s ou menos) durante uma parada unidirecional de ≥ 20 s do caminho até
o provedor; nos demais ritmos o resultado é 502. Sem perda de dados (o
documento segue PENDENTE e o retry é seguro). Registrado como limite da
heurística (§15, risco 8). Rodada encerrada sem achado confirmado.

---

## 18. Validação

Worktree novo, destacado no commit `af855a2` (árvore limpa: `git status
--porcelain` vazio antes e depois; só `dist/` e `node_modules/` ignorados),
`npm ci`, banco PostgreSQL novo, passos SEQUENCIAIS (um processo de teste por
vez, `--test-concurrency=1`). Armazenamento simulado localmente (memória e S3
falso em 127.0.0.1); nenhuma rede externa.

| # | Suíte | Testes | Passados | Falhos | Ignorados | Cancelados | `todo` |
|---|---|---|---|---|---|---|---|
| 01 | Novos testes de arquivos (32 obrigatórios, 8 do provedor S3, 10 da revisão) | 50 | 50 | 0 | 0 | 0 | 0 |
| 02 | Minuta e encerramento (+ responsabilidade, lifecycle, apuração) | 253 | 253 | 0 | 0 | 0 | 0 |
| 03 | Tarifas (administração P1 + motores, seleção, D15-C, migrations) | 168 | 168 | 0 | 0 | 0 | 0 |
| 04 | Autenticação e filas | 215 | 215 | 0 | 0 | 0 | 0 |
| 05 | Notificações (avisos de divergência, pendência, fallback) | 273 | 273 | 0 | 0 | 0 | 0 |
| 06 | Entrega 1 (handoff) + capacidade | 87 | 87 | 0 | 0 | 0 | 0 |
| 07 | Entrega 2 (ações) | 70 | 70 | 0 | 0 | 0 | 0 |
| 08 | Entrega 3 (leituras operacionais) | 47 | 47 | 0 | 0 | 0 | 0 |
| 09 | D12 (10 arquivos históricos) | 75 | 75 | 0 | 0 | 0 | 0 |
| 10 | Suíte completa do Demurrage Engine | 1452 | 1452 | 0 | 0 | 0 | 0 |
| 11 | V1 (`npm run test`) | 25 | 25 | 0 | 0 | 0 | 0 |
| 12 | D13 UI (`npm run test:demurrage-ui`) | 66 | 66 | 0 | 0 | 0 | 0 |
| 13 | Typecheck (`tsc --noEmit`; e com os arquivos de teste) | — | sem erros | — | — | — | — |
| 14 | Build (`npm run build`) | — | sem erros | — | — | — | — |

**D12 75/75**, conferido arquivo a arquivo (cada um rodado isoladamente,
contagem congelada): `demurrageV2Routes` 7, `leituraAutorizacao` 10,
`leituraContrato` 8, `leituraD12V12` 18, `leituraDetalhe` 6, `leituraFila` 6,
`leituraFilaV11` 8, `leituraFiltros` 4, `leituraTimeline` 5,
`leituraTimelineV11` 3 — todos passados, nenhum ignorado ou `todo`.

A suíte completa passa de 1402 (congelamento das tarifas) para 1452: +50 dos
testes novos de arquivos; nenhum teste congelado removido, ignorado ou
desativado (alterações inventariadas no §13).

**Regressões da revisão adversarial** (§17), cada uma rodada contra uma cópia
com o código ANTERIOR à respectiva correção (testes atuais, só ajuste de tipo
quando o campo novo não existia): R1 falha (objeto do documento apagado), R2
falha (`40P01`), R3 falha (incidente ausente da lista própria), R4a falha
(502 em vez de 400), R4c falha (502 em vez de 400), R8 falha (400 em vez de
408); R4b (controle) passa antes e depois. Com a correção, todas passam,
repetidas três vezes.

`public/` intocado (`git diff --stat 2331eea af855a2 -- public/` vazio).
Entrega **não congelada**; a Production P1 **não** está concluída.
