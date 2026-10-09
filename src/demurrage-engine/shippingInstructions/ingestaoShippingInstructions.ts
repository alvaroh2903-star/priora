import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { promoverMasterFreeTimeComClient } from '../freeTime/masterFreeTimeService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { registrarTentativaNaoEncontrada } from '../freeTime/freeTimeTentativas';
import {
  AnexoMetaSI, MensagemSI, OcrResultadoSI, OcorrenciaFreeTime, ProblemaExtracao,
  CAMPOS_FREE_TIME_SI, CampoFreeTime, anexoDocumental, avaliarOcr, consolidarOcorrencias, extrairFreeTimeDoCorpo, normalizarProcesso,
  extrairReferencias, hashConteudo, normalizarContainer, normalizarMbl, primeiraMensagem,
} from './extracaoShippingInstructions';

/**
 * Serviço IDEMPOTENTE de ingestão da Shipping Instructions (SI).
 *
 * Regra da Rocket: o PRIMEIRO e-mail cronológico da conversa de pré-alerta é a
 * SI. Examina corpo e anexos dessa mensagem e registra o Master Free Time só
 * quando explícito e com alcance seguro (processo/MBL/contêiner).
 *
 * Fluxo:
 * 1. Carrega a conversa (porta Graph), ordena por receivedDateTime, pega a 1ª.
 * 2. Calcula o hash da VERSÃO e reivindica a versão (`si_versoes`). Versão DONE
 *    não é refeita (sem novo download/leitura). PENDENTE/FAILED só por reprocesso
 *    manual (FAILED também automaticamente, com limite de tentativas).
 * 3. Leitura documental FORA de transação (corpo determinístico; anexos pela
 *    porta de leitura, aceitos só com confiança >= 0.90 e âncora explícita).
 * 4. Numa ÚNICA transação: intenções, associação processo/MBL/contêiner,
 *    promoções pelo serviço central (observação + divergência + avisos + outbox),
 *    proveniência, pendências abertas/resolvidas e o estado da versão.
 *
 * Não existe hoje job de importação de pré-alerta nem vínculo Outlook →
 * organização: `organizationId` e `conversationId` vêm do chamador autenticado.
 */

export interface ConteudoAnexo {
  dataBase64: string;
  mimeType: string;
}

/** Interfaces injetáveis: Graph (conversa/anexo) e leitura documental. */
export interface PortasShippingInstructions {
  carregarConversa(conversationId: string): Promise<MensagemSI[]>;
  lerAnexo(messageId: string, anexo: AnexoMetaSI): Promise<ConteudoAnexo | null>;
  lerDocumento(doc: ConteudoAnexo & { nome: string }): Promise<OcrResultadoSI>;
}

export type TipoPendenciaSI =
  | 'free_time_nao_encontrado' | 'free_time_ambiguo' | 'processo_nao_identificado' | 'mbl_nao_identificado'
  | 'conversa_multiprocesso' | 'container_nao_encontrado' | 'alcance_nao_determinado' | 'ocr_baixa_confianca';

/** Pendências que dependem da LEITURA do documento: só uma nova leitura as resolve. */
const TIPOS_EXTRACAO: TipoPendenciaSI[] = ['free_time_nao_encontrado', 'free_time_ambiguo', 'ocr_baixa_confianca'];
/** Pendências de ASSOCIAÇÃO: reavaliáveis pelo banco (sem reler o documento). */
const TIPOS_ASSOCIACAO: TipoPendenciaSI[] = [
  'processo_nao_identificado', 'mbl_nao_identificado', 'conversa_multiprocesso', 'container_nao_encontrado', 'alcance_nao_determinado',
];

interface PendenciaSI {
  tipo: TipoPendenciaSI;
  motivo: string;
  processoId?: string | null;
  mbl?: string | null;
  containerId?: string | null;
  containerNumero?: string | null;
  contexto?: Record<string, unknown>;
  /** Parte estável do contexto que identifica a pendência (sem versão/valores voláteis). */
  chave?: string;
}

export type StatusIngestao =
  | 'conversa_vazia' | 'ja_concluida' | 'aguardando_reprocessamento_manual' | 'em_andamento'
  | 'tentativas_esgotadas' | 'concluida' | 'pendente' | 'falhou' | 'posse_perdida';

export interface IngerirResultado {
  status: StatusIngestao;
  versaoId?: string;
  conteudoHash?: string;
  messageId?: string;
  promovidos: number;
  pendenciasAbertas: number;
  erro?: string;
}

