# Arquitetura multi-empresa da Priora (workspaces)

> Norte oficial do modelo de contas/organizações. Substitui a ideia anterior de
> "descobrir a empresa pelo Graph": **quem determina pertencimento é o admin da
> empresa**. O Microsoft só autentica e fornece dados.

## Princípio central

O usuário possui **credenciais individuais**, mas sua **conta operacional
pertence ao workspace da empresa que o convidou**. A integração Microsoft do
usuário é apenas uma **fonte de dados** vinculada àquela conta empresarial.

```
Outlook Pedro ──┐
Outlook Gilmar ─┼──►  PRIORA  ──►  Rocket Logistics
Outlook Gabi ───┘                      ↓
                                     Gestão
```

Quem "soma" os dados dos analistas é a **Priora** (por `company_id`), não o
Outlook do gestor.

## Papéis

- **Admin (comprador):** cria a organização na compra, gerencia plano, cadastra/
  desativa analistas, conecta o Microsoft **corporativo** (backup).
- **Analyst (analista):** convidado pelo admin; define a própria senha; conecta
  o **próprio** Microsoft como fonte de dados individual.

## Fluxos

### 1. Compra (landing) → Admin
1. Usuário cria conta na landing → escolhe plano → paga.
2. A conta da compra vira **Administrador** da empresa (organização criada).
3. Pode alterar o e-mail de login depois.

> **Estado atual:** o cadastro (`POST /api/priora/signup`) cria **só a conta**
> (aberta a qualquer um) e guarda o nome da empresa/tipo como intenção. A
> **empresa nasce ao assinar** um plano (`POST /api/priora/assinar`), que hoje
> aprova em **modo teste** (sem cobrança). O plano define o `seat_limit`
> (assentos/analistas). Quando o Stripe entrar (etapa 7), `/assinar` passa a ser
> o destino do webhook de "pagamento aprovado" — o resto do fluxo não muda.
> Catálogo de planos em `src/billing/plans.ts`.

### 2. Primeiro acesso do admin
1. Entra na Priora → aparece **Conectar com Microsoft**.
2. Conecta o **backup corporativo** → associado à empresa (conexão CORPORATE).

### 3. Portal do admin
1. Vê o **limite do plano** (nº de assentos).
2. Cadastra analistas por **e-mail** (não define senha).
3. A Priora cria contas **subordinadas à empresa**.

### 4. Convite do analista (sem admin definir senha)
```
Admin cadastra pedro@rocket.com
        ↓
Priora cria usuário Pedro (company_id=Rocket, role=analyst, status=invited)
        ↓
Pedro recebe convite (link com token)
        ↓
Pedro define a própria senha
        ↓
status = active
```

### 5. Primeiro login do analista
1. Entra na Priora → conta **já pertence à Rocket**.
2. **Conectar com Microsoft** → conecta o Outlook dele (conexão USER).
3. A Priora passa a usar aquela integração como **fonte de dados do Pedro**.

### 6. Desativação
```
Admin desativa Pedro → status = disabled
```
Pedro perde acesso; **o histórico continua associado à Rocket**.

## Modelo de dados (Supabase)

- **organizations** (empresas): id, nome, plano, limite de assentos, admin.
- **memberships**: user_id ↔ org_id, `role` (admin|analyst), `status`
  (invited|active|disabled).
- **invitations**: e-mail, org_id, role, token, expiração, status.
- **microsoft_connections**: por **usuário** OU por **empresa**, com
  `kind` = `CORPORATE` (backup@rocket.com) | `USER` (pedro@rocket.com…).
- **Dados operacionais** (demurrage/courier/bot…): cada linha carrega
  `company_id` **e** `user_id`.

### Isolamento (RLS)
- Visão do **analista**: filtra por `user_id` (seus próprios dados).
- Visão do **gestor/admin**: filtra por `company_id` (tudo da empresa).
- Uma empresa nunca vê dados de outra.

### Dois tipos de conexão Microsoft
1. **CORPORATE / SHARED** (`backup@rocket.com`): alimenta o que é compartilhado
   da empresa.
2. **USER** (`pedro@rocket.com`…): alimenta o contexto operacional de cada analista.

## Etapas de implementação

1. **Schema** multi-tenant (organizations, memberships, invitations, connections
   com `kind`, dados com `company_id`+`user_id`) + RLS.
2. **Cadastro do admin** cria a organização (empresa a partir do campo do registro).
3. **Portal do admin**: convidar/listar/desativar analistas; limite do plano.
4. **Convite por e-mail** (token) → analista define senha → `active`.
5. **Conexão Microsoft por usuário/empresa** (`kind`), substituindo o modelo de
   conta única atual; tokens isolados por `user_id`/`company_id`.
6. **Escopo dos dados** por `company_id`+`user_id`; visões analista vs gestor.
7. **Planos/pagamento** (limite de assentos) — provedor a definir (ex.: Stripe).

## Dependências externas (a contratar quando chegar a etapa)
- **Envio de e-mail** para convites (ex.: Supabase Auth invite / Resend / SMTP).
- **Pagamento/planos** (ex.: Stripe) para o fluxo de compra e limite de assentos.
