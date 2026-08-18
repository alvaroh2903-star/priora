# PB-001 — Pré-Alerta · Inventário de Regras (verificação)

> **Fonte:** `PB-001-pre-alerta.Volume-II.v0.4.docx` (Volume II — Base de Conhecimento Operacional, v0.4).
> Extração fiel em `PB-001-pre-alerta.fonte.md`.
> **Status:** índice para **conferência humana** antes da implementação. Nenhum código foi alterado.
> Cada regra abaixo é rastreável até o `.docx` pela numeração de capítulo/subvalidação.

---

## 0. Identidade

| Campo | Valor |
|---|---|
| Código | **PB-001** |
| Nome | **Pré-Alerta** |
| Objetivo | Validar consistência documental **MBL × HBL** antes da emissão do CE Mercante |
| Documentos principais | Master BL (MBL), House BL (HBL) |
| Fontes de apoio citadas | Shipping Instructions (SI), Debit Note (DN), Draft, Invoice, Packing List, histórico de e-mails (ETL), POP |
| Playbook dependente | **PB-002 — CE Mercante** (volume separado; reutiliza o conhecimento validado aqui) |
| Escopo | **13 famílias (V-003 → V-015), 50 subvalidações** |

**Fora deste volume (pré-condições do Core — declaradas como dependência, não reimplementadas):**
- **V-001** = existência/identificação do processo;
- **V-002** = ingestão/classificação/versionamento documental.
- O Pré-Alerta **pressupõe** que o Core já identificou o processo, classificou os documentos e vinculou a versão vigente.

---

## 1. Regras transversais (Capítulos Globais)

### 1.1 Estados
- **Nível de subvalidação (4 estados):** `✔ Consistente` · `⚠ Divergência` · `👤 Validação Humana` · `⏸ Não Avaliada`.
- **Nível visual (4 cores):** `🟢 Consistente` · `🟡 Atenção` · `🔴 Divergência` · `⚪ Não Avaliado`.
  - `🟡 Atenção` agrupa: **Validação Humana**, **Leitura Incerta** e **Atenção Contextual**.
- **Não existe estado "Informativo" no resultado da subvalidação** (o código atual tem — ver §4).

### 1.2 Três status independentes (obrigatório separar internamente)
`Document Status` × `Context Status` × `Visual Status`. Ex.: `Document=CONSISTENT` + `Context=ATTENTION` → visual `🟡`. Atenção contextual **nunca** entra na contagem de divergência documental. Métrica-alvo: *"47 consistentes / 3 divergências / 5 atenções contextuais"*.

### 1.3 Normalização determinística (nunca inferência)
- Preservar **valor bruto + valor normalizado + regra aplicada** (rastreável).
- Só normaliza quando há **uma única** interpretação válida pela estrutura do campo.
  - NCM (só dígito): `O→0`, `36O6 → 3606`. Container: resolve por **posição** (letra vs dígito). Peso/Cubagem: formatação numérica.
  - BL / lacres / alfanuméricos: **conservador** — se a regra não elimina a ambiguidade → `👤 Validação Humana`.
- **OCR ambíguo / baixa confiança → `👤 Validação Humana`** (nunca divergência nem consistente automáticos).

### 1.4 Prioridade e propagação
- Prioridade visual: `🔴 > 🟡 > 🟢`; `⚪` = ausência de conclusão (não é criticidade).
- Propaga o **maior** estado: `Campo → Subvalidação → Família → Documento → Playbook`.
- **`🔴` (divergência objetiva) ≠ urgência máxima.** A fila deve considerar **estado × criticidade** separadamente (ex.: V-014 é 🔴 mas Baixa).

---

## 2. Arquitetura de execução

### 2.1 DAG (ordem obrigatória)
**V-003 (Containers) roda primeiro** — constrói o **relacionamento Master↔House por contêiner**, que é pré-requisito de quase todas as famílias "por contêiner" (V-005/006/007/008). Cada família termina numa subvalidação de **Consolidação/Consistência**.

### 2.2 Fonte da Verdade por família (não é sempre o MBL!)
| Fonte da Verdade | Famílias |
|---|---|
| **MBL** | V-003, V-004, V-005, V-006, V-007, V-008, V-009 |
| **HBL** (exceção intencional) | **V-010 Participantes** (reflete a relação comercial real) |
| **Nenhuma / equivalência** | V-011 Mercadoria, V-013 Madeira, V-014 Navio |
| **Histórico de negociação / SR** | V-015 Frete (Master ≠ House por natureza) |