export interface IngerirInput {
  pool?: Pool;
  organizationId: string;
  conversationId: string;
  portas: PortasShippingInstructions;
  /** automatico: não refaz PENDENTE; manual (POST): reprocessa PENDENTE/FAILED. */
  modo: 'automatico' | 'manual';
  workerId?: string;
  ttlMs?: number;
  maxTentativasAutomaticas?: number;
  /** Quem acionou (auditoria das pendências/eventos). */
  autor?: string;
}

/** Registra a conversa de pré-alerta da organização (idempotente). */
export async function registrarConversaPreAlerta(
  pool: Pool,
  input: { organizationId: string; conversationId: string; origem: 'importacao_automatica' | 'manual' },
): Promise<void> {
  await pool.query(
    `INSERT INTO si_conversas (organization_id, conversation_id, origem) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, conversation_id) DO NOTHING`,
    [input.organizationId, input.conversationId, input.origem],
  );
}

interface PosseVersao { versaoId: string; epoca: number }

async function reivindicarVersao(
  pool: Pool,
  input: { organizationId: string; conversationId: string; msg: MensagemSI; hash: string; modo: 'automatico' | 'manual'; workerId: string; ttl: number; maxAuto: number },
): Promise<{ posse: PosseVersao } | { status: StatusIngestao; versaoId: string }> {
  const ins = await pool.query(
    `INSERT INTO si_versoes (organization_id, conversation_id, message_id, message_received_at, conteudo_hash, estado, worker_id, expira_em)
     VALUES ($1, $2, $3, $4, $5, 'PROCESSING', $6, now() + ($7 || ' seconds')::interval)
     ON CONFLICT (organization_id, conversation_id, conteudo_hash) DO NOTHING
     RETURNING id, epoca`,
    [input.organizationId, input.conversationId, input.msg.id, input.msg.receivedDateTime, input.hash, input.workerId, String(input.ttl)],
  );
  if (ins.rows[0]) return { posse: { versaoId: ins.rows[0].id, epoca: ins.rows[0].epoca } };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, estado, tentativas, expira_em FROM si_versoes
        WHERE organization_id = $1 AND conversation_id = $2 AND conteudo_hash = $3 FOR UPDATE`,
      [input.organizationId, input.conversationId, input.hash],
    );
    const v = rows[0];
    let decisao: StatusIngestao | 'reivindicar';
    if (v.estado === 'DONE') decisao = 'ja_concluida';
    else if (v.estado === 'PROCESSING') decisao = new Date(v.expira_em).getTime() > Date.now() ? 'em_andamento' : 'reivindicar';
    else if (v.estado === 'PENDENTE') decisao = input.modo === 'manual' ? 'reivindicar' : 'aguardando_reprocessamento_manual';
    else decisao = input.modo === 'manual' || v.tentativas < input.maxAuto ? 'reivindicar' : 'tentativas_esgotadas';
    if (decisao !== 'reivindicar') { await client.query('COMMIT'); return { status: decisao, versaoId: v.id }; }
    const up = await client.query(
      `UPDATE si_versoes SET estado = 'PROCESSING', epoca = epoca + 1, tentativas = tentativas + 1, worker_id = $2,
         expira_em = now() + ($3 || ' seconds')::interval, erro = NULL, iniciada_em = now(), concluida_em = NULL, atualizado_em = now()
       WHERE id = $1 RETURNING epoca`,
      [v.id, input.workerId, String(input.ttl)],
    );
    await client.query('COMMIT');
    return { posse: { versaoId: v.id, epoca: up.rows[0].epoca } };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

/** Resultado da leitura documental (fora de transação). */
interface Leitura {
  ocorrencias: OcorrenciaFreeTime[];
  problemas: ProblemaExtracao[];
  refs: { processos: string[]; mbls: string[]; containers: string[] };
}

async function lerShippingInstructions(msg: MensagemSI, portas: PortasShippingInstructions): Promise<Leitura> {
  const refs = extrairReferencias(`${msg.subject ?? ''}\n${msg.body}`);
  const corpo = extrairFreeTimeDoCorpo(msg.body);
  const ocorrencias = [...corpo.ocorrencias];
  const problemas = [...corpo.problemas];
  const processos = new Set(refs.processos), mbls = new Set(refs.mbls), containers = new Set(refs.containers);
  for (const anexo of msg.attachments.filter(anexoDocumental)) {
    const conteudo = await portas.lerAnexo(msg.id, anexo);
    if (!conteudo) {
      problemas.push({ tipo: 'ocr_baixa_confianca', motivo: 'anexo_sem_conteudo', attachmentId: anexo.id, attachmentNome: anexo.name, confianca: 0 });
      continue;
    }
    const r = await portas.lerDocumento({ ...conteudo, nome: anexo.name });
    const av = avaliarOcr(anexo, r);
    ocorrencias.push(...av.ocorrencias);
    problemas.push(...av.problemas);
    if (av.ocorrencias.length) {
      for (const o of av.ocorrencias) for (const n of o.containers) containers.add(n);
      if (r.mbl && normalizarMbl(r.mbl)) mbls.add(normalizarMbl(r.mbl));
      // Código integral (IM3126-26): nunca reduzido à base.
      if (r.processo && /^IM\d{3,6}(?:-\d{1,3})?$/i.test(normalizarProcesso(r.processo))) processos.add(normalizarProcesso(r.processo));
    }
  }
  return { ocorrencias, problemas, refs: { processos: [...processos], mbls: [...mbls], containers: [...containers] } };
}

function hashContexto(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface ProcessoResolvido { id: string; numero: string | null; mbl: string | null }

export type AssociacaoPor = 'numero_processo' | 'mbl' | 'numero_processo_e_mbl';

type Resolucao =
  | { ok: true; processo: ProcessoResolvido; associacao: AssociacaoPor }
  | { ok: false; pendencias: PendenciaSI[] };

/**
 * Associação SEGURA ao processo: exatamente um processo da organização, sem
 * conflito de refs. O código é comparado INTEGRALMENTE (IM3126-26 ≠ IM3126).
 * A SI real é emitida antes do MBL: um único código de processo explícito
 * basta — MBL ausente não bloqueia, não vira pendência e não é inventado.
 */
async function resolverProcesso(db: PoolClient, organizationId: string, refs: Leitura['refs']): Promise<Resolucao> {
  if (refs.processos.length > 1 || refs.mbls.length > 1) {
    return { ok: false, pendencias: [{ tipo: 'conversa_multiprocesso', motivo: 'multiplas_referencias_na_si', contexto: { processos: refs.processos, mbls: refs.mbls } }] };
  }
  if (!refs.processos.length && !refs.mbls.length) {
    return { ok: false, pendencias: [
      { tipo: 'processo_nao_identificado', motivo: 'si_sem_numero_de_processo' },
      { tipo: 'mbl_nao_identificado', motivo: 'si_sem_mbl' },
    ] };
  }
  const { rows } = await db.query(
    `SELECT id, numero_processo, mbl FROM processos
      WHERE organization_id = $1
        AND (upper(regexp_replace(coalesce(numero_processo, ''), '[[:space:]]', '', 'g')) = ANY($2::text[])
             OR upper(regexp_replace(coalesce(mbl, ''), '[[:space:]./-]', '', 'g')) = ANY($3::text[]))
      ORDER BY id`,
    [organizationId, refs.processos, refs.mbls],
  );
  if (rows.length === 0) {
    return { ok: false, pendencias: [{ tipo: 'processo_nao_identificado', motivo: 'referencias_sem_processo', contexto: { processos: refs.processos, mbls: refs.mbls } }] };
  }
  if (rows.length > 1) {
    return { ok: false, pendencias: [{ tipo: 'conversa_multiprocesso', motivo: 'referencias_casam_varios_processos', contexto: { processos: rows.map((r) => r.id) } }] };
  }
  const p: ProcessoResolvido = { id: rows[0].id, numero: rows[0].numero_processo, mbl: rows[0].mbl };
  const mblSi = refs.mbls[0], mblP = p.mbl ? normalizarMbl(p.mbl) : null;
  const procSi = refs.processos[0], procP = p.numero ? normalizarProcesso(p.numero) : null;
  if ((mblSi && mblP && mblSi !== mblP) || (procSi && procP && procSi !== procP)) {
    return { ok: false, pendencias: [{ tipo: 'alcance_nao_determinado', motivo: 'processo_e_mbl_da_si_nao_conferem', processoId: p.id, mbl: mblSi ?? null, contexto: { mblSi, mblProcesso: mblP, processoSi: procSi, processoCadastro: procP } }] };
  }
  const porNumero = !!procSi && procSi === procP;
  const porMbl = !!mblSi && mblSi === mblP;
  return { ok: true, processo: p, associacao: porNumero && porMbl ? 'numero_processo_e_mbl' : porNumero ? 'numero_processo' : 'mbl' };
}

interface IntencaoRow {
  id: string;
  campo: CampoFreeTime;
  /** 'mbl' = nível do processo inteiro (vale para os contêineres atuais e futuros). */
  escopo: 'mbl' | 'container';
  container_numero: string | null;
  valor_dias: number;
  encontrado_em: 'corpo' | 'anexo';
  attachment_id: string | null;
  attachment_nome: string | null;
  trecho_evidencia: string;
  metodo_extracao: 'texto' | 'ocr_visao';
  confianca: string | number;
  conteudo_hash: string;
  processos_ref: string[];
  mbls_ref: string[];
  containers_ref: string[];
}

interface ContextoVersao {
  organizationId: string;
  conversationId: string;
  messageId: string;
  messageReceivedAt: Date;
  versaoId: string;
  autor: string;
}

/**
 * Aplica as intenções de uma versão (DENTRO da transação do chamador): resolve o
 * processo, calcula o alcance, promove pelo serviço central e grava a
 * proveniência. Devolve as pendências de associação e o total promovido.
 * Usado pela ingestão e pela reaplicação (sem reler o documento).
 */
async function aplicarIntencoes(
  client: PoolClient,
  ctx: ContextoVersao,
  intencoes: IntencaoRow[],
  /**
   * D15-B (R05) — true quando ESTA leitura não trouxe Master Free Time
   * explícito (ver `pendenciasDaLeitura`/`temMaster` no chamador). Além da
   * pendência de leitura já existente (`si_pendencias.free_time_nao_encontrado`,
   * nível processo — vale mesmo sem contêiner cadastrado), registra a
   * TENTATIVA por contêiner JÁ CONHECIDO neste processo (histórico append-only
   * de `free_time_tentativas`, compartilhado com House/Master de outras
   * fontes). Sem contêiner conhecido ainda, nada é gravado aqui — a pendência
   * de leitura é o único registro possível até existir um contêiner.
   */
  masterNaoEncontrado = false,
): Promise<{ pendencias: PendenciaSI[]; promovidos: number }> {
  if (!intencoes.length) return { pendencias: [], promovidos: 0 };
  const refs = { processos: intencoes[0].processos_ref, mbls: intencoes[0].mbls_ref, containers: intencoes[0].containers_ref };
  const res = await resolverProcesso(client, ctx.organizationId, refs);
  if (!res.ok) return { pendencias: res.pendencias, promovidos: 0 };
  const P = res.processo;
  const pendencias: PendenciaSI[] = [];

  const { rows: cs } = await client.query(
    `SELECT id, numero, processo_id FROM containers WHERE organization_id = $1 AND processo_id = $2 ORDER BY id`,
    [ctx.organizationId, P.id],
  );
  const doProcesso = new Map<string, string>();
  for (const c of cs) { const n = normalizarContainer(c.numero); if (n) doProcesso.set(n, c.id); }

  if (masterNaoEncontrado) {
    for (const containerId of doProcesso.values()) {
      await registrarTentativaNaoEncontrada(client, {
        organizationId: ctx.organizationId, processoId: P.id, containerId, campo: 'masterFreeTimeDays',
        fonteTentada: 'shipping_instructions', motivo: 'master_free_time_ausente',
        evidenciaRef: `si_versao:${ctx.versaoId}`,
      });
    }
  }

  // Contêineres citados que não estão no processo: de outro processo → alcance
  // incerto; inexistentes → aguardam criação (nunca criados pela SI).
  const citados = new Set<string>([...refs.containers, ...intencoes.filter((i) => i.escopo === 'container').map((i) => i.container_numero!)]);
  for (const n of [...citados].sort()) {
    if (doProcesso.has(n)) continue;
    const { rows: outro } = await client.query(
      `SELECT processo_id FROM containers WHERE organization_id = $1
          AND upper(regexp_replace(numero, '[^A-Za-z0-9]', '', 'g')) = $2 LIMIT 1`,
      [ctx.organizationId, n],
    );
    pendencias.push(outro[0]
      ? { tipo: 'alcance_nao_determinado', motivo: 'container_de_outro_processo', processoId: P.id, mbl: P.mbl, containerNumero: n, contexto: { outroProcessoId: outro[0].processo_id } }
      : { tipo: 'container_nao_encontrado', motivo: 'container_citado_inexistente', processoId: P.id, mbl: P.mbl, containerNumero: n });
  }

  // Exceções por contêiner valem POR CAMPO (House e Master são independentes).
  const excecoes = (campo: CampoFreeTime) =>
    new Set(intencoes.filter((i) => i.campo === campo && i.escopo === 'container').map((i) => i.container_numero!));
  const alvos: Array<{ intencao: IntencaoRow; containerId: string }> = [];
  for (const i of intencoes) {
    if (i.escopo === 'container') {
      const id = doProcesso.get(i.container_numero!);
      if (id) alvos.push({ intencao: i, containerId: id });
      continue;
    }
    // Nível do processo: aplica aos contêineres ATUAIS; os futuros recebem pela
    // reaplicação. Processo ainda sem contêiner não é erro nem pendência.
    const ex = excecoes(i.campo);
    for (const [n, id] of doProcesso) if (!ex.has(n)) alvos.push({ intencao: i, containerId: id });
  }

  let promovidos = 0;
  for (const { intencao: i, containerId } of alvos) {
    const base = {
      organizationId: ctx.organizationId, containerId, valor: i.valor_dias, fonte: 'shipping_instructions' as const,
      observadoEm: ctx.messageReceivedAt, evidenciaRef: `si_intencao:${i.id}`,
    };
    // Master: serviço central (divergência SI × Master + recálculo). House:
    // writer transacional com a hierarquia de fontes. Ambos na MESMA transação.
    const r = i.campo === 'masterFreeTimeDays'
      ? await promoverMasterFreeTimeComClient(client, { ...base, autor: ctx.autor })
      : await promoverHouseFreeTimeComClient(client, base);
    if (r.conflitoMesmaFonte) {
      pendencias.push({ tipo: 'free_time_ambiguo', motivo: 'valor_diferente_para_mesma_mensagem', processoId: P.id, mbl: P.mbl, containerId, chave: i.campo, contexto: { campo: i.campo, intencaoId: i.id, valorNovo: i.valor_dias } });
      continue;
    }
    const { rowCount } = await client.query(
      `INSERT INTO si_proveniencias
         (organization_id, intencao_id, field_observation_id, processo_id, container_id, conversation_id, message_id,
          message_received_at, encontrado_em, attachment_id, attachment_nome, trecho_evidencia, valor_dias,
          metodo_extracao, confianca, conteudo_hash, observado_em, campo, associacao_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$8,$17,$18)
       ON CONFLICT (intencao_id, container_id) DO NOTHING`,
      [ctx.organizationId, i.id, r.observationId, P.id, containerId, ctx.conversationId, ctx.messageId, ctx.messageReceivedAt,
        i.encontrado_em, i.attachment_id, i.attachment_nome, i.trecho_evidencia, i.valor_dias, i.metodo_extracao, i.confianca, i.conteudo_hash,
        i.campo, res.associacao],
    );
    promovidos += rowCount ?? 0;
  }
  return { pendencias, promovidos };
}

/**
 * Grava as pendências (idempotentes por hash de contexto) e resolve as abertas
 * da conversa que não se repetiram, restritas aos `tiposResolviveis`. Devolve
 * quantas continuam abertas na conversa.
 */
async function sincronizarPendencias(
  client: PoolClient,
  ctx: ContextoVersao,
  pendencias: PendenciaSI[],
  tiposResolviveis: TipoPendenciaSI[],
): Promise<number> {
  const hashes: string[] = [];
  for (const p of pendencias) {
    const h = hashContexto({
      org: ctx.organizationId, conversa: ctx.conversationId, tipo: p.tipo, motivo: p.motivo,
      processo: p.processoId ?? null, container: p.containerId ?? null, numero: p.containerNumero ?? null, chave: p.chave ?? null,
    });
    hashes.push(h);
    await client.query(
      `INSERT INTO si_pendencias (organization_id, conversation_id, message_id, versao_id, processo_id, mbl, container_id,
                                  container_numero, tipo, motivo, contexto, contexto_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, contexto_hash) WHERE estado = 'aberta' DO NOTHING`,
      [ctx.organizationId, ctx.conversationId, ctx.messageId, ctx.versaoId, p.processoId ?? null, p.mbl ?? null,
        p.containerId ?? null, p.containerNumero ?? null, p.tipo, p.motivo, JSON.stringify(p.contexto ?? {}), h],
    );
  }
  await client.query(
    `UPDATE si_pendencias SET estado = 'resolvida', resolvido_em = now(), resolvido_por = $4
      WHERE organization_id = $1 AND conversation_id = $2 AND estado = 'aberta'
        AND NOT (contexto_hash = ANY($3::text[])) AND tipo = ANY($5::text[])`,
    [ctx.organizationId, ctx.conversationId, hashes, ctx.autor, tiposResolviveis],
  );
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM si_pendencias WHERE organization_id = $1 AND conversation_id = $2 AND estado = 'aberta'`,
    [ctx.organizationId, ctx.conversationId],
  );
  return rows[0].n;
}

