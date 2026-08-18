# Priora — Volume II
Base de Conhecimento Operacional
Manual dos Playbooks
Documento Mestre
## Playbook 01 — Pré‑Alerta
### Ficha Técnica

| Campo | Informação |
| --- | --- |
| Código | PB-001 |
| Nome | Pré‑Alerta |
| Objetivo | Validar a consistência documental entre MBL e HBL antes da emissão do CE Mercante. |
| Documentos Principais | Master Bill of Lading (MBL) e House Bill of Lading (HBL) |
| Famílias de Validação | Containers; Peso Bruto; Peso Líquido; Cubagem; Lacres; NCM; Portos; Partes Envolvidas; Madeira; Valores Comerciais |
| Dependências | Pipeline Documental; OCR; Parser; Core |
| Saída | Evidências para o Workspace da Auditoria |
| Playbooks Dependentes | PB-002 — CE Mercante |
| Versão | 1.0 (Em desenvolvimento) |
| Status | Em elaboração |
| Tempo médio estimado (manual) | 8–15 minutos* |
| Tempo médio estimado (Priora) | < 1 minuto* |

*Valores estimados, sujeitos à validação em ambiente operacional.
### Resumo Executivo
O Playbook Pré‑Alerta garante que o Master Bill of Lading (MBL) e o House Bill of Lading (HBL) representem corretamente a mesma operação logística antes da emissão do CE Mercante. Seu foco é identificar inconsistências documentais de forma objetiva, reduzindo retrabalho operacional e permitindo que o analista concentre sua atenção apenas nas situações que realmente exigem intervenção humana.
Capítulo Global — Regras de Leitura, Normalização e Ambiguidade
1. Objetivo
Este capítulo estabelece as regras globais utilizadas pela Priora para interpretar informações extraídas de documentos antes da execução das validações operacionais.
Seu objetivo é evitar que pequenas imperfeições de OCR gerem falsos alertas, sem permitir que o sistema invente informações ou faça correções sem fundamento objetivo.
Estas regras deverão ser aplicadas por todos os Playbooks e Famílias de Validação.
2. Princípio Fundamental
A Priora deverá distinguir:
erro de leitura
de
divergência operacional.
Uma leitura imperfeita do OCR não representa necessariamente uma divergência documental.
Antes de solicitar Validação Humana, a Priora deverá verificar se a ambiguidade pode ser resolvida de forma objetiva através da estrutura conhecida do campo.
3. Ordem de Tratamento
Toda informação extraída deverá seguir esta sequência:
Documento
↓
OCR / Parser
↓
Valor bruto
↓
Identificação do campo
↓
Aplicação das regras estruturais
↓
Normalização determinística
↓
Ainda existe mais de uma
interpretação plausível?
│
┌──┴──┐
NÃO   SIM
│      │
▼      ▼
Usar   🟡 Validação
valor     Humana
4. Valor Bruto e Valor Normalizado
A Priora deverá preservar sempre o conteúdo originalmente extraído.
Exemplo:
Valor OCR:
36O6
Campo:
NCM
Valor normalizado:
3606
Regra aplicada:
O → 0 em campo exclusivamente numérico
Dessa forma, a normalização é totalmente rastreável.
O valor original nunca deverá ser apagado.
5. Normalização não é Inferência
Uma correção automática somente poderá ocorrer quando houver uma única interpretação válida segundo as regras estruturais daquele campo.
Exemplo:
NCM
OCR:
36O6
Como o NCM aceita exclusivamente números:
O não é válido.
A única interpretação possível é:
3606
Resultado:
🟢 Leitura normalizada automaticamente.
Não existe necessidade de atenção humana.
6. Ambiguidade Real
Quando duas ou mais interpretações continuarem válidas depois da aplicação das regras estruturais, a Priora não deverá escolher uma delas.
Exemplo:
OCR:
39269?90
A imagem permite interpretar o caractere como:
0
6
8
Todas as possibilidades respeitam a estrutura numérica do NCM.
Resultado:
🟡 Leitura incerta — confirmar valor
7. Regras Estruturais por Tipo de Campo
Cada tipo de informação poderá possuir suas próprias restrições.
NCM
Campo exclusivamente numérico.
Permite correções estruturais inequívocas como:
O → 0
quando não houver outra interpretação possível.
Container
O identificador possui posições destinadas a letras e posições destinadas a números.
Assim, uma leitura ambígua poderá ser resolvida utilizando a posição do caractere.
Exemplo:
MSCU12345O7
Se o caractere O estiver em posição exclusivamente numérica, a Priora poderá avaliar sua normalização para 0, desde que as demais regras estruturais confirmem uma única interpretação válida.
Peso
OCR:
2O000 KG
Campo numérico.
Resultado normalizado:
20000 KG
desde que não exista outra leitura plausível.
Cubagem
OCR:
12,5O CBM
↓
12,50 CBM
quando a estrutura do campo tornar a interpretação inequívoca.
CNPJ
A estrutura conhecida do identificador poderá auxiliar na resolução de caracteres ambíguos e na validação do valor extraído.
BL, lacres e identificadores alfanuméricos
Como podem conter letras e números, a Priora deverá ser mais conservadora.
O e 0, por exemplo, podem ser igualmente válidos dependendo da estrutura específica daquele identificador.
Se a regra do campo não eliminar uma das possibilidades:
🟡 Validação Humana.
8. Uso de Evidências Redundantes
A Priora poderá utilizar outras evidências do mesmo processo para auxiliar na leitura, desde que isso não transforme uma hipótese em fato.
Exemplo:
Documento A:
MSCU12345O7
Documento B:
MSCU1234507
Se a estrutura do campo e uma segunda evidência confiável apontarem para o mesmo valor, a Priora poderá resolver a leitura automaticamente quando existir apenas uma interpretação operacional válida.
A evidência utilizada deverá permanecer registrada.
9. O que Pode ser Normalizado Automaticamente
Normalizações objetivas poderão incluir:
espaços desnecessários;
diferenças de caixa alta/baixa;
pontuação meramente formatadora;
separadores numéricos;
caracteres incompatíveis com o tipo do campo quando houver uma única substituição possível;
formatos equivalentes previamente definidos pelo Playbook.
Exemplo:
20.000,00 KG
e
20000.00 KG
podem representar o mesmo valor após normalização numérica.
10. O que Não Pode ser Normalizado Automaticamente
A Priora não deverá:
inventar caracteres ausentes;
escolher entre duas leituras igualmente possíveis;
completar códigos incompletos sem evidência;
corrigir um valor apenas porque outro documento apresenta algo diferente;
assumir que o OCR está errado para forçar consistência;
utilizar interpretação semântica para modificar informações objetivas.
11. Resultado Visual
Após a normalização:
🟢 Verde
Leitura resolvida objetivamente e documentação consistente.
Mesmo que o OCR bruto tenha apresentado pequena imperfeição, não há motivo para incomodar o analista.
🟡 Amarelo
Existe ambiguidade real ainda não resolvida.
Exemplo:
Leitura incerta — confirmar valor
🔴 Vermelho
Após leitura e normalização seguras, os valores continuam objetivamente divergentes.
Cinza
A informação não pôde ser avaliada por ausência de documento, campo ou evidência suficiente.
12. Princípio de Redução de Falsos Alertas
A Priora não deverá solicitar intervenção humana para solucionar um problema que suas próprias regras determinísticas conseguem resolver com segurança.
O objetivo é preservar a atenção do analista para situações que realmente exigem decisão humana.
13. Rastreabilidade
Toda normalização automática relevante deverá possuir registro contendo, quando aplicável:
valor bruto extraído;
valor normalizado;
regra utilizada;
documento de origem;
campo;
evidências auxiliares utilizadas.
Isso permite reconstruir posteriormente como a Priora chegou ao valor utilizado na auditoria.
14. Relação com os Playbooks
Os Playbooks não precisam repetir estas regras.
Cada Família deverá apenas definir as características estruturais específicas de seu campo.
Exemplo:
NCM: aplicar as Regras Globais de Leitura e Normalização. Campo exclusivamente numérico, com níveis aceitos de 4, 6 ou 8 dígitos.
Ou:
Container: aplicar as Regras Globais de Leitura e Normalização, respeitando a estrutura definida para identificadores de container.
E pronto.
Capítulo Global — Sistema de Estados Visuais da Auditoria
1. Objetivo
Este capítulo estabelece o padrão global de representação visual utilizado pela Priora nas telas de Auditoria Documental e OCR.
Seu objetivo é permitir que o analista identifique imediatamente quais informações:
não exigem nenhuma ação;
merecem atenção;
possuem divergência objetiva;
ainda não puderam ser avaliadas.
O sistema visual deverá ser aplicado de maneira uniforme em todos os Playbooks e Famílias de Validação.
2. Princípio Fundamental
As cores da Priora não representam apenas se dois valores são iguais ou diferentes.
Elas representam:
O nível de atenção operacional necessário naquele momento.
A pergunta visual da interface deverá ser:
“Preciso olhar para isso?”
3. Estados Globais

| Cor | Estado | Significado operacional |
| --- | --- | --- |
| 🟢 | Consistente | Nenhuma ação necessária |
| 🟡 | Atenção | Não existe divergência objetiva confirmada, mas há algo que merece análise |
| 🔴 | Divergência | Existe inconsistência objetiva que exige tratamento |
| ⚪ | Não Avaliado | A Priora ainda não possui condições suficientes para concluir |

4. 🟢 Verde — Consistente
O estado verde significa que a informação foi corretamente extraída, validada pelas regras aplicáveis e não possui nenhuma ressalva conhecida que exija atenção humana.
Exemplo:
NCM

| Documento | Valor |
| --- | --- |
| MBL | 39269090 |
| HBL | 39269090 |

Histórico relevante:
Nenhum.
Resultado:
🟢 Consistente
O significado operacional é:
O analista não precisa gastar tempo aqui.
4.1 Normalizações automáticas não removem o verde
Uma pequena imperfeição do OCR que tenha sido resolvida de forma determinística não deverá gerar atenção.
Exemplo:
MBL:
39269O90
Após aplicação das regras globais de leitura:
39269090
HBL:
39269090
Resultado:
🟢 Consistente
A normalização permanece registrada para rastreabilidade, mas não há motivo operacional para chamar o analista.
5. 🟡 Amarelo — Atenção Necessária
O amarelo significa:
Ainda não existe uma divergência objetiva confirmada, porém existe uma condição que merece atenção humana.
Esse estado poderá surgir por motivos diferentes.
A Priora deverá sempre informar por que o campo está amarelo.
5.1 Atenção Contextual
Os documentos estão consistentes, porém existe informação contextual relevante no processo.
Exemplo:
NCM
MBL:
39269090
HBL:
39269090
Resultado documental:
✔ Consistente.
Entretanto:
E-mail de 14/08/2026: “Favor adicionar também o NCM 85044090.”
Resultado visual:
🟡 Consistente — verificar contexto
Ações:
[Confirmar documentos atuais]
[Verificar e-mail]
5.2 Leitura Incerta
As regras estruturais não foram suficientes para determinar um único valor.
Exemplo:
39269?90
O caractere pode representar mais de um número válido.
Resultado:
🟡 Leitura incerta — confirmar valor
5.3 Validação Humana
Algumas informações podem exigir interpretação operacional mesmo que a leitura esteja perfeita.
Resultado:
🟡 Validação humana necessária
Portanto, amarelo é um estado de atenção, não necessariamente de erro.
6. 🔴 Vermelho — Divergência
O vermelho deverá ser utilizado quando houver uma divergência objetiva entre evidências que deveriam corresponder.
Exemplo:
NCM
MBL:
39269090
HBL:
39269099
Resultado:
🔴 Divergência
Outro exemplo:
Peso Bruto
MBL:
20.000 KG
HBL:
19.850 KG
Resultado:
🔴 Divergência
Aqui não existe apenas possibilidade de erro.
Existe uma inconsistência documental efetivamente identificada.
7. ⚪ Cinza — Não Avaliado
O cinza deverá representar situações em que a Priora não possui elementos suficientes para emitir uma conclusão.
Exemplos:
documento ausente;
campo não localizado;
validação ainda não executada;
informação não aplicável àquele processo;
dependência anterior ainda não resolvida.
Resultado:
⚪ Não Avaliado
A ausência de informação não deverá ser transformada automaticamente em divergência.
8. Separação entre Estado Documental e Estado Contextual
Internamente, a Priora deverá preservar separadamente:
Document Status
Context Status
Visual Status
Exemplo:
Document Status:
CONSISTENT
Context Status:
ATTENTION_REQUIRED
Visual Status:
YELLOW
Isso significa:
Os documentos estão corretos entre si, mas existe algo no contexto operacional que merece análise.
Essa separação é necessária para impedir que atenções contextuais contaminem métricas de divergência documental.
9. Regra de Priorização Visual
Quando diferentes condições existirem simultaneamente, a Priora deverá apresentar visualmente a condição de maior atenção.
A prioridade será:
🔴 Divergência
>
🟡 Atenção
>
🟢 Consistente
O estado cinza não representa criticidade; representa ausência de conclusão.
Exemplo
MBL e HBL possuem NCM diferente:
🔴 Divergência.
Também existe um e-mail relacionado à alteração do NCM.
O campo continua:
🔴 Divergência
Mas a Priora poderá adicionar abaixo:
⚠ Existe também contexto histórico relacionado a este NCM.
O amarelo não deverá substituir o vermelho.
10. Estado do Campo × Estado do Documento
Um documento poderá possuir diversas validações internas.
Exemplo:
HBL
Container     🟢
Peso          🟢
Cubagem       🟢
NCM           🟡
Consignee     🟢
Porto         🔴
O documento deverá refletir a condição de maior prioridade existente dentro dele.
Nesse caso:
🔴 HBL — Atenção necessária
Ao abrir o documento, o analista identifica imediatamente que:
Porto possui divergência objetiva;
NCM possui atenção contextual;
demais campos estão consistentes.
11. Estado do Documento × Estado da Família
A mesma lógica deverá continuar subindo pela hierarquia.
Campo
↓
Subvalidação
↓
Família
↓
Documento
↓
Playbook
Se qualquer evidência crítica estiver vermelha, a Família poderá apresentar indicação de divergência.
Se não houver vermelho, mas houver amarelo:
🟡 Atenção.
Se tudo estiver resolvido e consistente:
🟢 Consistente.
Assim, o analista consegue começar pelo nível mais alto e aprofundar somente onde necessário.
12. Comportamento Visual nas Telas de OCR
Os documentos apresentados na área de OCR deverão possuir indicação visual imediata.
Documento Verde
Todas as validações aplicáveis estão consistentes e não existem atenções pendentes.
O analista pode seguir sem abrir o documento.
Documento Amarelo
A documentação não possui divergência objetiva confirmada, porém existe pelo menos uma atenção pendente.
Exemplos:
histórico relevante;
leitura realmente incerta;
validação humana;
informação contextual.
Documento Vermelho
Existe pelo menos uma divergência objetiva confirmada.
O analista deverá conseguir acessar diretamente as evidências divergentes.
Documento Cinza
O documento ainda não foi completamente avaliado ou não possui elementos suficientes para determinadas validações.
13. A Cor Nunca Deverá Aparecer Sozinha
A Priora nunca deverá depender exclusivamente da cor para comunicar um estado.
Todo estado deverá possuir também:
ícone;
descrição textual;
motivo;
evidência relacionada quando aplicável.
Exemplo:
🟡 Consistente — verificar contexto
é superior a simplesmente exibir uma borda amarela.
Isso também reduz ambiguidades de interpretação visual.
14. Estados Resolvidos pelo Analista
Quando uma atenção amarela for revisada pelo analista, a Priora deverá registrar a decisão.
Exemplo:
🟡 Atenção contextual
↓
Analista verifica e-mail
↓
Confirma documentos atuais
↓
🟢 Resolvido
O histórico da decisão permanece registrado.
Caso o analista conclua que existe realmente um problema:
🟡 Atenção contextual
↓
Analista verifica
↓
Confirma necessidade de correção
↓
🔴 Pendência / Divergência operacional
Assim, amarelo pode evoluir para verde ou vermelho dependendo da análise.
15. Evitar Fadiga de Alertas
O sistema visual somente terá valor se as cores preservarem seu significado.
Portanto, a Priora deverá evitar gerar amarelos para situações que possam ser resolvidas automaticamente com segurança.
Especialmente:
pequenas normalizações de OCR;
diferenças de formatação;
eventos históricos irrelevantes;
mensagens antigas já resolvidas;
equivalências previamente definidas;
informações sem impacto operacional.
Amarelo deve significar “vale a pena olhar”.
Caso tudo vire amarelo, o estado perde completamente sua função.
16. Relação com as Regras Globais de Leitura
O Sistema Visual deverá ser aplicado somente depois das regras globais de Leitura, Normalização e Ambiguidade.
Fluxo:
OCR
↓
Leitura
↓
Normalização
↓
Resolução de ambiguidades estruturais
↓
Validação operacional
↓
Análise contextual
↓
Estado visual
Isso impede que erros triviais de OCR contaminem a auditoria.
17. Regra Global
🟢 Verde significa ausência de ação necessária.
🟡 Amarelo significa atenção necessária sem divergência objetiva confirmada.
🔴 Vermelho significa divergência objetiva que exige tratamento.
⚪ Cinza significa ausência de conclusão suficiente.
18. Objetivo de Experiência
A interface deverá permitir que o analista abra um processo e compreenda seu estado praticamente sem ler.
Idealmente:
Processo IM-24581
Pré-Alerta
MBL                    🟢
HBL 01                 🟢
HBL 02                 🟡
HBL 03                 🔴
A atenção do analista vai naturalmente para:
1º 🔴 resolver divergência.
2º 🟡 verificar atenção.
3º 🟢 não perder tempo.
Isso traduz visualmente a principal proposta operacional da Priora:
mostrar o que exige atenção agora.
Volume I — Arquitetura Cognitiva da Priora
Capítulo X — Evidence Timeline (ETL)
X.1 Objetivo
A Evidence Timeline (ETL) é a camada responsável por registrar cronologicamente todos os eventos relevantes ocorridos durante o ciclo de vida de um processo operacional.
Seu objetivo não é servir como contexto direto para a Inteligência Artificial, mas preservar a evolução completa da operação, garantindo rastreabilidade, auditoria e reconstrução histórica dos acontecimentos.
A ETL funciona como o histórico oficial do processo.
X.2 Princípio Fundamental
A Priora não toma decisões consultando diretamente o histórico completo da operação.
Ela registra todos os eventos na ETL, preserva o conhecimento consolidado no POP e entrega à IA apenas o contexto mínimo necessário através do Context Builder.
Assim, a ETL representa a memória histórica da plataforma, e não a memória de trabalho da Inteligência Artificial.
X.3 Responsabilidade da ETL
A ETL possui apenas quatro responsabilidades:
registrar eventos;
preservar sua ordem cronológica;
manter rastreabilidade completa;
disponibilizar eventos para consultas estruturadas.
Ela nunca executa inferências.
Ela nunca interpreta documentos.
Ela nunca envia informações diretamente para a IA.
X.4 Estrutura de um Evento
Cada evento registrado deverá possuir, sempre que possível:

| Campo | Descrição |
| --- | --- |
| Timestamp | Data e hora do evento |
| Tipo | Comunicação, Documento, Auditoria ou Sistema |
| Origem | Outlook, Documento, Sistema ou Usuário |
| Autor | Cliente, Agente, Analista ou Sistema |
| Objeto | NCM, Consignee, Peso, Porto, Container etc. |
| Valor Anterior | Quando existir |
| Novo Valor | Quando existir |
| Evidências | Documentos ou mensagens relacionados |
| Criticidade | Informativa, Operacional ou Crítica |

X.5 Tipos de Eventos
A ETL poderá registrar eventos como:
Comunicação
envio de e-mail;
resposta do cliente;
resposta do agente;
aprovação do analista.
Documento
novo Draft recebido;
novo HBL;
novo MBL;
novo Packing List;
novo Invoice.
Alteração
alteração de NCM;
alteração de Peso;
alteração de Cubagem;
alteração de Porto;
alteração de Participante;
alteração de Container.
Auditoria
divergência encontrada;
divergência resolvida;
validação humana concluída;
Playbook finalizado.
Sistema
OCR executado;
Parser concluído;
Documento classificado;
Processo sincronizado.
X.6 Relação entre ETL e POP
A ETL registra acontecimentos.
O POP representa conhecimento consolidado.
Exemplo:
08:15
Cliente solicita alteração do NCM.
↓
Evento registrado.
09:20
Analista aprova alteração.
↓
Novo evento.
11:05
Novo Draft recebido.
↓
Novo evento.
11:08
Context Builder identifica que o novo Draft atende à alteração aprovada.
↓
POP atualizado.
Perceba que quem decide atualizar o POP não é a ETL.
A ETL apenas registra que os eventos ocorreram.
X.7 Context Builder
A ETL nunca é consultada diretamente pela Inteligência Artificial.
Sempre que um Playbook precisar de informações históricas, a consulta deverá ocorrer através do Context Builder.
O Context Builder é responsável por:
identificar qual Playbook está sendo executado;
determinar quais informações são necessárias;
consultar a ETL;
consultar o POP;
consultar os documentos estruturados;
construir um contexto mínimo para a IA.
A IA jamais deverá consultar o histórico completo da operação.
X.8 Princípio do Contexto Mínimo
Todo Playbook deverá informar explicitamente quais objetos necessita para executar sua auditoria.
O Context Builder deverá entregar exclusivamente essas informações.
Exemplo:
Playbook NCM
Recebe:
NCM do MBL;
NCM do HBL;
último evento relacionado ao NCM;
evidência aprovada mais recente.
Jamais receberá:
histórico completo do Outlook;
todos os e-mails;
todos os documentos do processo;
informações sem relação com o NCM.
Esse princípio reduz:
custo computacional;
consumo de tokens;
tempo de processamento;
risco de alucinações.
X.9 Fonte da Verdade Temporal
A ETL introduz o conceito de Fonte da Verdade Temporal.
A informação mais recente nem sempre representa a informação vigente.
Uma alteração somente poderá modificar o conhecimento consolidado quando existir uma sequência de evidências suficientemente confiável.
Exemplo:
Cliente solicita alteração
↓
Analista aprova
↓
Novo Draft recebido
↓
Alteração aplicada
Somente após essa sequência o POP poderá ser atualizado.
X.10 Benefícios Arquiteturais
A separação entre ETL, POP, Context Builder e IA permite que a Priora:
mantenha histórico completo da operação;
preserve rastreabilidade das decisões;
reduza drasticamente o consumo de tokens;
desacople armazenamento de raciocínio;
escale para milhares de processos simultaneamente;
manter a IA focada apenas nas evidências relevantes para cada auditoria.
X.11 Fluxo Arquitetural
Outlook Graph
│
▼
Ingestion Engine
│
▼
OCR / Parser
│
▼
ETL
(Eventos)
│
▼
POP
(Conhecimento Consolidado)
│
▼
Context Builder
(Contexto Mínimo)
│
▼
FRO
(Raciocínio Operacional)
│
▼
IA
│
▼
Auditoria
X.12 Responsabilidades da Arquitetura
Cada componente possui uma responsabilidade única.

| Componente | Responsabilidade |
| --- | --- |
| ETL | Registrar todos os eventos do processo |
| POP | Consolidar o conhecimento vigente da operação |
| Context Builder | Construir o menor contexto necessário para cada Playbook |
| FRO | Definir como a IA deve raciocinar |
| IA | Executar o raciocínio utilizando apenas o contexto recebido |

Essa separação garante que nenhuma camada assuma responsabilidades que pertencem a outra.
Capítulo X+1 — Core Engine da Priora
X+1.1 Objetivo
O Core Engine é o núcleo responsável por coordenar todos os componentes da Priora durante a execução de um Playbook.
Seu objetivo é garantir que cada validação seja executada utilizando apenas as informações necessárias, preservando rastreabilidade, reduzindo custo computacional e mantendo independência em relação ao modelo de Inteligência Artificial utilizado.
O Core Engine não executa auditorias diretamente. Ele orquestra os componentes responsáveis por cada etapa do processamento.
X+1.2 Princípio Fundamental
A Inteligência Artificial nunca deverá controlar o fluxo da plataforma.
A IA é apenas um mecanismo especializado em interpretação e raciocínio.
Toda a orquestração pertence ao Core Engine.
X+1.3 Arquitetura Geral
FONTES DE DADOS
Outlook Graph      Uploads      APIs      HeadCargo      Portal Cliente
│              │            │            │               │
└──────────────┴────────────┴────────────┴───────────────┘
│
▼
Ingestion Engine
│
▼
OCR / Parser Engine
│
▼
Object Extractor
│
┌─────────────────┴─────────────────┐
▼                                   ▼
Evidence Timeline (ETL)        Perfil Operacional (POP)
│                                   │
└─────────────────┬─────────────────┘
▼
Context Builder
│
▼
Rule Engine
│
(Regras Determinísticas)
│
Existe ambiguidade?
│               │
NÃO             SIM
│               ▼
│              FRO
│               │
│               ▼
│        Inteligência Artificial
│               │
└───────┬───────┘
▼
Confidence Engine
│
▼
Decision Engine
│
▼
Evidências / Auditoria / Clara
X+1.4 Componentes
Ingestion Engine
Responsável por receber todas as informações externas.
Entre elas:
Microsoft Graph;
Uploads do usuário;
APIs de armadores;
HeadCargo;
Portal do Cliente;
integrações futuras.
Sua única responsabilidade é transformar qualquer origem em uma entrada padronizada para a plataforma.
OCR / Parser Engine
Responsável por transformar documentos em texto estruturado.
Nesta etapa ainda não existem objetos operacionais.
Existe apenas informação extraída.
Object Extractor
Após o Parser, a Priora identifica os objetos presentes no documento.
Exemplo:
Container;
Porto;
Participante;
Peso;
Cubagem;
NCM;
Documento;
Navio;
Mercadoria.
Esses objetos passam a compor o domínio operacional da plataforma.
Evidence Timeline (ETL)
Responsável por registrar todos os acontecimentos ocorridos durante a vida do processo.
A ETL nunca interpreta informações.
Ela apenas registra eventos.
Perfil Operacional do Processo (POP)
Responsável por representar o estado atual do conhecimento da operação.
Enquanto a ETL responde:
O que aconteceu?
O POP responde:
O que sabemos neste momento?
Context Builder
Responsável por construir o menor conjunto possível de informações necessário para cada Playbook.
A IA jamais consulta diretamente:
Outlook;
Banco de Dados;
ETL;
POP.
Ela recebe apenas um contexto previamente preparado.
Rule Engine
Responsável por executar todas as validações determinísticas da plataforma.
Exemplos:
comparação de pesos;
comparação de containers;
igualdade de NCM;
igualdade de lacres;
existência de documentos.
Sempre que uma regra puder ser resolvida matematicamente ou logicamente, ela deverá ser executada nesta camada.
A IA não deverá ser utilizada para validações determinísticas.
Framework de Raciocínio Operacional (FRO)
Quando o Rule Engine identificar uma situação que exige interpretação, o caso será encaminhado ao FRO.
O FRO define o método de raciocínio que a IA deverá seguir.
A IA nunca decide livremente.
Ela executa o processo definido pelo FRO.
Inteligência Artificial
A IA possui apenas duas responsabilidades:
interpretar informações ambíguas;
responder às perguntas estruturadas pelo FRO.
Ela não possui memória.
Ela não consulta bancos de dados.
Ela não controla o fluxo da plataforma.
Confidence Engine
Após toda validação, a Priora deverá calcular o grau de confiança da conclusão.
Esse cálculo considera fatores como:
qualidade do OCR;
quantidade de evidências;
convergência entre fontes;
histórico do processo;
consistência das regras;
confiança informada pela própria IA.
O Confidence Engine pertence ao Core Engine e não ao modelo de IA.
Decision Engine
Responsável por consolidar:
regras determinísticas;
conclusões da IA;
nível de confiança;
histórico do processo;
criticidade da validação.
A partir dessa consolidação, produz a decisão oficial da plataforma.
X+1.5 Fluxo de Execução de um Playbook
Sempre que um Playbook for iniciado, o Core Engine deverá seguir obrigatoriamente a seguinte sequência:
Receber os documentos.
Executar OCR e Parser.
Extrair os Objetos Operacionais.
Registrar eventos relevantes na ETL.
Atualizar o POP, quando permitido.
Construir o contexto mínimo através do Context Builder.
Executar o Rule Engine.
Encaminhar apenas ambiguidades ao FRO.
Receber a resposta da IA.
Calcular o nível de confiança.
Consolidar a decisão no Decision Engine.
Registrar novas evidências na ETL e atualizar o POP, quando aplicável.
X+1.6 Princípios Arquiteturais
Toda evolução da Priora deverá respeitar os seguintes princípios:
Responsabilidade Única
Cada componente possui uma única responsabilidade claramente definida.
IA Stateless
A IA nunca possui memória permanente.
Toda memória pertence ao Core Engine.
Contexto Mínimo
Nenhum modelo de IA deverá receber mais informações do que o estritamente necessário para executar sua tarefa.
IA sob Demanda
A IA somente será utilizada quando o Rule Engine não conseguir resolver a validação de forma determinística.
Evidência Antes da Inferência
Sempre que uma decisão puder ser tomada por evidências objetivas, a inferência por IA deverá ser evitada.
Independência Tecnológica
A arquitetura da Priora não poderá depender de um fornecedor específico de Inteligência Artificial.
Qualquer modelo compatível deverá ser capaz de executar o FRO sem necessidade de alterações estruturais.
X+1.7 Objetivo Estratégico
O Core Engine existe para garantir que o conhecimento da Priora permaneça na plataforma, e não no modelo de Inteligência Artificial utilizado.
Os modelos de IA poderão evoluir, ser substituídos ou coexistir.
A arquitetura, o conhecimento operacional, as regras de negócio e o método de raciocínio permanecerão sob controle exclusivo da Priora.
### Capítulo 1 — Visão Geral do Playbook
#### 1.1 Introdução
O Playbook Pré‑Alerta representa o primeiro estágio da Auditoria Documental da Priora. Sua função é garantir que os documentos recebidos antes da nacionalização da carga descrevam corretamente a mesma operação logística, identificando inconsistências antes que sejam propagadas para as etapas seguintes do processo. Este documento estabelece as regras operacionais que governam a execução desse Playbook e serve como referência oficial para desenvolvimento, manutenção e evolução da plataforma.
#### 1.2 Finalidade
Transformar uma conferência documental tradicionalmente manual em um processo estruturado, reproduzível e rastreável. A Priora deve localizar automaticamente os documentos, identificar os campos relevantes, comparar informações objetivas, organizar evidências e apresentar ao analista apenas aquilo que exige intervenção humana.
#### 1.3 Escopo
Este Playbook audita exclusivamente o Pré‑Alerta, contemplando Master Bill of Lading (MBL) e House Bill of Lading (HBL). Não fazem parte deste Playbook: CE Mercante, Invoice, Packing List, DN/CN, Liberação e Demurrage.
#### 1.4 Papel na Arquitetura da Priora
O Playbook ocupa a camada de conhecimento operacional. Ele não realiza OCR, não interpreta PDFs e não organiza documentos. Essas responsabilidades pertencem ao Pipeline Documental e ao Core. O Playbook recebe informações estruturadas e aplica exclusivamente as regras de negócio para produzir evidências operacionais.
#### 1.5 Estrutura do Playbook
Os Playbooks seguem a hierarquia: Playbook → Família de Validação → Subvalidação → Regra Operacional.
#### 1.6 Princípios Operacionais
Objetividade, Rastreabilidade, Explicabilidade, Modularidade e Redução da Carga Cognitiva são princípios obrigatórios.
#### 1.7 Resultado Esperado
Ao término da execução, a plataforma deve produzir validações consistentes, divergências, validações humanas, itens não avaliados e recomendações ao analista.
#### 1.8 Critérios de Aceitação
O Playbook será considerado corretamente implementado quando auditar apenas os documentos do Pré‑Alerta, aplicar todas as famílias previstas, produzir evidências rastreáveis, permitir auditorias parciais e reduzir significativamente a conferência manual.
### Capítulo 2 — Objetivo do Playbook
#### 2.1 Objetivo
O Playbook Pré‑Alerta tem como objetivo verificar se o Master Bill of Lading (MBL) e o House Bill of Lading (HBL) representam corretamente a mesma operação logística antes da emissão do CE Mercante.

Sua finalidade é identificar inconsistências documentais enquanto ainda há tempo hábil para solicitar correções ao agente de origem, evitando que erros sejam propagados para as etapas seguintes da operação.