### 2.3 Regras numéricas
- **Múltiplos Houses:** PB-001 é **MBL × N HBLs**. Comparação por-House; **soma dos Houses = total do Master** (volume, peso bruto, peso líquido, cubagem).
- **Sem tolerância:** qualquer diferença numérica após normalização = **divergência**. Formatos equivalentes (`8000` = `8000.00` = `8.000,000`) são iguais.
- **Sem conversão de unidade:** `KG ≠ LB` → divergência (mesmo que matematicamente equivalentes).

### 2.4 Camada contextual (novas peças de infraestrutura)
- **ETL — Evidence Timeline:** linha do tempo de eventos do processo (e-mails etc.).
- **Context Builder:** recupera **só** os trechos relevantes da ETL (determinístico); **IA só** para desambiguar frase (instrução vs dúvida). A IA **nunca** recebe o histórico inteiro.
- **POP — Perfil Operacional do Processo:** `company_id + process_id → POP`. Guarda participantes/descrições/valores canônicos confirmados + decisões (autor, data). **Compartilhado** na empresa; usuário = autor.
- **Perfil de relacionamento (permanente, cross-processo):** ex. profit share `Rocket × Agente = 60/40` (alimenta V-015).
- Subvalidações contextuais (V-012.3, V-013.3, V-014.3, V-015.7): **nunca** alteram o resultado documental nem o POP automaticamente; produzem `⚠ Atenção Contextual` e exigem decisão humana.
- **Novos tipos de documento citados** (não estão no pipeline atual): Shipping Instructions, Debit Note, Draft.

---

## 3. Inventário das 13 famílias / 50 subvalidações

Legenda IA: **OCR** = IA só para extrair o valor · **Não** = determinístico puro · **FRO** = IA semântica engaiolada · **Ctx** = IA só p/ desambiguar histórico.

### V-003 — Containers · *Crítica* · fonte MBL · dep: (Core) · **3 subvalidações** (Q1 ✔)
| Sub | Nome | Regra | Estados | Crit | IA |
|---|---|---|---|---|---|
| V-003.1 | Existência | p/ cada contêiner do MBL, existe no HBL do House? (por-House) | 4 | Alta | OCR |
| V-003.2 | Correspondência | nº do contêiner **char-a-char** (norm: caixa/espaços); ambíguo→👤 | 4 | Crítica | OCR |
| V-003.3 | **Relacionamento** | cria vínculo único MBL↔HBL por contêiner; 1 relacionamento/contêiner; por-House | 4 | Crítica | Não |

### V-004 — Volumes da Carga · fonte MBL · dep: V-003
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-004.1 | Quantidade de Volumes | comparação numérica; multi-House = soma | Alta | OCR |
| V-004.2 | Tipo de Volume | comparação **textual literal** (`Cartons ≠ Packages`); tabela de equivalência = **futuro** | Média | OCR |
| V-004.3 | Consistência | matriz Qtd×Tipo (só ✔+✔ = ✔) | Alta | Não |

### V-005 — Peso Bruto · fonte MBL · dep: V-003, V-004
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-005.1 | Peso Bruto por Contêiner | numérico, **sem tolerância**, sem conversão de unidade | Alta | OCR |
| V-005.2 | Peso Bruto Total | **soma dos Houses = total do Master**, sem tolerância | Alta | OCR |
| V-005.3 | Consistência | matriz (por-contêiner × total) | **Crítica** | Não |

### V-006 — Peso Líquido · fonte MBL · dep: V-003 *(mesmo template do V-005)*
V-006.1 por Contêiner · V-006.2 Total (soma Houses) · V-006.3 Consistência (Crítica). Sem tolerância.

### V-007 — Cubagem (CBM) · fonte MBL · dep: V-003 *(mesmo template do V-005)*
V-007.1 por Contêiner · V-007.2 Total (soma Houses) · V-007.3 Consistência. Sem tolerância.