function pendenciasDaLeitura(leitura: Leitura, temMaster: boolean): PendenciaSI[] {
  const out: PendenciaSI[] = [];
  for (const p of leitura.problemas) {
    if (p.tipo === 'ocr_baixa_confianca') {
      out.push({ tipo: p.tipo, motivo: p.motivo, chave: `anexo:${p.attachmentId}`, contexto: { attachmentId: p.attachmentId, attachmentNome: p.attachmentNome, confianca: p.confianca } });
    } else {
      out.push({
        tipo: 'free_time_ambiguo', motivo: p.motivo, chave: `${p.campo ?? ''}:${p.attachmentId ?? 'corpo'}:${(p.containers ?? []).join(',')}:${p.trecho ?? ''}`,
        containerNumero: p.containers && p.containers.length === 1 ? p.containers[0] : null,
        contexto: { campo: p.campo ?? null, trecho: p.trecho ?? null, attachmentId: p.attachmentId ?? null, containers: p.containers ?? [] },
      });
    }
  }
  // Ausência do MASTER Free Time é pendência (deixa o relógio Rocket pendente).
  // House ausente na SI não é pendência: sua fonte natural é o documento House.
  const masterTratado = temMaster || leitura.problemas.some((p) => p.tipo === 'ocr_baixa_confianca' || (p.tipo === 'free_time_ambiguo' && (p.campo ?? 'masterFreeTimeDays') === 'masterFreeTimeDays'));
  if (!masterTratado) out.push({ tipo: 'free_time_nao_encontrado', motivo: 'master_free_time_ausente', chave: 'masterFreeTimeDays' });
  return out;
}