Ao antecipar essas verificações, a Priora reduz retrabalho operacional, custos com amendments, atrasos na liberação e riscos decorrentes de informações incorretas.
#### 2.2 Momento de Execução
O Playbook Pré-Alerta deve ser executado imediatamente após o recebimento dos documentos de Pré-Alerta e antes da conferência do CE Mercante.
Este é o primeiro processo de auditoria documental da Priora.
As informações validadas neste Playbook servirão como referência para os Playbooks subsequentes.
#### 2.3 Documentos Utilizados
Para executar este Playbook, a Priora utiliza exclusivamente os seguintes documentos:
Master Bill of Lading (MBL);
House Bill of Lading (HBL).
A ausência de um dos documentos não impede a execução da auditoria.
Nesses casos, a Priora deverá realizar uma auditoria parcial e registrar explicitamente quais validações não puderam ser concluídas.
#### 2.4 Objetivo Operacional
Durante a execução deste Playbook, a Priora deve responder, de forma objetiva, às seguintes perguntas:
O Master e o House representam a mesma operação logística?
Todos os contêineres correspondem corretamente?
Os pesos e cubagens são consistentes?
Os lacres estão corretos?
Os portos são compatíveis?
Os participantes da operação estão corretamente identificados?
Existem divergências que exigem correção?
Existem campos que dependem de validação humana?
O objetivo do Playbook não é apenas localizar diferenças, mas indicar quais delas possuem impacto operacional.
#### 2.5 Limites do Playbook
Este Playbook não tem como objetivo:
validar informações do CE Mercante;
conferir Invoice ou Packing List;
analisar documentos financeiros;
interpretar e-mails;
aprovar liberações;
calcular Demurrage.
Essas responsabilidades pertencem a outros Playbooks da plataforma.
2.6 Resultado Esperado
Ao concluir a auditoria, a Priora deverá produzir um conjunto estruturado de evidências classificadas em:
Consistentes — informações validadas com sucesso;
Divergências — diferenças objetivas entre os documentos;
Validações Humanas — situações que dependem de análise do operador;
Itens Não Avaliados — validações impossibilitadas pela ausência de documentos ou informações.
Essas evidências formarão a base da Mesa de Auditoria e orientarão todas as ações do analista.
#### 2.7 Dependências
Para que o Playbook seja executado corretamente, é necessário que o Core já tenha:
identificado e classificado os documentos;
agrupado corretamente Master e House pertencentes ao mesmo processo;
extraído os campos necessários através do OCR e do Parser;
normalizado os dados para comparação.
O Playbook não executa essas etapas; ele apenas consome os objetos estruturados produzidos pelo Core..
#### 2.8 Critérios de Aceitação
O Playbook Pré-Alerta será considerado corretamente implementado quando for capaz de:
auditar exclusivamente MBL e HBL;
executar todas as Famílias de Validação previstas;
permitir auditorias parciais;
produzir evidências organizadas e rastreáveis;
distinguir automaticamente divergências objetivas de validações humanas;
fornecer ao analista uma visão clara e consolidada da operação antes do CE Mercante.
### Capítulo 3 — Família de Validação V-003 — Containers
#### 3.1 Objetivo
A Família de Validação V-003 — Containers é responsável por garantir que todos os contêineres representados no Master Bill of Lading (MBL) estejam corretamente refletidos no House Bill of Lading (HBL).
Essa família estabelece o relacionamento estrutural entre os documentos e serve como base para diversas validações posteriores, como Peso Bruto, Cubagem, Lacres e NCM.
Sem um relacionamento correto entre os contêineres, as demais comparações não podem ser executadas com segurança.
#### 3.2 Importância Operacional
O contêiner é a principal entidade física de uma operação marítima.
Toda carga está vinculada a um ou mais contêineres, e praticamente todas as informações relevantes do processo são organizadas em torno deles.
Uma identificação incorreta do contêiner compromete a confiabilidade de todas as demais validações documentais.
Por esse motivo, a Família V-003 deve ser executada antes de qualquer outra validação dependente.
#### 3.3 Estrutura da Família
A Família V-003 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-003.1 | Existência | Verificar se todos os contêineres existem nos dois documentos. |
| V-003.2 | Correspondência | Confirmar que o número do contêiner é exatamente o mesmo. |
| V-003.3 | Quantidade | Garantir que a quantidade de contêineres seja compatível. |
| V-003.4 | Relacionamento | Construir automaticamente o vínculo entre Master e House para as próximas validações. |

#### 3.4 Ordem de Execução
As Subvalidações desta família devem ser executadas obrigatoriamente na seguinte sequência:
V-003.1 Existência
↓
V-003.2 Correspondência
↓
V-003.3 Quantidade
↓
V-003.4 Relacionamento
Caso uma etapa impeça a continuidade da auditoria, as validações dependentes deverão ser classificadas como Não Avaliadas, e nunca como Consistentes.
#### 3.5 Dependências
Esta Família não depende de nenhuma outra Família de Validação.
Entretanto, diversas famílias dependem dela.
Entre elas:
Peso Bruto;
Peso Líquido;
Cubagem;
Lacres;
NCM;
Madeira (Wood Package).
Essas validações somente poderão ser executadas após a conclusão da V-003.
#### 3.6 Estados Possíveis
Cada Subvalidação poderá retornar um dos seguintes estados:
Consistente — a regra foi satisfeita integralmente.
Divergência — foi identificada uma inconsistência objetiva.
Validação Humana — a comparação depende de decisão do analista.
Não Avaliada — a regra não pôde ser executada por ausência de dados ou dependência não satisfeita.
Esses estados serão reutilizados por todas as Famílias de Validação da Priora.
#### 3.7 Critérios de Aceitação da Família
A Família V-003 será considerada corretamente implementada quando:
identificar corretamente todos os contêineres presentes nos documentos;
verificar sua correspondência entre MBL e HBL;
validar a quantidade de contêineres da operação;
construir o relacionamento necessário para as validações subsequentes;
impedir que regras dependentes utilizem relacionamentos inconsistentes.
##### 3.8 Subvalidação V-003.1 — Existência
[Conteúdo inserido conforme texto aprovado na conversa.]
##### 3.8.1 Objetivo
A Subvalidação V-003.1 — Existência tem como objetivo verificar se todos os contêineres necessários para representar a operação logística estão presentes nos documentos auditados.
Antes de comparar qualquer informação, a Priora deve confirmar que os contêineres efetivamente existem em ambos os documentos.
Esta é a primeira verificação realizada dentro da Família de Validação V-003.
##### 3.8.2 Importância Operacional
Nenhuma auditoria documental pode ser considerada confiável quando um contêiner esperado está ausente.
A ausência de um contêiner impede que diversas validações posteriores sejam executadas corretamente, como:
Peso Bruto;
Peso Líquido;
Cubagem;
Lacres;
NCM;
Madeira.
Por esse motivo, esta Subvalidação possui alta criticidade dentro do Playbook.
##### 3.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) é considerado a fonte principal para a existência dos contêineres.
O House Bill of Lading deve conter exatamente os contêineres correspondentes à operação representada por aquele House.
Nos casos de múltiplos Houses, a validação deve considerar apenas os contêineres pertencentes ao House em análise.
##### 3.8.4 Regra Operacional
Para cada contêiner identificado no Master Bill of Lading, a Priora deverá verificar se existe um contêiner correspondente no House Bill of Lading relacionado.
A validação responde apenas à pergunta:
O contêiner existe?
Ela ainda não verifica se o número está correto.
Essa comparação será realizada na Subvalidação V-003.2.
Exemplo — Consistente
MBL
FANU1234567
↓
HBL
FANU1234567
Resultado:
✔ O contêiner existe nos dois documentos.
Exemplo — Divergência
MBL
FANU1234567
↓
HBL
—
Resultado:
⚠ O contêiner esperado não foi localizado.
##### 3.8.5 Exceções
Múltiplos Houses
Quando um Master possuir mais de um House, a existência deverá ser validada considerando apenas os contêineres pertencentes ao House correspondente.
A ausência de um contêiner em um House não deve ser compensada pela existência desse mesmo contêiner em outro House.
Auditoria Parcial
Caso um dos documentos esteja ausente, esta Subvalidação deverá assumir o estado:
Não Avaliada
Nunca deverá concluir automaticamente que existe uma divergência.
##### 3.8.6 Estados Possíveis
Esta Subvalidação pode retornar apenas quatro estados:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
##### 3.8.7 Criticidade
Alta
A inexistência de um contêiner compromete toda a cadeia de validações dependentes.
Sempre que esta Subvalidação falhar, as validações que dependem do relacionamento entre contêineres deverão ser interrompidas ou classificadas como Não Avaliadas.
##### 3.8.8 Critérios de Aceitação
A Subvalidação V-003.1 será considerada corretamente implementada quando:
localizar todos os contêineres presentes no MBL;
verificar a existência dos contêineres correspondentes no HBL;
tratar corretamente operações com múltiplos Houses;
permitir auditorias parciais;
impedir que validações dependentes sejam executadas quando a existência do contêiner não puder ser comprovada.
##### 3.8.9 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-003.2 — Correspondência;
V-003.3 — Quantidade;
V-003.4 — Relacionamento;
Família V-004 — Peso Bruto;
Família V-005 — Peso Líquido;
Família V-006 — Cubagem;
Família V-007 — Lacres;
Família V-008 — NCM.
Se a existência de um contêiner não puder ser comprovada, essas validações não devem prosseguir automaticamente.
3.9 — Subvalidação V-003.2 — Correspondência
3.9.1 Objetivo
A Subvalidação V-003.2 — Correspondência tem como objetivo verificar se o número de identificação de cada contêiner é exatamente o mesmo entre o Master Bill of Lading (MBL) e o House Bill of Lading (HBL).
Enquanto a Subvalidação V-003.1 confirma apenas a existência do contêiner, esta etapa valida sua identidade.
Uma diferença em qualquer caractere é suficiente para caracterizar uma divergência.
3.9.2 Importância Operacional
O número do contêiner representa o identificador único da unidade física transportada.
É através dele que toda a cadeia documental é construída.
Peso, cubagem, lacres, NCM e diversas outras informações passam a estar vinculadas a esse identificador.
Uma divergência no número do contêiner compromete a confiabilidade de todas as validações subsequentes.
Por esse motivo, esta Subvalidação possui criticidade Crítica.
3.9.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) é considerado a fonte oficial para o número do contêiner.
O House Bill of Lading deverá reproduzir exatamente o mesmo identificador para cada contêiner pertencente à operação.
3.9.4 Regra Operacional
Após confirmar que o contêiner existe em ambos os documentos (V-003.1), a Priora deverá comparar o número completo do contêiner.
A comparação deverá ser realizada caractere por caractere.
Qualquer divergência encontrada deverá ser registrada como inconsistência.
Esta Subvalidação não realiza correções automáticas nem tenta inferir qual documento está correto.
Seu papel é apenas identificar que existe uma incompatibilidade entre os documentos.
Exemplo — Consistente
MBL
FANU1234567
↓
HBL
FANU1234567
Resultado:
✔ Correspondência confirmada.
Exemplo — Divergência
MBL
FANU1234567
↓
HBL
FANU1234587
Resultado:
⚠ Número do contêiner divergente.
3.9.5 Exceções
Leitura com baixa confiança
Quando o OCR identificar caracteres potencialmente ambíguos (como O/0, I/1, S/5, B/8), a Priora não deverá assumir automaticamente uma divergência.
Nesses casos, a Subvalidação deverá retornar o estado Validação Humana, permitindo que o analista confirme a leitura diretamente no documento.
Documento ausente
Na ausência do MBL ou do HBL, a Subvalidação deverá assumir o estado Não Avaliada.
3.9.6 Estados Possíveis
Esta Subvalidação poderá retornar apenas os seguintes estados:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
3.9.7 Criticidade
Crítica
O número do contêiner funciona como a chave primária de relacionamento entre os documentos.
Caso esta validação falhe, a confiabilidade de todas as comparações vinculadas àquele contêiner fica comprometida.
3.9.8 Critérios de Aceitação
A Subvalidação V-003.2 será considerada corretamente implementada quando:
comparar integralmente o número do contêiner entre MBL e HBL;
identificar qualquer divergência de caracteres;
encaminhar leituras incertas para validação humana;
registrar claramente o valor encontrado em cada documento;
impedir que a plataforma apresente uma falsa sensação de consistência quando existir incompatibilidade.
3.9.9 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-003.3 — Quantidade;
V-003.4 — Relacionamento;
Família V-004 — Peso Bruto;
Família V-005 — Peso Líquido;
Família V-006 — Cubagem;
Família V-007 — Lacres;
Família V-008 — NCM;
todas as demais validações que utilizem o número do contêiner como chave de relacionamento.
3.9.9 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação literal do número completo do contêiner, caractere por caractere |
| Normalização permitida | Remoção de espaços, padronização de letras maiúsculas e desconsideração de separadores meramente visuais |
| Dependência de IA | Nenhuma para a comparação |
| Uso de OCR | Apenas para extração do valor |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Impede o relacionamento automático seguro daquele contêiner |

Com essa inserção, os antigos itens seguintes mudam de numeração:
3.9.10 — Critérios de Aceitação
3.9.11 — Impacto nas Validações Dependentes
3.10.1 Objetivo
A Subvalidação V-003.3 — Relacionamento tem como objetivo estabelecer o vínculo definitivo entre os contêineres identificados no Master Bill of Lading (MBL) e seus respectivos contêineres no House Bill of Lading (HBL).
Este relacionamento servirá como base para todas as Famílias de Validação que dependem da comparação de informações por contêiner.
Diferentemente das Subvalidações anteriores, esta etapa não verifica novos dados documentais. Ela consolida os resultados obtidos pelas validações de Existência e Correspondência para construir uma estrutura confiável de comparação.
3.10.2 Importância Operacional
Grande parte das informações auditadas pela Priora está associada a um contêiner específico.
Peso bruto, peso líquido, cubagem, lacres e diversas outras validações dependem que cada contêiner esteja corretamente relacionado entre os documentos.
Caso esse relacionamento seja construído de forma incorreta, todas as comparações subsequentes poderão produzir resultados inválidos.
Por esse motivo, esta Subvalidação representa o encerramento da Família de Containers e o início efetivo das validações da carga.
3.10.3 Fonte da Verdade
O relacionamento deverá ser construído utilizando exclusivamente os resultados das Subvalidações anteriores.
A Priora somente poderá relacionar automaticamente um contêiner quando:
sua existência tiver sido confirmada (V-003.1);
sua correspondência tiver sido confirmada (V-003.2).
Caso qualquer uma dessas condições não seja satisfeita, o relacionamento não deverá ser criado automaticamente.
3.10.4 Regra Operacional
Para cada contêiner validado com sucesso, a Priora deverá criar um relacionamento único entre o registro do Master Bill of Lading e o registro correspondente do House Bill of Lading.
Esse relacionamento passa a ser utilizado como chave para todas as validações posteriores.
Cada contêiner poderá possuir apenas um relacionamento válido dentro da mesma operação.
Não é permitido que um mesmo contêiner seja relacionado simultaneamente a dois registros diferentes.
Exemplo — Consistente
MBL
FANU1234567
↓
HBL
FANU1234567
↓
Relacionamento criado
MBL:FANU1234567
│
▼
HBL:FANU1234567
Resultado:
✔ Relacionamento criado com sucesso.
Exemplo — Divergência
MBL
FANU1234567
↓
HBL
FANU1234587
Resultado:
⚠ Relacionamento não criado.
A Priora deverá registrar que não foi possível estabelecer um vínculo confiável entre os documentos.
3.10.5 Exceções
Múltiplos Houses
Quando um Master possuir mais de um House, o relacionamento deverá ser criado individualmente para cada House.
Cada House poderá conter apenas os contêineres que efetivamente pertencem àquele conhecimento.
Um contêiner nunca poderá estar relacionado simultaneamente a dois Houses diferentes.
Auditoria Parcial
Caso algum documento esteja ausente ou alguma Subvalidação anterior não tenha sido concluída, o relacionamento deverá assumir o estado Não Criado, impedindo a execução automática das validações dependentes.
3.10.6 Estados Possíveis
Esta Subvalidação poderá retornar os seguintes estados:
✔ Relacionamento Criado
⚠ Relacionamento Não Criado
👤 Validação Humana
⏸ Não Avaliada
3.10.7 Criticidade
Crítica
O relacionamento entre contêineres é a base estrutural de todas as validações posteriores.
Um relacionamento incorreto pode gerar uma sequência de comparações inválidas e comprometer toda a auditoria documental.
3.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Construção de relacionamento utilizando apenas contêineres previamente validados |
| Normalização permitida | Não aplicável |
| Dependência de IA | Nenhuma |
| Uso de OCR | Apenas para extração dos dados utilizados pelas Subvalidações anteriores |
| Permite inferência automática | Não |
| Fonte da verdade | Resultados das Subvalidações V-003.1 e V-003.2 |
| Baixa confiança de leitura | Herdada das validações anteriores |
| Falha da regra | Impede todas as validações dependentes daquele contêiner |

3.10.9 Critérios de Aceitação
A Subvalidação V-003.3 será considerada corretamente implementada quando:
criar relacionamentos apenas entre contêineres previamente validados;
impedir relacionamentos ambíguos;
tratar corretamente operações com múltiplos Houses;
impedir a continuidade das validações dependentes quando não houver relacionamento confiável;
registrar claramente quais relacionamentos foram criados e quais não puderam ser estabelecidos.
3.10.10 Impacto nas Validações Dependentes
Esta Subvalidação fornece a estrutura utilizada por todas as Famílias de Validação subsequentes.
A partir deste ponto, todas as comparações passam a utilizar o relacionamento criado nesta etapa como referência.
São diretamente dependentes desta Subvalidação:
V-004 — Volumes da Carga
V-005 — Peso Bruto
V-006 — Peso Líquido
V-007 — Cubagem
V-008 — Lacres
V-009 — NCM
V-010 — Portos
V-011 — Partes Envolvidas
V-012 — Madeira
V-013 — Valores Comerciais
Capítulo 4 — Família de Validação V-004 — Volumes da Carga
4.1 Objetivo
A Família de Validação V-004 — Volumes da Carga tem como objetivo garantir que a quantidade e a natureza dos volumes representados no Master Bill of Lading (MBL) sejam compatíveis com aquelas informadas no House Bill of Lading (HBL).
Esta família valida a composição física da carga, verificando se ambos os documentos descrevem corretamente os mesmos volumes transportados.
Enquanto a Família V-003 estabelece qual contêiner está sendo analisado, a Família V-004 estabelece o que está sendo transportado dentro dessa operação.
4.2 Importância Operacional
A conferência dos volumes é uma das verificações mais frequentes realizadas por analistas de importação.
Diferenças na quantidade ou no tipo de volume podem indicar:
erro na emissão documental;
divergências entre agente e embarcador;
documentos incompletos;
inconsistências que poderão ser reproduzidas no CE Mercante.
Por esse motivo, esta Família representa a primeira validação efetiva das características da carga.
4.3 Estrutura da Família
A Família V-004 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-004.1 | Quantidade de Volumes | Validar a quantidade de volumes transportados. |
| V-004.2 | Tipo de Volume | Validar o tipo de embalagem (Cartons, Bags, Pallets, Drums, Cases, Rolls etc.). |
| V-004.3 | Consistência dos Volumes | Confirmar que quantidade e tipo representam a mesma carga entre MBL e HBL. |

4.4 Ordem de Execução
As Subvalidações deverão ser executadas obrigatoriamente na seguinte sequência:
V-004.1 Quantidade de Volumes
↓
V-004.2 Tipo de Volume
↓
V-004.3 Consistência dos Volumes
Cada etapa utiliza os resultados produzidos pela anterior.
4.5 Dependências
Esta Família depende diretamente da conclusão da Família V-003 — Containers.
Somente após o relacionamento correto dos contêineres é possível garantir que a comparação dos volumes esteja sendo realizada dentro da operação correta.
As Famílias seguintes também dependerão desta validação, principalmente:
Peso Bruto;
Peso Líquido;
Cubagem;
Valores Comerciais.
4.6 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
Esses estados seguem o padrão definido para toda a Base de Conhecimento Operacional.
4.7 Critérios de Aceitação da Família
A Família V-004 será considerada corretamente implementada quando for capaz de:
validar corretamente a quantidade de volumes;
identificar diferenças no tipo de embalagem;
distinguir divergências objetivas de situações que exigem validação humana;
consolidar quantidade e tipo em uma única avaliação de consistência;
fornecer evidências claras e rastreáveis ao analista.
4.8 — Subvalidação V-004.1 — Quantidade de Volumes
4.8.1 Objetivo
A Subvalidação V-004.1 — Quantidade de Volumes tem como objetivo verificar se a quantidade total de volumes informada no Master Bill of Lading (MBL) corresponde à quantidade total informada no House Bill of Lading (HBL).
Esta validação garante que ambos os documentos representem a mesma quantidade física de unidades transportadas, independentemente do tipo de embalagem.
4.8.2 Importância Operacional
A quantidade de volumes é uma das principais informações utilizadas para identificar inconsistências documentais antes da chegada da carga.
Diferenças nesse campo podem indicar:
erro de digitação;
emissão incorreta do conhecimento;
alteração documental não refletida em ambos os documentos;
necessidade de correção junto ao agente de origem.
Uma divergência de quantidade deve sempre ser tratada como uma inconsistência objetiva.
4.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte de referência para a quantidade total de volumes.
O House Bill of Lading deverá representar exatamente a mesma quantidade referente à carga daquele House.
Nas operações com múltiplos Houses, a soma das quantidades dos Houses deverá corresponder à quantidade representada pelo Master.
4.8.4 Regra Operacional
A Priora deverá extrair a quantidade de volumes presente em cada documento e compará-la numericamente.
Esta validação considera exclusivamente o valor numérico.
O tipo de embalagem será validado posteriormente pela Subvalidação V-004.2.
Exemplo — Consistente
MBL
250 CARTONS
↓
HBL
250 CARTONS
Resultado:
✔ Quantidade consistente.
Exemplo — Divergência
MBL
250 CARTONS
↓
HBL
248 CARTONS
Resultado:
⚠ Divergência na quantidade de volumes.
4.8.5 Exceções
Múltiplos Houses
Quando houver mais de um House vinculado ao mesmo Master, a Priora deverá considerar a soma das quantidades presentes em todos os Houses.
Exemplo:
MBL
250 CARTONS
↓
HBL 1
100 CARTONS
↓
HBL 2
150 CARTONS
Resultado:
✔ Quantidade consistente.
Documento Ausente
Caso o MBL ou algum HBL necessário para compor a operação esteja ausente, a Subvalidação deverá assumir o estado Não Avaliada.
4.8.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
4.8.7 Criticidade
Alta
A quantidade de volumes representa uma característica estrutural da carga.
Uma divergência neste campo pode indicar inconsistências relevantes na documentação e deverá ser analisada pelo operador.
4.8.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação numérica da quantidade de volumes |
| Normalização permitida | Remoção de separadores e espaços |
| Dependência de IA | Apenas para extração do valor |
| Uso de OCR | Extração da quantidade |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Impede a confirmação da consistência dos volumes |

4.8.9 Critérios de Aceitação
A Subvalidação V-004.1 será considerada corretamente implementada quando:
comparar corretamente as quantidades entre MBL e HBL;
suportar operações com múltiplos Houses;
identificar diferenças numéricas objetivas;
registrar claramente os valores encontrados em cada documento;
encaminhar leituras incertas para validação humana.
4.8.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-004.2 — Tipo de Volume;
V-004.3 — Consistência dos Volumes;
V-005 — Peso Bruto (como evidência complementar);
V-006 — Peso Líquido;
Resumo Executivo da Auditoria.
4.9 — Subvalidação V-004.2 — Tipo de Volume
4.9.1 Objetivo
A Subvalidação V-004.2 — Tipo de Volume tem como objetivo verificar se o tipo de unidade de carga informado no Master Bill of Lading (MBL) corresponde exatamente ao tipo informado no House Bill of Lading (HBL).
Esta validação garante que ambos os documentos representem a carga utilizando a mesma classificação física de embalagem.
Enquanto a Subvalidação V-004.1 valida a quantidade, esta etapa valida a natureza da unidade transportada.
4.9.2 Importância Operacional
O tipo de volume representa a forma física como a carga foi acondicionada para transporte.
Diferenças nesse campo podem gerar interpretações incorretas sobre a operação logística e indicar erros de emissão documental.
As embalagens mais comuns incluem:
Cartons
Packages
Bags
Pallets
Drums
Cases
Rolls
Bundles
Crates
Boxes
Pieces
Bales
Sacks
A Priora não deve assumir equivalência entre tipos diferentes, mesmo que, operacionalmente, possam representar conceitos semelhantes.
4.9.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a referência para o tipo de volume.
O House Bill of Lading deverá reproduzir exatamente a mesma classificação para a carga correspondente.
4.9.4 Regra Operacional
Após validar a quantidade de volumes, a Priora deverá comparar o tipo de embalagem informado em ambos os documentos.
A comparação deverá ser textual, utilizando o valor extraído do documento.
Não deverão ser realizadas conversões automáticas nem inferências semânticas.
Por exemplo:
Cartons ≠ Packages
Drums ≠ Barrels
Bags ≠ Sacks
Mesmo que, em determinados contextos, esses termos possam ser utilizados como sinônimos, a Priora deverá tratá-los como diferentes até que exista uma regra operacional específica determinando o contrário.
Exemplo — Consistente
MBL
250 CARTONS
↓
HBL
250 CARTONS
Resultado:
✔ Tipo de volume consistente.
Exemplo — Divergência
MBL
250 CARTONS
↓
HBL
250 PACKAGES
Resultado:
⚠ Divergência no tipo de volume.
4.9.5 Exceções
Idioma
Caso ambos os documentos utilizem idiomas diferentes, mas a classificação seja oficialmente equivalente segundo uma tabela de equivalência definida pela Priora, a comparação poderá utilizar essa tabela.
Na ausência de uma equivalência oficialmente cadastrada, os valores deverão ser tratados como diferentes.
Observação: A tabela de equivalência será uma funcionalidade futura e não faz parte do escopo inicial do Playbook.
Documento Ausente
Na ausência do MBL ou do HBL, esta Subvalidação deverá assumir o estado Não Avaliada.
4.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
4.9.7 Criticidade
Média
Uma divergência no tipo de volume normalmente não impede a continuidade da auditoria, mas deve ser analisada pelo operador antes da confirmação da consistência documental.
4.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação textual literal |
| Normalização permitida | Remoção de espaços excedentes e padronização para maiúsculas |
| Dependência de IA | Apenas para extração do valor |
| Uso de OCR | Extração do tipo de volume |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência de tipo, mas não invalida a Subvalidação de Quantidade |

4.9.9 Critérios de Aceitação
A Subvalidação V-004.2 será considerada corretamente implementada quando:
comparar corretamente os tipos de volume entre MBL e HBL;
identificar diferenças textuais objetivas;
respeitar futuras tabelas de equivalência quando existentes;
registrar claramente os valores encontrados em cada documento;
encaminhar leituras incertas para validação humana.
4.9.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-004.3 — Consistência dos Volumes;
Resumo Executivo da Auditoria;
Geração de Evidências.
4.10 — Subvalidação V-004.3 — Consistência dos Volumes
4.10.1 Objetivo
A Subvalidação V-004.3 — Consistência dos Volumes tem como objetivo consolidar os resultados das Subvalidações Quantidade de Volumes (V-004.1) e Tipo de Volume (V-004.2) para determinar se os volumes descritos no Master Bill of Lading (MBL) e no House Bill of Lading (HBL) representam a mesma carga.
Esta Subvalidação não realiza novas comparações documentais.
Sua responsabilidade é interpretar os resultados obtidos pelas validações anteriores e produzir uma conclusão única sobre a consistência dos volumes.
4.10.2 Importância Operacional
Durante a conferência documental, o analista normalmente não toma decisões isoladas com base apenas na quantidade ou apenas no tipo de embalagem.
Sua conclusão é formada pelo conjunto dessas informações.
Esta Subvalidação reproduz esse comportamento operacional, transformando diversas verificações em uma única evidência de auditoria.
4.10.3 Fonte da Verdade
A Consistência dos Volumes utiliza exclusivamente os resultados produzidos pelas seguintes Subvalidações:
V-004.1 — Quantidade de Volumes
V-004.2 — Tipo de Volume
Nenhuma nova informação deverá ser extraída dos documentos nesta etapa.
4.10.4 Regra Operacional
A Priora deverá combinar os resultados das Subvalidações anteriores conforme a seguinte lógica:

| Quantidade | Tipo | Resultado |
| --- | --- | --- |
| ✔ | ✔ | ✔ Consistente |
| ✔ | ❌ | ⚠ Divergência |
| ❌ | ✔ | ⚠ Divergência |
| ❌ | ❌ | ⚠ Divergência |
| 👤 | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser considerada positiva quando ambas as validações anteriores forem consistentes.
Exemplo 1 — Consistente
MBL
250 CARTONS
↓
HBL
250 CARTONS
Resultado:
✔ Consistência dos volumes confirmada.
Exemplo 2 — Divergência de Tipo
MBL
250 CARTONS
↓
HBL
250 PACKAGES
Resultado:
⚠ Quantidade consistente.
⚠ Tipo divergente.
⚠ Consistência dos volumes divergente.
Exemplo 3 — Divergência de Quantidade
MBL
250 CARTONS
↓
HBL
248 CARTONS
Resultado:
⚠ Quantidade divergente.
✔ Tipo consistente.
⚠ Consistência dos volumes divergente.
4.10.5 Exceções
Esta Subvalidação não possui exceções próprias.
Qualquer exceção deverá ser herdada das Subvalidações V-004.1 e V-004.2.
4.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
4.10.7 Criticidade
Alta
Embora não execute comparações diretamente, esta Subvalidação representa a conclusão operacional da Família V-004.
Seu resultado será utilizado pelo Resumo Executivo da Auditoria e pela Clara ao explicar ao analista por que a carga foi considerada consistente ou divergente.
4.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica dos resultados anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | V-004.1 e V-004.2 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca a Família V-004 como inconsistente |

4.10.9 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
consolidar corretamente os resultados das Subvalidações V-004.1 e V-004.2;
produzir uma única conclusão operacional sobre os volumes;
respeitar os estados herdados das validações anteriores;
não realizar novas interpretações dos documentos;
fornecer uma evidência clara para o analista.
4.10.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-005 — Peso Bruto
V-006 — Peso Líquido
V-007 — Cubagem
Resumo Executivo da Auditoria
Explicações da Clara
Indicador geral de consistência documental
Capítulo 5 — Família de Validação V-005 — Peso Bruto
5.1 Objetivo
A Família de Validação V-005 — Peso Bruto tem como objetivo verificar se o peso bruto informado no Master Bill of Lading (MBL) corresponde exatamente ao peso bruto informado no House Bill of Lading (HBL), garantindo consistência tanto por contêiner quanto pela operação completa.
Esta Família valida uma das principais características físicas da carga e assegura que os documentos representem fielmente o mesmo embarque.
5.2 Importância Operacional
O peso bruto influencia diretamente diversas etapas da operação logística, incluindo controles aduaneiros, conferências documentais, armazenagem e transporte.
Diferenças nesse campo podem indicar:
erro de emissão documental;
alteração não refletida em todos os documentos;
associação incorreta entre House e Master;
inconsistências que poderão ser reproduzidas no CE Mercante.
Por esse motivo, trata-se de uma validação de alta criticidade.
5.3 Estrutura da Família
A Família V-005 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-005.1 | Peso Bruto por Contêiner | Validar o peso bruto individual de cada contêiner. |
| V-005.2 | Peso Bruto Total | Validar se a soma dos Houses corresponde ao peso bruto total do Master. |
| V-005.3 | Consistência do Peso Bruto | Consolidar os resultados anteriores em uma única conclusão operacional. |

5.4 Ordem de Execução
V-005.1 Peso Bruto por Contêiner
↓
V-005.2 Peso Bruto Total
↓
V-005.3 Consistência do Peso Bruto
A execução deverá seguir obrigatoriamente essa sequência.
5.5 Dependências
Esta Família depende da conclusão das seguintes Famílias:
V-003 — Containers;
V-004 — Volumes da Carga.
A comparação do peso somente poderá ocorrer quando os contêineres estiverem corretamente relacionados e a estrutura da carga já tiver sido validada.
5.6 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
5.7 Critérios de Aceitação da Família
A Família V-005 será considerada corretamente implementada quando for capaz de:
validar o peso bruto individual por contêiner;
validar o peso bruto total da operação;
identificar qualquer divergência, independentemente da diferença encontrada;
consolidar os resultados em uma única conclusão operacional;
produzir evidências claras e rastreáveis.
Observações Operacionais (decisões já consolidadas)
Este capítulo incorpora as seguintes regras aprovadas:
O peso bruto será conferido por contêiner e pelo total da operação.
Em operações com múltiplos Houses:
cada House será comparado ao(s) seu(s) respectivo(s) contêiner(es);
a soma dos pesos dos Houses deverá corresponder exatamente ao peso bruto total do Master.
Não existe tolerância. Qualquer diferença numérica deverá gerar divergência.
Formatações diferentes representam o mesmo valor quando equivalentes numericamente, por exemplo:
20000
20000.00
20.000,000
Não serão realizadas conversões automáticas de unidades.
Exemplo: KG ≠ LB → Divergência.
A fonte da verdade é sempre o Master Bill of Lading (MBL).
5.8 — Subvalidação V-005.1 — Peso Bruto por Contêiner
5.8.1 Objetivo
A Subvalidação V-005.1 — Peso Bruto por Contêiner tem como objetivo verificar se o peso bruto informado para cada contêiner no Master Bill of Lading (MBL) corresponde exatamente ao peso bruto informado no House Bill of Lading (HBL).
A comparação deverá ser realizada individualmente para cada contêiner previamente relacionado pela Família V-003 — Containers.
5.8.2 Importância Operacional
O peso bruto por contêiner representa uma das principais características físicas da carga.
Uma divergência nesse campo pode indicar:
erro na emissão documental;
associação incorreta entre House e Master;
alteração documental não refletida em todos os documentos;
erro operacional na consolidação da carga.
Como o peso é utilizado em diversas etapas da operação logística e do despacho aduaneiro, qualquer diferença deve ser analisada antes do prosseguimento do processo.
5.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte oficial para o peso bruto de cada contêiner.
O House Bill of Lading deverá reproduzir exatamente o mesmo valor para o respectivo contêiner.
5.8.4 Regra Operacional
Após o relacionamento dos contêineres, a Priora deverá comparar o peso bruto informado para cada contêiner entre o MBL e o HBL correspondente.
A comparação será exclusivamente numérica.
Qualquer diferença de valor deverá gerar divergência.
Não existe margem de tolerância operacional.
Exemplo — Consistente
MBL
Container FANU1234567
Peso Bruto: 8.000 KG
↓
HBL
Container FANU1234567
Peso Bruto: 8.000 KG
Resultado:
✔ Peso bruto consistente.
Exemplo — Divergência
MBL
Container FANU1234567
Peso Bruto: 8.000 KG
↓
HBL
Container FANU1234567
Peso Bruto: 8.001 KG
Resultado:
⚠ Divergência no peso bruto do contêiner.
5.8.5 Exceções
Casas Decimais
Os seguintes valores deverão ser considerados equivalentes:
8000
8000.00
8.000,000
A comparação deverá ocorrer após a normalização numérica realizada pelo Parser.
Unidade de Medida
A Priora não deverá realizar conversão automática de unidades.
Exemplo:
MBL
8.000 KG
↓
HBL
17.637 LB
Resultado:
⚠ Divergência.
Mesmo que os valores sejam matematicamente equivalentes.
Documento Ausente
Caso o MBL ou o HBL esteja ausente, a Subvalidação deverá assumir o estado Não Avaliada.
5.8.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
5.8.7 Criticidade
Alta
Uma divergência no peso bruto por contêiner compromete a confiabilidade da operação documental e pode indicar inconsistências relevantes para as etapas seguintes do processo.
5.8.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação numérica após normalização |
| Normalização permitida | Formatação numérica (casas decimais e separadores) |
| Dependência de IA | Apenas para extração do valor |
| Uso de OCR | Extração do peso bruto |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para o contêiner correspondente |