### V-008 — Lacres · *Crítica* · fonte MBL · dep: V-003
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-008.1 | Existência | cada contêiner tem lacre nos 2 docs? | Crítica | OCR |
| V-008.2 | Correspondência | igualdade após norm mínima (caixa/trim); qualquer char diff = divergência; ambíguo→👤 | Crítica | OCR |
| V-008.3 | **Unicidade** | um lacre pertence a **um só** contêiner na operação (nada de reuso) | Crítica | Não |
| V-008.4 | Consistência | matriz (existência × correspondência × unicidade) | Crítica | Não |

### V-009 — Portos · fonte MBL · dep: V-003
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-009.1 | Existência | POL/POD **obrigatórios**; Place of Receipt/Delivery/Transbordo **condicionais** | Alta | OCR |
| V-009.2 | Correspondência | **equivalência canônica UN/LOCODE** (`Shanghai`=`CNSHA`); sem proximidade geográfica; sem match seguro→👤 | Alta (POL/POD) / Média (demais) | OCR |
| V-009.3 | Consistência da Rota | sequência lógica `Receipt→POL→T/S→POD→Delivery`; inversão origem/destino = divergência | Alta | Não |
| V-009.4 | Consistência | consolidação | — | Não |

### V-010 — Participantes · *Crítica* · **fonte HBL** · dep: identificação MBL/HBL
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-010.1 | Existência | obrig.: Shipper, Consignee; condic.: Notify, Also Notify. Registra no POP | Crítica | OCR |
| V-010.2 | Correspondência | hierarquia de evidência: **forte** (identificador fiscal/alias POP) > **moderada** (nome normalizado/endereço/país/papel) > **fraca** (só nome parecido → nunca ✔ auto). Papel importa. | Crítica | OCR |
| V-010.3 | Identificador Fiscal | CNPJ/EIN/VAT/USCC: **comparação exata**; ID diferente = divergência ainda que nome igual | Crítica | OCR |
| V-010.4 | Consistência | matriz; consolida no POP. Master≠House por papel (consolidação LCL) **não** é divergência | Crítica | Não |

### V-011 — Mercadoria (Description of Goods) · fonte nenhuma (equivalência) · dep: MBL/HBL
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-011.1 | Existência da Descrição | há descrição? genéricas (`GOODS`) = evidência de baixa qualidade | Alta | OCR |
| V-011.2 | **Correspondência Semântica** | mesma mercadoria ainda que texto difira, via **FRO** (Observação→8 perguntas→Conclusão + confiança categórica; Baixa→👤). POP como contexto | Alta | **FRO** |
| V-011.3 | Consistência | matriz Existência×FRO×Confiança; confiança Média→👤 | Alta | indireta |

### V-012 — NCM · *Crítica* · dep: MBL/HBL (+ETL)
| Sub | Nome | Regra | Crit | IA |
|---|---|---|---|---|
| V-012.1 | Existência | há ≥1 NCM? multi-código = conjunto (ordem irrelevante) | Crítica | Não |
| V-012.2 | Correspondência | comparação no **menor nível de dígitos comum** (`3926` ≡ `39269090`; `392690`≠`392790`); só dígitos | Crítica | Não |
| V-012.3 | Verificação Contextual do Histórico | ETL+Context Builder acham pedido de alterar/incluir/excluir NCM; instrução clara→⚠ atenção, dúvida→👤/ignorar; nunca altera doc/POP auto | Crítica* | **Ctx** |
| V-012.4 | Consolidação | separa **Document Status** de **Context Status** (coexistem); mostra qual código diverge | Crítica | Não |

### V-013 — Madeira / Wooden Packaging · *Alta* · fonte nenhuma · dep: MBL/HBL (+Packing/ETL)
| Sub | Nome | Regra | IA |
|---|---|---|---|
| V-013.1 | Identificação da Condição | normaliza p/ condição estruturada (`SEM_MADEIRA`, `MADEIRA_FUMIGADA`…) via tabela/semântica controlada; `ISPM-15 ≠ TREATED` até aprovar→🟡 | semântica controlada |
| V-013.2 | Correspondência da Condição | mesmo significado operacional; contradição (sem×com madeira)=🔴; madeira declarada×silêncio=🔴; sem-madeira×silêncio=🟢 | semântica controlada |
| V-013.3 | Verificação Contextual | Packing List/e-mail sugerindo madeira → 🟡 atenção (não altera doc) | Ctx |
| V-013.4 | Consistência Consolidada | documental + contextual; **não por contêiner** | Não |

