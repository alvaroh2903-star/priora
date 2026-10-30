# Persistência no Supabase — Fase 0: exportação segura dos dados legados

> **Escopo desta fase:** só preparar, testar e documentar o exportador e a
> recuperação, usando dados sintéticos. Nada aqui foi executado em produção.
> Fica para depois, cada passo com autorização própria: exportação real, envio
> ao Storage, criação de bucket, migrations, mudança de variáveis no Render,
> conexão Microsoft por empresa (decisões A–C), importação (decisão D), merge e
> deploy.

Decisões do proprietário que orientam a fase (resumo):

- **A:** cada empresa terá a própria conexão Microsoft.
- **B:** só o admin da empresa conecta, substitui ou desconecta essa conta.
- **C:** sai o envio de reserva do watchdog pela conta Microsoft global; Gmail e webhook ficam.
- **D:** os dados legados pertencem à empresa "Pessoal da Priora" e à conta
  Microsoft informada pelo proprietário (o endereço fica fora do Git, de propósito).
  A importação só acontece se a identidade registrada nos arquivos conferir com
  essa conta e com a conexão autenticada da empresa.

## 1. Diagnóstico

### 1.1 Repositório (verificado em 30/10/2026)
- Linha A (`claude/demurrage-api-playwright-5q2lqq`) em `8e055b0`.
- Este trabalho fica no branch `feat/persistencia-supabase`, criado a partir de
  `8e055b0`. Não usa o branch padrão da sessão, porque ele carrega trabalho do
  Stage 0.
- Sobreposição com o PR #5:
  - nenhum arquivo em comum além do `package.json`;
  - lá foram acrescentadas linhas depois de `selftest:all`, e aqui uma linha no
    fim da lista de scripts;
  - são trechos diferentes, sem conflito esperado.
- Nenhum arquivo em `src/` foi alterado nesta fase.

### 1.2 Onde os registros estão hoje
Tudo fica em `config.dataDir = DATA_DIR || '.data'`, relativo ao diretório de
trabalho do processo. No Docker, `WORKDIR /app` e `npm start`, então o padrão é
`/app/.data`. **Não verificado:** se `DATA_DIR` está definido no Render.

| Arquivo | Quem grava | Conteúdo |
|---|---|---|
| `courier-estados.json` | `couriers/courierStore.ts` | estado do courier confirmado pelo operador (+ nota) |
| `courier-conferencia.json` | `couriers/courierStore.ts` | Recebido/Não recebido por processo e documento |
| `courier-followups.json` | `couriers/courierStore.ts` | follow-ups registrados |
| `demurrage-minutas.json` | `demurrage/demurrageStore.ts` | minuta solicitada por processo |
| `demurrage-atividades.json` | `demurrage/demurrageStore.ts` | feed de atividades (últimas 50) |
| `demurrage-bot-results.json` | `demurrage/demurrageBotStore.ts` | resultados acumulados do bot por BL/contêiner |
| `watchdog-auto.json` | `browser/carriers/watchdogScheduler.ts` | estado da volta automática do watchdog |
| `microsoft-account.json` | `auth/microsoftAccount.ts` | conta Microsoft ativa: `homeAccountId`, `username`, `connectedAt` |
| `msal-cache.json` | `auth/tokenCache.ts` | **tokens do MSAL (segredo)** |
| `sessions/` | `auth/fileSessionStore.ts` | sessões de login (uma por arquivo) |
| `scrapejobs/` | `index.ts` | jobs temporários de raspagem (diagnóstico) |

Como o código lê e grava (verificado no código):

- **Leitura:** cada store lê o arquivo uma vez e mantém o resultado em memória.
  Se o JSON não abrir, o erro é engolido e o store começa vazio (`{}` ou `[]`).
- **Gravação:** `writeFileSync` com o JSON inteiro a cada mudança, sem gravação
  atômica. Se falhar, só gera log, e a resposta HTTP continua de sucesso.
- **Exclusão:** `clearAll()` apaga os arquivos de courier, demurrage e bot.

### 1.3 Render
- **Sem disco persistente: VERIFICADO.** Print do proprietário em 27/10, na aba
  *Disk* do `priora-1`, mostrando "Add Disk".