5.8.9 Critérios de Aceitação
A Subvalidação V-005.1 será considerada corretamente implementada quando:
comparar corretamente o peso bruto de cada contêiner;
respeitar os relacionamentos estabelecidos pela Família V-003;
normalizar corretamente a representação numérica;
identificar qualquer diferença de valor;
não realizar conversões automáticas de unidade de medida.
5.8.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-005.2 — Peso Bruto Total;
V-005.3 — Consistência do Peso Bruto;
Resumo Executivo da Auditoria;
Explicações da Clara.
5.9 — Subvalidação V-005.2 — Peso Bruto Total
5.9.1 Objetivo
A Subvalidação V-005.2 — Peso Bruto Total tem como objetivo verificar se o peso bruto total informado no Master Bill of Lading (MBL) corresponde exatamente à soma dos pesos brutos informados nos House Bills of Lading (HBLs) pertencentes à mesma operação.
Esta validação garante a integridade da operação como um todo, independentemente da quantidade de Houses envolvidos.
5.9.2 Importância Operacional
Mesmo que todos os contêineres estejam corretos individualmente, a operação somente poderá ser considerada consistente quando o peso bruto total também corresponder ao valor informado no Master.
Essa conferência permite identificar:
omissão de um House;
duplicidade de informações;
erro na consolidação da carga;
divergências documentais que não aparecem na análise individual dos contêineres.
Por isso, esta Subvalidação complementa a análise por contêiner e valida a consistência global da operação.
5.9.3 Fonte da Verdade
O Master Bill of Lading (MBL) será considerado a fonte oficial para o peso bruto total da operação.
Os pesos informados nos Houses deverão, quando somados, resultar exatamente no mesmo valor.
5.9.4 Regra Operacional
A Priora deverá somar o peso bruto de todos os Houses pertencentes ao mesmo Master e comparar esse resultado com o peso bruto total informado no MBL.
Não existe margem de tolerância.
Qualquer diferença deverá ser registrada como divergência.
Esta comparação deverá ocorrer somente após a conclusão da Subvalidação V-005.1 — Peso Bruto por Contêiner.
Exemplo — Consistente
MBL
Peso Bruto Total: 20.000 KG
↓
HBL 1
8.000 KG
↓
HBL 2
12.000 KG
↓
Soma dos Houses:
20.000 KG
Resultado:
✔ Peso bruto total consistente.
Exemplo — Divergência
MBL
Peso Bruto Total: 20.000 KG
↓
HBL 1
8.000 KG
↓
HBL 2
11.950 KG
↓
Soma dos Houses:
19.950 KG
Resultado:
⚠ Divergência no peso bruto total da operação.
5.9.5 Exceções
House Único
Quando existir apenas um House vinculado ao Master, o peso bruto desse House deverá corresponder diretamente ao peso bruto total informado no MBL.
Casas Decimais
Os seguintes formatos deverão ser considerados equivalentes:
20000
20000.00
20.000,000
A comparação ocorrerá sempre após a normalização numérica.
Unidade de Medida
A Priora não realizará conversões automáticas entre unidades.
Caso os documentos utilizem unidades diferentes (KG × LB), a Subvalidação deverá retornar Divergência.
Documento Ausente
Na ausência do Master ou de qualquer House necessário para compor a operação, esta Subvalidação deverá assumir o estado Não Avaliada.
5.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
5.9.7 Criticidade
Alta
Uma divergência no peso bruto total compromete a consistência global da operação e deve ser tratada antes do prosseguimento da auditoria.
5.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Soma dos pesos dos Houses versus peso total do Master |
| Normalização permitida | Formatação numérica (casas decimais e separadores) |
| Dependência de IA | Apenas para extração dos valores |
| Uso de OCR | Extração dos pesos |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para a operação completa |

5.9.9 Critérios de Aceitação
A Subvalidação V-005.2 será considerada corretamente implementada quando:
somar corretamente os pesos brutos de todos os Houses;
comparar o resultado com o peso bruto total do Master;
identificar qualquer diferença de valor;
suportar operações com um ou múltiplos Houses;
produzir evidências claras e rastreáveis.
5.9.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-005.3 — Consistência do Peso Bruto;
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação.
5.10 — Subvalidação V-005.3 — Consistência do Peso Bruto
5.10.1 Objetivo
A Subvalidação V-005.3 — Consistência do Peso Bruto tem como objetivo consolidar os resultados das Subvalidações Peso Bruto por Contêiner (V-005.1) e Peso Bruto Total (V-005.2) para determinar se o peso bruto informado na operação é documentalmente consistente.
Esta Subvalidação não realiza novas comparações.
Seu papel é produzir uma conclusão operacional única para toda a Família V-005.
5.10.2 Importância Operacional
Na prática operacional, o analista não conclui a conferência do peso apenas porque um contêiner está correto.
A operação somente é considerada consistente quando:
todos os contêineres possuem pesos compatíveis;
o peso total da operação corresponde ao Master.
Esta Subvalidação reproduz exatamente essa lógica.
5.10.3 Fonte da Verdade
A Consistência do Peso Bruto utiliza exclusivamente os resultados produzidos por:
V-005.1 — Peso Bruto por Contêiner
V-005.2 — Peso Bruto Total
Nenhuma nova informação será extraída dos documentos.
5.10.4 Regra Operacional
A Priora deverá consolidar os resultados anteriores utilizando a seguinte lógica:

| Peso por Contêiner | Peso Total | Resultado |
| --- | --- | --- |
| ✔ | ✔ | ✔ Consistente |
| ✔ | ❌ | ⚠ Divergência |
| ❌ | ✔ | ⚠ Divergência |
| ❌ | ❌ | ⚠ Divergência |
| 👤 | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser considerada positiva quando ambas as Subvalidações forem consistentes.
Exemplo 1 — Consistente
Peso por Contêiner: ✔ Consistente
Peso Total: ✔ Consistente
Resultado:
✔ Consistência do Peso Bruto confirmada.
Exemplo 2 — Divergência no Peso Total
Peso por Contêiner: ✔ Consistente
Peso Total: ⚠ Divergência
Resultado:
⚠ Operação inconsistente.
Exemplo 3 — Divergência por Contêiner
Peso por Contêiner: ⚠ Divergência
Peso Total: ✔ Consistente
Resultado:
⚠ Operação inconsistente.
5.10.5 Exceções
Esta Subvalidação não possui exceções próprias.
Todos os estados especiais deverão ser herdados das Subvalidações anteriores.
5.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
5.10.7 Criticidade
Crítica
Esta Subvalidação representa a conclusão oficial da Família V-005.
Seu resultado será utilizado pelo Resumo Executivo da Auditoria e pela Clara para explicar ao analista a situação do peso bruto da operação.
5.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | V-005.1 e V-005.2 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca toda a Família V-005 como inconsistente |

5.10.9 Critérios de Aceitação
A Subvalidação V-005.3 será considerada corretamente implementada quando:
consolidar corretamente os resultados das Subvalidações anteriores;
produzir uma única conclusão operacional sobre o peso bruto da operação;
respeitar os estados herdados;
não realizar novas comparações documentais;
gerar uma evidência clara e rastreável para o analista.
5.10.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-006 — Peso Líquido
V-007 — Cubagem
Resumo Executivo da Auditoria
Explicações da Clara
Indicador Geral de Consistência da Operação
Capítulo 6 — Família de Validação V-006 — Peso Líquido
6.1 Objetivo
A Família de Validação V-006 — Peso Líquido tem como objetivo verificar se o peso líquido informado no Master Bill of Lading (MBL) corresponde exatamente ao peso líquido informado no House Bill of Lading (HBL), garantindo consistência tanto por contêiner quanto pela operação completa.
Esta Família assegura que ambos os documentos representem corretamente a quantidade líquida de carga transportada, desconsiderando o peso das embalagens e dos contêineres.
6.2 Importância Operacional
O peso líquido representa a quantidade efetiva de mercadoria transportada e constitui uma das principais informações utilizadas em processos aduaneiros, fiscais e operacionais.
Diferenças nesse campo podem indicar:
erro de emissão documental;
divergência entre Master e House;
alteração da carga não refletida nos documentos;
inconsistências que poderão ser reproduzidas no CE Mercante e na Declaração de Importação.
Por esse motivo, trata-se de uma validação de alta criticidade.
6.3 Estrutura da Família
A Família V-006 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-006.1 | Peso Líquido por Contêiner | Validar o peso líquido individual de cada contêiner. |
| V-006.2 | Peso Líquido Total | Validar se a soma dos Houses corresponde ao peso líquido total do Master. |
| V-006.3 | Consistência do Peso Líquido | Consolidar os resultados anteriores em uma única conclusão operacional. |

6.4 Ordem de Execução
V-006.1 Peso Líquido por Contêiner
↓
V-006.2 Peso Líquido Total
↓
V-006.3 Consistência do Peso Líquido
6.5 Dependências
Esta Família depende da conclusão das seguintes Famílias:
V-003 — Containers
V-004 — Volumes da Carga
O peso líquido somente poderá ser comparado quando os contêineres estiverem corretamente relacionados e a estrutura da carga já tiver sido validada.
6.6 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
6.7 Critérios de Aceitação da Família
A Família V-006 será considerada corretamente implementada quando for capaz de:
validar o peso líquido individual por contêiner;
validar o peso líquido total da operação;
identificar qualquer divergência, independentemente da diferença encontrada;
consolidar os resultados em uma única conclusão operacional;
produzir evidências claras, rastreáveis e compreensíveis para o analista.
Regras Operacionais Consolidadas
As seguintes regras passam a fazer parte desta Família:
O peso líquido deverá ser conferido por contêiner e pela operação completa.
Em operações com múltiplos Houses:
cada House será comparado ao(s) seu(s) respectivo(s) contêiner(es);
a soma dos pesos líquidos dos Houses deverá corresponder exatamente ao peso líquido total informado no Master.
Não existe margem de tolerância. Qualquer diferença deverá ser considerada uma divergência.
Representações numéricas diferentes, mas matematicamente equivalentes, deverão ser consideradas iguais, como:
15000
15000.00
15.000,000
A Priora não realizará conversão automática de unidades. Caso um documento utilize KG e outro LB, o resultado será Divergência.
O Master Bill of Lading (MBL) permanece como Fonte da Verdade para todas as comparações desta Família.
6.8.1 Objetivo
A Subvalidação V-006.1 — Peso Líquido por Contêiner tem como objetivo verificar se o peso líquido informado para cada contêiner no Master Bill of Lading (MBL) corresponde exatamente ao peso líquido informado no House Bill of Lading (HBL).
A comparação deverá ser realizada individualmente para cada contêiner previamente relacionado pela Família V-003 — Containers.
6.8.2 Importância Operacional
O peso líquido representa a quantidade efetiva de mercadoria transportada, desconsiderando embalagens, pallets e demais elementos que compõem o peso bruto.
Sua conferência é fundamental para garantir que ambos os documentos representem corretamente a mesma carga.
Uma divergência pode indicar:
erro de emissão documental;
inconsistência entre Master e House;
alteração da carga durante a consolidação;
necessidade de correção antes das próximas etapas da operação.
6.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte oficial para o peso líquido de cada contêiner.
O House Bill of Lading deverá reproduzir exatamente o mesmo valor para o respectivo contêiner.
6.8.4 Regra Operacional
Após o relacionamento dos contêineres, a Priora deverá comparar o peso líquido informado para cada contêiner entre o MBL e o HBL correspondente.
A comparação será exclusivamente numérica.
Qualquer diferença de valor deverá ser registrada como divergência.
Não existe margem de tolerância.
Exemplo — Consistente
MBL
Container FANU1234567
Peso Líquido: 7.500 KG
↓
HBL
Container FANU1234567
Peso Líquido: 7.500 KG
Resultado:
✔ Peso líquido consistente.
Exemplo — Divergência
MBL
Container FANU1234567
Peso Líquido: 7.500 KG
↓
HBL
Container FANU1234567
Peso Líquido: 7.495 KG
Resultado:
⚠ Divergência no peso líquido do contêiner.
6.8.5 Exceções
Casas Decimais
Os seguintes formatos deverão ser considerados equivalentes:
7500
7500.00
7.500,000
A comparação ocorrerá sempre após a normalização numérica realizada pelo Parser.
Unidade de Medida
A Priora não realizará conversão automática entre unidades.
Exemplo:
MBL
7.500 KG
↓
HBL
16.534 LB
Resultado:
⚠ Divergência.
Mesmo que os valores sejam matematicamente equivalentes.
Documento Ausente
Caso o MBL ou o HBL esteja ausente, esta Subvalidação deverá assumir o estado Não Avaliada.
6.8.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
6.8.7 Criticidade
Alta
Uma divergência no peso líquido por contêiner compromete a confiabilidade da carga representada pelos documentos e deve ser analisada antes da continuidade da auditoria.
6.8.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação numérica após normalização |
| Normalização permitida | Casas decimais e separadores numéricos |
| Dependência de IA | Apenas para extração do valor |
| Uso de OCR | Extração do peso líquido |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para o contêiner correspondente |

6.8.9 Critérios de Aceitação
A Subvalidação V-006.1 será considerada corretamente implementada quando:
comparar corretamente o peso líquido de cada contêiner;
respeitar os relacionamentos estabelecidos pela Família V-003;
normalizar corretamente os valores numéricos;
identificar qualquer divergência;
não realizar conversões automáticas de unidade de medida.
6.8.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-006.2 — Peso Líquido Total;
V-006.3 — Consistência do Peso Líquido;
Resumo Executivo da Auditoria;
Explicações da Clara.
6.9.1 Objetivo
A Subvalidação V-006.2 — Peso Líquido Total tem como objetivo verificar se o peso líquido total informado no Master Bill of Lading (MBL) corresponde exatamente à soma dos pesos líquidos informados nos House Bills of Lading (HBLs) pertencentes à mesma operação.
Esta validação garante que a consolidação documental da carga esteja correta e que todos os Houses representem integralmente o peso líquido informado no Master.
6.9.2 Importância Operacional
Mesmo quando todos os contêineres apresentam pesos líquidos consistentes individualmente, a operação somente poderá ser considerada correta se o peso líquido total também estiver consistente.
Esta conferência permite identificar:
omissão de Houses;
duplicidade de documentos;
erros na consolidação da carga;
inconsistências que podem passar despercebidas durante a análise individual dos contêineres.
6.9.3 Fonte da Verdade
O Master Bill of Lading (MBL) será considerado a fonte oficial para o peso líquido total da operação.
Os pesos líquidos informados nos Houses deverão, quando somados, corresponder exatamente ao valor informado no Master.
6.9.4 Regra Operacional
A Priora deverá somar o peso líquido de todos os Houses pertencentes ao mesmo Master e comparar esse resultado com o peso líquido total informado no MBL.
Não existe margem de tolerância.
Qualquer diferença, independentemente do valor, deverá ser registrada como divergência.
Esta comparação somente poderá ser executada após a conclusão da Subvalidação V-006.1 — Peso Líquido por Contêiner.
Exemplo — Consistente
MBL
Peso Líquido Total: 18.500 KG
↓
HBL 1
7.500 KG
↓
HBL 2
11.000 KG
↓
Soma dos Houses:
18.500 KG
Resultado:
✔ Peso líquido total consistente.
Exemplo — Divergência
MBL
Peso Líquido Total: 18.500 KG
↓
HBL 1
7.500 KG
↓
HBL 2
10.950 KG
↓
Soma dos Houses:
18.450 KG
Resultado:
⚠ Divergência no peso líquido total da operação.
6.9.5 Exceções
House Único
Quando existir apenas um House vinculado ao Master, o peso líquido desse House deverá corresponder diretamente ao peso líquido total informado no MBL.
Casas Decimais
Os seguintes formatos deverão ser considerados equivalentes:
18500
18500.00
18.500,000
A comparação deverá ocorrer sempre após a normalização numérica.
Unidade de Medida
A Priora não realizará conversões automáticas entre unidades.
Caso os documentos utilizem unidades diferentes (KG × LB), a Subvalidação deverá retornar Divergência.
Documento Ausente
Na ausência do Master ou de qualquer House necessário para compor a operação, esta Subvalidação deverá assumir o estado Não Avaliada.
6.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
6.9.7 Criticidade
Alta
Uma divergência no peso líquido total compromete a consistência global da operação e deverá ser analisada antes da continuidade da auditoria.
6.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Soma dos pesos líquidos dos Houses versus peso líquido total do Master |
| Normalização permitida | Formatação numérica (casas decimais e separadores) |
| Dependência de IA | Apenas para extração dos valores |
| Uso de OCR | Extração dos pesos líquidos |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para a operação completa |

6.9.9 Critérios de Aceitação
A Subvalidação V-006.2 será considerada corretamente implementada quando:
somar corretamente os pesos líquidos de todos os Houses;
comparar o resultado com o peso líquido total do Master;
identificar qualquer diferença de valor;
suportar operações com um ou múltiplos Houses;
produzir evidências claras e rastreáveis para o analista.
6.9.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-006.3 — Consistência do Peso Líquido;
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação.
6.10.1 Objetivo
A Subvalidação V-006.3 — Consistência do Peso Líquido tem como objetivo consolidar os resultados das Subvalidações V-006.1 — Peso Líquido por Contêiner e V-006.2 — Peso Líquido Total, produzindo uma única conclusão operacional sobre a consistência do peso líquido da operação.
Esta Subvalidação não realiza novas comparações documentais. Seu papel é interpretar as evidências produzidas anteriormente e fornecer ao analista uma conclusão clara e objetiva.
6.10.2 Importância Operacional
Durante uma conferência documental, a decisão do analista não é baseada apenas em uma comparação isolada.
A operação somente poderá ser considerada consistente quando:
todos os pesos líquidos individuais dos contêineres forem consistentes;
o peso líquido total da operação corresponder exatamente ao valor informado no Master Bill of Lading.
Esta Subvalidação representa a conclusão operacional da Família V-006.
6.10.3 Fonte da Verdade
A Consistência do Peso Líquido utiliza exclusivamente os resultados produzidos pelas seguintes Subvalidações:
V-006.1 — Peso Líquido por Contêiner
V-006.2 — Peso Líquido Total
Nenhum novo dado deverá ser extraído dos documentos nesta etapa.
6.10.4 Regra Operacional
A Priora deverá consolidar os resultados utilizando a seguinte matriz de decisão:

| Peso por Contêiner | Peso Total | Resultado Final |
| --- | --- | --- |
| ✔ | ✔ | ✔ Consistente |
| ✔ | ⚠ | ⚠ Divergência |
| ⚠ | ✔ | ⚠ Divergência |
| ⚠ | ⚠ | ⚠ Divergência |
| 👤 | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser confirmada quando ambas as Subvalidações anteriores forem consistentes.
Exemplo 1 — Operação Consistente
Peso por Contêiner
✔ Consistente
↓
Peso Total
✔ Consistente
↓
Resultado:
✔ Peso Líquido consistente.
Exemplo 2 — Divergência no Peso Total
Peso por Contêiner
✔ Consistente
↓
Peso Total
⚠ Divergência
↓
Resultado:
⚠ Operação inconsistente.
Exemplo 3 — Divergência por Contêiner
Peso por Contêiner
⚠ Divergência
↓
Peso Total
✔ Consistente
↓
Resultado:
⚠ Operação inconsistente.
6.10.5 Exceções
Esta Subvalidação não possui exceções próprias.
Todos os estados especiais deverão ser herdados das Subvalidações anteriores.
6.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
6.10.7 Criticidade
Crítica
Esta Subvalidação representa a conclusão oficial da Família V-006.
Seu resultado será utilizado pela Mesa de Auditoria, pelo Resumo Executivo e pela Clara para comunicar ao analista a situação do peso líquido da operação.
6.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica dos resultados das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | V-006.1 e V-006.2 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca toda a Família V-006 como inconsistente |

6.10.9 Critérios de Aceitação
A Subvalidação V-006.3 será considerada corretamente implementada quando:
consolidar corretamente os resultados das Subvalidações V-006.1 e V-006.2;
produzir uma única conclusão operacional sobre o peso líquido da operação;
respeitar os estados herdados;
não realizar novas comparações documentais;
gerar uma evidência clara, rastreável e compreensível para o analista.
6.10.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-007 — Cubagem
Resumo Executivo da Auditoria
Explicações da Clara
Indicador Geral de Consistência da Operação
📘 Fechamento da Família V-006
Com este capítulo, encerramos a Família V-006 — Peso Líquido.
A partir deste ponto, temos uma arquitetura consolidada para validações quantitativas da Priora:
Subvalidação 1: Conferência individual (por contêiner);
Subvalidação 2: Conferência global (total da operação);
Subvalidação 3: Consolidação operacional da família.
Essa estrutura é simples, previsível e altamente reutilizável.
Capítulo 7 — Família de Validação V-007 — Cubagem (CBM)
7.1 Objetivo
A Família de Validação V-007 — Cubagem (CBM) tem como objetivo verificar se a cubagem informada no Master Bill of Lading (MBL) corresponde exatamente à cubagem informada no House Bill of Lading (HBL), garantindo consistência tanto por contêiner quanto pela operação completa.
Esta Família assegura que ambos os documentos representem corretamente o volume físico ocupado pela carga.
7.2 Importância Operacional
A cubagem representa o espaço físico ocupado pela carga durante o transporte marítimo.
Sua conferência é fundamental para garantir que a documentação represente corretamente a operação logística.
Diferenças nesse campo podem indicar:
erro na emissão documental;
alteração da carga;
inconsistências entre Master e House;
divergências que poderão ser reproduzidas no CE Mercante.
Além disso, a cubagem influencia diretamente processos de consolidação, armazenagem e planejamento operacional.
Por esse motivo, trata-se de uma validação de alta criticidade.
7.3 Estrutura da Família
A Família V-007 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-007.1 | Cubagem por Contêiner | Validar a cubagem individual de cada contêiner. |
| V-007.2 | Cubagem Total | Validar se a soma das cubagens dos Houses corresponde à cubagem total do Master. |
| V-007.3 | Consistência da Cubagem | Consolidar os resultados anteriores em uma única conclusão operacional. |

7.4 Ordem de Execução
V-007.1 Cubagem por Contêiner
↓
V-007.2 Cubagem Total
↓
V-007.3 Consistência da Cubagem
7.5 Dependências
Esta Família depende da conclusão das seguintes Famílias:
V-003 — Containers
V-004 — Volumes da Carga
A cubagem somente poderá ser comparada quando os contêineres estiverem corretamente relacionados e a estrutura da carga já tiver sido validada.
7.6 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
7.7 Critérios de Aceitação da Família
A Família V-007 será considerada corretamente implementada quando for capaz de:
validar a cubagem individual por contêiner;
validar a cubagem total da operação;
identificar qualquer divergência;
consolidar os resultados em uma única conclusão operacional;
produzir evidências claras e rastreáveis.
Regras Operacionais Consolidadas
As seguintes regras passam a fazer parte desta Família:
A cubagem deverá ser conferida por contêiner e pela operação completa.
Em operações com múltiplos Houses:
cada House será comparado ao(s) seu(s) respectivo(s) contêiner(es);
a soma das cubagens dos Houses deverá corresponder exatamente à cubagem total informada no Master.
Não existe margem de tolerância.
Representações numéricas diferentes, mas matematicamente equivalentes, deverão ser consideradas iguais.
Exemplos válidos:
28
28.000
28,000
28.0
Todos representam exatamente o mesmo valor.
A Priora não realizará conversões automáticas de unidade.
Exemplo:
CBM
≠
FT³
Resultado:
⚠ Divergência.
O objetivo da Priora é validar documentos, e não interpretar ou converter unidades de medida.
O Master Bill of Lading (MBL) permanece como Fonte da Verdade para todas as comparações desta Família.
7.8 — Subvalidação V-007.1 — Cubagem por Contêiner
7.8.1 Objetivo
A Subvalidação V-007.1 — Cubagem por Contêiner tem como objetivo verificar se a cubagem (CBM) informada para cada contêiner no Master Bill of Lading (MBL) corresponde exatamente à cubagem informada no House Bill of Lading (HBL).
A comparação deverá ser realizada individualmente para cada contêiner previamente relacionado pela Família V-003 — Containers.
7.8.2 Importância Operacional
A cubagem representa o volume físico ocupado pela carga dentro do contêiner.
Sua conferência garante que ambos os documentos descrevam corretamente o espaço utilizado pela mercadoria.
Diferenças na cubagem podem indicar:
erro na emissão documental;
alteração da carga;
divergência entre Master e House;
inconsistências que poderão impactar o CE Mercante e demais documentos operacionais.
7.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte oficial para a cubagem de cada contêiner.
O House Bill of Lading deverá reproduzir exatamente o mesmo valor para o respectivo contêiner.
7.8.4 Regra Operacional
Após o relacionamento dos contêineres, a Priora deverá comparar a cubagem informada para cada contêiner entre o MBL e o HBL correspondente.
A comparação será exclusivamente numérica.
Qualquer diferença de valor deverá gerar divergência.
Não existe margem de tolerância.
Exemplo — Consistente
MBL
Container FANU1234567
Cubagem: 28.500 CBM
↓
HBL
Container FANU1234567
Cubagem: 28.500 CBM
Resultado:
✔ Cubagem consistente.
Exemplo — Divergência
MBL
Container FANU1234567
Cubagem: 28.500 CBM
↓
HBL
Container FANU1234567
Cubagem: 28.480 CBM
Resultado:
⚠ Divergência na cubagem do contêiner.
7.8.5 Exceções
Casas Decimais
Os seguintes formatos deverão ser considerados equivalentes:
28.5
28.500
28,500
28.5000
A comparação deverá ocorrer sempre após a normalização numérica realizada pelo Parser.
Unidade de Medida
A Priora não realizará conversão automática entre unidades.
Exemplo:
MBL
28.500 CBM
↓
HBL
1006.47 FT³
Resultado:
⚠ Divergência.
Mesmo que os valores sejam matematicamente equivalentes.
Documento Ausente
Caso o MBL ou o HBL esteja ausente, esta Subvalidação deverá assumir o estado Não Avaliada.
7.8.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
7.8.7 Criticidade
Alta
Uma divergência na cubagem por contêiner compromete a confiabilidade da representação física da carga e deverá ser analisada antes da continuidade da auditoria.
7.8.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação numérica após normalização |
| Normalização permitida | Casas decimais e separadores numéricos |
| Dependência de IA | Apenas para extração do valor |
| Uso de OCR | Extração da cubagem |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para o contêiner correspondente |

7.8.9 Critérios de Aceitação
A Subvalidação V-007.1 será considerada corretamente implementada quando:
comparar corretamente a cubagem de cada contêiner;
respeitar os relacionamentos estabelecidos pela Família V-003;
normalizar corretamente os valores numéricos;
identificar qualquer diferença de valor;
não realizar conversões automáticas de unidade de medida.
7.8.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-007.2 — Cubagem Total;
V-007.3 — Consistência da Cubagem;
Resumo Executivo da Auditoria;
Explicações da Clara.
7.9.1 Objetivo
A Subvalidação V-007.2 — Cubagem Total tem como objetivo verificar se a cubagem total informada no Master Bill of Lading (MBL) corresponde exatamente à soma das cubagens informadas nos House Bills of Lading (HBLs) pertencentes à mesma operação.
Esta validação garante que a representação volumétrica da operação esteja corretamente consolidada entre o Master e seus respectivos Houses.
7.9.2 Importância Operacional
Mesmo quando todos os contêineres apresentam cubagens consistentes individualmente, a operação somente poderá ser considerada correta quando a cubagem total também corresponder ao valor informado no Master.
Esta conferência permite identificar:
omissão de Houses;
duplicidade documental;
erro na consolidação da carga;
divergências que não são percebidas apenas pela análise individual dos contêineres.
7.9.3 Fonte da Verdade
O Master Bill of Lading (MBL) será considerado a fonte oficial para a cubagem total da operação.
As cubagens informadas nos Houses deverão, quando somadas, corresponder exatamente ao valor informado no Master.
7.9.4 Regra Operacional
A Priora deverá somar a cubagem de todos os Houses pertencentes ao mesmo Master e comparar esse resultado com a cubagem total informada no MBL.
Não existe margem de tolerância.
Qualquer diferença deverá ser registrada como divergência.
Esta comparação somente poderá ser executada após a conclusão da Subvalidação V-007.1 — Cubagem por Contêiner.
Exemplo — Consistente
MBL
Cubagem Total: 62.500 CBM
↓
HBL 1
25.000 CBM
↓
HBL 2
37.500 CBM
↓
Soma dos Houses
62.500 CBM
Resultado:
✔ Cubagem total consistente.
Exemplo — Divergência
MBL
Cubagem Total: 62.500 CBM
↓
HBL 1
25.000 CBM
↓
HBL 2
37.200 CBM
↓
Soma dos Houses
62.200 CBM
Resultado:
⚠ Divergência na cubagem total da operação.
7.9.5 Exceções
House Único
Quando existir apenas um House vinculado ao Master, sua cubagem deverá corresponder diretamente à cubagem total informada no MBL.
Casas Decimais
Os seguintes formatos deverão ser considerados equivalentes:
62.5
62.500
62,500
62.5000
A comparação deverá ocorrer sempre após a normalização numérica.
Unidade de Medida
A Priora não realizará conversões automáticas entre unidades.
Caso um documento utilize CBM e outro FT³, a Subvalidação deverá retornar Divergência.
Documento Ausente
Na ausência do Master ou de qualquer House necessário para compor a operação, esta Subvalidação deverá assumir o estado Não Avaliada.
7.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
7.9.7 Criticidade
Alta
Uma divergência na cubagem total compromete a consistência volumétrica da operação e deverá ser analisada antes da continuidade da auditoria.
7.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Soma das cubagens dos Houses versus cubagem total do Master |
| Normalização permitida | Casas decimais e separadores numéricos |
| Dependência de IA | Apenas para extração dos valores |
| Uso de OCR | Extração das cubagens |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para a operação completa |

7.9.9 Critérios de Aceitação
A Subvalidação V-007.2 será considerada corretamente implementada quando:
somar corretamente as cubagens de todos os Houses;
comparar o resultado com a cubagem total do Master;
identificar qualquer diferença de valor;
suportar operações com um ou múltiplos Houses;
produzir evidências claras, rastreáveis e compreensíveis para o analista.
7.9.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-007.3 — Consistência da Cubagem;
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação.
7.10.1 Objetivo
A Subvalidação V-007.3 — Consistência da Cubagem tem como objetivo consolidar os resultados das Subvalidações V-007.1 — Cubagem por Contêiner e V-007.2 — Cubagem Total, produzindo uma única conclusão operacional sobre a consistência da cubagem da operação.
Esta Subvalidação não realiza novas comparações documentais. Sua responsabilidade é interpretar as evidências produzidas anteriormente e fornecer ao analista uma conclusão clara e objetiva.
7.10.2 Importância Operacional
Durante a conferência documental, o analista não conclui que a cubagem está correta apenas porque um contêiner apresentou um valor consistente.
A operação somente poderá ser considerada consistente quando:
todas as cubagens individuais dos contêineres forem consistentes;
a cubagem total da operação corresponder exatamente ao valor informado no Master Bill of Lading.
Esta Subvalidação representa a conclusão operacional da Família V-007.
7.10.3 Fonte da Verdade
A Consistência da Cubagem utiliza exclusivamente os resultados produzidos pelas seguintes Subvalidações:
V-007.1 — Cubagem por Contêiner
V-007.2 — Cubagem Total
Nenhum novo dado deverá ser extraído dos documentos nesta etapa.
7.10.4 Regra Operacional
A Priora deverá consolidar os resultados utilizando a seguinte matriz de decisão:

| Cubagem por Contêiner | Cubagem Total | Resultado Final |
| --- | --- | --- |
| ✔ | ✔ | ✔ Consistente |
| ✔ | ⚠ | ⚠ Divergência |
| ⚠ | ✔ | ⚠ Divergência |
| ⚠ | ⚠ | ⚠ Divergência |
| 👤 | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser confirmada quando ambas as Subvalidações anteriores forem consistentes.
Exemplo 1 — Operação Consistente
Cubagem por Contêiner
✔ Consistente
↓
Cubagem Total
✔ Consistente
↓
Resultado:
✔ Cubagem consistente.
Exemplo 2 — Divergência no Total
Cubagem por Contêiner
✔ Consistente
↓
Cubagem Total
⚠ Divergência
↓
Resultado:
⚠ Operação inconsistente.
Exemplo 3 — Divergência por Contêiner
Cubagem por Contêiner
⚠ Divergência
↓
Cubagem Total
✔ Consistente
↓
Resultado:
⚠ Operação inconsistente.
7.10.5 Exceções
Esta Subvalidação não possui exceções próprias.
Todos os estados especiais deverão ser herdados das Subvalidações anteriores.
7.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
7.10.7 Criticidade
Crítica
Esta Subvalidação representa a conclusão oficial da Família V-007.
Seu resultado será utilizado pela Mesa de Auditoria, pelo Resumo Executivo e pela Clara para comunicar ao analista a situação da cubagem da operação.
7.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica dos resultados das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | V-007.1 e V-007.2 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca toda a Família V-007 como inconsistente |

7.10.9 Critérios de Aceitação
A Subvalidação V-007.3 será considerada corretamente implementada quando:
consolidar corretamente os resultados das Subvalidações V-007.1 e V-007.2;
produzir uma única conclusão operacional sobre a cubagem da operação;
respeitar os estados herdados;
não realizar novas comparações documentais;
gerar uma evidência clara, rastreável e compreensível para o analista.
7.10.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-008 — Lacres
Resumo Executivo da Auditoria
Explicações da Clara
Indicador Geral de Consistência da Operação
8.1 Objetivo
A Família de Validação V-008 — Lacres tem como objetivo verificar se o número do lacre informado para cada contêiner no Master Bill of Lading (MBL) corresponde exatamente ao número do lacre informado no House Bill of Lading (HBL).
Esta Família garante a integridade da identificação física dos contêineres e assegura que ambos os documentos representem corretamente o mesmo lacre para cada unidade transportada.
8.2 Importância Operacional
O lacre é o principal mecanismo de identificação da integridade física do contêiner durante o transporte internacional.
Sua conferência é fundamental para garantir que:
o contêiner correto foi embarcado;
a documentação representa corretamente a operação;
não houve troca indevida de identificação entre documentos.
Divergências de lacre podem indicar:
erro documental;
erro operacional;
associação incorreta entre contêineres;
necessidade de investigação antes da continuidade da operação.
Por esse motivo, esta é uma validação de criticidade crítica.
8.3 Estrutura da Família
A Família V-008 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-008.1 | Existência do Lacre | Verificar se todos os contêineres possuem um lacre informado. |
| V-008.2 | Correspondência do Lacre | Confirmar que o número do lacre é exatamente o mesmo entre MBL e HBL. |
| V-008.3 | Unicidade do Lacre | Garantir que um mesmo lacre não esteja associado a mais de um contêiner na operação. |
| V-008.4 | Consistência dos Lacres | Consolidar os resultados anteriores em uma única conclusão operacional. |

8.4 Ordem de Execução
V-008.1 Existência do Lacre
↓
V-008.2 Correspondência do Lacre
↓
V-008.3 Unicidade do Lacre
↓
V-008.4 Consistência dos Lacres
Cada Subvalidação depende da conclusão da anterior.
8.5 Dependências
Esta Família depende diretamente de:
V-003 — Containers
O relacionamento entre contêineres deve estar concluído antes da comparação dos lacres.
Não existe dependência das Famílias de Peso ou Cubagem.
8.6 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
8.7 Critérios de Aceitação da Família
A Família V-008 será considerada corretamente implementada quando for capaz de:
verificar a existência de um lacre para cada contêiner;
comparar corretamente os números de lacre entre MBL e HBL;
impedir que um mesmo lacre esteja associado a múltiplos contêineres;
consolidar os resultados em uma única conclusão operacional;
produzir evidências claras e rastreáveis.
Regras Operacionais Consolidadas
As seguintes regras passam a fazer parte desta Família:
Cada contêiner deverá possuir um único lacre.
Cada lacre deverá pertencer a apenas um contêiner.
O número do lacre deverá ser exatamente igual entre Master e House.
A Priora não realizará normalizações semânticas do número do lacre.
Diferenças de letras, números, espaços ou caracteres deverão ser tratadas como divergência, exceto pela normalização básica de espaços em branco nas extremidades e padronização para maiúsculas.
Na ausência do número do lacre em qualquer documento, a validação deverá ser classificada como Não Avaliada ou Validação Humana, conforme a causa da ausência.
8.8.1 Objetivo
A Subvalidação V-008.1 — Existência do Lacre tem como objetivo verificar se todos os contêineres relacionados na operação possuem um número de lacre informado nos documentos auditados.
Antes de comparar qualquer identificação, a Priora deverá confirmar que o lacre efetivamente existe para cada contêiner.
Esta é a primeira verificação realizada dentro da Família V-008.
8.8.2 Importância Operacional
O lacre representa o principal elemento de identificação da integridade física do contêiner.
Sem um número de lacre informado, não é possível confirmar se os documentos descrevem corretamente a unidade transportada.
Além disso, a ausência do lacre impede a execução segura das validações posteriores da Família.
Por esse motivo, esta Subvalidação possui criticidade crítica.
8.8.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte principal para a existência dos lacres.
Cada contêiner existente deverá possuir exatamente um número de lacre associado.
O House Bill of Lading deverá conter o respectivo lacre para cada contêiner relacionado.
8.8.4 Regra Operacional
Para cada contêiner previamente relacionado pela Família V-003 — Containers, a Priora deverá verificar se existe um número de lacre informado no MBL e no HBL correspondente.
Esta Subvalidação responde apenas à seguinte pergunta:
Existe um número de lacre informado para este contêiner?
Ela não verifica se os números são iguais.
Essa comparação será realizada na Subvalidação V-008.2 — Correspondência do Lacre.
Exemplo — Consistente
MBL
Container: FANU1234567
Lacre: ABC123456
↓
HBL
Container: FANU1234567
Lacre: ABC123456
Resultado:
✔ O contêiner possui número de lacre nos dois documentos.
Exemplo — Divergência
MBBL
Container: FANU1234567
Lacre: ABC123456
↓
HBL
Container: FANU1234567
Lacre:
—
Resultado:
⚠ O número do lacre esperado não foi localizado.
8.8.5 Exceções
Operações com Múltiplos Houses
Cada House deverá possuir os lacres correspondentes apenas aos contêineres sob sua responsabilidade.
A existência de um lacre em outro House não deverá ser utilizada para compensar a ausência do lacre no House auditado.
Documento Ausente
Caso o MBL ou o HBL esteja ausente, esta Subvalidação deverá assumir o estado:
⏸ Não Avaliada
Nunca deverá concluir automaticamente que existe uma divergência.
OCR com Baixa Confiança
Caso o OCR identifique um possível número de lacre, mas sinalize baixa confiança na leitura, a Priora deverá classificar a evidência como:
👤 Validação Humana
A plataforma não deverá assumir automaticamente que o lacre existe nem que está ausente.
8.8.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
8.8.7 Criticidade
Crítica
A inexistência do número de lacre impede a execução segura das demais validações desta Família.
Sempre que esta Subvalidação falhar, as Subvalidações V-008.2, V-008.3 e V-008.4 deverão ser classificadas como Não Avaliadas, salvo quando a falha decorrer exclusivamente de baixa confiança do OCR.
8.8.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Verificação de existência |
| Dependência de IA | Apenas para extração do número do lacre |
| Uso de OCR | Extração do lacre |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Interrompe as validações dependentes da Família |

8.8.9 Critérios de Aceitação
A Subvalidação V-008.1 será considerada corretamente implementada quando:
verificar a existência de um número de lacre para cada contêiner;
respeitar os relacionamentos estabelecidos pela Família V-003;
tratar corretamente operações com múltiplos Houses;
suportar auditorias parciais;
encaminhar leituras incertas para Validação Humana;
impedir a execução das validações dependentes quando a existência do lacre não puder ser comprovada.
8.9.1 Objetivo
A Subvalidação V-008.2 — Correspondência do Lacre tem como objetivo verificar se o número do lacre informado para cada contêiner no Master Bill of Lading (MBL) corresponde exatamente ao número informado no House Bill of Lading (HBL).
Esta comparação somente será executada após a confirmação da existência do lacre pela Subvalidação V-008.1.
8.9.2 Importância Operacional
O número do lacre identifica fisicamente o fechamento do contêiner.
Uma divergência nesse campo pode indicar:
erro de emissão documental;
erro operacional na consolidação;
troca indevida de documentos;
associação incorreta entre contêineres;
necessidade de investigação antes do prosseguimento da operação.
Como o lacre representa um identificador único, qualquer divergência deve ser considerada crítica.
8.9.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte oficial para o número do lacre.
O House Bill of Lading deverá reproduzir exatamente o mesmo número para o contêiner correspondente.
8.9.4 Regra Operacional
Após a confirmação da existência do lacre, a Priora deverá comparar o número informado no MBL com o número informado no HBL para o mesmo contêiner.
A comparação deverá ocorrer após uma normalização mínima dos dados.
Serão ignoradas apenas diferenças relacionadas a:
letras minúsculas e maiúsculas;
espaços em branco no início e no final do texto.
Nenhuma outra alteração será permitida.
Qualquer diferença de caracteres deverá gerar divergência.
Exemplo — Consistente
MBL
ABC123456
↓
HBL
ABC123456
Resultado:
✔ Correspondência confirmada.
Exemplo — Consistente (normalização)
MBL
abc123456
↓
HBL
ABC123456
Resultado:
✔ Correspondência confirmada após normalização.
Exemplo — Divergência
MBL
ABC123456
↓
HBL
ABC123458
Resultado:
⚠ Divergência no número do lacre.
8.9.5 Exceções
OCR com Baixa Confiança
Caso um dos números tenha sido extraído com baixa confiança, a comparação não deverá ser executada automaticamente.
O resultado será:
👤 Validação Humana
Documento Ausente
Caso o MBL ou HBL esteja ausente, a Subvalidação assumirá o estado:
⏸ Não Avaliada
Lacre Ausente
Caso a Subvalidação V-008.1 tenha identificado ausência do lacre, esta Subvalidação não deverá ser executada.
Seu estado será herdado como:
⏸ Não Avaliada
8.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
8.9.7 Criticidade
Crítica
Qualquer divergência no número do lacre compromete a identificação física do contêiner e exige análise antes da continuidade da operação.
8.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Comparação textual exata após normalização mínima |
| Normalização permitida | Maiúsculas/minúsculas e espaços externos |
| Dependência de IA | Apenas para extração do lacre |
| Uso de OCR | Extração do número |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para o contêiner correspondente |

8.9.9 Critérios de Aceitação
A Subvalidação V-008.2 será considerada corretamente implementada quando:
comparar corretamente os números dos lacres entre MBL e HBL;
respeitar os relacionamentos estabelecidos pela Família V-003;
aplicar apenas a normalização mínima permitida;
identificar qualquer diferença de caracteres;
encaminhar leituras incertas para Validação Humana;
produzir evidências claras e rastreáveis.
8.9.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-008.3 — Unicidade do Lacre;
V-008.4 — Consistência dos Lacres;
Resumo Executivo da Auditoria;
Explicações da Clara.
8.10 — Subvalidação V-008.3 — Unicidade do Lacre
8.10.1 Objetivo
A Subvalidação V-008.3 — Unicidade do Lacre tem como objetivo garantir que cada número de lacre esteja associado exclusivamente a um único contêiner dentro da operação auditada.
Esta validação verifica se não existem reutilizações indevidas do mesmo número de lacre em contêineres diferentes.
8.10.2 Importância Operacional
O lacre é um identificador físico único aplicado ao fechamento do contêiner.
Sua reutilização em mais de um contêiner dentro da mesma operação representa uma inconsistência grave, pois compromete a rastreabilidade da carga e a confiabilidade dos documentos.
A verificação da unicidade reduz o risco de:
associação incorreta entre contêineres;
duplicidade documental;
erro de emissão do conhecimento;
troca indevida de lacres.
8.10.3 Fonte da Verdade
Não existe uma fonte da verdade exclusiva para esta Subvalidação.
A validação deverá considerar o conjunto completo de lacres existentes na operação, independentemente de sua origem (Master ou Houses), verificando se cada número aparece associado a apenas um contêiner.
8.10.4 Regra Operacional
Após confirmar a existência e a correspondência dos lacres, a Priora deverá verificar se um mesmo número de lacre foi associado a mais de um contêiner.
Cada número de lacre deverá aparecer uma única vez na operação.
Caso um mesmo lacre esteja vinculado a dois ou mais contêineres distintos, a Subvalidação deverá registrar uma divergência.
Exemplo — Consistente

| Contêiner | Lacre |
| --- | --- |
| FANU1234567 | ABC123456 |
| TEMU7654321 | XYZ987654 |

Resultado:
✔ Todos os lacres são únicos.
Exemplo — Divergência

| Contêiner | Lacre |
| --- | --- |
| FANU1234567 | ABC123456 |
| TEMU7654321 | ABC123456 |

Resultado:
⚠ O lacre ABC123456 está associado a mais de um contêiner.
8.10.5 Exceções
Documento Ausente
Na ausência do MBL ou de um dos HBLs necessários para representar toda a operação, esta Subvalidação deverá assumir o estado Não Avaliada, pois não será possível garantir a unicidade dos lacres.
OCR com Baixa Confiança
Caso a leitura de um ou mais lacres tenha sido classificada como de baixa confiança, a Priora deverá encaminhar a evidência para Validação Humana, evitando conclusões automáticas sobre duplicidade.
8.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
8.10.7 Criticidade
Crítica
A reutilização de um mesmo número de lacre compromete a identificação física dos contêineres e exige análise imediata antes da continuidade da operação.
8.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Verificação de unicidade no conjunto da operação |
| Dependência de IA | Nenhuma além da extração dos lacres |
| Uso de OCR | Extração do número do lacre |
| Permite inferência automática | Não |
| Fonte da verdade | Conjunto completo da operação |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para toda a operação |

8.10.9 Critérios de Aceitação
A Subvalidação V-008.3 será considerada corretamente implementada quando:
verificar a unicidade de todos os lacres da operação;
identificar reutilizações indevidas;
suportar operações com múltiplos Houses;
encaminhar leituras incertas para Validação Humana;
produzir evidências claras e rastreáveis.
8.11.1 Objetivo
A Subvalidação V-008.4 — Consistência dos Lacres tem como objetivo consolidar os resultados das Subvalidações V-008.1 — Existência do Lacre, V-008.2 — Correspondência do Lacre e V-008.3 — Unicidade do Lacre, produzindo uma única conclusão operacional sobre a consistência dos lacres da operação.
Esta Subvalidação não realiza novas comparações documentais. Sua responsabilidade é interpretar as evidências geradas anteriormente e apresentar ao analista uma conclusão única, clara e rastreável.
8.11.2 Importância Operacional
A conferência dos lacres somente poderá ser considerada concluída quando todos os critérios fundamentais forem atendidos simultaneamente.
Isso significa que:
todos os contêineres possuem um lacre informado;
os números dos lacres correspondem exatamente entre Master e House;
nenhum lacre foi reutilizado em outro contêiner da mesma operação.
Somente quando essas três condições forem satisfeitas a operação poderá ser considerada consistente em relação aos lacres.
8.11.3 Fonte da Verdade
Esta Subvalidação utiliza exclusivamente os resultados produzidos pelas seguintes Subvalidações:
V-008.1 — Existência do Lacre
V-008.2 — Correspondência do Lacre
V-008.3 — Unicidade do Lacre
Nenhuma nova leitura dos documentos deverá ser realizada nesta etapa.
8.11.4 Regra Operacional
A Priora deverá consolidar os resultados utilizando a seguinte matriz de decisão:

| Existência | Correspondência | Unicidade | Resultado Final |
| --- | --- | --- | --- |
| ✔ | ✔ | ✔ | ✔ Consistente |
| ⚠ | qualquer | qualquer | ⚠ Divergência |
| ✔ | ⚠ | qualquer | ⚠ Divergência |
| ✔ | ✔ | ⚠ | ⚠ Divergência |
| 👤 | qualquer | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser confirmada quando todas as Subvalidações anteriores forem consistentes.
Exemplo 1 — Operação Consistente
Existência
✔
↓
Correspondência
✔
↓
Unicidade
✔
↓
Resultado
✔ Lacres consistentes.
Exemplo 2 — Divergência de Correspondência
Existência
✔
↓
Correspondência
⚠
↓
Unicidade
✔
↓
Resultado
⚠ Operação inconsistente.
Exemplo 3 — Lacre Duplicado
Existência
✔
↓
Correspondência
✔
↓
Unicidade
⚠
↓
Resultado
⚠ Operação inconsistente.
8.11.5 Exceções
Esta Subvalidação não possui exceções próprias.
Todos os estados especiais deverão ser herdados das Subvalidações anteriores.
8.11.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
8.11.7 Criticidade
Crítica
Esta Subvalidação representa a conclusão oficial da Família V-008.
Seu resultado será utilizado pela Mesa de Auditoria, pelo Resumo Executivo e pela Clara para informar ao analista a situação dos lacres da operação.
8.11.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | Resultados das Subvalidações V-008.1, V-008.2 e V-008.3 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca toda a Família V-008 como inconsistente |

8.11.9 Critérios de Aceitação
A Subvalidação V-008.4 será considerada corretamente implementada quando:
consolidar corretamente os resultados das três Subvalidações anteriores;
produzir uma única conclusão operacional sobre os lacres da operação;
respeitar os estados herdados;
não realizar novas comparações documentais;
gerar uma evidência clara, rastreável e compreensível para o analista.
8.11.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação;
Decisão operacional do analista quanto à necessidade de correção documental.
📘 Fechamento da Família V-008
Com este capítulo, encerramos a Família V-008 — Lacres.
A Base de Conhecimento da Priora agora possui três padrões arquiteturais bem definidos:
Validações Estruturais
Containers
Volumes
Validações Quantitativas
Peso Bruto
Peso Líquido
Cubagem
Validações de Identificadores
Lacres
Cada categoria possui uma lógica própria, mas todas seguem uma arquitetura consistente e previsível.
Capítulo 9 — Família de Validação V-009 — Portos
E aqui, antes de escrever, preciso alinhar as regras reais da operação, porque diferente de Peso e Lacres, existem várias combinações possíveis.
Primeiro, quais portos vocês realmente conferem?
Quando recebe um MBL e um HBL, você compara:
POL (Port of Loading)?
POD (Port of Discharge)?
Place of Receipt?
Place of Delivery?
Porto de Transbordo (T/S Port)?
Country of Origin?
Ou apenas alguns deles?
Segunda pergunta
A comparação é:
Exatamente igual?
Exemplo:
MBL
Port of Loading:
Shanghai
↓
HBL
Port of Loading:
Shanghai
✔
Ou vocês aceitam:
Shanghai
=
CNSHA
ou
Shanghai, China
ou
Shanghai (CN)
Ou seja, podemos usar uma tabela oficial de equivalências (UN/LOCODE) ou a regra é texto idêntico?
Terceira pergunta
Qual é a Fonte da Verdade?
Continua sendo o MBL?
Quarta pergunta
Se o Master vier:
Port of Loading
Shanghai
e o House vier:
Ningbo
Isso é sempre divergência?
Ou existe alguma exceção operacional?
Quinta pergunta
E o transbordo?
Por exemplo:
Master
Shanghai
↓
Singapore
↓
Santos
House
Shanghai
↓
Santos
O transbordo precisa obrigatoriamente existir nos dois documentos ou vocês ignoram esse campo quando ele não estiver presente?
Capítulo 9 — Família de Validação V-009 — Portos
9.1 Objetivo
A Família de Validação V-009 — Portos tem como objetivo verificar se os portos informados no Master Bill of Lading (MBL) correspondem corretamente aos portos informados no House Bill of Lading (HBL), garantindo que ambos os documentos representem a mesma rota logística.
Esta Família assegura que a origem, o destino e os demais pontos relevantes da operação estejam documentalmente consistentes.
9.2 Importância Operacional
Os portos representam a rota oficial percorrida pela carga.
Sua conferência é essencial para garantir que:
o embarque ocorreu no porto correto;
o destino documental corresponde ao destino contratado;
não existem divergências que possam comprometer o CE Mercante, a Declaração de Importação ou o planejamento operacional.
Erros de porto podem gerar:
emissão incorreta de documentos;
falhas de parametrização no sistema;
problemas na liberação aduaneira;
retrabalho operacional.
Por esse motivo, esta é uma validação de criticidade alta.
9.3 Estrutura da Família
A Família V-009 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-009.1 | Existência dos Portos | Verificar se os portos obrigatórios estão presentes nos documentos. |
| V-009.2 | Correspondência dos Portos | Confirmar que os portos representam a mesma localização logística. |
| V-009.3 | Consistência da Rota | Verificar se a sequência da operação é coerente. |
| V-009.4 | Consistência dos Portos | Consolidar os resultados anteriores. |

9.4 Ordem de Execução
V-009.1 Existência dos Portos
↓
V-009.2 Correspondência dos Portos
↓
V-009.3 Consistência da Rota
↓
V-009.4 Consistência dos Portos
Cada Subvalidação depende da conclusão da anterior.
9.5 Dependências
Esta Família depende diretamente de:
V-003 — Containers (agrupamento correto da operação);
identificação correta do Master e dos Houses.
Não depende das Famílias Quantitativas nem da Família de Lacres.
9.6 Campos Auditados
Durante o Playbook Pré-Alerta, a Priora deverá auditar os seguintes campos quando estiverem presentes:
Port of Loading (POL);
Port of Discharge (POD);
Place of Receipt;
Place of Delivery;
Portos de Transbordo (quando informados).
Cada campo será validado de acordo com sua obrigatoriedade e relevância operacional.
9.7 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.8 Critérios de Aceitação da Família
A Família V-009 será considerada corretamente implementada quando for capaz de:
verificar a existência dos portos obrigatórios;
confirmar que Master e House representam a mesma rota;
identificar inconsistências na sequência logística;
consolidar os resultados em uma única conclusão operacional;
produzir evidências claras e rastreáveis.
Regras Operacionais Consolidadas
As seguintes regras passam a fazer parte desta Família:
O Master Bill of Lading (MBL) será considerado a Fonte da Verdade para os portos.
A Priora deverá comparar os portos utilizando uma base oficial de equivalências, como códigos UN/LOCODE, quando disponível.
Diferenças apenas na forma de representação (nome do porto, código ou combinação de ambos) não deverão gerar divergência, desde que representem exatamente a mesma localização.
Exemplo:

| Representação A | Representação B | Resultado |
| --- | --- | --- |
| Shanghai | CNSHA | ✔ Consistente |
| Santos | BRSSZ | ✔ Consistente |
| Rotterdam | NLRTM | ✔ Consistente |

Caso dois portos representem localidades diferentes, o resultado será Divergência, independentemente da semelhança dos nomes.
Portos de transbordo serão auditados apenas quando informados em ambos os documentos. A ausência do transbordo em um dos documentos, quando esse campo não for obrigatório para o tipo de conhecimento emitido, não deverá gerar divergência automática, mas poderá resultar em Validação Humana, conforme a configuração da operação.
9.9 — Subvalidação V-009.1 — Existência dos Portos
9.9.1 Objetivo
A Subvalidação V-009.1 — Existência dos Portos tem como objetivo verificar se todos os portos obrigatórios para a operação estão presentes nos documentos auditados.
Antes de comparar qualquer informação, a Priora deverá confirmar que os campos necessários existem e podem ser auditados.
Esta é a primeira verificação realizada dentro da Família V-009.
9.9.2 Importância Operacional
A inexistência de um porto obrigatório impede que a Priora determine com segurança a rota logística representada pelos documentos.
Sem essa informação, torna-se impossível validar corretamente as etapas seguintes da Família, como a correspondência entre os portos e a consistência da rota.
Por esse motivo, esta Subvalidação possui criticidade alta.
9.9.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o Master Bill of Lading (MBL) será considerado a fonte principal para os portos obrigatórios da operação.
O House Bill of Lading deverá conter as mesmas informações para os campos aplicáveis.
9.9.4 Regra Operacional
Para cada campo de porto previsto na auditoria, a Priora deverá verificar sua existência no MBL e no HBL correspondente.
Os campos serão classificados em duas categorias:
Campos Obrigatórios
Port of Loading (POL)
Port of Discharge (POD)
A ausência de qualquer um desses campos impedirá a continuidade da validação daquele porto.
Campos Condicionais
Place of Receipt
Place of Delivery
Porto(s) de Transbordo
Esses campos somente serão considerados obrigatórios quando fizerem parte da documentação da operação.
Sua ausência, por si só, não caracteriza divergência automática.
Exemplo — Consistente
MBL

| Campo | Valor |
| --- | --- |
| POL | Shanghai |
| POD | Santos |

↓
HBL

| Campo | Valor |
| --- | --- |
| POL | Shanghai |
| POD | Santos |

Resultado:
✔ Todos os portos obrigatórios estão presentes.
Exemplo — Divergência
MBL

| Campo | Valor |
| --- | --- |
| POL | Shanghai |
| POD | Santos |

↓
HBL

| Campo | Valor |
| --- | --- |
| POL | Shanghai |
| POD | — |

Resultado:
⚠ O porto obrigatório Port of Discharge (POD) não foi localizado.
Exemplo — Campo Condicional Ausente
MBL

| Campo | Valor |
| --- | --- |
| Place of Delivery | — |

↓
HBL

| Campo | Valor |
| --- | --- |
| Place of Delivery | — |

Resultado:
✔ Campo não aplicável à operação.
9.9.5 Exceções
Operações sem Transbordo
Quando a operação não possuir porto de transbordo, a ausência desse campo deverá ser considerada normal e não gerará qualquer evidência de divergência.
Documento Ausente
Caso o MBL ou o HBL esteja ausente, esta Subvalidação deverá assumir o estado:
⏸ Não Avaliada
OCR com Baixa Confiança
Caso o OCR identifique um possível porto, mas sinalize baixa confiança na leitura, a Priora deverá classificar a evidência como:
👤 Validação Humana
9.9.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.9.7 Criticidade
Alta
A ausência de um porto obrigatório impede a validação segura da rota logística e compromete as Subvalidações posteriores da Família.
9.9.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Verificação de existência |
| Dependência de IA | Apenas para extração dos portos |
| Uso de OCR | Extração dos campos de porto |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Impede a validação daquele campo nas etapas seguintes |

9.9.9 Critérios de Aceitação
A Subvalidação V-009.1 será considerada corretamente implementada quando:
verificar a existência de todos os portos obrigatórios;
distinguir corretamente campos obrigatórios de campos condicionais;
tratar adequadamente operações com e sem transbordo;
suportar auditorias parciais;
encaminhar leituras incertas para Validação Humana;
impedir comparações quando a existência do campo não puder ser comprovada.
9.10 — Subvalidação V-009.2 — Correspondência dos Portos
9.10.1 Objetivo
Verificar se os portos informados no Master Bill of Lading correspondem aos portos informados no House Bill of Lading para cada etapa aplicável da rota.
A comparação deve considerar a localização representada, e não apenas o texto exibido.
9.10.2 Importância Operacional
Uma divergência de porto pode significar que Master e House representam rotas diferentes.
Isso pode provocar:
emissão incorreta do CE Mercante;
erros de cadastro no processo;
retrabalho documental;
inconsistências na liberação;
direcionamento incorreto da operação.
Por esse motivo, a correspondência do POL e do POD possui criticidade alta.
9.10.3 Fonte da Verdade
O MBL é a fonte de referência para os portos da operação.
O HBL deve representar os mesmos pontos logísticos aplicáveis ao House correspondente.
9.10.4 Regra Operacional
Após confirmar a existência dos campos, a Priora deverá comparar individualmente:
Port of Loading;
Port of Discharge;
Place of Receipt, quando aplicável;
Place of Delivery, quando aplicável;
porto de transbordo, quando informado nos dois documentos.
A igualdade não depende de texto idêntico. A Priora deve utilizar uma representação canônica confiável da localização.
Exemplo consistente

| MBL | HBL | Resultado |
| --- | --- | --- |
| Shanghai | CNSHA | ✔ Consistente |
| Santos | BRSSZ | ✔ Consistente |
| Hamburg, Germany | DEHAM | ✔ Consistente |

Exemplo divergente

| Campo | MBL | HBL | Resultado |
| --- | --- | --- | --- |
| POL | Shanghai | Ningbo | ⚠ Divergência |
| POD | Santos | Itapoá | ⚠ Divergência |

Mesmo que os portos estejam no mesmo país ou região, localidades distintas não são equivalentes.
9.10.5 Normalização e equivalência
São permitidas:
padronização de maiúsculas e minúsculas;
remoção de espaços excedentes;
desconsideração de país ou estado escrito junto ao porto;
associação entre nome oficial e código UN/LOCODE;
tratamento de acentos e caracteres equivalentes.
Não são permitidas:
associação baseada apenas em proximidade geográfica;
substituição por porto alternativo;
inferência de que dois portos “servem para a mesma região”;
correção automática de um porto divergente.
Sem correspondência canônica segura, o resultado deverá ser Validação Humana.
9.10.6 Campos condicionais
A ausência de Place of Receipt, Place of Delivery ou transbordo não gera divergência automática quando o campo não for obrigatório.
Entretanto, quando o campo existir nos dois documentos, seus valores deverão ser comparados.
Se existir no MBL e estiver ausente no HBL:
campo obrigatório ou confirmado como aplicável → Divergência;
aplicabilidade incerta → Validação Humana;
campo meramente opcional → Não Avaliada ou informativa.
9.10.7 Estados possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.10.8 Criticidade
Alta para POL e POD.
Média para Place of Receipt, Place of Delivery e transbordo, salvo quando o campo for essencial à operação específica.
9.10.9 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método | Comparação por equivalência canônica |
| Referência canônica | UN/LOCODE ou cadastro oficial equivalente |
| Dependência de IA | Extração e identificação inicial do texto |
| Permite inferência geográfica | Não |
| Fonte da verdade | MBL |
| Correspondência não conclusiva | Validação Humana |
| Falha da regra | Divergência no campo de porto correspondente |

9.10.10 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
comparar cada etapa da rota separadamente;
reconhecer nome e código oficial do mesmo porto;
distinguir portos diferentes, ainda que próximos;
respeitar a obrigatoriedade de cada campo;
nunca inferir equivalência sem base canônica;
apresentar os valores encontrados nos dois documentos.
9.10.11 Impacto nas validações dependentes
Influencia diretamente:
V-009.3 — Consistência da Rota;
V-009.4 — Consistência dos Portos;
Resumo Executivo;
explicações da Clara;
indicador geral da auditoria.
9.10 — Subvalidação V-009.2 — Correspondência dos Portos
9.10.1 Objetivo
Verificar se os portos informados no Master Bill of Lading correspondem aos portos informados no House Bill of Lading para cada etapa aplicável da rota.
A comparação deve considerar a localização representada, e não apenas o texto exibido.
9.10.2 Importância Operacional
Uma divergência de porto pode significar que Master e House representam rotas diferentes.
Isso pode provocar:
emissão incorreta do CE Mercante;
erros de cadastro no processo;
retrabalho documental;
inconsistências na liberação;
direcionamento incorreto da operação.
Por esse motivo, a correspondência do POL e do POD possui criticidade alta.
9.10.3 Fonte da Verdade
O MBL é a fonte de referência para os portos da operação.
O HBL deve representar os mesmos pontos logísticos aplicáveis ao House correspondente.
9.10.4 Regra Operacional
Após confirmar a existência dos campos, a Priora deverá comparar individualmente:
Port of Loading;
Port of Discharge;
Place of Receipt, quando aplicável;
Place of Delivery, quando aplicável;
porto de transbordo, quando informado nos dois documentos.
A igualdade não depende de texto idêntico. A Priora deve utilizar uma representação canônica confiável da localização.
Exemplo consistente

| MBL | HBL | Resultado |
| --- | --- | --- |
| Shanghai | CNSHA | ✔ Consistente |
| Santos | BRSSZ | ✔ Consistente |
| Hamburg, Germany | DEHAM | ✔ Consistente |

Exemplo divergente

| Campo | MBL | HBL | Resultado |
| --- | --- | --- | --- |
| POL | Shanghai | Ningbo | ⚠ Divergência |
| POD | Santos | Itapoá | ⚠ Divergência |

