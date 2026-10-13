import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CONTRATO_REGISTRO_DEMURRAGE_V1, ErroContratoDemurrage, RegistroProcessoDemurrageV1 } from '../registro/contrato';
import { PosCommitIncompletoError, ResultadoRegistroDemurrage, registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { reaplicarIntencoesShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';
import { EntradaHandoffNormalizada, ErroContratoHandoff, validarEntradaHandoff } from './contrato';

/**
 * Produção P1 (Entrega 1) — serviço de aplicação COMPARTILHADO do handoff.
 *
 * Um único ponto de entrada (`processarEventoHandoff`), chamável:
 *  - diretamente dentro do monólito (contexto de organização já resolvido,
 *    NUNCA passando pela autenticação HTTP — `CREDENCIAL_IDENTIDADE_INTERNA`);
 *  - pela rota HTTP fina (`demurrageHandoffRoutes.ts`), depois de verificada
 *    a assinatura HMAC — a rota só resolve o contexto autenticado e delega
 *    aqui; nenhuma lógica de negócio na rota.
 *
 * Duas camadas de idempotência, deliberadamente independentes:
 *
 *  CAMADA A (`demurrage_handoff_eventos`, nova) — identidade do EVENTO a
 *  montante, por (organização, origem_sistema, origem_evento_id). Só decide
 *  UMA coisa antes de tocar a camada B: o mesmo `origemEventoId` com um hash
 *  de payload DIFERENTE é conflito explícito — e nesse caso a camada B
 *  nunca é chamada (zero risco de escrita parcial). Com o MESMO hash (replay
 *  verdadeiro ou corrida concorrente), a chamada segue para a camada B, que
 *  decide a aplicação de fato.
 *
 *  CAMADA B (`demurrage_registros`, D10, já existente e congelada) —
 *  identidade do PAYLOAD normalizado, por `chaveIdempotencia`. Aqui é
 *  derivada deterministicamente de `(origemSistema, origemEventoId)`
 *  (`handoff:<sistema>:<eventoId>`), o que faz esta chamada herdar DE
 *  GRAÇA todas as garantias de concorrência já provadas do D10: lock
 *  consultivo por processo/contêiner, `INSERT ... ON CONFLICT DO NOTHING`,
 *  e o próprio `CHAVE_IDEMPOTENCIA_REUTILIZADA` como segunda linha de
 *  defesa contra payload divergente. "Entregas concorrentes idênticas
 *  aplicam uma vez" e "entregas concorrentes conflitantes têm desfecho
 *  determinístico sem duplicar linhas" vêm DESSA herança — nenhum lock
 *  novo foi inventado aqui.
 */

export const CREDENCIAL_IDENTIDADE_INTERNA = 'interno:confiavel' as const;

export interface ContextoHandoff {
  /** SEMPRE resolvido pelo chamador autenticado — nunca lido do corpo/query/headers da requisição. */
  organizationId: string;
  /** UUID da credencial HTTP autenticada, ou `CREDENCIAL_IDENTIDADE_INTERNA` para chamadas in-process confiáveis. */
  credencialIdentidade: string;
}

interface ContainerRespostaHandoff { numero: string; containerId: string; criado: boolean }

export type RespostaHandoff =
  | {
      resultado: 'APLICADO' | 'REPLAY_IDEMPOTENTE' | 'ACEITO_COM_PENDENCIA';
      eventoId: string;
      processoId: string;
      numeroProcesso: string;
      processoCriado: boolean;
      containers: ContainerRespostaHandoff[];
      pendenciasAbertas: Array<{ tipo: string; containerNumero: string | null }>;
    }
  | { resultado: 'EXIGE_REABERTURA'; eventoId: string; numeroProcesso: string; processoId: string | null }
  | { resultado: 'CONFLITO_EVENTO'; eventoId: string | null; detalhe: Record<string, unknown> }
  | { resultado: 'CONTRATO_INVALIDO'; detalhe: Record<string, unknown> }
  | { resultado: 'FALHA'; eventoId: string | null; detalhe: Record<string, unknown> };

/** Nunca grava segredo, assinatura, corpo da requisição ou conteúdo de documento — só a classificação do erro. */
function sanitizarFalha(erro: unknown): string {
  if (erro instanceof ErroContratoDemurrage) return `ErroContratoDemurrage:${erro.codigo}`;
  if (erro instanceof PosCommitIncompletoError) return 'PosCommitIncompletoError';
  if (erro instanceof Error) return `${erro.name}:${erro.message}`.slice(0, 500);
  return 'erro_desconhecido';
}

interface LinhaEventoExistente { id: string; payloadHash: string; resultado: string | null; concluidoEm: Date | null; processoId: string | null }

/**
 * Registra a identidade do evento (camada A) se for a PRIMEIRA entrega, ou
 * devolve a linha já existente (vencedora da corrida de `INSERT ... ON
 * CONFLICT DO NOTHING`). Nunca lança por conflito — quem chama decide o que
 * fazer com o hash divergente.
 */
async function registrarOuRecuperarEvento(
  pool: Pool, ctx: ContextoHandoff, norm: EntradaHandoffNormalizada,
): Promise<{ linha: LinhaEventoExistente; criadaAgora: boolean }> {
  const ins = await pool.query(
    `INSERT INTO demurrage_handoff_eventos
       (organization_id, credencial_identidade, origem_sistema, origem_processo_id, origem_evento_id, origem_ocorrido_em, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, origem_sistema, origem_evento_id) DO NOTHING
     RETURNING id, payload_hash AS "payloadHash", resultado, concluido_em AS "concluidoEm", processo_id AS "processoId"`,
    [ctx.organizationId, ctx.credencialIdentidade, norm.origemSistema, norm.origemProcessoId, norm.origemEventoId, norm.origemOcorridoEm, norm.payloadHash],
  );
  if (ins.rows.length) return { linha: ins.rows[0], criadaAgora: true };
  const { rows } = await pool.query(
    `SELECT id, payload_hash AS "payloadHash", resultado, concluido_em AS "concluidoEm", processo_id AS "processoId" FROM demurrage_handoff_eventos
      WHERE organization_id = $1 AND origem_sistema = $2 AND origem_evento_id = $3`,
    [ctx.organizationId, norm.origemSistema, norm.origemEventoId],
  );
  return { linha: rows[0], criadaAgora: false };
}

const RESULTADOS_TERMINAIS_COM_SUCESSO = new Set(['APLICADO', 'REPLAY_IDEMPOTENTE', 'ACEITO_COM_PENDENCIA', 'EXIGE_REABERTURA']);

/**
 * Conclui a linha do evento (camada A) de forma idempotente: a condição
 * `concluido_em IS NULL` faz a segunda escrita (ex.: o perdedor de uma
 * corrida concorrente que, mesmo assim, chega ao MESMO desfecho pela
 * camada B) virar um no-op silencioso — nunca duas linhas, nunca um erro.
 */
async function concluirEvento(
  pool: Pool, ctx: ContextoHandoff, norm: EntradaHandoffNormalizada,
  dados: { processoId: string | null; resultado: string; falhaSanitizada: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE demurrage_handoff_eventos
        SET processo_id = coalesce(processo_id, $4), resultado = $5, falha_sanitizada = $6, concluido_em = now()
      WHERE organization_id = $1 AND origem_sistema = $2 AND origem_evento_id = $3 AND concluido_em IS NULL`,
    [ctx.organizationId, norm.origemSistema, norm.origemEventoId, dados.processoId, dados.resultado, dados.falhaSanitizada],
  );
}

function construirEntradaD10(norm: EntradaHandoffNormalizada, organizationId: string): RegistroProcessoDemurrageV1 {
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

function respostaDeResultadoRegistro(r: ResultadoRegistroDemurrage, eventoId: string): RespostaHandoff {
  const base = {
    eventoId, processoId: r.processoId, numeroProcesso: r.numeroProcesso, processoCriado: r.processoCriado,
    containers: r.containers, pendenciasAbertas: r.pendenciasAbertas,
  };
  if (r.status === 'ja_registrado') return { resultado: 'REPLAY_IDEMPOTENTE', ...base };
  return { resultado: r.pendenciasAbertas.length ? 'ACEITO_COM_PENDENCIA' : 'APLICADO', ...base };
}

/**
 * Após um registro bem-sucedido (novo ou replay): reaplica o backlog de SI
 * (mecanismo JÁ EXISTENTE, já chamado periodicamente pelo tick do
 * scheduler) — melhor esforço, NUNCA desfaz o registro já confirmado. Uma
 * falha aqui é recuperável pelo próprio tick periódico (mesma garantia que
 * já vale hoje); não cria uma segunda pipeline de extração de SI.
 */
async function reconciliarBacklogSiMelhorEsforco(pool: Pool, organizationId: string): Promise<void> {
  try {
    await reaplicarIntencoesShippingInstructions({ pool, organizationId });
  } catch (erro) {
    // eslint-disable-next-line no-console
    console.error(`[demurrage-handoff] reconciliação de backlog SI falhou para organização ${organizationId} (recuperável pelo tick do scheduler):`, sanitizarFalha(erro));
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

  if (!criadaAgora && linha.payloadHash !== norm.payloadHash) {
    // Mesmo origemEventoId, payload DIFERENTE: conflito explícito — a
    // camada B nunca é tocada, então não há risco de escrita parcial.
    return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'payload_divergente_do_evento_original', origemEventoId: norm.origemEventoId } };
  }

  // Mesmo payload E já concluído com um desfecho TERMINAL (sucesso ou
  // reabertura exigida): replay puro, nem chega a chamar a camada B de novo.
  if (!criadaAgora && linha.concluidoEm && linha.resultado && RESULTADOS_TERMINAIS_COM_SUCESSO.has(linha.resultado)) {
    if (linha.resultado === 'EXIGE_REABERTURA') {
      return { resultado: 'EXIGE_REABERTURA', eventoId: linha.id, numeroProcesso: norm.numeroProcesso, processoId: linha.processoId };
    }
    // Reconstrói a resposta chamando a camada B — que, para a MESMA chave de
    // idempotência, devolve o resultado original completo sem reaplicar nada
    // (D10, `status: 'ja_registrado'`). Não reinventa um cache próprio do
    // resultado completo aqui: a camada B já É esse cache, comprovado.
    try {
      const r = await registrarProcessoDemurrage(construirEntradaD10(norm, ctx.organizationId), { pool });
      return respostaDeResultadoRegistro(r, linha.id);
    } catch (erro) {
      if (erro instanceof PosCommitIncompletoError) return respostaDeResultadoRegistroParcial(erro, linha.id, norm.numeroProcesso);
      throw erro;
    }
  }

  // Primeira entrega deste evento, OU mesmo payload mas uma tentativa
  // anterior nunca chegou a um desfecho terminal (crash entre a camada A e a
  // camada B, ou corrida concorrente ainda em andamento) — chama a camada B.
  try {
    const r = await registrarProcessoDemurrage(construirEntradaD10(norm, ctx.organizationId), { pool });
    const resposta = respostaDeResultadoRegistro(r, linha.id);
    await concluirEvento(pool, ctx, norm, { processoId: r.processoId, resultado: resposta.resultado, falhaSanitizada: null });
    await reconciliarBacklogSiMelhorEsforco(pool, ctx.organizationId);
    return resposta;
  } catch (erro) {
    if (erro instanceof PosCommitIncompletoError) {
      // O registro PRINCIPAL (processo/contêineres/ledger) já está
      // confirmado — só o recálculo/fotografia pós-commit falhou, e isso é
      // durável e recuperável repetindo a MESMA chamada (contrato já
      // documentado de `PosCommitIncompletoError`). Não é uma falha de
      // negócio do handoff: marca como aplicado (com a ressalva) e segue.
      await concluirEvento(pool, ctx, norm, { processoId: erro.processoId, resultado: 'ACEITO_COM_PENDENCIA', falhaSanitizada: sanitizarFalha(erro) });
      await reconciliarBacklogSiMelhorEsforco(pool, ctx.organizationId);
      return respostaDeResultadoRegistroParcial(erro, linha.id, norm.numeroProcesso);
    }
    if (erro instanceof ErroContratoDemurrage && erro.codigo === 'PROCESSO_FINAL') {
      // Processo em estado FINAL: retido para auditoria, NUNCA muta a
      // projeção FINAL silenciosamente — exige reabertura humana explícita.
      const processoId = await buscarProcessoIdPorNumero(pool, ctx.organizationId, norm.numeroProcesso);
      await concluirEvento(pool, ctx, norm, { processoId, resultado: 'EXIGE_REABERTURA', falhaSanitizada: null });
      return { resultado: 'EXIGE_REABERTURA', eventoId: linha.id, numeroProcesso: norm.numeroProcesso, processoId };
    }
    if (erro instanceof ErroContratoDemurrage && erro.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA') {
      // Segunda linha de defesa: a camada B viu o MESMO `chaveIdempotencia`
      // com um payload D10 normalizado diferente. Só pode acontecer se o
      // hash da camada A (sobre o envelope do handoff) coincidiu mas a
      // tradução para o contrato D10 diverge por outro motivo — ainda assim
      // é, por definição, um conflito do mesmo evento.
      await concluirEvento(pool, ctx, norm, { processoId: null, resultado: 'CONFLITO_EVENTO', falhaSanitizada: sanitizarFalha(erro) });
      return { resultado: 'CONFLITO_EVENTO', eventoId: linha.id, detalhe: { motivo: 'chave_idempotencia_reutilizada' } };
    }
    await concluirEvento(pool, ctx, norm, { processoId: null, resultado: 'FALHA', falhaSanitizada: sanitizarFalha(erro) });
    return { resultado: 'FALHA', eventoId: linha.id, detalhe: { motivo: sanitizarFalha(erro) } };
  }
}

function respostaDeResultadoRegistroParcial(erro: PosCommitIncompletoError, eventoId: string, numeroProcesso: string): RespostaHandoff {
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

async function buscarProcessoIdPorNumero(pool: Pool, organizationId: string, numeroProcesso: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`, [organizationId, numeroProcesso]);
  return rows[0]?.id ?? null;
}
