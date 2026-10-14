import { Client, Pool } from 'pg';
import { getPool } from '../db/pool';
import { CONTRATO_REGISTRO_DEMURRAGE_V1, ErroContratoDemurrage, RegistroProcessoDemurrageV1 } from '../registro/contrato';
import { PosCommitIncompletoError, ResultadoRegistroDemurrage, registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { reaplicarIntencoesShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';
import { EntradaHandoffNormalizada, ErroContratoHandoff, validarEntradaHandoff } from './contrato';
import { CodigoFalhaHandoff, classificarFalhaHandoff } from './erros';

/**
 * Produção P1 (Entrega 1, corretiva v1.1) — serviço de aplicação
 * COMPARTILHADO do handoff.
 *
 * Duas camadas de idempotência/identidade, cada uma com a SUA PRÓPRIA
 * garantia de banco, nunca só de aplicação:
 *
 *  CAMADA A (`demurrage_handoff_eventos`) — identidade do EVENTO a montante,
 *  por (organização, sistema, origemEventoId) — mas a identidade
 *  IMUTÁVEL do evento é o conjunto {organização, sistema, origemEventoId,
 *  origemProcessoId} (achado #2 da auditoria v1.1 — ver `verificarIdentidadeEvento`
 *  abaixo): comparar só o hash do payload de negócio deixaria passar como
 *  replay uma redelivery do MESMO evento com um `origemProcessoId`
 *  DIFERENTE, porque `origemProcessoId` fica deliberadamente FORA do hash
 *  (ver `contrato.ts`). A proteção de banco já existia desde a migration
 *  0040 (`forbid_handoff_evento_identidade_change` já cobre
 *  `origem_processo_id`) — o que faltava era a APLICAÇÃO comparar os dois
 *  campos antes de decidir "é replay".
 *
 *  CAMADA DE VÍNCULO (`demurrage_handoff_processo_links`, nova na v1.1) —
 *  identidade ESTÁVEL do PROCESSO a montante, por (organização, sistema,
 *  origemProcessoId) -> processo_id. Resolvida e AFIRMADA antes de chamar
 *  o D10 (achado #1 da auditoria v1.1 — ver `resolverVinculoProcesso`
 *  abaixo): o D10 nunca aprende sobre esse vínculo — a camada de handoff
 *  resolve/estabelece o vínculo e só então invoca o contrato `registro.v1`
 *  com o `numeroProcesso` já conferido contra o vínculo.
 *
 *  CAMADA B (`demurrage_registros`, D10, já existente e congelada) —
 *  identidade do PAYLOAD normalizado, por `chaveIdempotencia`, derivada
 *  deterministicamente de `(origemSistema, origemEventoId)`. Esta chamada
 *  herda DE GRAÇA todas as garantias de concorrência já provadas do D10:
 *  lock consultivo por processo/contêiner, `INSERT ... ON CONFLICT DO
 *  NOTHING`, `CHAVE_IDEMPOTENCIA_REUTILIZADA` como segunda linha de defesa.
 *
 * Replay de um evento JÁ CONCLUÍDO com sucesso é uma LEITURA PURA do
 * retrato persistido (`resposta_aplicada`, migration 0041) — nunca chama o
 * D10 de novo. A auditoria v1.1 (relatório §6) provou que reconstruir a
 * resposta chamando `registrarProcessoDemurrage` de novo NÃO é
 * garantidamente livre de escrita: o reparo pós-commit do outbox (D10
 * v1.1) roda incondicional a cada chamada e pode gravar em
 * `demurrage_pos_commit_outbox`/`snapshots`/`valores_apurados` mesmo para
 * um evento do handoff já concluído como `ACEITO_COM_PENDENCIA`.
 */

export const CREDENCIAL_IDENTIDADE_INTERNA = 'interno:confiavel' as const;

export interface ContextoHandoff {
  /** SEMPRE resolvido pelo chamador autenticado — nunca lido do corpo/query/headers da requisição. */
  organizationId: string;
  /** UUID da credencial HTTP autenticada, ou `CREDENCIAL_IDENTIDADE_INTERNA` para chamadas in-process confiáveis. */
  credencialIdentidade: string;
}

interface ContainerRespostaHandoff { numero: string; containerId: string; criado: boolean }

/** Retrato de uma aplicação bem-sucedida — é exatamente este objeto que é persistido em `resposta_aplicada` e devolvido num replay futuro, sem tocar o D10. */
export interface RespostaHandoffAplicada {
  resultado: 'APLICADO' | 'REPLAY_IDEMPOTENTE' | 'ACEITO_COM_PENDENCIA';
  eventoId: string;
  processoId: string;
  numeroProcesso: string;
  processoCriado: boolean;
  containers: ContainerRespostaHandoff[];
  pendenciasAbertas: Array<{ tipo: string; containerNumero: string | null }>;
}

export type RespostaHandoff =
  | RespostaHandoffAplicada
  | { resultado: 'EXIGE_REABERTURA'; eventoId: string; numeroProcesso: string; processoId: string | null }
  | { resultado: 'CONFLITO_EVENTO'; eventoId: string | null; detalhe: Record<string, unknown> }
  | { resultado: 'CONTRATO_INVALIDO'; detalhe: Record<string, unknown> }
  | { resultado: 'FALHA'; eventoId: string | null; detalhe: { motivo: CodigoFalhaHandoff } };

interface LinhaEventoExistente {
  id: string;
  origemProcessoId: string;
  payloadHash: string;
  resultado: string | null;
  concluidoEm: Date | null;
  processoId: string | null;
  respostaAplicada: RespostaHandoffAplicada | null;
}

/**
 * Registra a identidade do evento (camada A) se for a PRIMEIRA entrega, ou
 * devolve a linha já existente (vencedora da corrida de `INSERT ... ON
 * CONFLICT DO NOTHING`). Nunca lança por conflito — quem chama decide o que
 * fazer com a identidade/hash divergentes.
 */
async function registrarOuRecuperarEvento(
  pool: Pool, ctx: ContextoHandoff, norm: EntradaHandoffNormalizada,
): Promise<{ linha: LinhaEventoExistente; criadaAgora: boolean }> {
  const ins = await pool.query(
    `INSERT INTO demurrage_handoff_eventos
       (organization_id, credencial_identidade, origem_sistema, origem_processo_id, origem_evento_id, origem_ocorrido_em, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, origem_sistema, origem_evento_id) DO NOTHING
     RETURNING id, origem_processo_id AS "origemProcessoId", payload_hash AS "payloadHash", resultado,
               concluido_em AS "concluidoEm", processo_id AS "processoId", resposta_aplicada AS "respostaAplicada"`,
    [ctx.organizationId, ctx.credencialIdentidade, norm.origemSistema, norm.origemProcessoId, norm.origemEventoId, norm.origemOcorridoEm, norm.payloadHash],
  );
  if (ins.rows.length) return { linha: ins.rows[0], criadaAgora: true };
  // Nota sobre `origemOcorridoEm` (achado #2, tratamento explícito): o
  // `DO NOTHING` acima significa que, numa redelivery do MESMO evento, o
  // `origem_ocorrido_em` ORIGINAL nunca é sobrescrito, mesmo que a nova
  // entrega carregue um valor diferente — ele é tratado como metadado de
  // TRANSPORTE (versão/ordem da entrega), não como parte da identidade
  // imutável do evento, e por isso nunca participa da comparação de
  // conflito abaixo nem é "silenciosamente substituído": o valor
  // persistido é sempre o da primeira entrega, preservado por construção.
  const { rows } = await pool.query(
    `SELECT id, origem_processo_id AS "origemProcessoId", payload_hash AS "payloadHash", resultado,
            concluido_em AS "concluidoEm", processo_id AS "processoId", resposta_aplicada AS "respostaAplicada"
       FROM demurrage_handoff_eventos
      WHERE organization_id = $1 AND origem_sistema = $2 AND origem_evento_id = $3`,
    [ctx.organizationId, norm.origemSistema, norm.origemEventoId],
  );
  return { linha: rows[0], criadaAgora: false };
}

/**
 * Conclui a linha do evento (camada A) de forma idempotente: a condição
 * `concluido_em IS NULL` faz a segunda escrita (ex.: o perdedor de uma
 * corrida concorrente que, mesmo assim, chega ao MESMO desfecho) virar um
 * no-op silencioso — nunca duas linhas, nunca um erro. `respostaAplicada`,
 * quando informado, é o retrato que um replay futuro vai ler em vez de
 * chamar o D10 de novo.
 */
async function concluirEvento(
  pool: Pool, ctx: ContextoHandoff, norm: EntradaHandoffNormalizada,
  dados: { processoId: string | null; resultado: string; falhaSanitizada: CodigoFalhaHandoff | null; respostaAplicada?: RespostaHandoffAplicada | null },
): Promise<void> {
  await pool.query(
    `UPDATE demurrage_handoff_eventos
        SET processo_id = coalesce(processo_id, $4), resultado = $5, falha_sanitizada = $6,
            resposta_aplicada = coalesce($7::jsonb, resposta_aplicada), concluido_em = now()
      WHERE organization_id = $1 AND origem_sistema = $2 AND origem_evento_id = $3 AND concluido_em IS NULL`,
    [
      ctx.organizationId, norm.origemSistema, norm.origemEventoId, dados.processoId, dados.resultado, dados.falhaSanitizada,
      dados.respostaAplicada ? JSON.stringify(dados.respostaAplicada) : null,
    ],
  );
}

/** Exportado também para a suíte de injeção de falha da corretiva v1.2 (`handoffVinculoTransacaoV12.test.ts`), que chama `resolverVinculoProcesso` diretamente — nenhum caminho de produção importa esta função fora de `processarEventoHandoff` abaixo. */
export function construirEntradaD10(norm: EntradaHandoffNormalizada, organizationId: string): RegistroProcessoDemurrageV1 {
  const e = norm.entrada;
  return {
    versao: CONTRATO_REGISTRO_DEMURRAGE_V1,
    organizationId,
    numeroProcesso: norm.numeroProcesso,
    chaveIdempotencia: `handoff:${norm.origemSistema}:${norm.origemEventoId}`,
    origem: { sistema: norm.origemSistema, referencia: norm.origemProcessoId },
    cliente: e.cliente ?? null,
    house: e.house ?? null,
    mbl: e.mbl ?? null,
    armador: e.armador ?? null,
    condicaoComercial: e.condicaoComercial ?? null,
    responsavelOperacionalMembershipId: e.responsavelOperacionalMembershipId ?? null,
    houseFreeTimeDays: e.houseFreeTimeDays ?? null,
    masterFreeTimeDays: e.masterFreeTimeDays ?? null,
    containers: norm.containers.map((c) => ({
      numero: c.numero, tipoOriginal: c.tipoOriginal ?? null, houseFreeTimeDays: c.houseFreeTimeDays ?? null, masterFreeTimeDays: c.masterFreeTimeDays ?? null,
    })),
  };
}

function respostaDeResultadoRegistro(r: ResultadoRegistroDemurrage, eventoId: string): RespostaHandoffAplicada {
  const base = {
    eventoId, processoId: r.processoId, numeroProcesso: r.numeroProcesso, processoCriado: r.processoCriado,
    containers: r.containers, pendenciasAbertas: r.pendenciasAbertas,
  };
  if (r.status === 'ja_registrado') return { resultado: 'REPLAY_IDEMPOTENTE', ...base };
  return { resultado: r.pendenciasAbertas.length ? 'ACEITO_COM_PENDENCIA' : 'APLICADO', ...base };
}

function respostaDeResultadoRegistroParcial(erro: PosCommitIncompletoError, eventoId: string, numeroProcesso: string): RespostaHandoffAplicada {
  return {
    resultado: 'ACEITO_COM_PENDENCIA',
    eventoId,
    processoId: erro.processoId,
    numeroProcesso,
    processoCriado: false,
    containers: [],
    pendenciasAbertas: [{ tipo: 'pos_commit_em_reparo', containerNumero: null }],
  };
}

/**
 * Após um registro bem-sucedido (novo ou replay): reaplica o backlog de SI
 * (mecanismo JÁ EXISTENTE, já chamado periodicamente pelo tick do
 * scheduler) — melhor esforço, NUNCA desfaz o registro já confirmado. Uma
 * falha aqui é recuperável pelo próprio tick periódico; não cria uma
 * segunda pipeline de extração de SI. O log usa SÓ a classificação FECHADA
 * do erro (achado #3) — nunca `erro.message`.
 */
async function reconciliarBacklogSiMelhorEsforco(pool: Pool, organizationId: string): Promise<void> {
  try {
    await reaplicarIntencoesShippingInstructions({ pool, organizationId });
  } catch (erro) {
    // eslint-disable-next-line no-console
    console.error(`[demurrage-handoff] reconciliação de backlog SI falhou para organização ${organizationId} (recuperável pelo tick do scheduler): ${classificarFalhaHandoff(erro)}`);
  }
}

async function buscarProcessoIdPorNumero(pool: Pool, organizationId: string, numeroProcesso: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`, [organizationId, numeroProcesso]);
  return rows[0]?.id ?? null;
}

export type ResolucaoVinculo =
  | { tipo: 'conflito'; processoIdVinculado: string; numeroProcessoVinculado: string }
  | { tipo: 'resolvido'; processoId: string; resultadoAplicado?: ResultadoRegistroDemurrage; posCommitIncompleto?: PosCommitIncompletoError };

/**
 * SÓ TESTE (corretiva v1.2) — pontos de injeção de falha determinística
 * dentro da transação de `resolverVinculoProcesso`, usados EXCLUSIVAMENTE
 * pela suíte `handoffVinculoTransacaoV12.test.ts`. `processarEventoHandoff`
 * — o ÚNICO ponto de entrada que a rota HTTP e qualquer outro chamador de
 * produção usam — chama `resolverVinculoProcesso` SEM este 5º argumento;
 * não existe nenhum caminho (rota, contrato, variável de ambiente) que
 * permita a um request HTTP alcançar/ativar qualquer um destes ganchos.
 * Cada gancho, se lançar, interrompe a transação exatamente no ponto que
 * nomeia — é assim que os testes provam que TODO ponto de falha (lock
 * consultivo, leitura do vínculo, INSERT do vínculo, COMMIT, e o próprio
 * ROLLBACK) termina em exatamente um COMMIT bem-sucedido ou uma tentativa
 * de ROLLBACK antes do `release()`, nunca numa conexão devolvida ao pool
 * ainda dentro de uma transação aberta ou abortada (achado bloqueante desta
 * corretiva).
 */
export interface GanchosTesteResolverVinculo {
  /** Dispara imediatamente ANTES do lock consultivo de transação (`pg_advisory_xact_lock`). */
  antesDoLockConsultivo?: () => void | Promise<void>;
  /** Dispara imediatamente ANTES da leitura do vínculo já estabelecido (representa "falha antes do INSERT" — teste obrigatório #4). */
  antesDaLeituraDoVinculo?: () => void | Promise<void>;
  /** Dispara imediatamente ANTES do INSERT do vínculo, já depois do D10 ter sido chamado (representa "falha durante o INSERT" — teste obrigatório #5). */
  antesDoInsertDoVinculo?: () => void | Promise<void>;
  /** Dispara imediatamente ANTES de QUALQUER COMMIT desta função (teste obrigatório #6). */
  antesDoCommit?: () => void | Promise<void>;
  /** Quando presente, SUBSTITUI o ROLLBACK real — se lançar, simula a falha do próprio rollback (testes obrigatórios #9/#10). */
  antesDoRollback?: () => void | Promise<void>;
}

/**
 * Resolve/estabelece o vínculo ESTÁVEL (organização, sistema,
 * origemProcessoId) -> processo_id ANTES de chamar o D10 (achado #1 da v1.1).
 *
 * Toda a decisão roda sob um lock consultivo de TRANSAÇÃO
 * (`pg_advisory_xact_lock`) namespaced por `demurrage:handoff:vinculo:
 * <org>:<sistema>:<origemProcessoId>` — um namespace PRÓPRIO, que nenhum
 * outro código do sistema usa (mesma convenção dos locks do D10). Isso é o
 * que faz duas entregas CONCORRENTES para a MESMA identidade a montante
 * convergirem: a segunda só prossegue depois que a primeira já comitou (ou
 * abortou) o vínculo, então ela sempre vê o estado final e correto —
 * nunca duas "primeiras entregas" correndo em paralelo para o mesmo
 * `origemProcessoId`.
 *
 * - Vínculo já existe e o `numeroProcesso` desta entrega CONFERE: devolve
 *   o `processoId` vinculado (zero escrita aqui — o D10 é chamado depois,
 *   fora desta função, pelo chamador).
 * - Vínculo já existe e o `numeroProcesso` DIVERGE: conflito explícito —
 *   o D10 NUNCA é chamado (zero escrita de negócio, mesmo sob concorrência:
 *   a segunda entrega nem chega a tentar registrar).
 * - Vínculo NÃO existe (primeira entrega desta identidade a montante):
 *   chama o D10 AGORA, nesta janela (conexão separada do pool — o lock
 *   consultivo aqui e o lock do D10, por `numeroProcesso`, são namespaces
 *   DIFERENTES, sem risco de deadlock), e grava o vínculo com o
 *   `processoId` resultante antes de liberar o lock. `PosCommitIncompletoError`
 *   ainda estabelece o vínculo (o registro principal JÁ comitou — só o
 *   reparo pós-commit está pendente) antes de relançar; qualquer outro erro
 *   (ex.: `PROCESSO_FINAL`, violação de FK) nunca estabelece vínculo algum.
 *
 * SEGURANÇA TRANSACIONAL (corretiva v1.2 — achado bloqueante do usuário):
 * o estado da transação é rastreado EXPLICITAMENTE em `transacaoAberta`.
 * Todo caminho de saída depois de um `BEGIN` bem-sucedido passa por
 * exatamente um `COMMIT` OU por uma tentativa de `ROLLBACK` — nunca os
 * dois, nunca nenhum. O `finally` NUNCA libera a conexão cegamente: ela
 * nunca é devolvida a um pool compartilhado reutilizável enquanto seu
 * estado transacional não for conhecido (ver nota de concorrência abaixo —
 * corretiva v1.3). A falha do rollback nunca substitui o erro de negócio
 * ORIGINAL (sempre relançado sem alteração) e só é classificada/logada pelo
 * mapeamento FECHADO já existente (achado #3 da v1.1) — nunca `.message`,
 * stack, corpo da requisição ou segredo.
 *
 * CONCORRÊNCIA E O POOL COMPARTILHADO (corretiva v1.3 — achado bloqueante
 * levantado na revisão final da v1.2): a v1.2 validou que UMA chamada
 * isolada não se autobloqueia com `pool.max >= 2`, mas isso NÃO prova
 * segurança sob CONCORRÊNCIA — reproduzido deterministicamente (script de
 * investigação, não comitado): com `pool.max = N` e N chamadas concorrentes
 * para N identidades a montante DIFERENTES (sem contenção entre si no lock
 * consultivo — chaves distintas), cada uma adquire sua própria conexão do
 * `lockClient` (todas as N conexões do pool ficam ocupadas), e cada uma
 * então tenta adquirir uma SEGUNDA conexão do MESMO pool para o D10 — zero
 * conexões livres, nenhuma chamada nunca libera a sua primeira (está
 * esperando a segunda), nenhuma chamada nunca consegue a segunda (não há
 * conexão livre): deadlock permanente (o `pg-pool` não tem timeout de
 * conexão por padrão). Aumentar `pool.max` só eleva o N necessário para
 * saturar — não elimina o problema estrutural.
 *
 * CORREÇÃO: a conexão do `lockClient` (que faz o lock consultivo e,
 * eventualmente, o INSERT do vínculo) agora é um `pg.Client` DEDICADO —
 * conectado diretamente, FORA do `pool` compartilhado — nunca retirado nem
 * devolvido a nenhum pool. O D10 (`registrarProcessoDemurrage`, chamado
 * DENTRO desta transação) continua usando o `pool` compartilhado exatamente
 * como antes (nenhuma mudança em D10) — mas agora o `lockClient` e a
 * conexão que o D10 pega são fisicamente recursos DIFERENTES, sem disputa
 * nenhuma entre si. Isso elimina a dependência circular por construção: o
 * `pool` compartilhado só precisa servir UMA conexão por vez para o D10
 * (uso sequencial, nunca aninhado), e a disponibilidade de conexões no
 * `lockClient` nunca depende de quantas chamadas concorrentes de
 * `resolverVinculoProcesso` estão em voo — cada uma tem a sua própria
 * conexão dedicada, independente do `pool.max`. O `pg_advisory_xact_lock`
 * continua sendo exatamente o mesmo mecanismo entre processos/instâncias
 * (a semântica do lock no Postgres não depende de a conexão vir de um pool
 * Node ou de uma conexão direta) — a garantia de serialização do achado #1
 * da v1.1 (duas entregas concorrentes para o MESMO `origemProcessoId`
 * convergem) permanece intacta e é reconfirmada pelos testes de
 * concorrência existentes.
 *
 * CONFLITO OCULTO NA INSERÇÃO DO VÍNCULO (corretiva v1.2 — segundo achado
 * bloqueante): o `INSERT ... ON CONFLICT DO NOTHING` do vínculo agora usa
 * `RETURNING`. Quando o conflito suprime a linha (algo gravou o vínculo
 * para esta MESMA identidade a montante por FORA do lock consultivo desta
 * função — nunca pode ser outra chamada DESTA função, que está serializada
 * pelo mesmo lock), uma releitura AUTORITATIVA (ainda dentro da mesma
 * transação/lock) prova se o vínculo persistido aponta para o MESMO
 * `processoId` que acabamos de produzir/resolver. Só com essa prova de
 * igualdade a função devolve `resolvido`; uma divergência devolve conflito
 * explícito — nunca muta ou reatribui o vínculo já existente (o trigger
 * append-only da migration 0041 impediria de qualquer forma).
 */
export async function resolverVinculoProcesso(
  pool: Pool, organizationId: string, norm: EntradaHandoffNormalizada, entradaD10: RegistroProcessoDemurrageV1,
  ganchosTeste?: GanchosTesteResolverVinculo,
): Promise<ResolucaoVinculo> {
  // Conexão DEDICADA (não do `pool` compartilhado) — ver nota de
  // concorrência acima (corretiva v1.3). `pool.options.connectionString`
  // é a mesma connection string que o `pool` recebido já usa (o `Pool`
  // desta base de código é sempre construído só com `{ connectionString }`,
  // em produção e em todos os testes).
  const lockClient = new Client({ connectionString: pool.options.connectionString });
  await lockClient.connect();
  let transacaoAberta = false;
  try {
    await lockClient.query('BEGIN');
    transacaoAberta = true;

    await ganchosTeste?.antesDoLockConsultivo?.();
    await lockClient.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`demurrage:handoff:vinculo:${organizationId}:${norm.origemSistema}:${norm.origemProcessoId}`],
    );

    const lerVinculoAtual = () => lockClient.query<{ processoId: string; numeroProcesso: string }>(
      `SELECT l.processo_id AS "processoId", p.numero_processo AS "numeroProcesso"
         FROM demurrage_handoff_processo_links l JOIN processos p ON p.id = l.processo_id
        WHERE l.organization_id = $1 AND l.origem_sistema = $2 AND l.origem_processo_id = $3`,
      [organizationId, norm.origemSistema, norm.origemProcessoId],
    );

    await ganchosTeste?.antesDaLeituraDoVinculo?.();
    const { rows } = await lerVinculoAtual();
    if (rows.length) {
      await ganchosTeste?.antesDoCommit?.();
      await lockClient.query('COMMIT');
      transacaoAberta = false;
      if (rows[0].numeroProcesso !== norm.numeroProcesso) {
        return { tipo: 'conflito', processoIdVinculado: rows[0].processoId, numeroProcessoVinculado: rows[0].numeroProcesso };
      }
      return { tipo: 'resolvido', processoId: rows[0].processoId };
    }

    let processoIdEstabelecido: string;
    let resultadoAplicado: ResultadoRegistroDemurrage | undefined;
    let posCommitIncompleto: PosCommitIncompletoError | undefined;
    try {
      resultadoAplicado = await registrarProcessoDemurrage(entradaD10, { pool });
      processoIdEstabelecido = resultadoAplicado.processoId;
    } catch (erroD10) {
      if (!(erroD10 instanceof PosCommitIncompletoError)) throw erroD10;
      posCommitIncompleto = erroD10;
      processoIdEstabelecido = erroD10.processoId;
    }

    await ganchosTeste?.antesDoInsertDoVinculo?.();
    const ins = await lockClient.query<{ processoId: string }>(
      `INSERT INTO demurrage_handoff_processo_links (organization_id, origem_sistema, origem_processo_id, processo_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, origem_sistema, origem_processo_id) DO NOTHING
       RETURNING processo_id AS "processoId"`,
      [organizationId, norm.origemSistema, norm.origemProcessoId, processoIdEstabelecido],
    );

    let processoIdPersistido: string | undefined;
    let numeroProcessoPersistido: string | undefined;
    if (ins.rows.length) {
      processoIdPersistido = ins.rows[0].processoId;
    } else {
      // Conflito OCULTO (achado v1.2): releitura autoritativa, ainda dentro
      // desta transação/lock, antes de decidir qualquer coisa.
      const releitura = await lerVinculoAtual();
      processoIdPersistido = releitura.rows[0]?.processoId;
      numeroProcessoPersistido = releitura.rows[0]?.numeroProcesso;
    }

    await ganchosTeste?.antesDoCommit?.();
    await lockClient.query('COMMIT');
    transacaoAberta = false;

    if (processoIdPersistido !== processoIdEstabelecido) {
      // NUNCA muta/reatribui o vínculo já persistido — só constata e
      // devolve conflito explícito. O D10 já pode ter aplicado `entradaD10`
      // contra `processoIdEstabelecido` nesta mesma chamada (não há como
      // desfazer uma transação já comitada dentro de `registrarProcessoDemurrage`)
      // — por isso este NÃO é um caminho de zero escrita como o conflito
      // normal (vínculo já existia, verificado ANTES do D10 ser chamado);
      // é defesa em profundidade contra um vínculo gravado por fora desta
      // função, documentada no relatório v1.2 (§ verificação de conflito).
      return {
        tipo: 'conflito',
        processoIdVinculado: processoIdPersistido as string,
        numeroProcessoVinculado: numeroProcessoPersistido ?? norm.numeroProcesso,
      };
    }

    if (posCommitIncompleto) return { tipo: 'resolvido', processoId: processoIdEstabelecido, posCommitIncompleto };
    return { tipo: 'resolvido', processoId: processoIdEstabelecido, resultadoAplicado };
  } catch (erro) {
    if (transacaoAberta) {
      try {
        if (ganchosTeste?.antesDoRollback) await ganchosTeste.antesDoRollback();
        else await lockClient.query('ROLLBACK');
      } catch (erroRollback) {
        // O ROLLBACK também falhou: a conexão é DEDICADA (corretiva v1.3,
        // nunca pertenceu a um pool compartilhado) — o `finally` abaixo
        // encerra (`end()`) essa conexão física incondicionalmente, então
        // não há "devolver suja ao pool" a evitar aqui. A falha do rollback
        // NUNCA substitui o erro de negócio ORIGINAL (`erro`, relançado
        // abaixo sem alteração) e só é classificada/logada pelo mapeamento
        // FECHADO já existente (achado #3 da v1.1) — nunca `.message`,
        // stack ou erro bruto.
        // eslint-disable-next-line no-console
        console.error(`[demurrage-handoff] rollback de resolverVinculoProcesso também falhou — conexão dedicada será encerrada: ${classificarFalhaHandoff(erroRollback)}`);
      }
      transacaoAberta = false;
    }
    throw erro;
  } finally {
    // Conexão DEDICADA (nunca de um pool) — sempre `end()`, nunca
    // `release()`: não há pool nenhum para devolver (suja ou limpa) esta
    // conexão. Encerrar a conexão TCP garante que o Postgres aborta
    // qualquer transação remanescente do lado do servidor, mesmo se a
    // tentativa de ROLLBACK acima também tiver falhado.
    await lockClient.end().catch((erroEnd) => {
      // eslint-disable-next-line no-console
      console.error(`[demurrage-handoff] encerrar a conexão dedicada de resolverVinculoProcesso falhou (sem impacto — a conexão já estava inutilizável): ${classificarFalhaHandoff(erroEnd)}`);
    });
  }
}

export async function processarEventoHandoff(
  entradaBruta: unknown, ctx: ContextoHandoff, opcoes: { pool?: Pool } = {},
): Promise<RespostaHandoff> {
  let norm: EntradaHandoffNormalizada;
  try {
    norm = validarEntradaHandoff(entradaBruta);
  } catch (erro) {
    if (erro instanceof ErroContratoHandoff) return { resultado: 'CONTRATO_INVALIDO', detalhe: { codigo: erro.codigo, ...erro.detalhe } };
    throw erro;
  }

  const pool = opcoes.pool ?? getPool();
  const { linha, criadaAgora } = await registrarOuRecuperarEvento(pool, ctx, norm);

  if (!criadaAgora) {
    // Achado #2: a identidade IMUTÁVEL do evento é {organização, sistema,
    // origemEventoId, origemProcessoId} — nunca só o hash do payload de
    // negócio (que exclui `origemProcessoId` de propósito). As duas
    // verificações abaixo NUNCA chamam o D10, NUNCA reconciliam SI e NUNCA
    // atualizam esta linha já existente — a linha do evento original
    // permanece exatamente como estava.
    if (linha.origemProcessoId !== norm.origemProcessoId) {
      return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'origem_processo_id_divergente_do_evento_original' } };
    }
    if (linha.payloadHash !== norm.payloadHash) {
      return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'payload_divergente_do_evento_original' } };
    }
    // Replay estrito: identidade completa E payload idênticos, já concluído
    // com um desfecho terminal — leitura pura do retrato persistido, sem
    // tocar o D10 (auditoria de replay, ver cabeçalho do arquivo).
    if (linha.concluidoEm && linha.resultado) {
      if (linha.resultado === 'EXIGE_REABERTURA') {
        return { resultado: 'EXIGE_REABERTURA', eventoId: linha.id, numeroProcesso: norm.numeroProcesso, processoId: linha.processoId };
      }
      if (linha.respostaAplicada) {
        // O rótulo do PRÓPRIO replay é sempre `REPLAY_IDEMPOTENTE` (a
        // categoria "isto é uma repetição, nenhum trabalho novo aconteceu"
        // — ver Entrega 1, §2.2), mesmo que a aplicação original tenha sido
        // `APLICADO` ou `ACEITO_COM_PENDENCIA`; os demais campos do retrato
        // (processoId, contêineres, pendências) preservam o estado real.
        return { ...linha.respostaAplicada, resultado: 'REPLAY_IDEMPOTENTE', eventoId: linha.id };
      }
      // Linha concluída sem retrato (nunca ocorre para um sucesso gravado
      // depois desta correção — só defesa em profundidade para uma linha
      // de antes da v1.1): cai para a reaplicação normal abaixo.
    }
  }

  // Primeira entrega deste evento, OU mesma identidade/payload mas uma
  // tentativa anterior nunca chegou a um desfecho terminal (crash entre a
  // camada A e a camada B, ou corrida concorrente ainda em andamento).
  const entradaD10 = construirEntradaD10(norm, ctx.organizationId);

  try {
    const vinculo = await resolverVinculoProcesso(pool, ctx.organizationId, norm, entradaD10);

    if (vinculo.tipo === 'conflito') {
      // Achado #1: este `origemProcessoId` já está vinculado a OUTRO
      // processo interno (numeroProcesso diferente) — conflito de
      // identidade explícito, ZERO escrita de negócio (o D10 nunca chega a
      // ser chamado para esta entrega).
      await concluirEvento(pool, ctx, norm, { processoId: null, resultado: 'CONFLITO_EVENTO', falhaSanitizada: null });
      return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'processo_vinculado_diferente' } };
    }

    if (vinculo.posCommitIncompleto) {
      const resposta = respostaDeResultadoRegistroParcial(vinculo.posCommitIncompleto, linha.id, norm.numeroProcesso);
      await concluirEvento(pool, ctx, norm, {
        processoId: vinculo.posCommitIncompleto.processoId, resultado: 'ACEITO_COM_PENDENCIA',
        falhaSanitizada: classificarFalhaHandoff(vinculo.posCommitIncompleto), respostaAplicada: resposta,
      });
      await reconciliarBacklogSiMelhorEsforco(pool, ctx.organizationId);
      return resposta;
    }

    // `resultadoAplicado` presente = esta foi a primeira entrega desta
    // identidade a montante, já aplicada DENTRO de `resolverVinculoProcesso`
    // (não chama o D10 de novo); ausente = o vínculo já existia e conferia
    // — aplica normalmente agora.
    const r = vinculo.resultadoAplicado ?? await registrarProcessoDemurrage(entradaD10, { pool });
    const resposta = respostaDeResultadoRegistro(r, linha.id);
    await concluirEvento(pool, ctx, norm, { processoId: r.processoId, resultado: resposta.resultado, falhaSanitizada: null, respostaAplicada: resposta });
    await reconciliarBacklogSiMelhorEsforco(pool, ctx.organizationId);
    return resposta;
  } catch (erro) {
    if (erro instanceof PosCommitIncompletoError) {
      // Só alcançável quando o vínculo já existia e a aplicação normal
      // (fora de `resolverVinculoProcesso`) foi quem lançou — mesmo tratamento.
      const resposta = respostaDeResultadoRegistroParcial(erro, linha.id, norm.numeroProcesso);
      await concluirEvento(pool, ctx, norm, {
        processoId: erro.processoId, resultado: 'ACEITO_COM_PENDENCIA', falhaSanitizada: classificarFalhaHandoff(erro), respostaAplicada: resposta,
      });
      await reconciliarBacklogSiMelhorEsforco(pool, ctx.organizationId);
      return resposta;
    }
    if (erro instanceof ErroContratoDemurrage && erro.codigo === 'PROCESSO_FINAL') {
      // Processo em estado FINAL: retido para auditoria, NUNCA muta a
      // projeção FINAL silenciosamente — exige reabertura humana explícita.
      // Nenhum vínculo é estabelecido (não foi uma aplicação bem-sucedida).
      const processoId = await buscarProcessoIdPorNumero(pool, ctx.organizationId, norm.numeroProcesso);
      await concluirEvento(pool, ctx, norm, { processoId, resultado: 'EXIGE_REABERTURA', falhaSanitizada: null });
      return { resultado: 'EXIGE_REABERTURA', eventoId: linha.id, numeroProcesso: norm.numeroProcesso, processoId };
    }
    if (erro instanceof ErroContratoDemurrage && erro.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA') {
      await concluirEvento(pool, ctx, norm, { processoId: null, resultado: 'CONFLITO_EVENTO', falhaSanitizada: classificarFalhaHandoff(erro) });
      return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'chave_idempotencia_reutilizada' } };
    }
    const codigo = classificarFalhaHandoff(erro);
    await concluirEvento(pool, ctx, norm, { processoId: null, resultado: 'FALHA', falhaSanitizada: codigo });
    return { resultado: 'FALHA', eventoId: linha.id, detalhe: { motivo: codigo } };
  }
}