Mesmo que os portos estejam no mesmo país ou região, localidades distintas não são equivalentes.
9.10.5 Normalização e equivalência
São permitidas:
padronização de maiúsculas e minúsculas;
remoção de espaços excedentes;
desconsideração de país ou estado escrito junto ao porto;
associação entre nome oficial e código UN/LOCODE;
tratamento de acentos e caracteres equivalentes.
Não são permitidas:
associação baseada apenas em proximidade geográfica;
substituição por porto alternativo;
inferência de que dois portos “servem para a mesma região”;
correção automática de um porto divergente.
Sem correspondência canônica segura, o resultado deverá ser Validação Humana.
9.10.6 Campos condicionais
A ausência de Place of Receipt, Place of Delivery ou transbordo não gera divergência automática quando o campo não for obrigatório.
Entretanto, quando o campo existir nos dois documentos, seus valores deverão ser comparados.
Se existir no MBL e estiver ausente no HBL:
campo obrigatório ou confirmado como aplicável → Divergência;
aplicabilidade incerta → Validação Humana;
campo meramente opcional → Não Avaliada ou informativa.
9.10.7 Estados possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.10.8 Criticidade
Alta para POL e POD.
Média para Place of Receipt, Place of Delivery e transbordo, salvo quando o campo for essencial à operação específica.
9.10.9 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método | Comparação por equivalência canônica |
| Referência canônica | UN/LOCODE ou cadastro oficial equivalente |
| Dependência de IA | Extração e identificação inicial do texto |
| Permite inferência geográfica | Não |
| Fonte da verdade | MBL |
| Correspondência não conclusiva | Validação Humana |
| Falha da regra | Divergência no campo de porto correspondente |

9.10.10 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
comparar cada etapa da rota separadamente;
reconhecer nome e código oficial do mesmo porto;
distinguir portos diferentes, ainda que próximos;
respeitar a obrigatoriedade de cada campo;
nunca inferir equivalência sem base canônica;
apresentar os valores encontrados nos dois documentos.
9.10.11 Impacto nas validações dependentes
Influencia diretamente:
V-009.3 — Consistência da Rota;
V-009.4 — Consistência dos Portos;
Resumo Executivo;
explicações da Clara;
indicador geral da auditoria.
O próximo é V-009.3 — Consistência da Rota, que verificará o conjunto da sequência logística, e não apenas cada porto isoladamente.
hoje 12:27
boa, continue
Perfeito.
Agora chegamos na Subvalidação que, na minha opinião, diferencia uma simples comparação de campos de uma auditoria operacional.
Até agora verificamos:
Existe o porto?
O porto corresponde?
Agora vamos responder:
"A rota faz sentido?"
Isso é diferente.
Podemos ter todos os portos iguais e, ainda assim, a rota estar errada.
9.11 — Subvalidação V-009.3 — Consistência da Rota
9.11.1 Objetivo
A Subvalidação V-009.3 — Consistência da Rota tem como objetivo verificar se a sequência logística representada pelos portos é operacionalmente coerente entre o Master Bill of Lading (MBL) e o House Bill of Lading (HBL).
Esta validação analisa a rota como um conjunto, garantindo que a operação descrita nos documentos represente o mesmo fluxo logístico.
9.11.2 Importância Operacional
Mesmo quando todos os portos individuais correspondem corretamente, a sequência da operação pode apresentar inconsistências.
Exemplos:
inversão entre origem e destino;
omissão de uma etapa obrigatória;
rota incompatível com o restante da documentação;
inconsistência entre Place of Receipt, POL, POD e Place of Delivery.
Esses cenários podem gerar falhas operacionais mesmo sem divergências aparentes em campos isolados.
9.11.3 Fonte da Verdade
O Master Bill of Lading (MBL) será considerado a referência para a sequência logística da operação.
O House Bill of Lading deverá representar uma rota compatível com o Master.
9.11.4 Regra Operacional
Após validar a existência e a correspondência dos portos, a Priora deverá analisar a coerência da sequência logística.
A ordem lógica da operação deverá respeitar, quando aplicável:
Place of Receipt
↓
Port of Loading (POL)
↓
Transbordo(s)
↓
Port of Discharge (POD)
↓
Place of Delivery
Cada etapa deverá ocorrer em uma sequência operacional compatível.
Exemplo — Consistente

| Etapa | MBL | HBL |
| --- | --- | --- |
| Place of Receipt | Suzhou | Suzhou |
| POL | Shanghai | Shanghai |
| POD | Santos | Santos |
| Place of Delivery | Navegantes | Navegantes |

Resultado:
✔ Rota consistente.
Exemplo — Divergência
MBL
POL: Shanghai
POD: Santos
↓
HBL
POL: Santos
POD: Shanghai
Resultado:
⚠ Origem e destino invertidos.
Exemplo — Divergência
MBL
Place of Receipt
Suzhou
↓
HBL
Place of Receipt
Hamburg
↓
POL
Shanghai
Resultado:
⚠ Sequência logística incompatível.
9.11.5 Regras Especiais
Transbordo
A existência de um porto de transbordo no Master não obriga sua presença no House, desde que:
o POL e o POD permaneçam consistentes;
a ausência do transbordo não altere a interpretação da rota.
Caso o transbordo modifique a rota operacional representada, a evidência deverá ser encaminhada para Validação Humana.
Place of Receipt e Place of Delivery
Esses campos complementam a rota logística, mas nem sempre fazem parte da operação.
Quando presentes, deverão ser considerados na análise.
Quando ausentes, não invalidam automaticamente a consistência da rota.
OCR com Baixa Confiança
Caso algum porto essencial tenha sido extraído com baixa confiança, a conclusão da rota deverá assumir o estado:
👤 Validação Humana
9.11.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.11.7 Criticidade
Alta
Uma rota inconsistente compromete a interpretação da operação logística e pode gerar erros em diversas etapas posteriores.
9.11.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Análise da sequência logística |
| Dependência de IA | Nenhuma além da extração dos campos |
| Uso de OCR | Extração dos portos |
| Permite inferência automática | Não |
| Fonte da verdade | Master Bill of Lading |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Marca divergência para a rota da operação |

9.11.9 Critérios de Aceitação
A Subvalidação V-009.3 será considerada corretamente implementada quando:
validar a ordem lógica da rota;
identificar inversões entre origem e destino;
considerar corretamente os campos condicionais;
tratar adequadamente operações com ou sem transbordo;
produzir evidências claras e rastreáveis para o analista.
9.11.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-009.4 — Consistência dos Portos;
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação.
9.12 — Subvalidação V-009.4 — Consistência dos Portos
9.12.1 Objetivo
A Subvalidação V-009.4 — Consistência dos Portos tem como objetivo consolidar os resultados das Subvalidações V-009.1 — Existência dos Portos, V-009.2 — Correspondência dos Portos e V-009.3 — Consistência da Rota, produzindo uma única conclusão operacional sobre a consistência da rota logística representada pelos documentos.
Esta Subvalidação não realiza novas comparações documentais. Sua responsabilidade é consolidar as evidências produzidas anteriormente e fornecer uma conclusão clara para o analista.
9.12.2 Importância Operacional
A operação somente poderá ser considerada consistente em relação aos portos quando:
todos os portos obrigatórios existirem;
todos os portos correspondentes representarem a mesma localização logística;
a sequência da rota for operacionalmente coerente.
A ausência de qualquer um desses requisitos compromete a confiabilidade da operação.
9.12.3 Fonte da Verdade
Esta Subvalidação utiliza exclusivamente os resultados produzidos por:
V-009.1 — Existência dos Portos
V-009.2 — Correspondência dos Portos
V-009.3 — Consistência da Rota
Nenhuma nova leitura documental deverá ser realizada.
9.12.4 Regra Operacional
A Priora deverá consolidar os resultados utilizando a seguinte matriz de decisão:

| Existência | Correspondência | Rota | Resultado Final |
| --- | --- | --- | --- |
| ✔ | ✔ | ✔ | ✔ Consistente |
| ⚠ | qualquer | qualquer | ⚠ Divergência |
| ✔ | ⚠ | qualquer | ⚠ Divergência |
| ✔ | ✔ | ⚠ | ⚠ Divergência |
| 👤 | qualquer | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser confirmada quando todas as Subvalidações anteriores forem consistentes.
Exemplo 1 — Operação Consistente
Existência
✔
↓
Correspondência
✔
↓
Consistência da Rota
✔
↓
Resultado
✔ Portos consistentes.
Exemplo 2 — Divergência de Porto
Existência
✔
↓
Correspondência
⚠
↓
Consistência da Rota
⚠
↓
Resultado
⚠ Operação inconsistente.
Exemplo 3 — Rota Incompatível
Existência
✔
↓
Correspondência
✔
↓
Consistência da Rota
⚠
↓
Resultado
⚠ Rota inconsistente.
9.12.5 Exceções
Esta Subvalidação não possui exceções próprias.
Todos os estados especiais deverão ser herdados das Subvalidações anteriores.
9.12.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
9.12.7 Criticidade
Alta
Esta Subvalidação representa a conclusão oficial da Família V-009.
Seu resultado será utilizado pela Mesa de Auditoria, pelo Resumo Executivo e pela Clara para informar ao analista a situação da rota logística.
9.12.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método de comparação | Consolidação lógica das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte da verdade | Resultados das Subvalidações V-009.1, V-009.2 e V-009.3 |
| Baixa confiança de leitura | Herdada das Subvalidações anteriores |
| Falha da regra | Marca toda a Família V-009 como inconsistente |

9.12.9 Critérios de Aceitação
A Subvalidação V-009.4 será considerada corretamente implementada quando:
consolidar corretamente os resultados das três Subvalidações anteriores;
produzir uma única conclusão operacional sobre os portos da operação;
respeitar os estados herdados;
não realizar novas comparações documentais;
gerar uma evidência clara, rastreável e compreensível para o analista.
9.12.10 Impacto nas Validações Dependentes
Esta Subvalidação influencia diretamente:
V-010 — Participantes;
Resumo Executivo da Auditoria;
Explicações da Clara;
Indicador Geral de Consistência da Operação.
📘 Fechamento da Família V-009
Com este capítulo, encerramos a Família V-009 — Portos.
A Base de Conhecimento da Priora passa a suportar validações de:
Estrutura (Containers e Volumes);
Quantidades (Pesos e Cubagem);
Identificadores (Lacres);
Dados Cadastrais (Portos);
Contexto Operacional (Consistência da Rota).
Capítulo 10 — Família de Validação V-010 — Participantes
10.1 Objetivo
A Família de Validação V-010 — Participantes tem como objetivo verificar se os participantes informados no Master Bill of Lading (MBL) e no House Bill of Lading (HBL) representam corretamente as mesmas entidades envolvidas na operação logística.
Esta Família garante que as pessoas físicas ou jurídicas relacionadas ao embarque estejam corretamente identificadas e desempenhem os papéis esperados em ambos os documentos.
10.2 Importância Operacional
Os participantes definem quem envia, recebe e acompanha a carga.
Sua correta identificação é fundamental para:
emissão correta dos documentos;
liberação da carga;
comunicação entre as partes;
atendimento às exigências aduaneiras;
rastreabilidade da operação.
Erros nessa etapa podem gerar:
emissão incorreta do CE Mercante;
exigências da Receita Federal;
retrabalho documental;
atrasos na liberação;
problemas jurídicos relacionados à titularidade da carga.
Por esse motivo, esta é uma validação de criticidade crítica.
10.3 Estrutura da Família
A Família V-010 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-010.1 | Existência dos Participantes | Verificar se todos os participantes obrigatórios estão presentes. |
| V-010.2 | Correspondência dos Participantes | Comparar os nomes e os papéis desempenhados por cada participante. |
| V-010.3 | Identificador Fiscal | Comparar os identificadores fiscais quando existentes. |
| V-010.4 | Consistência dos Participantes | Consolidar todas as evidências produzidas pela Família. |

10.4 Ordem de Execução
V-010.1 Existência
↓
V-010.2 Correspondência
↓
V-010.3 Identificador Fiscal
↓
V-010.4 Consistência
Cada Subvalidação depende da conclusão da anterior.
10.5 Dependências
Esta Família depende de:
correta identificação do MBL e HBL;
relacionamento entre Master e House;
OCR concluído;
Parser concluído.
Não depende das Famílias de Peso, Cubagem ou Lacres.
10.6 Participantes Auditados
Durante o Playbook Pré-Alerta, a Priora deverá auditar, quando presentes:
Shipper
Consignee
Notify Party
Also Notify Party (quando existir)
Outros participantes poderão ser incorporados futuramente conforme a evolução da plataforma.
10.7 Identificador Fiscal
Sempre que disponível, a Priora deverá utilizar o identificador fiscal como principal elemento de identificação da entidade.
Exemplos:

| País | Identificador |
| --- | --- |
| Brasil | CNPJ |
| Estados Unidos | EIN |
| União Europeia | VAT |
| Alemanha | VAT ID |
| China | Unified Social Credit Code |

A Base de Conhecimento utilizará o conceito genérico de Identificador Fiscal, evitando regras específicas para um único país.
10.8 Fonte da Verdade
Durante o Playbook Pré-Alerta, o House Bill of Lading (HBL) será considerado a Fonte da Verdade para os participantes comerciais da operação.
Isso ocorre porque o HBL representa a relação contratual entre o agente de cargas e seu cliente, refletindo com maior precisão quem são o embarcador, o consignatário e as demais partes envolvidas naquela operação específica.
O Master Bill of Lading deverá ser compatível com essas informações, respeitando as particularidades da consolidação da carga.
Observação importante: Diferentemente das Famílias anteriores, nesta Família a Fonte da Verdade não é o MBL. Essa exceção é intencional e reflete a realidade operacional do transporte internacional.
10.9 Estados Possíveis
Cada Subvalidação poderá retornar:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
10.10 Critérios de Aceitação da Família
A Família V-010 será considerada corretamente implementada quando for capaz de:
identificar todos os participantes obrigatórios;
verificar seus respectivos papéis na operação;
comparar corretamente seus identificadores fiscais quando existentes;
distinguir diferenças meramente textuais de diferenças efetivas;
consolidar todas as evidências em uma única conclusão operacional.
10.11 — Subvalidação V-010.1 — Existência dos Participantes
10.11.1 Objetivo
A Subvalidação V-010.1 — Existência dos Participantes tem como objetivo verificar se todos os participantes obrigatórios da operação estão presentes nos documentos auditados.
Antes de comparar nomes, papéis ou identificadores fiscais, a Priora deverá confirmar que cada participante obrigatório foi corretamente identificado.
Esta é a primeira verificação realizada dentro da Família V-010.
10.11.2 Importância Operacional
Uma operação somente pode ser corretamente interpretada quando todas as partes essenciais estiverem identificadas.
A ausência de um participante obrigatório compromete:
a emissão documental;
a comunicação entre as partes;
a conferência dos dados cadastrais;
as validações posteriores da Família.
Por esse motivo, esta Subvalidação possui criticidade crítica.
10.11.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, o House Bill of Lading (HBL) será considerado a principal referência para os participantes comerciais da operação.
Sempre que existir informação adicional proveniente da Shipping Instructions ou da Memória Operacional do Processo (POP), ela poderá complementar a auditoria, preservando a origem de cada dado.
10.11.4 Regra Operacional
Para cada participante obrigatório, a Priora deverá verificar sua existência.
Os participantes serão classificados em:
Obrigatórios
Shipper
Consignee
Condicionais
Notify Party
Also Notify Party
Esses últimos somente serão considerados obrigatórios quando fizerem parte da operação.
Exemplo — Consistente

| Participante | HBL |
| --- | --- |
| Shipper | ✔ |
| Consignee | ✔ |
| Notify | ✔ |

Resultado:
✔ Todos os participantes obrigatórios estão presentes.
Exemplo — Divergência

| Participante | HBL |
| --- | --- |
| Shipper | ✔ |
| Consignee | — |

Resultado:
⚠ Participante obrigatório não localizado.
Exemplo — Campo Condicional
Notify Party
↓
Não informado.
Resultado:
✔ Campo não aplicável à operação.
10.11.5 Integração com o Perfil Operacional do Processo (POP)
Sempre que um participante for identificado pela primeira vez durante a operação, a Priora deverá registrar no Perfil Operacional do Processo (POP):
nome informado;
papel desempenhado;
documento de origem;
data da identificação;
identificador fiscal (quando existente);
nível de confiança da informação.
Esse cadastro servirá como referência para todas as auditorias futuras relacionadas ao mesmo processo.
10.11.6 Exceções
Shipping Instructions
Caso um participante esteja ausente no HBL, mas tenha sido identificado anteriormente na Shipping Instructions com alto grau de confiança, a Priora não deverá preencher automaticamente o documento, mas poderá utilizar essa informação para:
enriquecer o Perfil Operacional do Processo;
orientar futuras validações;
apresentar contexto adicional ao analista.
A ausência no documento continua sendo uma evidência operacional e deverá ser exibida.
OCR com Baixa Confiança
Caso o OCR identifique parcialmente um participante, a evidência deverá assumir o estado:
👤 Validação Humana.
Documento Ausente
Na ausência do HBL, esta Subvalidação deverá assumir:
⏸ Não Avaliada.
10.11.7 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
10.11.8 Criticidade
Crítica
A inexistência de um participante obrigatório impede a correta interpretação comercial da operação e compromete todas as Subvalidações posteriores da Família.
10.11.9 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Automática e determinística |
| Método de comparação | Verificação de existência |
| Dependência de IA | Extração inicial dos participantes |
| Uso de OCR | Extração dos campos cadastrais |
| Permite inferência automática | Não |
| Fonte da verdade | HBL + Perfil Operacional do Processo (como apoio) |
| Baixa confiança de leitura | Encaminhar para Validação Humana |
| Falha da regra | Impede a continuidade das Subvalidações da Família |

10.11.10 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
localizar corretamente todos os participantes obrigatórios;
distinguir participantes obrigatórios dos condicionais;
registrar automaticamente novos participantes no Perfil Operacional do Processo;
preservar a origem de cada informação cadastrada;
impedir inferências automáticas em caso de ausência documental;
produzir evidências claras e rastreáveis.
10.12 — Subvalidação V-010.2 — Correspondência dos Participantes
10.12.1 Objetivo
A Subvalidação V-010.2 — Correspondência dos Participantes tem como objetivo verificar se os participantes identificados nos documentos e no histórico do processo representam efetivamente as mesmas entidades envolvidas na operação, respeitando o papel desempenhado por cada uma delas.
Esta validação deve comparar a identidade do participante de forma contextual, utilizando o nome como evidência relevante, mas nunca como único elemento de confirmação quando houver identificadores mais fortes disponíveis.
10.12.2 Importância Operacional
A identificação incorreta de um participante pode alterar de forma significativa a interpretação comercial, documental e jurídica da operação.
Uma divergência pode indicar, entre outros cenários:
troca indevida de Consignee;
alteração de Shipper não refletida nos documentos;
informação cadastral incorreta;
documento emitido para empresa diferente;
risco de propagação do erro para o CE Mercante e demais etapas posteriores.
Por esse motivo, esta Subvalidação possui criticidade crítica.
10.12.3 Fonte da Verdade
A correspondência dos participantes deverá utilizar, em ordem de relevância operacional:
Shipping Instructions e histórico do e-mail do Pré-Alerta, quando contiverem dados cadastrais objetivos;
Perfil Operacional do Processo (POP), quando o participante já tiver sido confirmado anteriormente;
House Bill of Lading (HBL);
Master Bill of Lading (MBL), respeitando a natureza da relação representada pelo Master.
A Priora deverá sempre preservar a origem de cada informação utilizada.
10.12.4 Regra Operacional
Para cada participante, a Priora deverá verificar se a entidade encontrada corresponde à entidade já conhecida para aquele papel na operação.
A comparação deverá considerar, quando disponíveis:
papel do participante;
nome empresarial;
identificador fiscal;
país;
endereço;
aliases previamente confirmados;
histórico armazenado no POP.
A correspondência não deverá ser definida apenas pela semelhança textual entre nomes.
10.12.5 Hierarquia de Evidência
A Priora deverá utilizar a seguinte hierarquia para confirmar a identidade de um participante:
Evidência Forte
Identificador Fiscal coincidente;
alias previamente confirmado pelo analista no POP;
cadastro canônico já validado no processo.
Evidência Moderada
nome empresarial equivalente após normalização autorizada;
endereço compatível;
país compatível;
papel compatível.
Evidência Fraca
nomes apenas semelhantes;
abreviações desconhecidas;
traduções não cadastradas;
coincidência parcial de palavras.
Evidência fraca, isoladamente, nunca deverá produzir Consistente automático.
10.12.6 Normalização Permitida do Nome
Antes da comparação textual, a Priora poderá aplicar normalizações estruturais, como:
padronização para letras maiúsculas;
remoção de espaços excedentes;
remoção de pontuação irrelevante;
normalização de acentos;
padronização de formas societárias conhecidas, quando previamente definidas.
Exemplo:
ROCKET LOGÍSTICA E AGENCIAMENTO DE CARGAS S.A.
e
Rocket Logística e Agenciamento de Cargas S.A
podem ser normalizados para uma representação textual equivalente.
Essa normalização, porém, não substitui a validação da identidade jurídica.
10.12.7 Identidade Jurídica e Identificador Fiscal
Sempre que houver Identificador Fiscal disponível, ele deverá prevalecer sobre pequenas diferenças de nome.
Exemplo canônico:
Entidade:
ROCKET LOGÍSTICA E AGENCIAMENTO DE CARGAS S.A.
CNPJ:
27.909.874/0001-12
Se um novo documento apresentar uma variação textual do nome, mas o mesmo CNPJ validado, a Priora poderá considerar a entidade consistente.
Exemplo:
POP / Shipping Instructions
ROCKET LOGÍSTICA E AGENCIAMENTO DE CARGAS S.A.
CNPJ 27.909.874/0001-12
Novo documento
ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS SA
CNPJ 27.909.874/0001-12
Resultado:
✔ Mesmo participante confirmado.
10.12.8 Nomes Sem Identificador Fiscal
Quando o identificador fiscal não estiver disponível, a Priora poderá utilizar nome, endereço, país, papel e aliases confirmados como conjunto de evidências.
Exemplo:
POP
ABC IMPORTAÇÃO LTDA
HBL
ABC IMPORTACAO LTDA.
Resultado:
✔ Consistente, desde que a normalização estrutural seja suficiente e não exista evidência contraditória.
Entretanto:
POP
ABC IMPORTAÇÃO LTDA
HBL
ABC IMPORTS LTDA
Resultado:
👤 Validação Humana.
A Priora não deverá concluir automaticamente que são a mesma empresa.
10.12.9 Papel do Participante
A identidade correta não é suficiente por si só.
A entidade também deverá estar associada ao papel correto na operação.
Exemplo:
Uma empresa já confirmada como Consignee não poderá aparecer como Shipper e ser considerada automaticamente consistente apenas porque o CNPJ é o mesmo.
O papel também faz parte da validação.
10.12.10 Integração com o Perfil Operacional do Processo
Sempre que um participante for confirmado, o POP poderá registrar:
nome canônico;
papel;
identificador fiscal;
país;
endereço;
aliases confirmados;
fonte da informação;
data de confirmação;
usuário responsável pela confirmação, quando houver intervenção humana.
Essas informações poderão ser reutilizadas pelos Playbooks posteriores, principalmente no CE Mercante.
10.12.11 Alteração de Participante
Caso um novo documento apresente um participante diferente do registrado no POP, a Priora deverá:
registrar a divergência;
apresentar o participante anteriormente conhecido;
apresentar o novo participante encontrado;
preservar ambos no histórico;
nunca substituir automaticamente o participante canônico;
solicitar validação humana quando a mudança puder ser legítima.
10.12.12 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
10.12.13 Criticidade
Crítica
Uma divergência de participante pode alterar a titularidade, responsabilidade ou interpretação comercial da operação.
10.12.14 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Comparação cadastral com memória operacional |
| Método | Papel + Nome + Identificador Fiscal + POP |
| Dependência de IA | Extração e apoio à normalização |
| Uso de OCR | Extração dos dados cadastrais |
| Permite inferência automática | Não |
| Fonte principal | Shipping Instructions / POP / HBL |
| Identificador forte | Identificador Fiscal |
| Baixa confiança | Validação Humana |
| Falha da regra | Divergência do participante correspondente |

10.13 — Subvalidação V-010.3 — Correspondência do Identificador Fiscal
10.13.1 Objetivo
A Subvalidação V-010.3 — Correspondência do Identificador Fiscal tem como objetivo verificar se o Identificador Fiscal associado aos participantes da operação corresponde ao cadastro previamente conhecido e aos documentos auditados.
Sempre que disponível, o Identificador Fiscal será considerado a evidência mais forte para confirmação da identidade jurídica de um participante.
10.13.2 Importância Operacional
Diferentemente do nome empresarial, que pode sofrer abreviações, traduções ou pequenas variações de escrita, o Identificador Fiscal representa de forma única uma entidade jurídica.
Por esse motivo, sua conferência reduz significativamente o risco de:
identificar empresas diferentes como se fossem a mesma;
aceitar documentos emitidos para terceiros;
propagar erros cadastrais para o CE Mercante;
gerar inconsistências jurídicas na operação.
Esta Subvalidação possui criticidade crítica.
10.13.3 Fontes de Informação
A Priora poderá obter o Identificador Fiscal através das seguintes fontes, em ordem de prioridade:
Shipping Instructions;
Histórico do e-mail do Pré-Alerta;
Perfil Operacional do Processo (POP);
House Bill of Lading (HBL);
Master Bill of Lading (MBL);
Outros documentos oficiais que contenham o identificador.
Cada identificação deverá registrar sua origem.
10.13.4 Regra Operacional
Sempre que existir um Identificador Fiscal disponível para um participante, a Priora deverá compará-lo com o Identificador Fiscal previamente conhecido para aquele mesmo participante.
A comparação deverá responder à pergunta:
Esta entidade jurídica é realmente a mesma?
Exemplo — Consistente
Shipping Instructions
ROCKET LOGÍSTICA E AGENCIAMENTO DE CARGAS S.A.
CNPJ: 27.909.874/0001-12
↓
CE House
ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS SA
CNPJ: 27.909.874/0001-12
Resultado:
✔ Identificador Fiscal correspondente.
Mesmo com pequenas diferenças na escrita do nome, a entidade jurídica permanece a mesma.
Exemplo — Divergência
POP
ABC IMPORTAÇÃO LTDA
CNPJ: 12.345.678/0001-90
↓
Novo Documento
ABC IMPORTAÇÃO LTDA
CNPJ: 12.345.679/0001-90
Resultado:
⚠ Divergência de Identificador Fiscal.
Exemplo — Ausência do Identificador
Caso nenhum documento contenha Identificador Fiscal:
Resultado:
👤 A identidade deverá ser analisada utilizando as demais evidências disponíveis (nome, papel, país, endereço e histórico do POP).
A ausência do identificador, por si só, não caracteriza divergência.
10.13.5 Países e Identificadores
A Priora deverá utilizar o conceito genérico de Identificador Fiscal, permitindo auditorias internacionais.
Exemplos:

| País | Identificador |
| --- | --- |
| Brasil | CNPJ |
| Estados Unidos | EIN |
| Alemanha | VAT ID |
| União Europeia | VAT |
| China | Unified Social Credit Code |

Novos identificadores poderão ser incorporados futuramente sem alterar a arquitetura da Família.
10.13.6 Atualização do Perfil Operacional do Processo (POP)
Quando um Identificador Fiscal for confirmado, o POP deverá armazenar:
identificador;
país emissor;
participante associado;
documento de origem;
data da confirmação;
nível de confiança da informação.
Esses dados poderão ser utilizados automaticamente pelos Playbooks posteriores.
10.13.7 Alteração do Identificador
Caso um novo documento apresente um Identificador Fiscal diferente daquele registrado no POP, a Priora deverá:
registrar a divergência;
preservar ambos os valores;
informar a origem de cada informação;
impedir atualização automática do POP;
encaminhar a situação para análise humana.
10.13.8 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
10.13.9 Criticidade
Crítica
O Identificador Fiscal representa a evidência mais forte da identidade jurídica de um participante.
Sua divergência deverá ser tratada como uma inconsistência de alta relevância operacional.
10.13.10 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Comparação determinística |
| Método | Comparação exata do Identificador Fiscal |
| Dependência de IA | Apenas extração do dado |
| Uso de OCR | Extração do Identificador Fiscal |
| Permite inferência automática | Não |
| Fonte principal | POP + Shipping Instructions |
| Fonte complementar | HBL / MBL |
| Falha da regra | Divergência do participante correspondente |

10.13.11 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
comparar corretamente os Identificadores Fiscais disponíveis;
respeitar a prioridade das fontes de informação;
registrar a origem de cada identificador;
atualizar o POP apenas quando houver confirmação;
impedir alterações automáticas em caso de conflito;
produzir evidências claras, rastreáveis e auditáveis.
10.14 — Subvalidação V-010.4 — Consistência dos Participantes
10.14.1 Objetivo
A Subvalidação V-010.4 — Consistência dos Participantes tem como objetivo consolidar todas as evidências produzidas pelas Subvalidações anteriores da Família V-010, produzindo uma única conclusão operacional sobre a consistência dos participantes da operação.
Esta etapa não realiza novas comparações documentais. Sua função é interpretar os resultados obtidos anteriormente e apresentar uma conclusão única ao analista.
10.14.2 Importância Operacional
Os participantes representam as entidades jurídicas responsáveis pela operação logística.
Uma operação somente poderá ser considerada consistente quando:
todos os participantes obrigatórios estiverem presentes;
cada participante exercer o papel operacional esperado;
os participantes corresponderem às entidades conhecidas pelo processo;
os identificadores fiscais forem compatíveis quando disponíveis.
Somente a combinação desses fatores garante a correta identificação das partes envolvidas.
10.14.3 Fonte da Verdade
Esta Subvalidação utilizará exclusivamente os resultados produzidos por:
V-010.1 — Existência dos Participantes
V-010.2 — Correspondência dos Participantes
V-010.3 — Correspondência do Identificador Fiscal
Além disso, poderá consultar o Perfil Operacional do Processo (POP) para enriquecer a apresentação das evidências ao analista, sem alterar automaticamente os resultados das Subvalidações.
10.14.4 Regra Operacional
A Priora deverá consolidar os resultados utilizando a seguinte matriz de decisão:

| Existência | Correspondência | Identificador Fiscal | Resultado Final |
| --- | --- | --- | --- |
| ✔ | ✔ | ✔ | ✔ Consistente |
| ⚠ | qualquer | qualquer | ⚠ Divergência |
| ✔ | ⚠ | qualquer | ⚠ Divergência |
| ✔ | ✔ | ⚠ | ⚠ Divergência |
| 👤 | qualquer | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | qualquer | ⏸ Não Avaliada |

A consistência somente poderá ser confirmada quando todas as Subvalidações anteriores forem consistentes.
Exemplo 1 — Operação Consistente
Participantes presentes ✔
Papéis operacionais corretos ✔
Identificadores fiscais compatíveis ✔
↓
Resultado:
✔ Participantes consistentes.
Exemplo 2 — Divergência de Papel Operacional
HBL
Consignee
ABC IMPORTAÇÃO
MBL
Consignee
Rocket Logística e Agenciamento de Cargas S.A.
↓
Resultado:
✔ Consistente, desde que esse comportamento seja o esperado para o tipo de operação (ex.: consolidação LCL).
Observação: A Priora deverá validar os participantes conforme as regras de negócio de cada documento, e não exigir igualdade textual entre campos que possuem funções diferentes.
Exemplo 3 — Divergência de Identificador Fiscal
Participante identificado.
↓
Mesmo nome.
↓
CNPJ diferente.
↓
Resultado:
⚠ Divergência.
10.14.5 Integração com o Perfil Operacional do Processo (POP)
Ao concluir esta Família, a Priora deverá consolidar no POP todos os participantes confirmados durante a auditoria, preservando:
nome canônico;
aliases aprovados;
papel operacional;
identificador fiscal;
país;
endereço (quando disponível);
documento de origem;
data de confirmação;
nível de confiança da evidência;
histórico de alterações.
Essas informações serão utilizadas como referência para os próximos Playbooks, especialmente na validação do CE Mercante.
10.14.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
10.14.7 Criticidade
Crítica
Esta Subvalidação representa a conclusão oficial da Família V-010.
Seu resultado será utilizado pela Mesa de Auditoria, pelo Resumo Executivo e pela Clara para explicar a situação cadastral da operação.
10.14.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Consolidação determinística |
| Método | Consolidação das Subvalidações anteriores |
| Dependência de IA | Nenhuma |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte principal | Resultados da Família V-010 |
| Integração | Perfil Operacional do Processo (POP) |
| Falha da regra | Marca a Família V-010 como inconsistente |

10.14.9 Critérios de Aceitação
A Subvalidação V-010.4 será considerada corretamente implementada quando:
consolidar corretamente todas as evidências produzidas pela Família;
respeitar os papéis operacionais esperados para cada documento;
utilizar o POP como memória operacional do processo;
preservar a rastreabilidade das informações;
gerar uma conclusão única, clara e auditável para o analista.
Capítulo 11 — Família de Validação V-011 — Mercadoria (Description of Goods)
11.1 Objetivo
A Família de Validação V-011 — Mercadoria tem como objetivo verificar se a descrição da mercadoria presente no Master Bill of Lading (MBL) e no House Bill of Lading (HBL) representa a mesma carga transportada.
Esta Família busca identificar divergências relevantes entre as descrições, distinguindo diferenças meramente redacionais de alterações que possam modificar a interpretação da mercadoria.
11.2 Importância Operacional
A descrição da mercadoria é utilizada em diversas etapas da operação logística.
Uma descrição inconsistente pode gerar:
divergências documentais;
dificuldades na conferência do CE Mercante;
erros de classificação operacional;
necessidade de amendments;
retrabalho durante a liberação.
Entretanto, pequenas diferenças de redação são relativamente comuns entre documentos e nem sempre representam erro.
Por esse motivo, esta Família exige interpretação contextual.
Sua criticidade é média, podendo tornar-se alta quando a divergência alterar o entendimento da carga.
11.3 Estrutura da Família
A Família V-011 é composta pelas seguintes Subvalidações:

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-011.1 | Existência da Descrição | Verificar se a mercadoria está descrita nos documentos. |
| V-011.2 | Correspondência Semântica | Verificar se ambas as descrições representam a mesma mercadoria. |
| V-011.3 | Consistência da Mercadoria | Consolidar o resultado da Família. |

