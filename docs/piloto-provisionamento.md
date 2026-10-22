# Provisionamento do ambiente piloto (I4)

Prepara, num banco **exclusivo do piloto**, a organização, as pessoas e os papéis. Depois disso, a caixa monitorada é vinculada pela própria aplicação, que confere a posse da conta.

**Não** conecta à produção, **não** migra o banco, **não** vincula a caixa, **não** grava o cadastro institucional, **não** liga o armador automático e **não** depende do HeadCargo.

## O que o provisionamento faz

| Faz | Não faz |
|---|---|
| Cria a organização (`organizations`), por `slug` | Remover, renomear ou trocar papel (divergência = conflito) |
| Cria as pessoas (`usuarios`) e as memberships (`organization_memberships`) com o papel **declarado** | Criar papel por padrão, ADMIN implícito ou CLIENT |
| Grava o vínculo **explícito** da conta Microsoft (`usuarios.home_account_id`) quando ele ainda está vazio | Gravar o vínculo de conta de quem já é membro de **outra** organização |
| Confere a situação da caixa declarada (pendente, vinculada, pausada, de outra organização) | Vincular a caixa (é da rota `POST /api/captura`, pela própria conta da caixa, ADMIN) |
| Simula por padrão; aplica tudo ou nada, numa transação | Deixar estado parcial: qualquer erro desfaz tudo |

Reexecutar o mesmo manifesto não muda nada. Acrescentar ao manifesto só cria o que falta.

## Manifesto (`priora-piloto/v1`)

Exemplo sintético: [`docs/piloto/manifesto.exemplo.json`](piloto/manifesto.exemplo.json).

**Campos.** A lista de campos é fechada: um campo desconhecido é recusado, e não há campo de senha, token ou chave.
- `organizacao`: `slug` (minúsculas, dígitos e hífen) e `nome`.
- `membros[]`: `nome`, `email`, `homeAccountId` (ou `null`) e `papel` (`ANALYST`, `MANAGER` ou `ADMIN`).
  - O papel é **obrigatório**.
  - ADMIN existe só quando declarado.
- `caixa` (opcional): `homeAccountId` e `username` da caixa monitorada.
  - A conta da caixa precisa estar entre os membros como **ADMIN**, porque a rota existente de vínculo exige isso.

**De onde vem o `homeAccountId`.** A pessoa tenta entrar na Priora do piloto. A tela "Conta Microsoft não vinculada" mostra o identificador. O operador o copia para o manifesto e reexecuta. Enquanto ele estiver `null`, a pessoa existe, mas não entra (pendência `CONTA_PENDENTE`).

Guarde o manifesto real **fora do repositório**: ele tem nomes e e-mails.

## Passo a passo (máquina confiável, banco do piloto)

1. **Banco exclusivo e migrado.** Rode as migrações apontando **só** para o banco do piloto:

   ```bash
   read -rs PGPASSWORD; export PGPASSWORD                  # a senha nunca vai na URL
   DEMURRAGE_DATABASE_URL='postgresql://USUARIO@HOST:5432/BANCO_DO_PILOTO?sslmode=require' npm run db:migrate:demurrage
   ```

2. **Simulação** (padrão; transação somente leitura, nada é gravado):

   ```bash
   export PRIORA_PILOTO_DATABASE_URL='postgresql://USUARIO@HOST:5432/BANCO_DO_PILOTO?sslmode=require'
   npm run -s piloto:provisionar -- --manifesto /caminho/fora/do/repo/piloto.json
   ```

   Confira o banco conectado, o que seria criado, os ADMIN declarados, os conflitos e as pendências.

3. **Aplicação** (o `--alvo` precisa ser o nome do banco conectado):

   ```bash
   npm run -s piloto:provisionar -- --manifesto /caminho/fora/do/repo/piloto.json --aplicar --alvo BANCO_DO_PILOTO --relatorio /caminho/fora/do/repo/relatorio.json
   unset PGPASSWORD PRIORA_PILOTO_DATABASE_URL
   ```

4. **Caixa monitorada.**
   - Na Priora do piloto, conecte a conta Microsoft da caixa.
   - Vincule a caixa à organização (`POST /api/captura`), logado como essa conta, que é a ADMIN declarada.
   - Reexecute o passo 2: a caixa deve aparecer como `VINCULADA`.

5. **Pessoas.** Cada pessoa sem conta tenta entrar e informa o identificador. Acrescente-o ao manifesto e repita os passos 2 e 3.

6. **Cadastro institucional.** Quem grava é uma pessoa ADMIN, pela API existente da Liberação. Não faz parte deste provisionamento.

## Proteções da linha de comando

Em caso de recusa, a linha de comando sai com código 2 e nada é lido nem gravado.

- O banco vem **só** de `PRIORA_PILOTO_DATABASE_URL`. Não há reserva em `DATABASE_URL` nem em `DEMURRAGE_DATABASE_URL`.
- URL com senha é recusada (`SENHA_NA_URL`); a senha vai em `PGPASSWORD`.
- `--aplicar` exige `--alvo` igual ao banco conectado (`ALVO_DIVERGENTE`).
- Migrações ausentes ou pendentes recusam (`MIGRACOES_AUSENTES`, `MIGRACOES_PENDENTES`). O provisionamento nunca migra.
- Execuções simultâneas são serializadas por uma trava consultiva do banco.
- A saída e o relatório não têm a URL, os nomes nem as contas, e os e-mails aparecem só com a inicial e o domínio. O relatório é gravado com permissão `600`.

**Códigos de saída:**
- `0`: ok;
- `1`: manifesto inválido ou conflito (nada gravado);
- `2`: ambiente recusado ou erro (nada gravado).

## Conflitos (a execução inteira é recusada)

| Conflito | Quando ocorre |
|---|---|
| `ORGANIZACAO_COM_OUTRO_NOME` | o slug já existe com outro nome |
| `USUARIO_COM_OUTRO_NOME` | o e-mail já existe com outro nome |
| `USUARIO_COM_OUTRA_CONTA` | o e-mail já existe vinculado a outra conta |
| `CONTA_DE_OUTRO_USUARIO` | a conta já pertence a outra pessoa |
| `EMAIL_AMBIGUO` | o e-mail existe com duas grafias no banco |
| `VINCULO_DE_CONTA_DE_MEMBRO_DE_OUTRA_ORGANIZACAO` | gravar a conta valeria também em outra organização |
| `PAPEL_DIVERGENTE` | a pessoa já é membro com outro papel |
| `CAIXA_DE_OUTRA_ORGANIZACAO` | a caixa declarada está vinculada a outra organização |

Um conflito nunca é resolvido automaticamente. Corrija o manifesto ou trate o caso fora do provisionamento.