async function inserirIntencao(
  client: PoolClient,
  ctx: ContextoVersao & { conteudoHash: string; refs: Leitura['refs'] },
  o: OcorrenciaFreeTime,
  escopo: 'mbl' | 'container',
  containerNumero: string | null,
): Promise<{ row: IntencaoRow; divergente: boolean }> {
  const campo = o.campo;
  const ins = await client.query(
    `INSERT INTO si_intencoes
       (organization_id, versao_id, conversation_id, message_id, message_received_at, processos_ref, mbls_ref, containers_ref,
        escopo, container_numero, valor_dias, encontrado_em, attachment_id, attachment_nome, trecho_evidencia,
        metodo_extracao, confianca, conteudo_hash, campo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (versao_id, campo, escopo, (COALESCE(container_numero, ''))) DO NOTHING
     RETURNING *`,
    [ctx.organizationId, ctx.versaoId, ctx.conversationId, ctx.messageId, ctx.messageReceivedAt, ctx.refs.processos, ctx.refs.mbls,
      ctx.refs.containers, escopo, containerNumero, o.valor, o.encontradoEm, o.attachmentId, o.attachmentNome, o.trecho,
      o.metodo, o.confianca, ctx.conteudoHash, campo],
  );
  if (ins.rows[0]) return { row: ins.rows[0], divergente: false };
  // Reprocesso da MESMA versão: a intenção já existe (append-only). Se a nova
  // leitura discordar do valor já registrado, é ambiguidade — nada muda.
  const { rows } = await client.query(
    `SELECT * FROM si_intencoes WHERE versao_id = $1 AND campo = $2 AND escopo = $3 AND COALESCE(container_numero, '') = $4`,
    [ctx.versaoId, campo, escopo, containerNumero ?? ''],
  );
  return { row: rows[0], divergente: rows[0].valor_dias !== o.valor };
}