11.4 Ordem de Execução
V-011.1 Existência
↓
V-011.2 Correspondência Semântica
↓
V-011.3 Consolidação
11.5 Dependências
Esta Família depende de:
identificação correta do MBL;
identificação correta do HBL;
OCR concluído;
Parser concluído.
Opcionalmente poderá utilizar o Perfil Operacional do Processo (POP) para contextualizar descrições anteriormente confirmadas.
11.6 Campo Auditado
Durante o Playbook Pré-Alerta, a Priora deverá auditar o campo:
Description of Goods
Quando existirem múltiplas descrições no mesmo documento, todas deverão ser consideradas.
11.7 Fonte da Verdade
Nesta Família não existe uma Fonte da Verdade absoluta.
A descrição da mercadoria poderá variar entre o MBL e o HBL por motivos comerciais, operacionais ou de consolidação.
A Priora deverá avaliar se ambas representam a mesma carga, em vez de exigir igualdade textual.
11.8 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
11.9 Critérios de Aceitação da Família
A Família V-011 será considerada corretamente implementada quando for capaz de:
identificar corretamente a descrição da mercadoria;
distinguir diferenças textuais de diferenças materiais;
utilizar interpretação semântica quando necessário;
produzir evidências claras e justificáveis;
consolidar todas as verificações em uma única conclusão operacional.
11.10 — Subvalidação V-011.1 — Existência da Descrição da Mercadoria
11.10.1 Objetivo
A Subvalidação V-011.1 — Existência da Descrição da Mercadoria tem como objetivo verificar se os documentos auditados contêm uma descrição suficiente da carga transportada.
Antes de interpretar qualquer informação semântica, a Priora deverá confirmar que existe uma descrição passível de análise.
Esta é a primeira verificação da Família V-011.
11.10.2 Importância Operacional
Sem uma descrição da mercadoria, torna-se impossível avaliar:
se Master e House representam a mesma carga;
a coerência com documentos posteriores;
possíveis divergências materiais.
Por esse motivo, esta Subvalidação possui criticidade alta.
11.10.3 Fonte da Informação
Durante o Pré-Alerta, a descrição poderá ser obtida de:
Master Bill of Lading;
House Bill of Lading.
Caso futuramente existam Shipping Instructions ou documentos comerciais contendo descrição da carga, essas informações poderão enriquecer o Perfil Operacional do Processo.
11.10.4 Regra Operacional
Para cada documento auditado, a Priora deverá responder:
Existe uma descrição da mercadoria?
A resposta deverá considerar:
descrição textual;
descrição em múltiplas linhas;
descrições agrupadas;
descrições resumidas.
A ausência de descrição impede a execução da próxima Subvalidação.
Exemplo — Consistente
MBL
PLASTIC HOUSEHOLD PRODUCTS
↓
HBL
PLASTIC HOUSEHOLD PRODUCTS
↓
✔ Ambas possuem descrição.
Exemplo — Auditoria Parcial
MBL
PLASTIC HOUSEHOLD PRODUCTS
↓
HBL
—
↓
⏸ Não Avaliada.
A Priora não poderá comparar semanticamente uma descrição inexistente.
11.10.5 Descrições Genéricas
Descrições excessivamente genéricas, como:
GOODS
CARGO
GENERAL MERCHANDISE
não deverão ser consideradas automaticamente inválidas.
Entretanto, deverão gerar uma evidência de baixa qualidade da informação.
Essa evidência poderá ser utilizada posteriormente pela Clara para orientar o analista.
11.10.6 OCR
Caso o OCR apresente baixa confiança na leitura da descrição:
↓
👤 Validação Humana.
11.10.7 Estados
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
11.10.8 Criticidade
Alta
11.10.9 Base Técnica

| Campo | Definição |
| --- | --- |
| Tipo | Determinística |
| Método | Existência |
| IA | Apenas OCR |
| Fonte | MBL/HBL |
| Inferência | Não |
| Dependência | OCR |

11.10.10 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
localizar a descrição da mercadoria;
aceitar descrições em múltiplas linhas;
tratar corretamente auditorias parciais;
encaminhar OCR incerto para Validação Humana;
registrar descrições genéricas como evidências de baixa qualidade.
11.11 — Subvalidação V-011.2 — Correspondência Semântica da Mercadoria
11.11.1 Objetivo
A Subvalidação V-011.2 — Correspondência Semântica da Mercadoria tem como objetivo verificar se as descrições presentes no Master Bill of Lading (MBL) e no House Bill of Lading (HBL) representam a mesma mercadoria, ainda que utilizem descrições diferentes.
Ao contrário das validações determinísticas, esta Subvalidação utiliza interpretação contextual para avaliar o significado operacional das descrições.
11.11.2 Importância Operacional
Diferenças textuais entre MBL e HBL são comuns.
Em muitas operações:
MBL
PLASTIC PRODUCTS
HBL
PLASTIC KITCHEN CONTAINERS
representam exatamente a mesma carga.
Entretanto:
MBL
STEEL PIPES
HBL
ELECTRONIC COMPONENTS
representam mercadorias completamente distintas.
O objetivo desta Subvalidação é distinguir diferenças aceitáveis de divergências que alterem a natureza da carga.
Sua criticidade é Alta.
11.11.3 Framework de Raciocínio Operacional (FRO)
Para reduzir alucinações e garantir rastreabilidade, a IA não poderá responder diretamente se as descrições são iguais ou diferentes.
Ela deverá seguir obrigatoriamente o Framework de Raciocínio Operacional (FRO).
O resultado final somente poderá ser emitido após a execução completa das etapas abaixo.
Etapa 1 — Observação
Nesta etapa a IA apenas descreve objetivamente o conteúdo encontrado.
É proibido interpretar.
Exemplo:
MBL
PLASTIC HOUSEHOLD PRODUCTS
HBL
PLASTIC KITCHEN CONTAINERS
Resultado esperado:
O MBL descreve "Plastic Household Products".
O HBL descreve "Plastic Kitchen Containers".
Nada além disso.
Etapa 2 — Análise Estruturada
A IA deverá responder, obrigatoriamente, às seguintes perguntas.
Pergunta 1
As duas descrições representam a mesma categoria geral de mercadoria?
Pergunta 2
Existe alguma contradição objetiva entre elas?
Exemplo:
Steel
↓
Plastic
↓
Resposta:
Sim.
Pergunta 3
Uma descrição é apenas mais específica do que a outra?
Exemplo:
Plastic Products
↓
Plastic Kitchen Containers
↓
Resposta:
Sim.
Pergunta 4
Alguma informação importante foi omitida?
Exemplo:
Hazardous Cargo
↓
House não menciona carga perigosa.
↓
Resposta:
Sim.
Pergunta 5
Existe alguma característica que altere significativamente a natureza da carga?
Exemplos:
produto químico;
alimento;
medicamento;
carga perigosa;
madeira;
bateria de lítio;
produto refrigerado.
Pergunta 6
A descrição é compatível com o Perfil Operacional do Processo (POP)?
Caso o POP já possua descrição previamente confirmada, ela deverá ser utilizada apenas como contexto.
Nunca como substituição da análise documental.
Pergunta 7
Existe conflito com outras informações do processo?
Exemplos:
descrição incompatível com NCM;
descrição incompatível com Wood Package;
descrição incompatível com peso;
descrição incompatível com documentos comerciais.
Caso exista conflito objetivo, a IA deverá informá-lo.
Pergunta 8
Qual é o nível de confiança da conclusão?
A IA deverá classificar sua própria conclusão como:
Muito Alta
Alta
Média
Baixa
Conclusões com confiança Baixa deverão ser encaminhadas automaticamente para Validação Humana.
Etapa 3 — Conclusão
Somente após responder às perguntas anteriores a IA poderá concluir:
✔ Consistente
⚠ Divergência
👤 Validação Humana
A conclusão deverá ser acompanhada de uma justificativa objetiva baseada nas respostas do FRO.
11.11.4 Regras Operacionais
A Priora não deverá exigir igualdade textual entre as descrições.
O objetivo é verificar equivalência operacional da mercadoria.
Diferenças de idioma, pluralização, abreviações ou nível de detalhamento não caracterizam divergência automaticamente.
11.11.5 Exemplos
Exemplo 1 — Consistente
MBL
PLASTIC PRODUCTS
HBL
PLASTIC KITCHEN CONTAINERS
FRO
Categoria:
✔ Mesma.
Contradição:
Não.
Especialização:
Sim.
Resultado:
✔ Consistente.
Exemplo 2 — Divergência
MBL
STEEL PIPES
HBL
ELECTRONIC COMPONENTS
Categoria:
Diferente.
Contradição:
Sim.
Resultado:
⚠ Divergência.
Exemplo 3 — Validação Humana
MBL
TEXTILE PRODUCTS
HBL
GARMENTS
Categoria:
Possivelmente equivalente.
Contradição:
Não.
Especialização:
Inconclusiva.
Confiança:
Baixa.
Resultado:
👤 Validação Humana.
11.11.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
11.11.7 Criticidade
Alta
Uma interpretação incorreta da mercadoria pode comprometer diversas validações posteriores, especialmente NCM, Wood Package, classificação documental e conferência do CE Mercante.
11.11.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Semântica estruturada |
| Método | Framework de Raciocínio Operacional (FRO) |
| Dependência de IA | Alta |
| Uso de OCR | Extração da descrição |
| Permite inferência automática | Apenas dentro do FRO |
| Fonte principal | MBL + HBL |
| Fonte complementar | Perfil Operacional do Processo (POP) |
| Falha da regra | Divergência ou Validação Humana, conforme confiança |

11.12 — Subvalidação V-011.3 — Consistência da Mercadoria
11.12.1 Objetivo
A Subvalidação V-011.3 — Consistência da Mercadoria tem como objetivo consolidar todas as evidências produzidas pelas Subvalidações anteriores da Família V-011, emitindo uma única conclusão operacional sobre a consistência da mercadoria representada pelos documentos.
Esta Subvalidação não interpreta novamente a descrição da carga. Sua responsabilidade é consolidar as evidências já produzidas, considerando também o nível de confiança da análise semântica.
11.12.2 Importância Operacional
A descrição da mercadoria influencia diretamente diversas etapas posteriores da operação, incluindo:
conferência do CE Mercante;
validação do NCM;
conferência de Madeira (ISPM-15);
classificação documental;
geração de evidências para o analista.
Uma conclusão incorreta nesta etapa pode propagar inconsistências para diversos módulos da Priora.
11.12.3 Fonte da Verdade
Esta Subvalidação utilizará exclusivamente os resultados produzidos por:
V-011.1 — Existência da Descrição
V-011.2 — Correspondência Semântica
Opcionalmente, poderá consultar o Perfil Operacional do Processo (POP) apenas para contextualização da conclusão, nunca para alterar automaticamente o resultado da auditoria.
11.12.4 Regra Operacional
A consolidação deverá considerar simultaneamente:
existência da descrição;
conclusão produzida pelo Framework de Raciocínio Operacional (FRO);
nível de confiança da IA;
conflitos com o Perfil Operacional do Processo;
conflitos com outras Famílias já executadas.
A Priora deverá consolidar os resultados utilizando a seguinte matriz:

| Existência | FRO | Confiança | Resultado Final |
| --- | --- | --- | --- |
| ✔ | ✔ | Alta ou Muito Alta | ✔ Consistente |
| ✔ | ✔ | Média | 👤 Validação Humana |
| ✔ | ⚠ | qualquer | ⚠ Divergência |
| 👤 | qualquer | qualquer | 👤 Validação Humana |
| ⏸ | qualquer | qualquer | ⏸ Não Avaliada |

A Priora nunca deverá assumir automaticamente uma conclusão positiva quando a própria IA indicar baixa confiança.
11.12.5 Integração com o Perfil Operacional do Processo (POP)
Quando a correspondência da mercadoria for considerada consistente e possuir confiança Alta ou Muito Alta, a descrição poderá ser registrada no POP como uma nova evidência da operação.
O POP deverá armazenar:
descrição original encontrada;
representação canônica (quando existir);
documento de origem;
data da confirmação;
nível de confiança;
justificativa resumida produzida pelo FRO.
Caso a conclusão seja Validação Humana, nenhuma atualização automática deverá ocorrer.
11.12.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
11.12.7 Criticidade
Alta
Esta Subvalidação representa a conclusão oficial da Família V-011 e será utilizada como referência para validações futuras relacionadas à mercadoria.
11.12.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Consolidação semântica |
| Método | Consolidação do FRO |
| Dependência de IA | Indireta (resultado da Subvalidação anterior) |
| Uso de OCR | Não |
| Permite inferência automática | Não |
| Fonte principal | Resultados das Subvalidações anteriores |
| Integração | Perfil Operacional do Processo (POP) |
| Falha da regra | Divergência ou Validação Humana |

11.12.9 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
consolidar corretamente os resultados das Subvalidações anteriores;
respeitar o nível de confiança da IA;
impedir atualizações automáticas do POP em análises inconclusivas;
produzir uma conclusão única, clara e auditável;
registrar todas as evidências utilizadas na decisão.
Família V-012 — NCM
Depois das suas respostas, eu mudaria completamente o foco.
Inicialmente eu imaginava uma família "inteligente".
Mas não.
O trabalho do analista não é descobrir se o NCM faz sentido.
O trabalho dele é garantir que todos os documentos representem exatamente o que foi aprovado.
Essa diferença é enorme.
Então a Família NCM deixa de ser semântica e volta a ser 100% determinística.
Isso é ótimo.
Capítulo 12 — Família de Validação V-012 — NCM
12.1 Objetivo
A Família de Validação V-012 — NCM tem como objetivo verificar se os códigos NCM presentes nos documentos da operação representam exatamente as mesmas classificações fiscais aprovadas para o embarque.
Durante o Playbook Pré-Alerta, a Priora não tem como finalidade validar se o NCM está tecnicamente correto perante a legislação fiscal.
Sua responsabilidade é garantir que todos os documentos contenham o mesmo código aprovado para aquela operação.
12.2 Importância Operacional
O NCM é uma das informações mais críticas de toda a documentação de importação.
Uma divergência pode resultar em:
necessidade de amendment do Bill of Lading;
reemissão documental;
retrabalho operacional;
atraso na liberação da carga;
custos junto ao armador;
multas aplicadas pela Receita Federal, quando o CE Mercante já tiver sido transmitido.
Em determinadas situações, uma divergência de NCM pode gerar custos superiores ao próprio frete internacional.
Por esse motivo, esta Família possui criticidade crítica.
12.3 Objetivo Operacional
Durante esta Família, a Priora deverá responder às seguintes perguntas:
Todos os documentos apresentam os mesmos códigos NCM?
Algum NCM foi alterado durante a negociação documental?
As alterações solicitadas foram efetivamente aplicadas?
Existe divergência entre MBL e HBL?
Existe divergência entre Draft aprovado e documento final?
Existem códigos ausentes?
Existem códigos adicionais?
Alguma alteração crítica deixou de ser aplicada?
Observe que nenhuma dessas perguntas busca verificar se o NCM está fiscalmente correto.
O objetivo é garantir consistência documental.
12.4 Estrutura da Família

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-012.1 | Existência dos NCMs | Verificar se todos os códigos estão presentes. |
| V-012.2 | Correspondência dos NCMs | Comparar os códigos entre os documentos. |
| V-012.3 | Histórico de Alterações | Verificar se alterações aprovadas foram aplicadas. |
| V-012.4 | Consolidação | Emitir a conclusão final da Família. |

12.5 Ordem de Execução
V-012.1 Existência
↓
V-012.2 Correspondência
↓
V-012.3 Histórico de Alterações
↓
V-012.4 Consolidação
12.6 Fontes de Informação
A Priora poderá utilizar como evidências:
Drafts;
MBL;
HBL;
Invoice;
Packing List;
CE House;
CE Master;
Histórico de e-mails;
Perfil Operacional do Processo (POP);
Evidence Timeline (ETL).
Cada Playbook utilizará apenas as fontes necessárias para sua execução, conforme definido pelo Context Builder.
12.7 Fonte da Verdade
Durante o Playbook Pré-Alerta, a Fonte da Verdade será determinada pela sequência de evidências registrada na ETL.
Na ausência de um Draft final aprovado ou de evidências suficientes, a Priora deverá utilizar como referência os documentos vigentes da operação.
Quando existir uma solicitação formal de alteração aprovada, seguida do recebimento de uma nova versão documental, essa nova versão passará a representar a informação vigente.
12.8 Regras Gerais
Durante esta Família:
diferenças entre códigos deverão ser tratadas como divergências objetivas;
não haverá interpretação semântica do código;
a Priora não deverá sugerir NCMs alternativos;
incompatibilidades aparentes entre descrição e NCM poderão ser registradas apenas como observações informativas, sem impacto na auditoria.
12.9 Critérios de Aceitação
A Família será considerada corretamente implementada quando for capaz de:
localizar todos os NCMs presentes;
comparar corretamente códigos de quatro, seis e oito dígitos;
identificar alterações documentais;
verificar se alterações aprovadas foram aplicadas;
preservar rastreabilidade completa;
consolidar todas as evidências em uma conclusão única.
12.10 — Subvalidação V-012.1 — Existência dos Códigos NCM
12.10.1 Objetivo
A Subvalidação V-012.1 — Existência dos Códigos NCM tem como objetivo verificar se todos os documentos auditados contêm os códigos NCM esperados para a operação.
Antes de comparar os códigos entre os documentos, a Priora deverá confirmar sua existência.
Esta é a primeira validação da Família V-012.
12.10.2 Importância Operacional
A ausência de um código NCM pode impedir a correta conferência documental e comprometer etapas posteriores da operação.
Sem a existência do código, torna-se impossível verificar:
correspondência entre documentos;
alterações solicitadas pelo cliente;
consistência do CE Mercante;
necessidade de amendments.
Por esse motivo, esta Subvalidação possui criticidade crítica.
12.10.3 Fonte da Informação
Durante o Playbook Pré-Alerta, a Priora poderá localizar códigos NCM em:
MBL;
HBL;
Drafts;
Invoice;
Packing List.
A utilização de cada documento dependerá do contexto da auditoria definido pelo Playbook.
12.10.4 Regra Operacional
Para cada documento participante da auditoria, a Priora deverá responder:
Existe pelo menos um código NCM informado?
Quando a operação possuir múltiplos códigos NCM, todos deverão ser extraídos e registrados.
A ordem em que aparecem no documento não deverá influenciar a validação.
Exemplo — Consistente
MBL
392690
847130
85044030
↓
HBL
392690
847130
85044030
Resultado:
✔ Todos os códigos esperados foram encontrados.
Exemplo — Divergência
MBL
392690
847130
85044030
↓
HBL
392690
85044030
Resultado:
⚠ Um código NCM esperado não foi localizado.
Exemplo — Auditoria Parcial
Caso um dos documentos necessários para a comparação não esteja disponível:
Resultado:
⏸ Não Avaliada.
A ausência do documento não deverá gerar automaticamente uma divergência.
12.10.5 Múltiplos NCM
Uma mesma operação poderá conter diversos códigos NCM.
A Priora deverá tratar todos os códigos pertencentes ao processo como um conjunto de informações.
Nesta etapa, não será realizada qualquer associação entre NCM e contêiner, mercadoria ou item da Invoice.
Essa associação, quando necessária, pertence a outros Playbooks ou módulos específicos.
12.10.6 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
12.10.7 Criticidade
Crítica
A inexistência de códigos NCM inviabiliza as demais Subvalidações desta Família.
12.10.8 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método | Verificação de existência |
| Dependência de IA | Nenhuma |
| Uso de OCR | Extração dos códigos |
| Permite inferência automática | Não |
| Fonte principal | Documentos definidos pelo Playbook |
| Falha da regra | Interrompe as Subvalidações seguintes |

12.10.9 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
localizar todos os códigos NCM presentes nos documentos;
suportar operações com múltiplos NCM;
tratar corretamente auditorias parciais;
impedir o prosseguimento das comparações quando os códigos necessários não puderem ser identificados.
12.11 — Subvalidação V-012.2 — Correspondência dos Códigos NCM
12.11.1 Objetivo
A Subvalidação V-012.2 — Correspondência dos Códigos NCM tem como objetivo verificar se os códigos NCM presentes nos documentos auditados representam exatamente a mesma classificação fiscal aprovada para a operação.
A comparação deverá ser realizada de forma determinística, considerando a quantidade de dígitos disponível em cada documento.
12.11.2 Importância Operacional
Uma divergência de NCM representa uma das inconsistências mais críticas de toda a documentação da operação.
Erros nesta informação podem resultar em:
amendments documentais;
reemissão de Bill of Lading;
atrasos na operação;
multas da Receita Federal;
custos operacionais para o Agente de Carga ou para o Cliente, conforme a origem do erro.
Por esse motivo, esta Subvalidação possui criticidade crítica.
12.11.3 Fonte da Verdade
Durante o Playbook Pré-Alerta, a Priora deverá comparar os documentos definidos pelo escopo da auditoria.
Quando existir histórico de alterações aprovado (ETL), a comparação deverá considerar a versão documental vigente da operação.
A Priora não deverá assumir automaticamente que o documento mais recente representa a informação correta.
12.11.4 Regra Operacional
A comparação dos códigos NCM deverá respeitar o menor nível de detalhamento comum entre os documentos comparados.
Exemplos
Caso 1 — 4 × 4 dígitos
MBL
3926
↓
HBL
3926
Resultado:
✔ Consistente.
Caso 2 — 4 × 6 dígitos
MBL
3926
↓
HBL
392690
Resultado:
✔ Consistente.
A comparação deverá utilizar apenas os quatro primeiros dígitos.
Caso 3 — 4 × 8 dígitos
MBL
3926
↓
HBL
39269090
Resultado:
✔ Consistente.
Caso 4 — 6 × 8 dígitos
MBL
392690
↓
HBL
39269090
Resultado:
✔ Consistente.
Caso 5 — Divergência
MBL
392690
↓
HBL
392790
Resultado:
⚠ Divergência.
Os seis primeiros dígitos não correspondem.
Caso 6 — 8 × 8 dígitos
MBL
39269090
↓
HBL
39269099
Resultado:
⚠ Divergência.
Os códigos completos diferem.
12.11.5 Múltiplos Códigos NCM
Quando a operação possuir múltiplos códigos NCM, a Priora deverá comparar os conjuntos de códigos entre os documentos.
A validação deverá verificar:
códigos ausentes;
códigos adicionais;
códigos divergentes.
A ordem em que os códigos aparecem não deverá influenciar a comparação.
Exemplo
MBL
3926
8471
8504
↓
HBL
8504
3926
8471
Resultado:
✔ Consistente.
12.11.6 Normalização
Antes da comparação, a Priora deverá:
remover espaços;
remover caracteres não numéricos;
preservar apenas os dígitos do código;
identificar automaticamente se o código possui 4, 6 ou 8 dígitos.
Nenhuma outra transformação será permitida.
12.11.7 Alterações Solicitadas
Caso a ETL registre uma solicitação formal de alteração do NCM, seguida de aprovação e recebimento de um novo documento, a comparação deverá ocorrer utilizando apenas a versão vigente da operação.
Versões anteriores permanecerão disponíveis para auditoria, mas não deverão ser utilizadas como referência principal.
12.11.8 Estados Possíveis
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
12.11.9 Criticidade
Crítica
Qualquer divergência objetiva deverá ser apresentada ao analista antes da continuidade da operação.
12.11.10 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Determinística |
| Método | Comparação numérica normalizada |
| Dependência de IA | Nenhuma |
| Uso de OCR | Extração dos códigos |
| Permite inferência automática | Não |
| Fonte principal | Documentos vigentes definidos pelo Playbook |
| Falha da regra | Divergência documental |

12.11.11 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando:
comparar corretamente códigos de 4, 6 e 8 dígitos;
respeitar o menor nível de detalhamento comum entre os documentos;
identificar códigos ausentes, adicionais e divergentes;
ignorar a ordem dos códigos durante a comparação;
considerar corretamente a versão documental vigente quando existirem alterações aprovadas;
produzir evidências claras e rastreáveis.
Bora. Então eu substituiria a V-012.3 anterior inteira por esta versão, porque agora ela representa exatamente o comportamento que queremos da Priora.
12.12 — Subvalidação V-012.3 — Verificação Contextual do Histórico de NCM
12.12.1 Objetivo
A Subvalidação V-012.3 — Verificação Contextual do Histórico de NCM tem como objetivo identificar no histórico operacional possíveis solicitações de alteração, inclusão ou exclusão de NCM que possam exigir atenção do analista.
Esta Subvalidação não substitui nem altera automaticamente o resultado da comparação documental realizada pela V-012.2.
Seu papel é utilizar o histórico como uma camada adicional de segurança operacional.
12.12.2 Importância Operacional
É possível que MBL e HBL estejam perfeitamente consistentes entre si e, ainda assim, exista no histórico do processo uma solicitação anterior que não tenha sido refletida nos documentos atuais.
Exemplo:
MBL
39269090
HBL
39269090
Resultado documental:
✔ MBL × HBL consistentes.
Porém, no histórico:
14/08/2026 — 10:32
Cliente:
"Favor adicionar também o NCM 85044090."
Nesse cenário, a Priora não deverá concluir automaticamente que os documentos estão incorretos.
Ela deverá informar ao analista que existe uma evidência histórica relevante que merece verificação.
12.12.3 Fonte da Verdade
A Fonte da Verdade primária desta Família continua sendo o estado documental vigente da operação, conforme definido pelas Subvalidações anteriores.
O histórico operacional funciona como evidência contextual complementar.
Portanto:
Uma mensagem encontrada no histórico nunca deverá, isoladamente, substituir automaticamente a informação existente nos documentos vigentes.
Somente o analista poderá confirmar que determinada evidência histórica representa uma alteração que deveria estar refletida na documentação atual.
12.12.4 Regra Operacional
Após concluir a V-012.2, a Priora deverá verificar se existem eventos históricos relevantes relacionados aos NCMs da operação.
A busca deverá considerar exclusivamente eventos relacionados a:
alteração de NCM;
inclusão de NCM;
exclusão de NCM;
correção de NCM;
solicitação de revisão de NCM.
A Priora não deverá utilizar o histórico completo indiscriminadamente.
Fluxo
V-012.2
Comparação documental
↓
MBL × HBL consistentes?
↓
Resultado documental registrado
↓
Consultar eventos relevantes de NCM
│
┌───┴───┐
│       │
NÃO     SIM
│       │
▼       ▼
Sem      Avaliar relevância
alerta      do evento
│
┌─────┴─────┐
│           │
Irrelevante    Relevante
│           │
▼           ▼
Ignorar     ⚠ Alerta
12.12.5 Critério para Geração de Alerta
Um evento histórico somente deverá gerar alerta quando houver evidência suficientemente clara de que uma informação relacionada ao NCM poderia ter sido modificada.
Exemplos de eventos relevantes:
“Favor alterar o NCM para 39269090.”
“Please add NCM 85044090.”
“Remove NCM 3926 from the BL.”
“Correct NCM should be 84713012.”
Essas mensagens indicam uma ação operacional concreta.
Não devem gerar alerta automaticamente
Mensagens como:
“Could you check the NCM?”
“What is the NCM?”
“I believe the NCM might be different.”
“Please verify classification.”
Essas mensagens podem indicar dúvida ou discussão, mas não necessariamente uma instrução de alteração.
Quando existir ambiguidade relevante, a Priora poderá encaminhar o caso para Validação Humana, sem transformar a mensagem em uma alteração confirmada.
12.12.6 Resultado Documental × Alerta Contextual
O resultado documental e o alerta histórico deverão permanecer independentes.
Exemplo:
Validação documental
✔ NCM consistente
MBL: 39269090
HBL: 39269090
Contexto operacional
⚠️ Possível alteração de NCM identificada no histórico
Foi encontrada uma solicitação relacionada à inclusão de NCM em 14/08/2026 às 10:32.
Valor mencionado: 85044090
Verifique se essa solicitação deveria estar refletida nos documentos atuais.
Botões:
[Confirmar documentos atuais]
[Verificar e-mail]
Quando aplicável:
[Solicitar correção]
12.12.7 Ação — Verificar E-mail
Ao selecionar Verificar e-mail, a Priora deverá abrir diretamente a evidência que originou o alerta.
A interface deverá apresentar, sempre que disponível:
data e hora;
remetente;
destinatários;
assunto;
trecho relevante;
NCM identificado;
acesso à mensagem completa;
acesso à thread completa, caso necessário.
A Priora deverá direcionar o analista para a mensagem específica, evitando que ele precise procurar manualmente dentro de toda a conversa.
12.12.8 Ação — Confirmar Documentos Atuais
Caso o analista revise a evidência e determine que os documentos atuais estão corretos, poderá selecionar:
Confirmar documentos atuais
A Priora deverá registrar:
usuário responsável;
data e hora;
alerta analisado;
evidência histórica relacionada;
decisão tomada;
versão documental analisada.
Exemplo:
Alerta histórico revisado.
Analista:
Pedro
Data:
15/08/2026 — 14:32
Evidência:
E-mail de 14/08/2026 — 10:32
Decisão:
Documentação atual confirmada.
Após a confirmação, o mesmo alerta não deverá reaparecer para a mesma versão documental, salvo surgimento de nova evidência relevante.
12.12.9 Ação — Solicitar Correção
Caso o analista identifique que a alteração encontrada no histórico realmente deveria estar refletida nos documentos atuais, poderá selecionar:
Solicitar correção
Nesse momento, o alerta deixa de ser apenas contextual e passa a originar uma pendência operacional.
Exemplo:
NCM documental:
MBL × HBL
✔ Consistentes
Histórico:
⚠ Alteração não refletida
Analista:
Solicitar correção
↓
Pendência criada
↓
Aguardando nova documentação
A inconsistência deverá ser registrada como:
Alteração operacional não refletida na documentação vigente.
E não como:
“MBL divergente de HBL.”
Essa distinção deverá ser preservada.
12.12.10 Alterações Sucessivas
Uma operação poderá possuir diversas discussões ou alterações de NCM ao longo do processo.
Exemplo:
08:20
NCM inicial: 3926
↓
10:15
Solicitação:
Alterar para 392690
↓
13:40
Nova solicitação:
Adicionar 85044090
A ETL deverá preservar todos os eventos.
Entretanto, a Priora deverá apresentar ao analista apenas aqueles que ainda possam possuir relevância para a documentação vigente.
Eventos já solucionados e refletidos corretamente não deverão gerar alertas desnecessários.
12.12.11 Uso do Context Builder
A Inteligência Artificial não deverá receber todo o histórico de e-mails do processo.
O Context Builder deverá recuperar somente eventos potencialmente relacionados ao NCM.
Fluxo esperado:
V-012.3 iniciada
↓
ETL possui eventos relacionados a NCM?
│
┌────┴────┐
│         │
NÃO       SIM
│         │
▼         ▼
Encerrar   Filtrar eventos
↓
Há possível mudança?
│        │
NÃO      SIM
│        │
▼        ▼
Encerrar   Contexto mínimo
↓
IA/FRO somente
se necessário
Um processo poderá possuir centenas de mensagens sem que elas sejam enviadas ao modelo.
12.12.12 Papel da Inteligência Artificial
A IA poderá ser utilizada apenas quando for necessário interpretar linguisticamente uma mensagem para determinar se ela representa:
alteração;
inclusão;
exclusão;
correção;
dúvida;
solicitação de verificação.
A IA não deverá decidir se o novo NCM é fiscalmente correto.
Também não deverá substituir automaticamente o NCM vigente no POP ou nos documentos.
Seu papel é apenas identificar se existe uma evidência operacional que merece atenção humana.
12.12.13 Exceções
Histórico sem relação objetiva com NCM
Nenhum alerta.
NCM mencionado incidentalmente
Nenhum alerta, salvo existência de ação operacional associada.
Solicitação ambígua
👤 Validação Humana, quando relevante.
Alteração já refletida na documentação
Nenhum alerta pendente.
O evento permanece registrado na ETL apenas para rastreabilidade.
Documento necessário ausente
⏸ Não Avaliada, quando a ausência impedir verificar se a possível alteração foi refletida.
12.12.14 Estados Possíveis
A V-012.3 possuirá estados próprios relacionados ao contexto histórico:
Sem Alerta — nenhuma evidência histórica relevante encontrada.
⚠ Atenção Histórica — possível alteração relevante identificada.
👤 Validação Humana — evidência ambígua que exige interpretação do analista.
Revisado pelo Analista — evidência analisada e documentação atual confirmada.
Correção Necessária — analista confirmou que a alteração deveria estar refletida nos documentos.
⏸ Não Avaliada — evidências insuficientes.
Esses estados não substituem o status da V-012.2.
12.12.15 Criticidade
Crítica, quando existir uma possível alteração de NCM ainda não refletida.
Entretanto, o alerta histórico deverá inicialmente possuir caráter de atenção, e não de divergência documental automática.
A divergência operacional somente deverá ser confirmada após análise suficiente da evidência ou decisão do analista.
12.12.16 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Contextual / Híbrida |
| Validação documental | Executada pela V-012.2 |
| Fonte histórica | Evidence Timeline |
| Seleção de contexto | Context Builder |
| Uso de IA | Somente interpretação de eventos ambíguos ou semânticos |
| Comparação objetiva | Rule Engine |
| Altera automaticamente resultado documental | Não |
| Altera automaticamente POP | Não |
| Exige decisão humana para confirmar correção | Sim |
| Permite inferência fiscal de NCM | Não |