### V-014 — Navio / Voyage · *Baixa* · fonte nenhuma · dep: MBL/HBL
| Sub | Nome | Regra | IA |
|---|---|---|---|
| V-014.1 | Correspondência do Navio | igualdade após norm (caixa/espaços; `M/V` acessório); navio diferente=🔴 (mas Baixa) | Não |
| V-014.2 | Correspondência da Voyage | quando presente nos 2 (`432N`=`V.432N`); ausência isolada=⚪ | Não |
| V-014.3 | Verificação Contextual | e-mail "amend vessel/voyage" → 🟡 atenção; sem tracking externo | Ctx |
| V-014.4 | Consistência Consolidada | Baixa mesmo em 🔴 (prioridade de fila inferior a NCM/Peso) | Não |

### V-015 — Frete e Valores Comerciais · *Alta* · fonte histórico/SR · dep: MBL/HBL/**DN**/histórico
> **Master ≠ House por natureza** (papéis comerciais diferentes). Profit Share = % **só sobre a margem do Ocean Freight** (não THC/BAF/locais).

| Sub | Nome | Regra |
|---|---|---|
| V-015.1 | Buying Rate / MBL | MBL vs Buying Rate negociado; ≤ acordado=🟢; acima=🟡; acima eliminando margem=🔴 |
| V-015.2 | Selling Rate / HBL | HBL vs SR informado pela Rocket; abaixo do SR=🔴; acima=🟡 |
| V-015.3 | Margem Comercial | `SR − BR`: positiva=🟢, zero=🟡, negativa=🔴 (exceção comercial documentada→🟡→aceite c/ justificativa) |
| V-015.4 | THC e Outras Cobranças | vs instrução comercial; solicitado e ausente=🔴; sem instrução=🟡 |
| V-015.5 | Modalidade de Pagamento | PREPAID/COLLECT vs instrução (sem regra universal) |
| V-015.6 | Debit Note / Profit Share | Ocean Freight + Profit Share da DN vs estrutura comercial acordada |
| V-015.7 | Verificação Contextual | histórico de negociação | 
| V-015.8 | Consistência Consolidada | consolida documental + contexto comercial |

---

## 4. Deltas **regra × código atual** (o que muda em `src/auditoria/`)

> Mapeando o spec contra `playbooks.ts` / `auditoriaRoutes.ts` / `docExtractor.ts` de hoje.

1. **Tolerância numérica — CORRIGIR.** Spec: **zero tolerância** (peso/cubagem/volume). Código: `cmpNumero(...,0.01)` (peso 1%) e `0.02` (cubagem 2%). → comparar exato **após normalização numérica**.
2. **Multi-House — REDESENHAR.** Spec: MBL × **N** HBLs (pareamento por-House + somas). Código: `pick('MBL')[0]` × `pick('HBL')[0]` (1×1).
3. **Relacionamento por contêiner (V-003.4) — NOVO.** Spec: relacionamento explícito como pré-requisito. Código: pareia ad hoc em `paresContainers`.
4. **Modelo de estados — REMODELAR.** Spec: 4 estados + `Document/Context/Visual` + `Atenção Contextual`. Código: 5 estados planos (tem `Informativo`, não tem contexto).
5. **OCR baixa confiança → 👤 — NOVO.** Spec: por campo. Código: só `legivel` do doc inteiro.
6. **NCM por nível de dígitos (4/6/8) — CORRIGIR.** Spec: menor nível comum. Código: `cmpTexto` (igualdade de string).
7. **Portos canônicos (UN/LOCODE) + rota — NOVO.** Código: `cmpTexto` cru em porto origem/destino.
8. **Participantes (V-010) — NOVO.** Fonte **HBL**, CNPJ exato + POP. Código hoje **não** compara shipper/consignee/notify (acertadamente evita comparar Master×House como iguais, mas não faz a validação HBL-cêntrica prevista).
9. **Lacre unicidade (V-008.3) — NOVO.**
10. **Famílias inexistentes no código:** V-004 (Volumes), V-006 (Peso Líquido), V-013 (Madeira), V-014 (Navio/Voyage), V-015 (Frete). 
11. **Mercadoria semântica (V-011.2/FRO) — MUDAR.** Código: descrição é só `Informativo`. Spec: FRO (IA) com criticidade Alta.
12. **Infra contextual (ETL + Context Builder + POP + perfis) — NOVO** e transversal.