- **Comportamento sem disco**, pela documentação do Render:
  - "without a persistent disk, any changes you make to a service's local files
    are lost every time the service redeploys or restarts"
    (<https://render.com/docs/disks>);
  - "any changes a running service makes to its filesystem are lost with each
    deploy" (<https://render.com/docs/deploys#ephemeral-filesystem>).
  - Isso não foi testado neste serviço; está tratado como risco alto.
- **Shell:** o painel conecta a uma instância em execução; só existe em plano pago
  (<https://render.com/docs/ssh>).
- **Variáveis de ambiente:**
  - salvar uma variável dispara deploy, a menos que se escolha **Save only**
    (<https://render.com/docs/configure-environment-variables>);
  - o Render sempre define `RENDER=true` (<https://render.com/docs/environment-variables>).

### 1.4 Autenticação Microsoft (verificado no código)
- **Cache de tokens:** o MSAL usa `msal-cache.json` (`auth/tokenCache.ts`) e
  regrava o arquivo inteiro a cada mudança.
- **Conta conectada:** é global ao processo, em `microsoft-account.json`
  (`auth/microsoftAccount.ts`). A sessão guarda `homeAccountId`/`username`, e o
  `requireAuth` compara com essa conta global.
- **E-mail da conta:** vem do `result.account.username` devolvido pelo MSAL no
  `/auth/callback`.
- **Login:** `/auth/login` não exige login Priora no servidor. No callback,
  conectar uma conta **diferente** da ativa executa `clearDerivedData()` e apaga
  couriers, demurrage e bot de todos.
- **Logout:** `POST /auth/logout` remove todos os tokens e apaga os mesmos dados.
  Hoje só a página `api-test.html` chama essa rota.
- **Arquivos com segredo:** `msal-cache.json` (tokens) e `sessions/*`
  (identificadores de sessão). Nenhum dos dois entra no backup.

### 1.5 Riscos
**Confirmados:**
1. **Deploy ou reinício** apaga todos os arquivos (sem disco; documentação do Render).
2. **Conectar outra conta Microsoft** apaga os registros de todos. Não exige
   login Priora no servidor.
3. **`POST /auth/logout`** apaga os registros de todos.
4. **Arquivo corrompido ou gravado pela metade é zerado em silêncio:** o JSON
   não abre, o store começa vazio, e a próxima gravação sobrescreve o arquivo
   com quase nada.
5. **Gravação não atômica:** queda no meio da escrita deixa JSON inválido, que
   cai no risco 4.
6. **Atividades limitadas às últimas 50:** as mais antigas são descartadas por
   desenho.
7. **autoSync grava os resultados do bot a cada 120 min** (padrão). A dupla
   leitura do exportador detecta se isso coincidir com a exportação.
8. **A própria exportação pode estourar a memória:** a instância tem 512 MB, e o
   pico de memória do exportador é algumas vezes o tamanho dos dados. Um estouro
   reinicia a instância e, pelo risco 1, apaga os arquivos. Por isso o limite
   padrão é de 16 MB, e o modo só-inventário mostra o total antes de qualquer
   cifra.

**Não verificados:**
- valor de `DATA_DIR`;
- lista real de arquivos e tamanhos em produção;
- se `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` aparecem no Shell;
- formato da chave de serviço (JWT antigo ou `sb_secret_`);
- se o Shell do Render oferece terminal interativo com modo raw (prompt oculto);
- `AZURE_TENANT_ID`;
- modo do Auto-Deploy: o comentário do CI fala em "After CI Checks Pass", e o
  proprietário informou Auto-Deploy ligado;
- reinícios por falta de memória (512 MB);
- comportamento real do Storage do projeto. Os endpoints foram conferidos no
  código do `@supabase/storage-js` 2.112.3 do `package-lock`, não contra o
  servidor.

## 2. Inventário fechado

| Entra no backup | Fica de fora | Interrompe |
|---|---|---|
| `courier-estados.json`, `courier-conferencia.json`, `courier-followups.json`, `demurrage-minutas.json`, `demurrage-atividades.json`, `demurrage-bot-results.json`, `watchdog-auto.json`, `microsoft-account.json` (só identificadores; campo a mais interrompe) | `msal-cache.json` (tokens), `sessions/` (sessões), `scrapejobs/` (temporários) | qualquer outra entrada no diretório. O terminal mostra só o nome, o tipo e o tamanho, e nada é descartado em silêncio |

Arquivo do inventário que não existe é registrado como `presente: false`.
Interrompem também:

- link simbólico no lugar de um arquivo do inventário;
- diretório sem nenhum arquivo do inventário.

## 3. Segurança

**Formato do pacote (`.priora-legado`):**

```
"PRIORALG" | tamanho do cabeçalho (u32) | cabeçalho JSON | conteúdo cifrado | tag GCM (16 bytes)
```

**Cabeçalho, em claro:**
- formato e versão;
- algoritmo;
- IV aleatório de 12 bytes;
- data;
- verificador da chave.

**Conteúdo cifrado:**
- o manifesto;
- os bytes exatos de cada arquivo.

- **Criptografia:**
  - AES-256-GCM, com IV novo a cada pacote;
  - todo o trecho até o fim do cabeçalho entra como AAD;
  - alterar qualquer byte do pacote (cabeçalho, conteúdo, tag) ou truncá-lo
    falha a autenticação, e nada é devolvido.
- **Chave:**
  - 32 bytes aleatórios em base64, gerados **na máquina do operador**;
  - ficam num cofre de senhas, nunca no Git, no banco, em chat ou em log;
  - o exportador lê a chave num **prompt oculto**, duas vezes, para evitar um
    backup ilegível por erro de digitação;
  - a linha de comando recusa `--chave`, e sem terminal só lê de stdin com
    `--chave-stdin` explícito;
  - depois de usar, a chave é zerada na memória.
- **Verificador da chave:**
  - são 16 caracteres hexadecimais de um SHA-256 rotulado, e não permitem
    recuperar a chave;
  - o operador anota junto da chave;
  - o verificador usa esse valor para distinguir chave errada de pacote adulterado.
- **Nada em claro:**
  - tudo é montado em memória;
  - o único arquivo gravado é o pacote cifrado (modo 0600, sem sobrescrever);
  - o terminal mostra só tamanhos, contagens, hashes e a situação da conta (o
    e-mail não aparece);
  - falhas mostram código e mensagem curta;
  - erro de JSON não repete trecho do arquivo, e erro HTTP não repete
    cabeçalhos, URL nem chave.
- **Segredos:**
  - os arquivos com segredo ficam fora do inventário;
  - cada arquivo exportado passa por varredura de padrões: chaves de token MSAL
    e OAuth, JWT, `Bearer`, chave privada, `sb_secret_`;
  - achou um padrão, interrompe, mostrando só o nome do padrão.
- **Consistência:**
  - duas passagens de leitura independentes, separadas pelo intervalo
    `--intervalo-ms` (padrão 3 s);
  - o conjunto de entradas, a presença e o SHA-256 de cada arquivo têm de bater;
  - qualquer diferença interrompe com `ALTERADO`;
  - JSON inválido ou formato inesperado interrompe;
  - limite de tamanho total: `--limite-mb`, padrão 16 (ver risco 8). Não
    aumentar sem avaliar a memória da instância.
- **Autoverificação:** antes de qualquer destino, o exportador abre o próprio
  pacote com a chave e valida o manifesto.
- **Envio:**
  - **Bloqueios antes de enviar:**
    - só com `--enviar-supabase <bucket>` e confirmação explícita (digitar
      `ENVIAR`, ou `--confirmo-envio` sem terminal);
    - recusa bucket que não seja privado (`public !== false`).
  - **Sem sobrescrever:** sobe com `x-upsert: false`, então objeto existente é erro.
  - **Conferência:** baixa o objeto e confere o SHA-256.
  - **Credenciais:** usa `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` do
    ambiente, sem imprimir. Chave `sb_secret_` vai só no `apikey`.
  - **Rede:** sem `--enviar-supabase` não há nenhuma conexão.
- **Falha segura:**
  - qualquer erro sai com código 2 e a mensagem "Nada foi declarado como exportado.";
  - "EXPORTAÇÃO CONCLUÍDA" só aparece no fim de tudo.
- **Manifesto, dentro do pacote:**
  - formato, versão e data;
  - origem: diretório, commit (`RENDER_GIT_COMMIT`) e versão do Node;
  - conta Microsoft legada (`homeAccountId`, `username`), sem tokens;
  - conta esperada e situação (`confere`, `diverge`, `nao-informada` ou
    `conta-legada-ausente`);
  - por arquivo: presença, bytes, SHA-256 e contagens por tipo;
  - entradas excluídas que estavam presentes;
  - hash do conjunto.
- **Conta divergente:** a exportação **preserva** os dados mesmo assim e avisa.
  A importação (fase futura) ficará bloqueada até decisão do proprietário.

## 4. Recuperação

`scripts/legado/verificar.js --arquivo <pacote> [--restaurar-em <dir vazio>] [--comparar-com <origem>]`

1. Lê o cabeçalho e mostra o verificador esperado.
2. Pede a chave (prompt oculto) e recusa chave incorreta (`CHAVE_INCORRETA`).
3. Autentica o pacote; adulteração ou truncamento resulta em `ADULTERADO`.
4. Valida o manifesto:
   - inventário exato;
   - arquivos presentes;
   - tamanho, SHA-256 e contagens de cada arquivo, recalculados a partir do
     conteúdo;
   - hash do conjunto;
   - conta igual à de `microsoft-account.json`;
   - data igual à do cabeçalho.
5. Com `--restaurar-em`:
   - exige diretório vazio ou inexistente;
   - recusa o `DATA_DIR` configurado e qualquer instância do Render (`RENDER`);
   - grava com 0700 (diretório) e 0600 (arquivos), sem sobrescrever, e relê
     conferindo os hashes.
6. Com `--comparar-com`, confere presença e SHA-256 contra a origem.

Nesta fase a restauração serve só para provar o backup com dados sintéticos.
Com dados reais, a verificação recomendada é **sem** `--restaurar-em`: ela
valida tudo em memória e não cria cópia em claro.

## 5. Testes

`npm run legado:selftest` roda `scripts/legado/teste/legado.test.js`, com
`node:test`, dados sintéticos e rede restrita a 127.0.0.1. O Supabase Storage é
um servidor falso local.

- **Exportação e recuperação:**
  - ida e volta completa, com arquivos restaurados byte a byte iguais à origem;
  - o pacote não contém nenhuma marca em claro;
  - o conteúdo não contém tokens, sessões nem jobs;
  - repetir a exportação não altera a origem (tamanho, mtime e hash);
  - modo só-inventário.
- **Diretório e arquivos:**
  - arquivo ausente;
  - diretório vazio ou inexistente;
  - entrada desconhecida;
  - link simbólico;
  - JSON inválido, sem trecho na mensagem;
  - sete formatos inesperados;
  - quatro alterações entre leituras;
  - três segredos plantados;
  - limite de tamanho;
  - `--saida` inválida.
- **Conta:** confere, diverge (exporta e avisa), ausente e não informada.
- **Criptografia e chave:**
  - falha de cifra: exceção, retorno inválido e pacote corrompido;
  - formatos de chave;
  - `--chave` recusado;
  - sem terminal;
  - prompt oculto: duas digitações, sem eco, correção, divergência e cancelamento.
- **Verificador:**
  - chave incorreta;
  - adulteração no conteúdo, no cabeçalho e na tag;
  - truncamento, bytes a mais, assinatura inicial e cabeçalho gigante;
  - onze manifestos inconsistentes e data divergente;
  - restauração recusada em diretório ocupado, no Render e no `DATA_DIR`;
  - comparação divergente.
- **Envio:**
  - sucesso com bucket privado, `x-upsert: false`, conferência por download e
    recuperação do objeto guardado;
  - chave `sb_secret_`;
  - bucket público, bucket inexistente, erro 500, objeto existente, download
    corrompido e download indisponível;
  - Storage inalcançável, envio não confirmado e credenciais ausentes.
- **Linha de comando, em processo separado:**
  - exportar e recuperar com **toda** a rede bloqueada;
  - códigos de saída;
  - a guarda de rede realmente barra conexões.
- **Varredura final:** nenhuma saída de nenhum teste contém marca sintética,
  chave do backup ou chave de serviço.
- **Documento:** o hash do `exportar.js` publicado aqui confere com o arquivo.

**Prova de que os testes pegam defeitos:** com 10 defeitos introduzidos de
propósito, a suíte falhou em todos:

- sem varredura de segredos;
- sem comparar as duas leituras;
- sem AAD;
- entrada desconhecida ignorada;
- contagens não conferidas;
- e-mail da conta no log;
- `x-upsert` ligado;
- bucket público aceito;
- restauração em diretório ocupado;
- `msal-cache.json` fora da lista de excluídos.

## 6. Procedimento futuro do operador (NÃO executado)

Os passos marcados **[AUTORIZAÇÃO]** só podem ser feitos com autorização
explícita do proprietário. Até lá, e até a exportação terminar:

- nada de merge na Linha A (o Auto-Deploy faria deploy);
- nada de deploy manual, reinício ou variável salva com deploy;
- nada de conectar ou desconectar conta Microsoft.

**Integridade do script:** sha256 do exportar.js: `9835132645253bc760db1503ae9a01be2ddcdab50f0b6fddf3693e96ecc4c004`

1. **Chave (máquina do operador, fora da produção).**
   - Rodar `openssl rand -base64 32` e guardar o resultado no cofre de senhas da
     empresa. Nunca colar em chat, ticket, e-mail ou Git.
2. **[AUTORIZAÇÃO] Bucket privado no Supabase.**
   - Em Storage → New bucket, criar `priora-legado` com **Public bucket desligado**.
   - É mudança de configuração no Supabase de produção.
3. **[AUTORIZAÇÃO — acesso à produção] Shell do Render** (`priora-1` → Shell), numa
   janela sem uso da equipe e longe da volta do autoSync.
   1. Descobrir o diretório. Se aparecer `(não definido)`, o diretório é
      `/app/.data`. Se aparecer um valor relativo, ele vale a partir de `/app`.
      Nos comandos abaixo, troque `/app/.data` pelo diretório encontrado.
      ```
      node -e 'console.log(process.env.DATA_DIR || "(não definido)")'
      ```
   2. Copiar o script: colar o conteúdo de `scripts/legado/exportar.js`, deste
      commit, entre as linhas abaixo:
      ```
      cat > /tmp/priora-exportar.js <<'FIM_PRIORA_EXPORTADOR'
      …conteúdo do exportar.js…
      FIM_PRIORA_EXPORTADOR
      ```
   3. Conferir o hash, que precisa ser igual ao publicado acima. Se for
      diferente, apague o arquivo e cole de novo.
      ```
      sha256sum /tmp/priora-exportar.js
      ```
   4. Inventário, sem chave e sem gravar nada:
      ```
      node /tmp/priora-exportar.js --dir /app/.data --conta-esperada <conta informada pelo proprietário> --somente-inventario
      ```
      Dependendo do resultado:
      - `DESCONHECIDO`: parar e levar os nomes listados ao proprietário;
      - `ALTERADO`: repetir mais tarde;
      - `LIMITE`, ou total perto de 16 MB: parar e levar ao proprietário;
      - conta que não confere: levar ao proprietário (a exportação ainda
        preserva os dados).
   5. **[AUTORIZAÇÃO] Exportação e envio:**
      ```
      node /tmp/priora-exportar.js --dir /app/.data --conta-esperada <conta informada pelo proprietário> --enviar-supabase priora-legado
      ```
      - Digitar `ENVIAR`. O texto não aparece.
      - Colar a chave duas vezes. Ela não aparece.
      - Esperado no final:
        - verificador da chave (anotar no cofre, junto da chave);
        - hash do pacote;
        - nome do objeto;
        - a linha `EXPORTAÇÃO CONCLUÍDA`.
   6. Apagar o script: `rm /tmp/priora-exportar.js`. Nenhum dado em claro foi gravado.
   7. Repassar ao proprietário só o resumo impresso: contagens, hashes, objeto,
      verificador e situação da conta.
4. **[AUTORIZAÇÃO] Prova de recuperação, na máquina do operador** (não na produção):
   1. Baixar o objeto pelo painel do Supabase (Storage → `priora-legado` → Download).
   2. Rodar, sem `--restaurar-em`:
      ```
      node scripts/legado/verificar.js --arquivo <pacote baixado>
      ```
   3. Esperado: `VERIFICAÇÃO CONCLUÍDA`.

Se o Shell não tiver terminal interativo, o prompt oculto não funciona e o
exportador para. Nesse caso o operador **não** usa `--chave-stdin` com `echo`,
porque a chave iria para o histórico, e leva o caso ao proprietário.

**Rollback desta fase:**
- **No Render:** a exportação só lê, então não há nada a desfazer.
- **No Supabase:** o objeto enviado pode ficar guardado como cópia cifrada.
  Apagá-lo é uma exclusão e exige autorização.