12.12.17 Critérios de Aceitação
A Subvalidação será considerada corretamente implementada quando conseguir:
localizar eventos históricos relacionados a NCM;
distinguir alteração, inclusão, exclusão, correção e simples discussão;
evitar alertas baseados em menções irrelevantes;
preservar separação entre consistência documental e contexto histórico;
apresentar data, origem e evidência do evento;
direcionar o analista diretamente ao e-mail relevante;
permitir confirmação da documentação atual;
permitir criação de pendência quando a alteração não tiver sido aplicada;
impedir atualização automática do NCM apenas com base no histórico;
evitar reexibição de alertas já revisados para a mesma versão documental;
utilizar apenas o contexto mínimo necessário.
12.12.18 Impacto nas Validações Dependentes
A V-012.3 não deverá alterar automaticamente as demais Subvalidações.
Quando não houver alerta relevante:
V-012.2
✔ Consistente
+
V-012.3
Sem alerta
↓
Família segue normalmente
Quando existir atenção histórica:
V-012.2
✔ Consistente
+
V-012.3
⚠ Atenção Histórica
↓
NCM documental permanece consistente
+
Analista recebe ponto de atenção
Quando o analista confirmar que uma alteração deveria ter sido aplicada:
V-012.3
Correção Necessária
↓
Pendência operacional
↓
Família NCM permanece com
ação necessária
até nova versão documental
Regra fundamental da V-012.3
O histórico existe para revelar aquilo que os documentos, isoladamente, podem não contar. Ele não substitui a auditoria documental: ele alerta o analista quando existe evidência concreta de que algo merece ser revisado.
2.13 — Subvalidação V-012.4 — Consistência Consolidada do NCM
12.13.1 Objetivo
A Subvalidação V-012.4 — Consistência Consolidada do NCM tem como objetivo reunir os resultados das Subvalidações anteriores e apresentar ao analista uma conclusão única sobre o estado dos NCMs da operação.
A consolidação deverá considerar separadamente:
a consistência documental dos NCMs;
a existência de atenções contextuais identificadas no histórico.
Essas duas dimensões não deverão ser confundidas.
12.13.2 Importância Operacional
Um código NCM pode estar:
corretamente presente;
consistente entre Master e House;
mas possuir uma possível alteração identificada no histórico.
Da mesma forma, pode existir uma divergência documental objetiva sem qualquer evento relevante nos e-mails.
Por isso, a Priora não deverá reduzir toda a análise a um único “certo ou errado”.
A consolidação deverá responder:
Os documentos estão consistentes?
e, separadamente:
Existe algum contexto que merece atenção do analista?
12.13.3 Fonte da Verdade
A conclusão documental será construída a partir das evidências analisadas nas Subvalidações:
V-012.1 — Existência dos NCMs
V-012.2 — Correspondência dos NCMs
A V-012.3 — Verificação Contextual do Histórico deverá complementar a conclusão, mas não substituir automaticamente o resultado documental.
12.13.4 Regra Operacional
A Priora deverá consolidar a Família seguindo esta lógica:
V-012.1 — Existência
│
▼
V-012.2 — Correspondência
│
▼
Resultado documental
│
├───────────────┐
│               │
▼               ▼
V-012.3             Sem histórico
Histórico              relevante
│               │
▼               ▼
Contexto adicional   Sem ressalva
│               │
└───────┬───────┘
▼
V-012.4 Consolidação
12.13.5 Cenário 1 — Documentos Consistentes e Sem Contexto Relevante
MBL:
39269090
HBL:
39269090
Histórico:
Nenhuma evidência relevante relacionada ao NCM.
Resultado:
✔ NCM Consistente
Não existe ação necessária por parte do analista.
12.13.6 Cenário 2 — Documentos Consistentes com Atenção Contextual
MBL:
39269090
HBL:
39269090
Resultado documental:
✔ Consistente.
Entretanto:
14/08/2026 — Cliente solicitou inclusão do NCM 85044090.
Resultado consolidado:
✔ NCM documentalmente consistente
⚠ Atenção contextual identificada
A Priora deverá apresentar a evidência ao analista, sem classificar Master e House como divergentes.
Ações disponíveis:
[Confirmar documentos atuais]
[Verificar e-mail]
Quando aplicável:
[Solicitar correção]
12.13.7 Cenário 3 — Divergência Documental
MBL:
39269090
HBL:
39269099
Resultado:
⚠ Divergência de NCM
A divergência já existe objetivamente entre os documentos.
A existência ou não de histórico contextual poderá ajudar o analista a compreender a origem da diferença, mas não será necessária para confirmar que existe uma divergência documental.
12.13.8 Cenário 4 — NCM Ausente
MBL:
39269090
HBL:
Nenhum NCM identificado.
Resultado:
⚠ NCM ausente no HBL
A correspondência completa não poderá ser confirmada.
12.13.10 Cenário 6 — Documento Ausente
Caso um documento necessário para a validação não esteja disponível:
⏸ Não Avaliada
A ausência do documento não deverá ser tratada automaticamente como divergência.
A auditoria poderá continuar parcialmente quando permitido pelo Playbook.
12.13.11 Múltiplos NCMs
Quando existirem múltiplos códigos, a consolidação deverá considerar o conjunto completo.
Exemplo:
MBL
3926
8471
8504
HBL
39269090
84713012
85044090
Resultado:
✔ Consistente
porque todos os prefixos apresentados correspondem.
Divergência parcial
MBL:
3926
8471
8504
HBL:
39269090
84713012
9403
Resultado:
⚠ Divergência
A evidência deverá mostrar exatamente qual código não possui correspondência.
Exemplo:

| NCM Master | NCM House | Resultado |
| --- | --- | --- |
| 3926 | 39269090 | ✔ |
| 8471 | 84713012 | ✔ |
| 8504 | 9403 | ⚠ |

A Priora não deverá apenas informar “NCM divergente”.
Ela deverá mostrar onde está a divergência.
12.13.12 Separação entre Status Documental e Contextual
Internamente, a Priora deverá manter esses resultados separados.
Exemplo:
Document Status:
CONSISTENT
Context Status:
ATTENTION
A interface poderá consolidar visualmente essas informações, mas o sistema deverá preservar a diferença conceitual.
Isso permitirá posteriormente gerar métricas como:
47 validações documentais consistentes
3 divergências documentais
5 atenções contextuais
sem classificar uma atenção histórica como erro documental.
12.13.13 Exceções
NCMs em ordem diferente
Não representam divergência.
Diferentes níveis de detalhamento
São aceitos quando os dígitos apresentados forem compatíveis.
Exemplo:
3926
×
39269090
✔ Consistente.
Código adicional identificado no histórico
Não gera divergência automaticamente.
Gera atenção contextual quando houver evidência relevante.
Discussão antiga já solucionada
Não deverá permanecer como alerta ativo.
O evento continuará registrado para rastreabilidade.
Observação semântica entre descrição e NCM
Não deverá alterar o resultado da Família.
No futuro, a Priora poderá apresentar:
Observação informativa: possível incompatibilidade entre descrição da mercadoria e NCM.
Mas essa observação:
não gera divergência;
não bloqueia o processo;
não sugere outro NCM;
não substitui a classificação fiscal realizada pelo cliente.
Isso fica fora do MVP da validação principal.
12.13.14 Estados Possíveis
Para o resultado documental:
✔ Consistente
⚠ Divergência
👤 Validação Humana
⏸ Não Avaliada
Adicionalmente, poderá existir:
⚠ Atenção Contextual
A Atenção Contextual deverá coexistir com o status documental.
Exemplo:
✔ Consistente
⚠ Atenção Contextual
12.13.15 Criticidade
Crítica
O NCM é uma informação crítica para as etapas posteriores da operação e qualquer divergência confirmada deverá receber prioridade elevada de tratamento.
A presença de uma atenção contextual, entretanto, não significa automaticamente erro crítico. Ela indica que existe uma evidência que merece revisão.
12.13.16 Base Técnica da Validação

| Campo | Definição |
| --- | --- |
| Tipo de validação | Consolidação |
| Dependências | V-012.1, V-012.2 e V-012.3 |
| Regra principal | Rule Engine |
| Uso de IA | Nenhum na consolidação |
| Resultado documental | Independente do contexto histórico |
| Contexto histórico | Complementar |
| Atualização automática do POP | Somente quando regras permitirem |
| Criticidade | Crítica |

12.13.17 Critérios de Aceitação
A V-012.4 será considerada corretamente implementada quando conseguir:
consolidar existência, correspondência e contexto histórico;
preservar separação entre divergência documental e atenção contextual;
suportar múltiplos NCMs;
identificar exatamente quais códigos estão divergentes;
tratar corretamente códigos de 4, 6 e 8 dígitos;
não transformar alertas históricos em divergências automaticamente;
direcionar apenas situações necessárias ao analista;
produzir uma conclusão clara e rastreável.
12.13.18 Impacto nas Validações Dependentes
O resultado consolidado da Família V-012 poderá alimentar Playbooks posteriores, principalmente o CE Mercante.
Quando o NCM estiver:
✔ Consistente
O estado validado poderá ser reutilizado como evidência no processo.
✔ Consistente + ⚠ Atenção Contextual
O NCM permanece documentalmente consistente, porém existe uma pendência de revisão contextual antes que a informação seja considerada plenamente resolvida.
⚠ Divergente
A divergência deverá permanecer aberta até correção ou aceite justificado pelo analista.
👤 Validação Humana
A informação não deverá ser tratada como definitivamente validada até decisão humana.
Capítulo 13 — Família de Validação V-013 — Madeira / Wooden Packaging
13.1 Objetivo
A Família V-013 — Madeira / Wooden Packaging tem como objetivo verificar se as declarações relacionadas à presença e à condição de embalagens de madeira estão coerentes entre os documentos da operação.
A informação aparece normalmente na Description of Goods do MBL e do HBL, geralmente apresentada com destaque dentro da descrição.
A validação deverá identificar principalmente:
existência ou ausência de madeira;
madeira tratada;
madeira fumigada;
outras condições expressamente declaradas;
contradições entre Master e House;
evidências contextuais de possível alteração ou inconsistência.
13.2 Importância Operacional
Informações incorretas relacionadas à embalagem de madeira podem gerar riscos operacionais, fiscalização, necessidade de correção documental e possíveis custos ou penalidades.
Entretanto, a Priora não deverá determinar por conta própria quais exigências fitossanitárias se aplicam à mercadoria.
A responsabilidade da auditoria é verificar se a documentação representa corretamente aquilo que foi informado para a operação.
Quando uma informação necessária não tiver sido fornecida pelo cliente, a Priora deverá apenas preservar as evidências disponíveis, sem assumir automaticamente responsabilidade de qualquer participante.
Criticidade: Alta.
13.3 Escopo
A informação é tratada como característica da carga da operação, não como característica individual de cada contêiner.
Portanto:
A V-013 não executa validação de madeira por contêiner.
A Família considera principalmente:
MBL;
HBL.
Como fontes contextuais complementares poderão ser utilizados:
Packing List;
histórico de e-mails;
POP;
ETL.
Certificados de fumigação ou documentos fitossanitários não fazem parte da auditoria do Pré-Alerta neste Playbook.
13.4 Estrutura da Família

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-013.1 | Identificação da Condição de Madeira | Identificar a declaração existente em cada documento |
| V-013.2 | Correspondência da Condição | Verificar se Master e House representam a mesma condição |
| V-013.3 | Verificação Contextual | Identificar evidências externas que mereçam atenção |
| V-013.4 | Consistência Consolidada | Consolidar documentação e contexto |

13.5 Ordem de Execução
V-013.1
Identificação da condição
↓
V-013.2
Correspondência
↓
V-013.3
Verificação contextual
↓
V-013.4
Consolidação
V-013.1 — Identificação da Condição de Madeira
Objetivo
Identificar se cada documento declara:
ausência de madeira;
presença de madeira;
madeira tratada;
madeira fumigada;
outra condição reconhecida;
nenhuma informação.
Importância Operacional
Antes de comparar Master e House, a Priora precisa transformar diferentes formas de escrita em uma representação operacional comum.
Por exemplo:
NO WOODEN PACKAGING
e
NO WOOD PACKING
não devem ser tratados como informações diferentes apenas por variação textual.
Fonte da Verdade
Nesta etapa não existe Fonte da Verdade entre Master e House.
A Priora apenas identifica objetivamente o que cada documento declara.
Regra Operacional
A informação deverá ser extraída da descrição do MBL e do HBL e classificada em uma condição estruturada.
Exemplo:
Texto original:
NO WOODEN PACKAGING
↓
Condição:
SEM_MADEIRA
Outro:
Texto original:
WOODEN PACKING FUMIGATED
↓
Condição:
MADEIRA_FUMIGADA
Equivalências Semânticas
Variações textuais que possuam claramente o mesmo significado operacional poderão ser normalizadas.
Exemplo:
NO WOODEN PACKAGING
=
NO WOOD PACKING
=
WITHOUT WOODEN PACKAGING
Resultado:
SEM_MADEIRA
Da mesma forma:
FUMIGATED WOODEN PACKING
e
WOODEN PACKING FUMIGATED
podem representar:
MADEIRA_FUMIGADA
A normalização deverá seguir tabela de equivalências ou regra semântica controlada.
A IA não deverá criar livremente novos significados.
Caso ISPM-15
Por enquanto, a Priora não deverá assumir automaticamente:
ISPM-15
=
TREATED WOOD
até que essa equivalência operacional seja formalmente aprovada no playbook.
Quando essa situação aparecer sem regra cadastrada:
🟡 Confirmar equivalência da declaração de madeira
Depois que a operação confirmar a equivalência desejada, ela poderá ser adicionada à tabela e deixar de exigir análise humana.
Ausência de Declaração
A ausência de menção à madeira não representa automaticamente erro.
Em operações sem pallets, caixas ou outras embalagens de madeira, a informação pode simplesmente não aparecer.
Portanto:
MBL: sem menção
HBL: sem menção
não deverá gerar divergência automaticamente.
Possible States
🟢 Condição identificada
🟡 Condição ambígua
⚪ Não identificada / sem menção
Criticality
Alta
Technical Basis of Validation
Predominantemente determinística, utilizando:
extração textual;
tabela de equivalências;
classificação semântica controlada quando necessária.
Acceptance Criteria
A validação deverá:
identificar declarações de madeira;
reconhecer ausência de declaração;
normalizar variações equivalentes;
preservar texto original;
evitar inferência quando houver mais de uma interpretação possível.
Impact on Dependent Validations
O resultado alimenta diretamente a V-013.2 — Correspondência da Condição.
V-013.2 — Correspondência da Condição de Madeira
Objetivo
Verificar se MBL e HBL apresentam condições de embalagem de madeira operacionalmente compatíveis.
Importância Operacional
Master e House podem utilizar textos diferentes sem necessariamente estarem divergentes.
A Priora deverá comparar o significado operacional, e não simplesmente a igualdade das frases.
Fonte da Verdade
Nenhum dos documentos deverá ser automaticamente considerado superior nesta comparação.
A finalidade é detectar incompatibilidade documental.
Regra Operacional
Mesmo significado
MBL:
NO WOODEN PACKAGING
HBL:
NO WOOD PACKING
Resultado:
🟢 Consistente
Condições equivalentes cadastradas
MBL:
WOODEN PACKING FUMIGATED
HBL:
FUMIGATED WOODEN PACKAGING
Resultado:
🟢 Consistente
Contradição objetiva
MBL:
NO WOODEN PACKAGING
HBL:
WOODEN PACKING TREATED
Resultado:
🔴 Divergência
Existe uma contradição objetiva:
um documento declara ausência de madeira;
o outro declara presença de madeira.
Madeira declarada × silêncio
MBL:
WOODEN PACKING TREATED
HBL:
sem qualquer menção.
Resultado:
🔴 Inconsistência
Conforme a regra operacional definida, quando um documento declara existência de embalagem de madeira e o outro não apresenta a informação, a condição deverá ser tratada como inconsistente.
Sem madeira × silêncio
Quando um documento informa explicitamente ausência de madeira e o outro não possui menção, a Priora poderá aceitar a ausência como compatível desde que não exista evidência contrária no processo.
Exemplo:
MBL:
NO WOODEN PACKAGING
HBL:
sem menção.
Sem Packing List, e-mail ou outra evidência indicando madeira.
Resultado:
🟢 Sem contradição identificada
A ausência de texto, nesse cenário, não deverá criar um falso alerta.
Exceptions
Expressões como:
N/A
deverão ser interpretadas como:
Não aplicável
e não deverão, por si só, gerar divergência.
Possible States
🟢 Consistente
🟡 Validação Humana
🔴 Divergência
⚪ Não Avaliada
Criticality
Alta
Technical Basis of Validation
Tipo:
Semântica controlada + determinística
A IA poderá auxiliar na classificação da frase, mas a conclusão deverá utilizar estados previamente definidos.
Acceptance Criteria
A validação deverá:
aceitar variações textuais semanticamente equivalentes;
identificar contradições objetivas;
diferenciar silêncio documental de declaração explícita;
não comparar simplesmente strings.
Impact on Dependent Validations
Alimenta a V-013.4 e poderá receber contexto adicional da V-013.3.
V-013.3 — Verificação Contextual da Madeira
Essa aqui segue exatamente a lógica que fechamos no NCM.
Objetivo
Identificar no histórico ou em documentos complementares evidências relacionadas à embalagem de madeira que possam exigir atenção do analista, sem alterar automaticamente a conclusão documental.
Fontes Contextuais
Principalmente:
histórico de e-mails;
Packing List;
POP;
ETL.
Regra Operacional
Imagine:
MBL
NO WOODEN PACKAGING
HBL
NO WOODEN PACKAGING
Documentalmente:
🟢 Consistente.
Porém, Packing List:
20 WOODEN PALLETS
Resultado:
🟡 Consistente documentalmente — verificar contexto
Ou:
E-mail:
“Please change wooden packing to treated.”
Resultado:
🟡 Possível alteração relacionada à embalagem de madeira identificada no histórico
O que a Priora deverá apresentar
Exemplo:
🟡 Atenção contextual — Wooden Packaging
Master e House estão consistentes entre si.
Entretanto, foi encontrada uma possível informação relacionada à madeira:
Packing List: 20 WOODEN PALLETS
Verifique se a declaração existente no BL está correta.
Ações:
[Confirmar documentos atuais]
[Ver evidência]
[Solicitar correção]
Histórico de E-mail
A mesma lógica vale para mensagens como:
“Please add wooden packing information.”
“Cargo is packed on wooden pallets.”
“Please amend to fumigated wooden packing.”
Essas mensagens podem gerar:
🟡 Atenção Contextual
Não:
🔴 Divergência automática.
O analista continua responsável por determinar se aquela informação deveria efetivamente estar refletida nos documentos vigentes.
Informação Irrelevante
Uma simples ocorrência da palavra wood, sem relação clara com embalagem, alteração ou condição da carga, não deverá gerar alerta.
Possible States
Sem alerta
🟡 Atenção Contextual
👤 Validação Humana
Revisado pelo Analista
Correção Necessária
Criticality
Alta quando confirmada como relevante.
Technical Basis of Validation
Tipo:
Contextual / híbrida
IA apenas quando necessária para interpretar significado de uma mensagem ou expressão.
Context Builder deverá entregar somente trechos relacionados à madeira.
Acceptance Criteria
A Priora deverá:
encontrar contexto relevante;
ignorar menções irrelevantes;
não transformar Packing/e-mail em Fonte da Verdade absoluta;
mostrar a evidência diretamente ao analista;
preservar o resultado documental separado.
Impact on Dependent Validations
Pode adicionar atenção contextual à Família, mas não altera automaticamente a V-013.2.
V-013.4 — Consistência Consolidada da Madeira
Objetivo
Consolidar a condição documental e possíveis evidências contextuais em um resultado único para apresentação ao analista.
Regra Operacional
Cenário A
Master e House:
NO WOODEN PACKAGING
Sem contexto relevante.
🟢 Consistente
Cenário B
Master:
WOODEN PACKING FUMIGATED
House:
FUMIGATED WOODEN PACKAGING
🟢 Consistente
Cenário C
Master:
NO WOODEN PACKAGING
House:
WOODEN PACKING TREATED
🔴 Divergência
Cenário D
Master e House:
NO WOODEN PACKAGING
Packing List:
20 WOODEN PALLETS
🟡 Consistente documentalmente — verificar contexto
Cenário E
Master e House:
WOODEN PACKING TREATED
E-mail anterior:
“Please remove wooden packing declaration.”
🟡 Possível alteração identificada no histórico
Estados Finais
Documental:
🟢 Consistente
🔴 Divergência
🟡 Validação Humana
⚪ Não Avaliada
Contextual:
Sem atenção
🟡 Atenção Contextual
Revisado
Correção Necessária
Criticality
Alta
A Família não deverá ser tratada como crítica por padrão, conforme a operação definida.
Technical Basis of Validation

| Campo | Regra |
| --- | --- |
| Natureza | Semântica controlada + determinística |
| Fonte principal | MBL × HBL |
| Contexto complementar | Packing List + e-mails |
| Validação por container | Não |
| Certificado de fumigação | Fora do Pré-Alerta |
| Uso de IA | Apenas onde necessário |
| Altera documento automaticamente | Não |
| Criticidade | Alta |

Acceptance Criteria
A Família será considerada corretamente implementada quando conseguir:
identificar presença ou ausência de declaração de madeira;
distinguir estados como madeira tratada e fumigada;
reconhecer equivalências semânticas aprovadas;
detectar contradições entre Master e House;
utilizar Packing List e e-mails como contexto;
preservar separação entre divergência documental e atenção contextual;
evitar alertas quando nenhuma ação humana for necessária.
Capítulo 14 — Família de Validação V-014 — Navio / Voyage
14.1 Objetivo
A Família V-014 — Navio / Voyage tem como objetivo verificar se as informações de navio e, quando disponível, viagem estão coerentes entre o MBL e o HBL da operação.
A conferência é predominantemente documental e objetiva.
O foco principal é o navio de partida informado nos documentos.
Informações relacionadas a transbordos não fazem parte desta validação.
14.2 Importância Operacional
Navio e Voyage não representam, no Pré-Alerta, uma das informações de maior risco operacional.
Na prática, essas informações normalmente já chegam consistentes entre Master e House e raramente exigem intervenção do analista.
Ainda assim, quando houver diferença objetiva entre os documentos, a Priora deverá apontá-la.
Como não foi definida uma consequência operacional específica para esse erro, o Playbook não deverá associar automaticamente multas, bloqueios ou impactos que não estejam comprovados.
Criticidade: Baixa.
14.3 Escopo
A Família poderá analisar:
nome do navio;
número da viagem, quando presente.
A prioridade operacional é o nome do navio.
A Voyage deverá ser conferida quando estiver disponível nos documentos, mas sua ausência isolada poderá ser aceita.
Não fazem parte desta Família:
navios de transbordo;
feeder;
mother vessel;
tracking do armador;
programação externa do navio;
comparação com sistemas externos.
14.4 Estrutura da Família

| Código | Subvalidação | Objetivo |
| --- | --- | --- |
| V-014.1 | Correspondência do Navio | Comparar o navio informado no MBL e HBL |
| V-014.2 | Correspondência da Voyage | Comparar a viagem quando presente |
| V-014.3 | Verificação Contextual | Identificar possíveis alterações no histórico |
| V-014.4 | Consistência Consolidada | Consolidar o resultado da Família |

14.5 Ordem de Execução
V-014.1
Navio
↓
V-014.2
Voyage
↓
V-014.3
Contexto
↓
V-014.4
Consolidação
V-014.1 — Correspondência do Navio
Objetivo
Verificar se o navio informado no MBL corresponde ao navio informado no HBL.
Importância Operacional
Embora seja uma informação de baixa criticidade no Pré-Alerta, uma diferença objetiva entre os navios indica que os documentos não estão representando exatamente a mesma informação operacional.
Fonte da Verdade
Não existe, nesta Subvalidação, preferência automática entre MBL e HBL.
A validação busca identificar correspondência documental.
Regra Operacional
Quando ambos os documentos apresentarem o navio, os valores deverão corresponder após aplicação das Regras Globais de Leitura e Normalização.
Exemplo — Consistente
MBL:
MSC SEAVIEW
HBL:
MSC SEAVIEW
Resultado:
🟢 Consistente
Variação de escrita equivalente
MBL:
MSC SEAVIEW
HBL:
M/V MSC SEAVIEW
Resultado:
🟢 Consistente
O prefixo M/V, nesse contexto, não altera a identidade do navio.
Divergência
MBL:
MSC SEAVIEW
HBL:
MSC VIRTUOSA
Resultado:
🔴 Divergência de Navio
Mesmo possuindo baixa criticidade, trata-se de uma divergência objetiva entre os documentos.
Ausência da Informação
Caso um dos documentos não apresente navio, a ausência poderá ser aceita.
Exemplo:
MBL:
MSC SEAVIEW
HBL:
sem informação de navio.
Resultado:
⚪ Sem comparação completa
A ausência isolada não deverá gerar vermelho automaticamente.
Normalização
Poderão ser ignoradas diferenças que não alterem a identidade do navio, como:
caixa alta/baixa;
espaços excedentes;
prefixos equivalentes claramente acessórios, como M/V.
A Priora não deverá alterar nomes para forçar correspondência.
Estados Possíveis
🟢 Consistente
🔴 Divergência
🟡 Validação Humana, quando a identidade permanecer ambígua
⚪ Sem comparação completa
Criticidade
Baixa
Base Técnica

| Campo | Definição |
| --- | --- |
| Tipo | Determinística |
| Fonte | MBL × HBL |
| Uso de IA | Normalmente nenhum |
| Tracking externo | Não utilizado |
| Transbordo | Fora do escopo |
| Criticidade | Baixa |

Critérios de Aceitação
A Priora deverá:
identificar o navio nos documentos;
aceitar variações textuais equivalentes;
detectar navios objetivamente diferentes;
aceitar ausência isolada sem gerar falsa divergência;
não consultar fontes externas.
V-014.2 — Correspondência da Voyage
Objetivo
Verificar se o número da viagem informado no MBL corresponde ao informado no HBL, quando essa informação estiver disponível em ambos.
Regra Operacional
A Voyage possui importância secundária em relação ao navio.
Quando estiver presente nos dois documentos, deverá ser comparada.
Exemplo — Consistente
MBL:
432N
HBL:
432N
🟢 Consistente
Normalizações aceitas
Os seguintes formatos poderão ser considerados equivalentes quando representarem claramente a mesma Voyage:
432N
432 N
V.432N
Resultado:
🟢 Consistente
Divergência
MBL:
432N
HBL:
433N
Resultado:
🔴 Divergência de Voyage
A divergência deverá ser apresentada ao analista, porém permanece com criticidade baixa.
Voyage Ausente
Caso a Voyage não esteja presente em um ou ambos os documentos:
⚪ Sem comparação de Voyage
Isso não deverá impedir a validação do navio.
Criticidade
Baixa
Base Técnica
Predominantemente determinística, utilizando normalização textual simples antes da comparação.
Impacto nas Validações Dependentes
Uma divergência de Voyage deverá aparecer na consolidação, mas não transforma automaticamente a Família em um item de alta prioridade operacional.
V-014.3 — Verificação Contextual de Navio / Voyage
Objetivo
Identificar possíveis solicitações de alteração de Vessel ou Voyage existentes no histórico operacional que possam exigir atenção do analista.
Assim como no NCM e na Madeira, o histórico funciona como evidência contextual, e não como verdade absoluta.
Regra Operacional
Exemplo:
MBL:
MSC SEAVIEW / 432N
HBL:
MSC SEAVIEW / 432N
Resultado documental:
🟢 Consistente.
Porém, existe e-mail:
“Please amend vessel/voyage to MSC VIRTUOSA / 433N.”
Resultado visual:
🟡 Consistente documentalmente — verificar possível alteração
Ações:
[Confirmar documentos atuais]
[Verificar e-mail]
Quando aplicável:
[Solicitar correção]
Mudança Operacional de Navio
Alterações de navio podem ocorrer durante a operação, por exemplo em função de alterações de programação ou rollover.
A Priora não deverá interpretar automaticamente uma mudança identificada no histórico como erro documental.
Deverá apenas alertar quando houver evidência relevante de possível alteração ainda relacionada à documentação vigente.
Histórico Irrelevante
Menções antigas a navios que não constituam instrução, alteração ou informação relevante não deverão gerar atenção.
Fonte Contextual
histórico de e-mails;
ETL;
POP, quando aplicável.
Não utilizar:
tracking do armador;
sites externos;
programação marítima externa.
Estados
Sem alerta
🟡 Atenção Contextual
👤 Validação Humana
Revisado pelo Analista
Correção Necessária
Criticidade
Baixa
O contexto deverá ser mostrado sem competir visualmente com divergências críticas de outras Famílias.
V-014.4 — Consistência Consolidada de Navio / Voyage
Objetivo
Consolidar as validações de navio, Voyage e possíveis evidências contextuais em um único resultado operacional.
Cenário 1 — Tudo consistente
MBL:
MSC SEAVIEW / 432N
HBL:
MSC SEAVIEW / 432N
Sem contexto relevante.
🟢 Consistente
Cenário 2 — Variação textual
MBL:
MSC SEAVIEW / 432N
HBL:
M/V MSC SEAVIEW / V.432N
Após normalização:
🟢 Consistente
Cenário 3 — Navio divergente
MBL:
MSC SEAVIEW
HBL:
MSC VIRTUOSA
🔴 Divergência de Navio
Criticidade: Baixa.
Cenário 4 — Voyage divergente
MBL:
MSC SEAVIEW / 432N
HBL:
MSC SEAVIEW / 433N
🔴 Divergência de Voyage
Criticidade: Baixa.
Cenário 5 — Informação ausente
MBL:
MSC SEAVIEW
HBL:
sem Vessel/Voyage.
⚪ Comparação incompleta
Não gerar divergência apenas pela ausência.
Cenário 6 — Documentos consistentes com contexto
MBL:
MSC SEAVIEW / 432N
HBL:
MSC SEAVIEW / 432N
E-mail relevante:
“Please amend vessel to MSC VIRTUOSA.”
Resultado:
🟡 Consistente documentalmente — atenção contextual
Estados Finais
Documental:
🟢 Consistente
🔴 Divergência
🟡 Validação Humana
⚪ Comparação incompleta
Contextual:
Sem atenção
🟡 Atenção Contextual
Revisado
Correção Necessária
Criticidade
Baixa
Mesmo quando houver vermelho, sua prioridade operacional deverá permanecer inferior à de Famílias críticas como NCM, Peso ou outras informações com maior impacto.
Isso é importante: vermelho significa divergência objetiva, não necessariamente alta criticidade.
A prioridade da fila poderá considerar separadamente:
Estado: 🔴 Divergência
Criticidade: Baixa
em vez de tratar todo vermelho como urgência máxima.
Critérios de Aceitação
A Família V-014 será considerada corretamente implementada quando:
comparar corretamente o navio entre MBL e HBL;
comparar Voyage quando disponível;
aceitar variações simples de formatação;
não gerar divergência pela ausência isolada da informação;
não considerar transbordos inexistentes nos documentos;
não consultar tracking externo;
identificar alterações relevantes no histórico;
preservar separação entre divergência documental e atenção contextual;
manter criticidade baixa em toda a Família.
Capítulo 15 — Família de Validação V-015 — Frete e Valores Comerciais
15.1 Objetivo
A Família V-015 — Frete e Valores Comerciais tem como objetivo validar se os valores comerciais apresentados no MBL, HBL e Debit Note representam corretamente as condições negociadas para a operação.
A validação deverá considerar separadamente:
Buying Rate — valor de compra do frete;
Selling Rate — valor de venda do frete;
Margem Comercial;
THC e cobranças adicionais do HBL;
Profit Share da Debit Note;
modalidade de pagamento;
possíveis alterações ou exceções identificadas no histórico.
Esta Família não deverá assumir que Master e House devem possuir o mesmo valor de frete.
Eles representam papéis comerciais diferentes.
15.2 Importância Operacional
Frete e valores comerciais possuem impacto direto sobre a rentabilidade e a execução financeira da operação.
Uma inconsistência pode resultar em:
venda abaixo do custo;
perda de margem;
cobrança incorreta ao cliente;
pagamento incorreto ao agente;
ausência de pagamento devido ao armador;
impossibilidade de liberação da carga;
retrabalho documental e comercial.
Por esse motivo, a Família possui criticidade Alta, especialmente nas validações relacionadas ao HBL e à margem comercial.
15.3 Documentos da Família
A validação considera principalmente três documentos:
MBL
Representa o valor de compra do frete junto ao agente/armador.
HBL
Representa o valor comercial de frete a ser cobrado na operação.
Debit Note — DN
Representa os valores devidos ao agente, incluindo normalmente:
Ocean Freight;
Profit Share.
A DN é recebida normalmente no mesmo e-mail do Pré-Alerta juntamente com MBL e HBL. No exemplo fornecido, a DN apresenta USD 4.700 de Ocean Freight e USD 300 de Profit Share, totalizando USD 5.000.
15.4 Conceitos Comerciais
Buying Rate
É o valor de compra do Ocean Freight.
Sua principal referência deverá ser a negociação realizada com o agente no histórico do Pré-Alerta.
Selling Rate — SR
É o valor de venda informado pela Rocket ao agente para constar no House.
Normalmente surge após solicitação semelhante a:
“Could you please advise the SR?”
A resposta da Rocket determina o Selling Rate esperado do HBL.
Margem Comercial
A margem do frete será:
Selling Rate - Buying Rate
Exemplo:
Buying Rate:
USD 4.700
Selling Rate:
USD 5.300
Margem:
USD 600
Profit Share
É a parcela da margem do Ocean Freight destinada ao agente conforme o acordo comercial entre as empresas.
O Profit Share é calculado exclusivamente sobre o lucro do Ocean Freight.
Não deverão entrar nesse cálculo:
THC;
BAF;
taxas locais;
outras charges;
demais componentes comerciais.
15.5 Estrutura da Família