/** Ingestão da SI de uma conversa. Idempotente por versão do conteúdo. */
export async function ingerirShippingInstructions(input: IngerirInput): Promise<IngerirResultado> {
  const pool = input.pool ?? getPool();
  const workerId = input.workerId ?? `si-${process.pid}`;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 10 * 60_000) / 1000));
  const autor = input.autor ?? `si:${input.modo}`;

  const mensagens = await input.portas.carregarConversa(input.conversationId);
  const msg = primeiraMensagem(mensagens);
  if (!msg) return { status: 'conversa_vazia', promovidos: 0, pendenciasAbertas: 0 };
  const hash = hashConteudo(msg);

  const claim = await reivindicarVersao(pool, {
    organizationId: input.organizationId, conversationId: input.conversationId, msg, hash, modo: input.modo,
    workerId, ttl, maxAuto: input.maxTentativasAutomaticas ?? 3,
  });
  if ('status' in claim) return { status: claim.status, versaoId: claim.versaoId, conteudoHash: hash, messageId: msg.id, promovidos: 0, pendenciasAbertas: 0 };
  const posse = claim.posse;

  const marcarFalha = async (erro: string) => {
    await pool.query(
      `UPDATE si_versoes SET estado = 'FAILED', erro = $3, worker_id = NULL, atualizado_em = now()
        WHERE id = $1 AND epoca = $2 AND estado = 'PROCESSING'`,
      [posse.versaoId, posse.epoca, erro.slice(0, 500)],
    );
  };

  // Leitura documental FORA de transação (Graph + leitura de anexos).
  let leitura: Leitura;
  try {
    leitura = await lerShippingInstructions(msg, input.portas);
  } catch (erro: any) {
    const texto = String(erro?.message ?? erro);
    await marcarFalha(texto);
    return { status: 'falhou', versaoId: posse.versaoId, conteudoHash: hash, messageId: msg.id, promovidos: 0, pendenciasAbertas: 0, erro: texto };
  }

  const ctx: ContextoVersao = {
    organizationId: input.organizationId, conversationId: input.conversationId, messageId: msg.id,
    messageReceivedAt: new Date(msg.receivedDateTime), versaoId: posse.versaoId, autor: `${autor}:versao:${posse.versaoId}`,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fencing: só o dono atual da versão persiste resultados.
    const { rows: v } = await client.query(
      `SELECT id FROM si_versoes WHERE id = $1 AND epoca = $2 AND estado = 'PROCESSING' FOR UPDATE`,
      [posse.versaoId, posse.epoca],
    );
    if (!v[0]) {
      await client.query('ROLLBACK');
      return { status: 'posse_perdida', versaoId: posse.versaoId, conteudoHash: hash, messageId: msg.id, promovidos: 0, pendenciasAbertas: 0 };
    }

    const cons = consolidarOcorrencias(leitura.ocorrencias);
    leitura.problemas.push(...cons.problemas);
    const intencoes: IntencaoRow[] = [];
    const extras: PendenciaSI[] = [];
    const ctxI = { ...ctx, conteudoHash: hash, refs: leitura.refs };
    const registrar = async (o: OcorrenciaFreeTime, escopo: 'mbl' | 'container', numero: string | null) => {
      const r = await inserirIntencao(client, ctxI, o, escopo, numero);
      if (r.divergente) extras.push({ tipo: 'free_time_ambiguo', motivo: 'leituras_divergentes_mesma_versao', containerNumero: numero, chave: `intencao:${r.row.id}`, contexto: { campo: o.campo, intencaoId: r.row.id, valorRegistrado: r.row.valor_dias, valorNovo: o.valor } });
      else intencoes.push(r.row);
    };
    for (const campo of CAMPOS_FREE_TIME_SI) {
      const cc = cons.porCampo[campo];
      if (cc.nivelMbl) await registrar(cc.nivelMbl, 'mbl', null);
      for (const [n, o] of cc.porContainer) await registrar(o, 'container', n);
    }

    const temMaster = intencoes.some((i) => i.campo === 'masterFreeTimeDays');
    const aplicado = await aplicarIntencoes(client, ctx, intencoes, !temMaster);
    const pendencias = [...pendenciasDaLeitura(leitura, temMaster), ...extras, ...aplicado.pendencias];
    const abertas = await sincronizarPendencias(client, ctx, pendencias, [...TIPOS_EXTRACAO, ...TIPOS_ASSOCIACAO]);
    const estado = abertas === 0 ? 'DONE' : 'PENDENTE';
    await client.query(
      `UPDATE si_versoes SET estado = $2, worker_id = NULL, concluida_em = now(), atualizado_em = now() WHERE id = $1`,
      [posse.versaoId, estado],
    );
    await client.query('COMMIT');
    return {
      status: estado === 'DONE' ? 'concluida' : 'pendente', versaoId: posse.versaoId, conteudoHash: hash, messageId: msg.id,
      promovidos: aplicado.promovidos, pendenciasAbertas: abertas,
    };
  } catch (erro: any) {
    await client.query('ROLLBACK');
    const texto = String(erro?.message ?? erro);
    await marcarFalha(texto);
    return { status: 'falhou', versaoId: posse.versaoId, conteudoHash: hash, messageId: msg.id, promovidos: 0, pendenciasAbertas: 0, erro: texto };
  } finally {
    client.release();
  }
}