---

## 5. Inconsistências / resíduos no documento (revisar na fonte)
- **Ficha Técnica desatualizada:** lista **10** famílias; o corpo implementa **13** (faltam V-004 Volumes, V-011 Mercadoria, V-014 Navio).
- **V-003.3:** a tabela da família chama `.3 Quantidade` + `.4 Relacionamento`; o corpo detalha só Existência/Correspondência/**Relacionamento**. **Resolvido (Q1):** V-003 = 3 subvalidações; "Quantidade" não existe.
- **Resíduos de edição colados no texto:** perguntas do autor sobre portos (cap. 9, antes do 9.1); **V-009.2 duplicada**; `"hoje 12:27 / boa, continue"`; `"Bora. Então eu substituiria a V-012.3 anterior inteira…"` (antes de 12.12).
- **V-014.4** usa numeração `2.13`/`12.13` trocada em pontos; cross-refs esporádicos mislabelados (`V-009 — NCM`).

---

## 6. Decisões travadas (Q1–Q6) e faseamento

**Decisões:**
- **Q1 ✔** V-003 = **3 subvalidações** (Existência / Correspondência / Relacionamento). "Quantidade" não existe.
- **Q2 ✔** Portos com **UN/LOCODE no v1**. Tipo de embalagem (V-004.2): **comparação literal no v1**, sem tabela de equivalência.
- **Q3 ✔** ETL + Context Builder **fazem parte do v1**, mas **implementados depois** do núcleo documental determinístico. PB-001 só é considerado completo com a camada contextual funcionando.
- **Q4 ✔** V-015 (Frete) **no v1**, porém **depois** das validações documentais básicas (depende de DN + histórico de negociação + perfil de relacionamento).
- **Q5 ✔** Enquanto **Shipping Instructions** não forem ingeridas, adiar **apenas** as partes de V-010/V-015 que dependem delas. O restante de V-010 segue normal.
- **Q6 ✔** **Zero tolerância** para peso bruto, peso líquido e cubagem. Após normalização numérica, **qualquer diferença = divergência**.
- **Q7 ✔** Consolidação com precedência uniforme: `⚠ Divergência > 👤 Validação Humana > ⏸ Não Avaliada > ✔ Consistente`. Estados individuais preservados; o consolidado fica em Divergência se houver qualquer divergência objetiva (não é "escondida" por outra dimensão em validação humana).
- **Q8 ✔** Convenção numérica: `20.000→20000`, `12,5→12.5`, `30,780→30.78` (ponto = milhar em grupos de 3; vírgula = decimal); comparação após normalização.
- **Q9 ✔** Pareamento de contêiner: casa por número exato; **fallback 1×1** (1 no MBL, 1 no HBL) pareia para diagnóstico — número diferente → **V-003.2 Divergência** (não "dois ausentes"); leitura incerta → 👤; o relacionamento (V-003.3) só nasce após a correspondência confirmada.

**Faseamento do v1 (aprovado):**
1. **Fase 1 — núcleo documental determinístico:** V-003 (relacionamento Master↔House) → V-005/006/007 (pesos/cubagem, zero tolerância) → V-004 (volumes) → V-008 (lacres) → V-009 (portos, UN/LOCODE) → V-012.1/.2 (NCM documental) → V-011.1 → V-010 (parte não dependente de SI). Sem IA nova, sem infra contextual.
2. **Fase 2 — camada contextual + semântica:** ETL + Context Builder; V-012.3 / V-013.3 / V-014.3; V-011.2 (FRO); V-013 / V-014.
3. **Fase 3 — comercial + fontes novas:** V-015 (Frete) + Debit Note + histórico de negociação + perfil de relacionamento; partes de V-010/V-015 dependentes de Shipping Instructions; POP persistido.

> Nota de engenharia: as famílias da Fase 1 são **stateless** (comparação sobre docs extraídos) e **não** exigem a persistência. A fundação de persistência (POP, pendências, histórico, "confirmar auditoria") entra quando a primeira feature *stateful* precisar dela — evitando construir o banco antes de haver o que persistir.

---

*Gerado a partir do Volume II v0.4. Regras rastreáveis à fonte por código de subvalidação (V-0XX.Y).*