| Código | Subvalidação |
| --- | --- |
| V-015.1 | Buying Rate / MBL |
| V-015.2 | Selling Rate / HBL |
| V-015.3 | Margem Comercial |
| V-015.4 | THC e Outras Cobranças |
| V-015.5 | Modalidade de Pagamento |
| V-015.6 | Debit Note / Profit Share |
| V-015.7 | Verificação Contextual |
| V-015.8 | Consistência Consolidada |

V-015.1 — Buying Rate / MBL
Objetivo
Verificar se o Ocean Freight apresentado no MBL está compatível com o valor de compra negociado com o agente.
Fonte da Verdade
A principal Fonte da Verdade será o histórico da negociação do Pré-Alerta.
Exemplo:
Agente:
Ocean Freight USD 4.700
↓
MBL:
Ocean Freight USD 4.700
Resultado:
🟢 Consistente
Valor igual ou inferior
Caso o MBL apresente valor igual ou inferior ao acordado:
🟢 Aceitável
Exemplo:
Buying Rate negociado:
USD 4.700
MBL:
USD 4.600
A Priora poderá informar:
ℹ️ MBL USD 100 abaixo do Buying Rate negociado.
Sem gerar atenção.
Valor superior
Exemplo:
Buying Rate:
USD 4.700
MBL:
USD 4.900
Resultado padrão:
🟡 MBL acima do Buying Rate negociado — verificar
Ações:
[Verificar e-mail]
[Confirmar valor]
[Solicitar esclarecimento]
Valor superior eliminando margem
Se o aumento do Master fizer com que o Selling Rate não cubra mais o custo:
🔴 Prejuízo aparente
A criticidade operacional aumenta porque a operação passa a apresentar perda financeira.
V-015.2 — Selling Rate / HBL
Objetivo
Verificar se o Ocean Freight apresentado no HBL corresponde ao SR informado pela Rocket.
No exemplo enviado, o HBL apresenta Ocean Freight USD 5.300 Collect. SHYY26074590-OHBL.
Fonte da Verdade
O SR enviado pela Rocket ao agente.
Valor igual ao SR
SR:
USD 5.300
HBL:
USD 5.300
🟢 Consistente
HBL abaixo do SR
SR:
USD 5.300
HBL:
USD 5.100
🔴 Selling Rate abaixo do valor solicitado
Trata-se de divergência objetiva em relação à instrução comercial.
HBL acima do SR
SR:
USD 5.300
HBL:
USD 5.500
Embora comercialmente represente margem superior:
🟡 Selling Rate acima do solicitado — verificar
Isso pode gerar cobrança diferente daquela acordada com o cliente.
V-015.3 — Margem Comercial
Objetivo
Verificar a relação entre Buying Rate e Selling Rate.
Margem positiva
Master:
USD 4.700
House:
USD 5.300
🟢 Margem positiva
Margem zero
Master:
USD 5.000
House:
USD 5.000
🟡 Selling Rate sem margem aparente
Não é automaticamente erro documental, mas merece atenção comercial.
Margem negativa
Master:
USD 5.000
House:
USD 4.800
🔴 Selling Rate inferior ao Buying Rate — prejuízo aparente
Exceção comercial
Em situações específicas, a operação poderá trabalhar com Selling Rate inferior ao Buying Rate quando existir compensação comercial documentada.
Exemplos:
rebate;
compensação financeira;
condição comercial específica;
outra receita relacionada à operação.
Nesse cenário:
🟡 Margem negativa com possível exceção comercial — verificar justificativa
A Priora não deverá aceitar automaticamente a operação como correta.
Será necessária evidência clara.
Após confirmação humana:
✔ Exceção comercial aceita com justificativa.
A justificativa deverá permanecer registrada.
V-015.4 — THC e Outras Cobranças do HBL
Objetivo
Validar o THC e outras taxas que tenham sido expressamente solicitadas para constar no HBL.
THC
O THC normalmente deverá ser validado contra a instrução comercial enviada pela Rocket.
Exemplo:
E-mail:
Please show Destination THC USD 450
HBL:
THC USD 450
🟢 Consistente
THC divergente
Solicitado:
USD 450
HBL:
USD 350
🔴 Divergência
THC ausente
Caso tenha sido solicitado e não apareça:
🔴 THC solicitado não identificado
THC sem referência
Se o HBL apresentar THC, mas a Priora não localizar instrução suficientemente clara:
🟡 Confirmar THC
Outras Cobranças
Outras taxas poderão ser auditadas quando houver instrução explícita no processo.
Exemplos:
BAF;
NAK;
FAK;
outras charges.
A Priora não deverá assumir que toda cobrança existente no Master deve aparecer no House.
V-015.5 — Modalidade de Pagamento
Objetivo
Validar se condições como:
PREPAID;
COLLECT;
COLLECT ABROAD
estão de acordo com a instrução comercial da operação.
Regra Operacional
Não existe regra universal de que determinado frete deve ser Prepaid ou Collect.
A condição correta deverá ser determinada a partir do histórico e dos drafts.
Dentro da operação descrita, existe preferência:
1. Prepaid
2. Collect Abroad
3. Collect
mas essa preferência não deverá ser tratada como regra universal da plataforma.
Divergência
Se a instrução disser:
PREPAID
e o documento apresentar:
COLLECT
🔴 Divergência
quando houver evidência clara da condição acordada.
V-015.6 — Debit Note / Profit Share
Objetivo
Validar se o Ocean Freight e o Profit Share apresentados na DN são compatíveis com a estrutura comercial da operação.
Estrutura Esperada
A DN normalmente apresenta:
OCEAN FREIGHT
PROFIT SHARE
No exemplo real:
Ocean Freight:
USD 4.700
Profit Share:
USD 300
Total:
USD 5.000
SHYY26074590 DN.
Cálculo Interno da Priora
A Priora deverá reconstruir:
Profit Total
=
Selling Rate - Buying Rate
Depois:
Profit Share esperado
=
Profit Total × percentual do agente
Exemplo real:
Buying Rate:
4.700
Selling Rate:
5.300
Profit:
600
Parâmetro inicial:
50/50
Profit Share esperado:
300
DN:
300
🟢 Compatível
Parâmetro Inicial de Profit Share
Quando a Priora não possuir acordo específico registrado para aquele relacionamento comercial:
utilizar 50/50 como parâmetro inicial de cálculo.
Esse valor não deverá ser tratado como verdade absoluta.
Profit Share diferente do esperado
Exemplo:
Profit:
600
50/50 esperado:
300
DN:
360
Resultado:
🟡 Profit Share diferente do parâmetro utilizado
Mensagem:
Considerando divisão 50/50, o valor esperado seria USD 300. A DN apresenta USD 360. Confirme o acordo comercial aplicável.
Ações:
[Confirmar percentual]
[Verificar contexto]
Aprendizado do acordo
Se o analista informar:
Agente:
Aurora
Profit Share:
60% agente / 40% Rocket
esse relacionamento poderá ser salvo no POP.
Nas próximas operações com o mesmo agente, a Priora poderá utilizar esse parâmetro como referência inicial.
Profit Share inferior
Se a DN apresentar valor inferior ao esperado:
🟢 não deverá gerar amarelo automaticamente.
A Priora poderá apenas exibir:
ℹ️ Profit Share inferior ao parâmetro esperado.
Por representar condição financeiramente favorável à Rocket, não exige necessariamente intervenção.
V-015.7 — Verificação Contextual
Objetivo
Identificar alterações comerciais relevantes no histórico que possam modificar:
Buying Rate;
Selling Rate;
THC;
modalidade de pagamento;
outras charges;
Profit Share.
Exemplo
Documentos:
Master:
USD 4.700
House:
USD 5.300
Mas posteriormente:
“Please change SR to USD 5.500.”
Resultado:
🟡 Possível alteração de Selling Rate identificada no histórico
A Priora não altera automaticamente a conclusão.
Ela apresenta:
[Verificar e-mail]
[Confirmar documentos atuais]
[Solicitar correção]
V-015.8 — Consistência Consolidada
Cenário A — Operação normal
Buying:
4.700
Selling:
5.300
Profit:
600
Profit Share:
300
THC:
conforme instrução
Modalidade:
conforme instrução
🟢 Valores comerciais consistentes
Cenário B — Master acima do acordado, ainda com margem
🟡 Buying Rate acima do negociado — verificar
Cenário C — House igual ao Master
🟡 Margem zero — verificar condição comercial
Cenário D — House abaixo do Master
🔴 Prejuízo aparente
Salvo existência de exceção comercial claramente documentada.
Cenário E — House abaixo do Master com rebate documentado
🟡 Exceção comercial identificada — revisar justificativa
Após confirmação:
✔ Aceito com justificativa.
Cenário F — SR diferente do House
House abaixo:
🔴 Divergência
House acima:
🟡 Revisar valor
Cenário G — Profit Share incompatível
🟡 Confirmar acordo de Profit Share
Criticidade

| Item | Criticidade |
| --- | --- |
| Buying Rate | Alta |
| Selling Rate | Alta |
| Margem Comercial | Alta |
| THC | Alta |
| Modalidade de Pagamento | Alta |
| Profit Share / DN | Alta |

Regra Central da V-015
A Priora não deve comparar Master, House e DN como se representassem o mesmo valor. Cada documento representa uma função comercial distinta: o Master registra o custo, o House registra a venda e a DN registra o settlement com o agente. A auditoria deve validar a relação entre essas informações e as condições comerciais efetivamente acordadas.
Capítulo 16 — Regras Gerais e Casos Especiais do Pré-Alerta
16.1 Objetivo
Este capítulo estabelece as regras aplicáveis ao Playbook Pré-Alerta como um todo, independentemente da Família de Validação executada.
Seu objetivo é definir como a Priora deverá agir em situações como:
múltiplos Houses;
documentos ausentes;
versões diferentes do mesmo documento;
documentos substituídos;
auditorias parciais;
reprocessamento;
conflitos de classificação;
alterações posteriores à auditoria;
evidências contraditórias;
exceções aceitas pelo analista.
Essas regras não deverão ser repetidas individualmente em cada Família.
16.2 Princípio Fundamental
O Pré-Alerta representa uma fotografia auditável do estado documental da operação em determinado momento.
Portanto, a Priora deverá sempre ser capaz de responder:
Quais documentos foram analisados?
Quais versões foram utilizadas?
Quais evidências estavam disponíveis?
Quais conclusões foram emitidas?
Quem confirmou ou alterou alguma decisão?
O que mudou depois?
16.3 Múltiplos Houses
A existência de múltiplos HBLs dentro de um mesmo Master é uma situação normal da operação e deverá ser suportada nativamente pelo Playbook.
Exemplo:
Processo
OMBL
│
├── HBL 01
├── HBL 02
└── HBL 03
A Priora não deverá tratar múltiplos Houses como exceção ou anomalia.
16.3.1 Relação Master × Houses
Cada House deverá ser validado individualmente contra o Master apenas nas informações que realmente possuam relação operacional.
Exemplo:
Master
Container A
Container B
Container C
↓
House 01 → Container A
House 02 → Container B
House 03 → Container C
A Priora deverá preservar essas relações.
Não deverá comparar indiscriminadamente todos os campos de todos os Houses contra todos os campos do Master.
16.4 Consolidação de Valores em Múltiplos Houses
Algumas Famílias possuem lógica consolidada.
Exemplos:
Peso
HBL 01 = 5.000 KG
HBL 02 = 7.000 KG
HBL 03 = 8.000 KG
Total Houses = 20.000 KG
Master = 20.000 KG
🟢 Consistente.
Cubagem
Mesma lógica quando aplicável.
Frete
Não deverá utilizar automaticamente soma House → Master como regra documental simples.
A relação comercial deverá respeitar:
Buying Rate;
Selling Rate;
quantidade de containers;
estrutura comercial da operação.
Cada Família define sua própria lógica.
16.5 Documento Ausente
A ausência de um documento necessário não deverá gerar automaticamente uma divergência documental.
Exemplo:
MBL disponível
HBL ausente
Resultado:
⚪ Auditoria parcial — HBL não disponível
As validações que dependem diretamente do HBL deverão ficar:
⚪ Não Avaliadas.
Entretanto, validações que possam ser executadas apenas com os documentos existentes poderão continuar.
16.6 Auditoria Parcial
A Priora deverá permitir auditorias parciais.
Um Playbook não deverá ser interrompido completamente apenas porque uma determinada evidência está ausente.
Exemplo:
Containers       ⚪ Não Avaliado
Peso             🟢 Consistente
NCM              🟢 Consistente
Frete            🟡 Atenção
Participantes    🟢 Consistente
Resultado:
Auditoria parcialmente concluída
A interface deverá deixar claro quais partes não puderam ser analisadas.
16.7 Versões Documentais
Um mesmo documento poderá possuir várias versões durante o Pré-Alerta.
Exemplo:
HBL Draft v1
↓
Correção solicitada
↓
HBL Draft v2
↓
Correção
↓
HBL Final
Todas as versões relevantes deverão permanecer registradas.
Entretanto, apenas uma versão deverá ser considerada vigente para cada etapa da auditoria.
16.8 Determinação da Versão Vigente
Quando existirem múltiplas versões, a Priora deverá utilizar evidências objetivas para determinar qual delas representa o estado atual.
Como critérios auxiliares poderão ser utilizados:
posição cronológica na thread de e-mail;
data de recebimento;
indicação explícita de versão;
confirmação do analista;
informação interna do documento.
A data impressa dentro do PDF não deverá ser utilizada isoladamente como principal critério quando existir evidência de recebimento posterior.
16.9 Ambiguidade de Versão
Caso a Priora não consiga determinar com segurança qual documento é o vigente:
🟡 Confirmar versão documental
O sistema deverá apresentar as versões encontradas.
Exemplo:
Foram encontrados dois HBLs possivelmente vigentes.
HBL A
Recebido: 14:32
HBL B
Recebido: 14:48
Ações:
[Usar versão A]
[Usar versão B]
[Ver e-mail]
A Priora não deverá escolher arbitrariamente.
16.10 Documento Substituído
Quando uma nova versão for confirmada como substituta:
HBL v1
STATUS: SUPERSEDED
HBL v2
STATUS: CURRENT
A versão anterior continua preservada para rastreabilidade, mas deixa de participar das validações vigentes.
16.11 Reprocessamento Automático
Quando uma nova versão documental for recebida, a Priora não deverá necessariamente executar novamente o Playbook inteiro.
O sistema deverá identificar quais informações foram alteradas.
Exemplo:
Novo HBL recebido
Mudanças identificadas:
NCM
THC
Nesse caso, deverão ser reprocessadas prioritariamente as validações dependentes desses objetos.
Outras validações já confirmadas poderão permanecer válidas quando nenhuma evidência relevante tiver sido alterada.
16.12 Resultado Anterior Não Deve Ser Apagado
Reprocessar uma validação não significa apagar o resultado anterior.
Exemplo:
14/08 — 10:32
NCM
🔴 Divergente
↓
Correção solicitada
↓
14/08 — 15:48
Novo HBL recebido
↓
NCM
🟢 Consistente
A Priora deverá preservar a sequência completa.
Isso permite posteriormente saber:
quando o erro surgiu;
quando foi identificado;
quando foi corrigido;
qual versão documental resolveu o problema.
16.13 Conflito de Classificação Documental
A Priora poderá identificar um documento pelo nome do arquivo como HBL, mas seu conteúdo indicar outra classificação.
Exemplo:
Arquivo:
HBL_FINAL.pdf
Conteúdo:
Master Bill of Lading
Nesse caso:
🟡 Classificação documental incerta
A Priora não deverá forçar a classificação pelo nome do arquivo.
O analista poderá confirmar:
[Master]
[House]
[Outro Documento]
A classificação confirmada deverá persistir.
16.14 Classificação Manual Persistente
Uma classificação corrigida manualmente não deverá ser perdida em reprocessamentos futuros.
Se o analista confirmar:
Documento X = HBL
essa decisão deverá permanecer associada àquela versão documental.
16.15 Evidências Contraditórias
Quando duas fontes confiáveis indicarem informações diferentes e nenhuma regra objetiva determinar qual possui precedência:
🟡 Validação Humana
Exemplo:
E-mail A:
SR = USD 5.300
E-mail posterior:
SR = USD 5.500
Mas não existe evidência clara
de qual instrução foi efetivamente aprovada.
A Priora não deverá escolher o valor que “parece mais provável”.
16.16 Contexto Histórico Não Substitui Documento Automaticamente
Essa regra global deverá valer para todo o Pré-Alerta.
O histórico contextualiza a auditoria documental, mas não substitui automaticamente o estado dos documentos.
Exemplo:
MBL × HBL
🟢 Consistentes
+
possível alteração antiga no e-mail
↓
🟡 Atenção Contextual
Não:
E-mail diferente
=
documento automaticamente errado
16.17 Aceite com Justificativa
Nem toda divergência precisa necessariamente resultar em correção documental.
Em determinadas situações, o analista poderá concluir que a condição é aceitável.
A ação deverá ser:
Aceitar com justificativa
Nunca simplesmente:
“Ignorar”.
Registro obrigatório
O aceite deverá armazenar:
usuário;
data e hora;
validação;
divergência original;
justificativa;
documentos analisados;
evidências relacionadas.
Exemplo:
Selling Rate abaixo do Buying Rate
🔴 Prejuízo aparente
↓
Analista:
Aceitar com justificativa
Motivo:
Operação possui rebate comercial
confirmado pelo gestor.
Resultado:
✔ Aceito com justificativa
A divergência original permanece no histórico.
16.18 Estados de uma Pendência
Uma divergência ou atenção poderá evoluir através dos seguintes estados:
Pendente
↓
Confirmado pelo Analista
↓
Correção Solicitada
↓
Aguardando Retorno
↓
┌───────────────┐
▼               ▼
Corrigido     Aceito com
Justificativa
Esses estados pertencem à gestão operacional da evidência e não deverão ser confundidos com o resultado original da validação.
16.19 Solicitar Correção
Quando o analista determinar que uma divergência precisa ser corrigida, poderá acionar:
Solicitar correção
A partir desse momento:
Issue:
Correction Requested
A Priora poderá auxiliar na geração do e-mail correspondente.
A Clara deverá sugerir o texto.
Ela não deverá enviar automaticamente sem ação explícita do usuário.
16.20 Documento Corrigido
Quando uma nova versão chegar e a validação anteriormente divergente passar:
🔴 Divergência
↓
Nova versão
↓
🟢 Consistente
a pendência poderá assumir:
Corrigido
A Priora deverá vincular:
divergência original;
solicitação;
nova versão;
resultado corrigido.
16.21 Alteração Após Auditoria Confirmada
Uma auditoria confirmada representa apenas o estado existente naquele momento.
Se novos documentos forem recebidos posteriormente:
a auditoria anterior não deverá ser modificada.
Deverá ser criada uma nova execução ou atualização versionada.
Exemplo:
Audit #1
15/08 — 14:00
CONFIRMED
↓
Novo HBL recebido
15/08 — 17:20
↓
Audit #2
REPROCESSING
Isso mantém integridade histórica.
16.22 Confirmação da Auditoria
Ao selecionar Confirmar Auditoria, a Priora deverá registrar um snapshot contendo:
usuário;
data e hora;
Playbook;
documentos utilizados;
versões utilizadas;
resultados de cada Família;
atenções contextuais;
divergências abertas;
validações humanas;
itens não avaliados.
Confirmar uma auditoria não significa que tudo está correto.
Significa:
O analista reconhece que aquele é o estado da auditoria naquele momento.
Isso permite confirmar uma auditoria contendo:
🟢 34 consistentes
🟡 3 atenções
🔴 2 divergências
⚪ 1 não avaliado
sem apagar ou resolver essas pendências.
16.23 Evidência Visual
Sempre que uma divergência for apresentada, a Priora deverá mostrar os valores utilizados na decisão.
Não apenas:
🔴 Peso divergente
Mas:

| Documento | Valor |
| --- | --- |
| MBL | 20.000 KG |
| HBL | 19.850 KG |

Diferença: 150 KG
Da mesma forma:

| Documento | NCM |
| --- | --- |
| MBL | 39269090 |
| HBL | 39269099 |

A explicabilidade deverá estar baseada em evidências visíveis, não em justificativas genéricas da IA.
16.24 Navegação para Evidência
Sempre que possível, o analista deverá poder acessar diretamente a origem da informação.
Exemplos:
[Ver no MBL]
[Ver no HBL]
[Ver e-mail]
[Ver DN]
[Ver Packing List]
Idealmente, o visualizador deverá abrir diretamente na página ou região relevante.
16.25 Regra de Não Repetição
Uma mesma inconsistência não deverá aparecer várias vezes como se fossem problemas independentes.
Exemplo:
Se Peso Bruto divergente causa:
divergência no valor total;
divergência na consolidação;
a interface poderá apresentar a Família como problemática, mas o analista deverá conseguir perceber que existe uma origem principal, e não dois erros distintos artificialmente criados.
16.26 Prioridade Operacional
A prioridade de tratamento deverá considerar pelo menos:
Estado Visual
+
Criticidade
+
Contexto Operacional
Exemplo:
NCM
🔴 Divergência
Criticidade: Crítica
prioridade muito alta.
Voyage
🔴 Divergência
Criticidade: Baixa
prioridade inferior.
Isso evita tratar todos os vermelhos como igualmente urgentes.
16.27 Critério de Conclusão do Pré-Alerta
O Playbook poderá ser tecnicamente concluído mesmo contendo pendências.
O resultado deverá distinguir:
Concluído sem pendências
Todas as validações aplicáveis estão resolvidas.
Concluído com atenções
Existem itens amarelos ainda pendentes.
Concluído com divergências
Existem divergências abertas.
Parcialmente concluído
Existem validações que não puderam ser executadas.
Essa diferenciação é mais fiel do que simplesmente:
“Aprovado / Reprovado”.
16.28 Regra Central do Capítulo
A Priora deverá preservar a evolução da auditoria, nunca apenas seu resultado final. Documentos mudam, decisões são revistas e divergências podem ser aceitas ou corrigidas. Cada mudança deverá permanecer rastreável sem destruir o estado anterior.
Capítulo 17 — Consolidação e Encerramento do Pré-Alerta
17.1 Objetivo
Este capítulo define como a Priora deverá consolidar os resultados de todas as Famílias de Validação do Playbook Pré-Alerta e apresentar uma conclusão operacional única ao analista.
O encerramento do Playbook não deverá reduzir a auditoria a um simples:
Aprovado / Reprovado.
A Priora deverá preservar:
consistências;
atenções contextuais;
divergências;
validações humanas;
itens não avaliados;
pendências abertas;
exceções aceitas;
histórico de correções.
17.2 Princípio Fundamental
O objetivo da consolidação é responder:
“O que exige atenção agora?”
A Priora deverá esconder complexidade onde não houver necessidade de intervenção e destacar somente aquilo que realmente exige ação do analista.
17.3 Hierarquia de Consolidação
A consolidação ocorrerá em quatro níveis:
Evidência / Campo
↓
Subvalidação
↓
Família
↓
Playbook
Cada nível deverá preservar a origem do resultado.
A Priora nunca deverá apresentar uma conclusão global sem permitir que o analista navegue até a evidência que a originou.
17.4 Consolidação de uma Subvalidação
Uma Subvalidação poderá assumir:
🟢 Consistente;
🟡 Atenção;
🔴 Divergência;
⚪ Não Avaliada.
Quando existirem várias evidências dentro da mesma Subvalidação, a condição de maior atenção deverá ser refletida visualmente.
Exemplo:
Peso por Container
Container A    🟢
Container B    🟢
Container C    🔴
↓
Subvalidação:
🔴 Divergência
17.5 Consolidação de uma Família
Cada Família deverá apresentar:
estado visual;
criticidade;
quantidade de evidências;
quantidade de atenções;
quantidade de divergências;
pendências abertas.
Exemplo:
V-012 — NCM
Status documental: 🟢 Consistente
Contexto: 🟡 Atenção histórica
Criticidade: Crítica
3 códigos analisados
0 divergências documentais
1 atenção contextual
O resultado consolidado da Família poderá aparecer visualmente como:
🟡 NCM — Atenção contextual
sem perder internamente o fato de que a documentação está consistente.
17.6 Consolidação do Playbook
Ao finalizar a execução, a Priora deverá gerar um resumo geral.
Exemplo:
PRÉ-ALERTA
🟢 11 Famílias consistentes
🟡 2 Famílias com atenção
🔴 1 Família com divergência
⚪ 1 Família parcialmente avaliada
Abaixo:
Containers              🟢
Volumes                 🟢
Peso Bruto              🟢
Peso Líquido            🟢
Cubagem                 🟢
Lacres                  🟢
Portos                  🔴
Participantes           🟢
Mercadoria              🟢
NCM                     🟡
Madeira                 🟢
Navio / Voyage          🟢
Valores Comerciais      🟡
A prioridade visual deverá direcionar o analista primeiro para:
🔴 divergências;
🟡 atenções;
⚪ itens não avaliados;
🟢 itens resolvidos.
17.7 Estado Global do Pré-Alerta
O Playbook poderá assumir quatro estados principais.
Concluído sem Pendências
Todas as validações aplicáveis foram executadas e não existem atenções ou divergências abertas.
🟢 Pré-Alerta concluído
Concluído com Atenções
Não existem divergências objetivas abertas, mas existem itens que ainda merecem revisão humana.
🟡 Pré-Alerta concluído com atenções
Concluído com Divergências
Existe pelo menos uma divergência objetiva ainda aberta.
🔴 Pré-Alerta concluído com divergências
Parcialmente Concluído
Uma ou mais validações não puderam ser executadas por ausência de evidência, documento ou condição necessária.
⚪ Pré-Alerta parcialmente concluído
17.8 Criticidade Global
O estado visual não deverá ser utilizado isoladamente para determinar a prioridade operacional.
A Priora deverá considerar também a criticidade.
Exemplo:
🔴 NCM
Criticidade: Crítica
🔴 Voyage
Criticidade: Baixa
Embora ambos estejam vermelhos, o NCM deverá aparecer acima na fila de atenção.
17.9 Ordenação da Fila de Atenção
Eu usaria como princípio:
Estado
+
Criticidade
+
Pendência operacional
+
Recência / prazo
Exemplo:
Prioridade 1
🔴 NCM divergente
Criticidade: Crítica
Prioridade 2
🔴 Selling Rate abaixo do Buying Rate
Criticidade: Alta
Prioridade 3
🟡 Alteração de THC encontrada no histórico
Criticidade: Alta
Prioridade 4
🔴 Voyage divergente
Criticidade: Baixa
Isso é mais inteligente do que simplesmente agrupar tudo por cor.
17.10 Tela de Resultado
A tela final deverá ser simples.
Eu imagino algo assim:
PROCESSO IM-24581
PRÉ-ALERTA
──────────────────────────────
🔴 2 divergências
🟡 3 atenções
⚪ 1 não avaliado
──────────────────────────────
EXIGE AÇÃO
🔴 NCM
MBL: 39269090
HBL: 39269099
[Ver evidência]
[Solicitar correção]
[Aceitar com justificativa]
🟡 Valores Comerciais
Buying Rate: USD 4.700
Selling Rate: USD 4.700
Margem aparente: USD 0
[Verificar]
[Ver e-mail]
🟡 Madeira
Documentos consistentes,
mas Packing List menciona
WOODEN PALLETS.
[Ver evidência]
[Confirmar]
E só depois viriam os verdes.
17.11 Área de Itens Consistentes
Os itens verdes deverão permanecer disponíveis, mas visualmente recolhidos.
Exemplo:
✔ 38 validações consistentes
[Ver detalhes]
O analista não precisa ler 38 confirmações de que está tudo certo.
Esse é um ponto central da proposta da Priora.
17.12 Evidência de Divergência
Toda divergência deverá apresentar:
campo;
documento A;
valor A;
documento B ou Fonte da Verdade;
valor B;
criticidade;
motivo objetivo;
acesso às evidências.
Exemplo:

| Campo | MBL | HBL |
| --- | --- | --- |
| NCM | 39269090 | 39269099 |

🔴 Divergência crítica
A explicação não deverá ser:
“A IA detectou inconsistência.”
Deverá ser:
“Os códigos apresentados nos documentos diferem nos dois últimos dígitos.”
17.13 Atenções Contextuais
Atenções contextuais deverão aparecer separadas das divergências documentais.
Exemplo:
🟡 NCM documentalmente consistente
Foi encontrada solicitação de inclusão de outro NCM no e-mail de 14/08/2026.
Isso impede que o analista confunda:
“há uma evidência para verificar”
com:
“os documentos estão errados”.
17.14 Ações Disponíveis
Dependendo do estado da evidência, poderão estar disponíveis:
Para divergência
Ver evidência;
Solicitar correção;
Aceitar com justificativa.
Para atenção contextual
Verificar e-mail;
Confirmar documentos atuais;
Solicitar correção.
Para validação humana
Confirmar valor;
Selecionar interpretação;
Adicionar justificativa.
Para item não avaliado
Adicionar documento;
Classificar documento;
Reprocessar.
17.15 Clara — Resumo Operacional
A Clara deverá apresentar um resumo curto e orientado à ação.
Exemplo:
Pré-Alerta analisado.
Encontrei 2 divergências e 3 pontos de atenção.
O item mais crítico é uma divergência de NCM entre Master e House.
Também encontrei Selling Rate sem margem aparente e uma possível alteração de THC no histórico.
A Clara não deverá repetir dezenas de campos consistentes.
17.16 Clara — Geração de E-mail
Quando existirem divergências que precisem ser encaminhadas ao mesmo responsável, a Priora poderá gerar um rascunho consolidado.
Exemplo:
Dear Agent,
Please kindly check the following points:
NCM on HBL differs from MBL;
Destination THC differs from our previous instruction;
Please confirm the vessel information.
Thank you.
O e-mail deverá ser apenas sugerido.
Nenhuma mensagem deverá ser enviada automaticamente sem ação explícita do usuário.
17.17 Agrupamento por Responsável
Quando os problemas pertencerem a responsáveis diferentes, a Priora não deverá gerar um único e-mail indiscriminadamente.
Exemplo:
Problemas do agente
→ 1 draft
Problema do cliente
→ outro draft
Isso evita encaminhar informações ao destinatário errado.
17.18 Confirmar Auditoria
Ao selecionar:
Confirmar Auditoria
a Priora deverá registrar um snapshot do estado atual.
O snapshot deverá incluir:
processo;
Playbook;
usuário;
data e hora;
documentos;
versões;
resultados;
divergências;
atenções;
decisões humanas;
itens não avaliados.
17.19 Confirmação Não Significa Aprovação
Essa regra deverá ficar explícita.
Confirmar Auditoria não significa confirmar que todos os documentos estão corretos.
Significa apenas:
O analista confirma que revisou e reconhece o estado apresentado naquele momento.
Uma auditoria pode ser confirmada contendo:
divergências;
atenções;
pendências;
itens parcialmente avaliados.
17.20 Reabertura e Nova Versão
Se um novo documento for recebido após a confirmação:
Audit #1
CONFIRMED
↓
Novo HBL recebido
↓
Audit #2
UPDATED / REPROCESSING
A auditoria anterior permanece imutável.
A Priora cria uma nova versão de análise.
17.21 Encerramento de Pendências
Uma pendência poderá ser encerrada por:
Correção
Nova documentação resolve a divergência.
Aceite com Justificativa
O analista ou gestor aceita conscientemente a condição.
Confirmação Contextual
Uma atenção amarela é revisada e considerada resolvida.
Nenhuma dessas ações deverá apagar o histórico original.
17.22 Critério de Playbook Resolvido
O Pré-Alerta poderá ser considerado operacionalmente resolvido quando:
não existirem divergências pendentes;
não existirem atenções que exijam decisão;
validações humanas obrigatórias estiverem concluídas;
itens não avaliados relevantes tiverem sido tratados ou aceitos com justificativa.
Isso é diferente de simplesmente ter executado o Playbook.
17.23 Saída para Playbooks Dependentes
Quando o Pré-Alerta estiver suficientemente validado, seus resultados poderão alimentar Playbooks posteriores.
Principalmente:
CE Mercante
A Priora deverá reutilizar:
containers;
pesos;
cubagem;
NCM;
participantes;
portos;
demais informações consolidadas.
Isso evita executar novamente todo o trabalho de descoberta.
17.24 Resultado Operacional
Ao final, o Pré-Alerta deverá produzir:
estado documental consolidado;
evidências estruturadas;
divergências abertas;
atenções contextuais;
decisões humanas;
POP atualizado quando aplicável;
eventos registrados na ETL;
base confiável para o próximo Playbook.
17.25 Regra Central do Encerramento
A Priora não deve transformar uma auditoria complexa em uma tela complexa. Toda a complexidade deve existir por trás da interface para que o analista veja apenas aquilo que exige ação.