/**
 * Reaplica, SEM reler o documento, as intenções já extraídas da versão mais
 * recente (DONE/PENDENTE) de cada conversa: contêineres criados depois recebem o
 * valor; pendências de associação que deixaram de existir são resolvidas.
 * Pendências de leitura (ambiguidade, baixa confiança, não encontrado) só se
 * resolvem com nova leitura (POST) — não são tocadas aqui.
 */
export async function reaplicarIntencoesShippingInstructions(input: { pool?: Pool; organizationId?: string; autor?: string }): Promise<{ versoes: number; promovidos: number }> {
  const pool = input.pool ?? getPool();
  const { rows: candidatas } = await pool.query(
    `WITH ultimas AS (
       SELECT DISTINCT ON (organization_id, conversation_id) id, organization_id, conversation_id, estado
         FROM si_versoes
        WHERE estado IN ('DONE', 'PENDENTE') AND ($1::uuid IS NULL OR organization_id = $1)
        ORDER BY organization_id, conversation_id, criado_em DESC)
     SELECT u.id FROM ultimas u
      WHERE u.estado = 'PENDENTE'
         OR EXISTS (
           SELECT 1 FROM si_intencoes i
             JOIN processos p ON p.organization_id = i.organization_id
              AND (upper(regexp_replace(coalesce(p.numero_processo, ''), '[[:space:]]', '', 'g')) = ANY(i.processos_ref)
                   OR upper(regexp_replace(coalesce(p.mbl, ''), '[[:space:]./-]', '', 'g')) = ANY(i.mbls_ref))
             JOIN containers c ON c.processo_id = p.id AND c.organization_id = p.organization_id
            WHERE i.versao_id = u.id
              AND NOT EXISTS (SELECT 1 FROM si_proveniencias pv WHERE pv.intencao_id = i.id AND pv.container_id = c.id)
              AND (i.escopo = 'container' AND upper(regexp_replace(c.numero, '[^A-Za-z0-9]', '', 'g')) = i.container_numero
                   OR i.escopo = 'mbl' AND NOT EXISTS (
                        SELECT 1 FROM si_intencoes x WHERE x.versao_id = i.versao_id AND x.campo = i.campo AND x.escopo = 'container'
                           AND x.container_numero = upper(regexp_replace(c.numero, '[^A-Za-z0-9]', '', 'g')))))
      ORDER BY u.id`,
    [input.organizationId ?? null],
  );

  let promovidos = 0;
  for (const cand of candidatas) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: vs } = await client.query(
        `SELECT * FROM si_versoes WHERE id = $1 AND estado IN ('DONE', 'PENDENTE') FOR UPDATE`, [cand.id],
      );
      const v = vs[0];
      if (!v) { await client.query('ROLLBACK'); continue; }
      const ctx: ContextoVersao = {
        organizationId: v.organization_id, conversationId: v.conversation_id, messageId: v.message_id,
        messageReceivedAt: new Date(v.message_received_at), versaoId: v.id, autor: `${input.autor ?? 'si:reaplicacao'}:versao:${v.id}`,
      };
      const { rows: intencoes } = await client.query(`SELECT * FROM si_intencoes WHERE versao_id = $1 ORDER BY escopo DESC, container_numero`, [v.id]);
      const aplicado = await aplicarIntencoes(client, ctx, intencoes);
      const abertas = await sincronizarPendencias(client, ctx, aplicado.pendencias, TIPOS_ASSOCIACAO);
      await client.query(`UPDATE si_versoes SET estado = $2, atualizado_em = now() WHERE id = $1`, [v.id, abertas === 0 ? 'DONE' : 'PENDENTE']);
      await client.query('COMMIT');
      promovidos += aplicado.promovidos;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }
  return { versoes: candidatas.length, promovidos };
}
