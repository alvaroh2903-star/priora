import { Db, ErroIdentidade, resolverMaster, resolverProcesso } from '../../identidade';
import { processosVinculadosAoMaster, vinculoDoProcesso } from '../../auditoria/fatos/vinculos';
import { fatosCourierDoProcesso } from '../../couriers/fatos/courierFatos';
import {
  Atencao, CodigoAcao, IndeterminacaoL1b, ItemOperacional, MarcoConfirmadoL1b, Responsavel, SaidaBloqueadorL1b, SaidaEtapaL1b, SaidaProximaAcaoL1b,
  SubEtapa,
} from '../dominio';
import { EstadoDisponibilidadeCourier, disponibilidadeDoCourier } from './entrada';
import { AvaliacaoLiberacao, ProjecaoLiberacao, VERSAO_PROJECAO, canonico, ehUuid, obterLiberacaoDoProcesso } from './projecao';

/**
 * L11a — contrato de LEITURA da tela da Liberação. Só lê: a projeção L2/L4
 * persistida e, para exibição, os donos de cada dado (S6 identidade e
 * pendências, S2 vínculo, S1 Courier, Auditoria, caixa monitorada, membros) —
 * sem copiar nada para a L2 e sem recalcular. A tela não decide nada: tudo o
 * que ela mostra, inclusive as três dimensões do N-17 e a decisão operacional
 * oficial (L1b), vem pronto daqui.
 *
 * Projeção gravada por versão anterior ao motor oficial (`versaoProjecao` < 3, formato da L1a) nunca é
 * apresentada como decisão: o processo aparece como "aguardando reavaliação", sem etapa nem ação.
 */

/** A projeção gravada é a decisão vigente do motor oficial (L1b)? */
const ehDecisaoVigente = (p: Pick<ProjecaoLiberacao, 'versaoProjecao'>): boolean => p.versaoProjecao >= VERSAO_PROJECAO;

/* ------------------------------ decisão operacional (L1b) ------------------------------ */

/**
 * A decisão operacional oficial pronta para exibir: os valores que a L1b gravou, copiados sem regra nova.
 * Etapa, bloqueio e próxima ação continuam saídas independentes (cap. 4). O responsável é o do próprio item
 * da L1b, e a tela diz de qual: o da próxima ação quando ela é conhecida ("Responsável pela próxima ação");
 * senão, o do bloqueio conhecido ("Responsável pelo impedimento"). Item sem responsável, ou fatos
 * insuficientes, é "não determinável": nada se deduz do MBL, da identidade, da tela ou da falta de dado.
 */
export interface DecisaoOperacional {
  etapa: SaidaEtapaL1b;
  subEtapa: SubEtapa | null;
  bloqueador: SaidaBloqueadorL1b;
  proximaAcao: SaidaProximaAcaoL1b;
  /** O bloqueio e a próxima ação são o MESMO item da L1b (o detalhe do item aparece uma vez). */
  mesmoItem: boolean;
  /**
   * CONHECIDO: o item atribui um responsável. NENHUM: nada pendente (sem bloqueio nem ação, e nada a determinar).
   * NAO_DETERMINAVEL: fatos insuficientes (`doItem` null) ou o item não atribui responsável (ex.: informação
   * indisponível, ação de Master bloqueada pelos vinculados).
   */
  responsavel:
    | { tipo: 'CONHECIDO'; quem: Responsavel; doItem: 'PROXIMA_ACAO' | 'BLOQUEIO' }
    | { tipo: 'NENHUM' }
    | { tipo: 'NAO_DETERMINAVEL'; doItem: 'PROXIMA_ACAO' | 'BLOQUEIO' | null };
  /** Atenções de consistência da L1b (não são etapa, classe nem apresentação). */
  atencoes: Atencao[];
  /** O que a Priora ainda não sabe com as fontes atuais (D-6, N-17): uma vez só, como a L1b devolveu. */
  indeterminacao: IndeterminacaoL1b;
  /** Os demais itens da decisão, além do bloqueio e da próxima ação, como a L1b os devolveu. */
  outrosItens: ItemOperacional[];
  progresso: MarcoConfirmadoL1b[];
}

function responsavelDo(
  de: { item: ItemOperacional; doItem: 'PROXIMA_ACAO' | 'BLOQUEIO' } | null, nadaPendente: boolean,
): DecisaoOperacional['responsavel'] {
  if (de) return de.item.responsavel ? { tipo: 'CONHECIDO', quem: de.item.responsavel, doItem: de.doItem } : { tipo: 'NAO_DETERMINAVEL', doItem: de.doItem };
  return nadaPendente ? { tipo: 'NENHUM' } : { tipo: 'NAO_DETERMINAVEL', doItem: null };
}

export function decisaoOperacionalDe(a: AvaliacaoLiberacao): DecisaoOperacional {
  const bloqueio = a.bloqueador.tipo === 'CONHECIDO' ? canonico(a.bloqueador.item) : null;
  const acao = a.proximaAcao.tipo === 'CONHECIDA' ? canonico(a.proximaAcao.item) : null;
  return {
    etapa: a.etapa,
    subEtapa: a.subEtapa,
    bloqueador: a.bloqueador,
    proximaAcao: a.proximaAcao,
    mesmoItem: bloqueio !== null && bloqueio === acao,
    responsavel: responsavelDo(
      a.proximaAcao.tipo === 'CONHECIDA' ? { item: a.proximaAcao.item, doItem: 'PROXIMA_ACAO' }
        : a.bloqueador.tipo === 'CONHECIDO' ? { item: a.bloqueador.item, doItem: 'BLOQUEIO' } : null,
      a.bloqueador.tipo === 'NENHUM' && a.proximaAcao.tipo === 'NENHUMA',
    ),
    atencoes: a.atencoes,
    indeterminacao: a.indeterminacao,
    outrosItens: a.itens.filter((i) => canonico(i) !== bloqueio && canonico(i) !== acao),
    progresso: a.progresso,
  };
}

/* ------------------------------ inclusão na Liberação ------------------------------ */

/**
 * Por que o processo está na Liberação (decisão congelada). Só estes três
 * fatos já existentes da Vertical 1 qualificam; identidade central sozinha
 * (processo que só existe pela Demurrage ou pelo legado), `apuracao_status`,
 * campos da Demurrage, código-base ou semelhança nunca qualificam:
 *  - AVALIACAO_GRAVADA: há projeção L2 do processo;
 *  - VINCULO_COM_MASTER: há linha de vínculo Processo↔Master que o S2 ainda
 *    considera válida (as duas identidades ainda resolvem igual no S6) —
 *    publicada (VINCULADO) ou em CONFLITO;
 *  - CONFERENCIA_NO_COURIER: há conferência do S1 cuja referência EXATA o S6
 *    resolve hoje para o processo (código ou alias vigente).
 */
export type MotivoDeInclusao = 'AVALIACAO_GRAVADA' | 'VINCULO_COM_MASTER' | 'CONFERENCIA_NO_COURIER';
const ORDEM_MOTIVOS: MotivoDeInclusao[] = ['AVALIACAO_GRAVADA', 'VINCULO_COM_MASTER', 'CONFERENCIA_NO_COURIER'];

/** Disponibilidade do Courier AGORA, lida do dono (caixa monitorada) — a 3ª dimensão do N-17. */
export interface FonteCourierAgora {
  fonte: 'COURIER';
  estado: EstadoDisponibilidadeCourier;
  desde: string;
}

async function fonteCourierAgora(db: Db, organizationId: string): Promise<FonteCourierAgora> {
  const d = await disponibilidadeDoCourier(db, organizationId);
  return { fonte: 'COURIER', estado: d.estado, desde: d.fonte.desde };
}

/** Processos da organização com contexto de Liberação e os motivos de cada um. Só leitura. */
async function processosComContexto(db: Db, organizationId: string): Promise<Map<string, Set<MotivoDeInclusao>>> {
  const motivos = new Map<string, Set<MotivoDeInclusao>>();
  const anotar = (processoId: string, m: MotivoDeInclusao) => motivos.set(processoId, (motivos.get(processoId) ?? new Set()).add(m));
  const avaliados = await db.query(`SELECT processo_id FROM liberacao_avaliacoes WHERE organization_id = $1`, [organizationId]);
  for (const r of avaliados.rows) anotar(r.processo_id, 'AVALIACAO_GRAVADA');
  const vinculados = await db.query(
    `SELECT DISTINCT processo_id FROM processo_master_vinculos WHERE organization_id = $1`, [organizationId],
  );
  for (const r of vinculados.rows) {
    if ((await vinculoDoProcesso(db, organizationId, r.processo_id)).tipo !== 'SEM_VINCULO') anotar(r.processo_id, 'VINCULO_COM_MASTER');
  }
  const conferidas = await db.query(
    `SELECT DISTINCT processo_ref FROM courier_fatos WHERE organization_id = $1 AND tipo = 'CONFERENCIA_DOCUMENTO'`, [organizationId],
  );
  for (const r of conferidas.rows) {
    const processoId = await processoDaReferencia(db, organizationId, r.processo_ref);
    if (processoId) anotar(processoId, 'CONFERENCIA_NO_COURIER');
  }
  return motivos;
}

/** Os mesmos três critérios para UM processo, pelos contratos de saída dos donos (S2 e S1). */
async function motivosDoProcesso(db: Db, organizationId: string, processoId: string, avaliado: boolean): Promise<MotivoDeInclusao[]> {
  const out: MotivoDeInclusao[] = [];
  if (avaliado) out.push('AVALIACAO_GRAVADA');
  if ((await vinculoDoProcesso(db, organizationId, processoId)).tipo !== 'SEM_VINCULO') out.push('VINCULO_COM_MASTER');
  if ((await fatosCourierDoProcesso(db, organizationId, processoId)).assuntos.length > 0) out.push('CONFERENCIA_NO_COURIER');
  return out;
}

/* ------------------------------------ lista ------------------------------------ */

/** Resumo para a lista, lido da decisão gravada (nada recalculado, nada presumido). */
export interface ResumoDaLiberacao {
  master: { situacao: string; via: string | null; motivo: string | null };
  house: { situacao: string };
  etapa: { tipo: string; etapa: string | null };
  /** Bloqueio e próxima ação da L1b: o motivo e a ação quando conhecidos (null = nenhum ou não determinável, em `tipo`). */
  bloqueio: { tipo: string; motivo: string | null };
  proximaAcao: { tipo: string; acao: CodigoAcao | null; responsavel: Responsavel | null };
  /** Divergências em ABERTA ou EM_ANALISE (N-14). */
  divergenciasAtivas: number;
  terminal: boolean;
  alteradoEm: string;
}

export interface ItemDaLista {
  processoId: string;
  /** Código do processo na identidade central (S6); null = ainda sem código. */
  codigo: string | null;
  /** false = há contexto de Liberação, mas a avaliação ainda não foi gravada (não quer dizer que não há fatos). */
  avaliado: boolean;
  /** true = a avaliação gravada é anterior ao motor oficial (L1b): não é decisão vigente e não tem resumo. */
  reavaliacaoPendente: boolean;
  motivosDeInclusao: MotivoDeInclusao[];
  resumo: ResumoDaLiberacao | null;
}

export interface ListaDaLiberacao {
  processos: ItemDaLista[];
  fonteCourier: FonteCourierAgora;
}

const ATIVAS = ['ABERTA', 'EM_ANALISE'];

function resumir(p: ProjecaoLiberacao): ResumoDaLiberacao {
  const a = p.avaliacao;
  const r = a.master.l1a.resolucao as { tipo: string; via?: string; motivo?: string };
  return {
    master: { situacao: r.tipo, via: r.via ?? null, motivo: r.motivo ?? null },
    house: { situacao: a.house.l1a.tipo },
    etapa: { tipo: a.etapa.tipo, etapa: a.etapa.tipo === 'DETERMINADA' ? a.etapa.etapa : null },
    bloqueio: { tipo: a.bloqueador.tipo, motivo: a.bloqueador.tipo === 'CONHECIDO' ? a.bloqueador.item.motivo : null },
    proximaAcao: a.proximaAcao.tipo === 'CONHECIDA'
      ? { tipo: a.proximaAcao.tipo, acao: a.proximaAcao.item.acao, responsavel: a.proximaAcao.item.responsavel }
      : { tipo: a.proximaAcao.tipo, acao: null, responsavel: null },
    divergenciasAtivas: (a.divergencias ?? []).filter((d) => ATIVAS.includes(d.divergencia.estado)).length,
    terminal: p.terminal,
    alteradoEm: p.alteradoEm,
  };
}

/** Só os processos da organização com contexto de Liberação. Ordem neutra (código), sem priorização. Nada é gravado. */
export async function listarLiberacao(db: Db, organizationId: string): Promise<ListaDaLiberacao> {
  const motivos = await processosComContexto(db, organizationId);
  const fonteCourier = await fonteCourierAgora(db, organizationId);
  if (motivos.size === 0) return { processos: [], fonteCourier };
  const { rows } = await db.query(
    `SELECT p.id, p.numero_processo, a.processo_id IS NOT NULL AS avaliado,
            a.avaliacao, a.fontes, a.impressao_material, a.versao_projecao, a.sequencia, a.terminal, a.avaliado_em, a.alterado_em
       FROM processos p
       LEFT JOIN liberacao_avaliacoes a ON a.organization_id = p.organization_id AND a.processo_id = p.id
      WHERE p.organization_id = $1 AND p.id = ANY($2::uuid[])
      ORDER BY p.numero_processo NULLS LAST, p.id`,
    [organizationId, [...motivos.keys()]],
  );
  return {
    fonteCourier,
    processos: rows.map((r) => ({
      processoId: r.id,
      codigo: r.numero_processo ?? null,
      avaliado: r.avaliado,
      reavaliacaoPendente: r.avaliado && !ehDecisaoVigente({ versaoProjecao: r.versao_projecao }),
      motivosDeInclusao: ORDEM_MOTIVOS.filter((m) => motivos.get(r.id)!.has(m)),
      resumo: r.avaliado && ehDecisaoVigente({ versaoProjecao: r.versao_projecao })
        ? resumir({
          organizationId, processoId: r.id, avaliacao: r.avaliacao, fontes: r.fontes, impressaoMaterial: r.impressao_material,
          versaoProjecao: r.versao_projecao, sequencia: r.sequencia, terminal: r.terminal,
          avaliadoEm: new Date(r.avaliado_em).toISOString(), alteradoEm: new Date(r.alterado_em).toISOString(),
        })
        : null,
    })),
  };
}

/* ------------------------------ evidências legíveis ------------------------------ */

/** Autor de um fato do Courier: a membership real; o nome só quando os dados do membro o têm (nunca inventado). */
export interface AutorDoFato { membershipId: string; nome: string | null }

/** Evidência legível: rótulo humano e o mínimo do dono para entender a fonte. A referência técnica fica em `ref`. */
export type EvidenciaLegivel =
  | {
    ref: string; tipo: 'COURIER_CONFERENCIA'; rotulo: string; documento: string; valor: string; envelope: string;
    referencia: string; proveniencia: string; registradoEm: string; autor: AutorDoFato;
  }
  | { ref: string; tipo: 'COURIER_ENVELOPE'; rotulo: string; valor: string; envelope: string; registradoEm: string; autor: AutorDoFato }
  | { ref: string; tipo: 'AUDITORIA_EXTRACAO'; rotulo: string; anexo: string; documento: string; recebidoEm: string | null }
  | { ref: string; tipo: 'OUTRA'; rotulo: string };

const REF = /\b(courier_fato|auditoria_extracao):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

async function evidenciasLegiveis(db: Db, organizationId: string, p: ProjecaoLiberacao): Promise<Record<string, EvidenciaLegivel>> {
  const refs = new Set<string>();
  for (const m of JSON.stringify(p.avaliacao).matchAll(REF)) refs.add(m[0]);
  const c = p.fontes.courier;
  for (const id of [c.mblFatoId, c.hblOriginalFatoId, c.envelopeFatoId, ...c.naoPublicadosFatoIds]) if (id) refs.add(`courier_fato:${id}`);
  for (const id of p.fontes.vinculo.situacao === 'SEM_VINCULO' ? [] : p.fontes.vinculo.extracaoIds) refs.add(`auditoria_extracao:${id}`);

  const ids = (prefixo: string) => [...refs].filter((r) => r.startsWith(`${prefixo}:`)).map((r) => r.slice(prefixo.length + 1));
  const out: Record<string, EvidenciaLegivel> = {};
  const courier = ids('courier_fato');
  if (courier.length) {
    const { rows } = await db.query(
      `SELECT f.id, f.tipo, f.documento, f.valor, f.tracking_bruto, f.processo_ref_bruta, f.associacao, f.registrado_em,
              f.autor_membership_id, u.nome AS autor_nome
         FROM courier_fatos f
         LEFT JOIN organization_memberships m ON m.id = f.autor_membership_id AND m.organization_id = f.organization_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE f.organization_id = $1 AND f.id = ANY($2::uuid[])`, [organizationId, courier],
    );
    for (const r of rows) {
      const ref = `courier_fato:${r.id}`;
      const registradoEm = new Date(r.registrado_em).toISOString();
      const autor: AutorDoFato = { membershipId: r.autor_membership_id, nome: String(r.autor_nome ?? '').trim() || null };
      out[ref] = r.tipo === 'ESTADO_ENVELOPE'
        ? { ref, tipo: 'COURIER_ENVELOPE', rotulo: 'Estado do envelope no Courier', valor: r.valor, envelope: r.tracking_bruto, registradoEm, autor }
        : {
          ref, tipo: 'COURIER_CONFERENCIA', rotulo: 'Conferência no Courier', documento: r.documento, valor: r.valor,
          envelope: r.tracking_bruto, referencia: r.processo_ref_bruta, proveniencia: r.associacao, registradoEm, autor,
        };
    }
  }
  const auditoria = ids('auditoria_extracao');
  if (auditoria.length) {
    const { rows } = await db.query(
      `SELECT id, attachment_nome, tipo_detectado, mensagem_recebida_em
         FROM auditoria_extracoes WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [organizationId, auditoria],
    );
    for (const r of rows) {
      const ref = `auditoria_extracao:${r.id}`;
      out[ref] = {
        ref, tipo: 'AUDITORIA_EXTRACAO', rotulo: 'Documento lido pela Auditoria', anexo: r.attachment_nome, documento: r.tipo_detectado,
        recebidoEm: r.mensagem_recebida_em ? new Date(r.mensagem_recebida_em).toISOString() : null,
      };
    }
  }
  for (const ref of refs) if (!out[ref]) out[ref] = { ref, tipo: 'OUTRA', rotulo: 'Evidência registrada' };
  return out;
}

/* ------------------------------ pendências de identidade (S6) ------------------------------ */

/**
 * Pendência de identidade ATIVA (ABERTA / EM_ANALISE, N-14) ligada a este
 * processo ou ao seu Master pelo PRÓPRIO S6 — nunca por palpite:
 *  - REFERENCIA_DESTE_PROCESSO: a chave da pendência é uma referência que o S6
 *    resolve hoje para este processo (código ou alias vigente);
 *  - PROCESSO_INDICADO_PELA_EVIDENCIA: ALIAS_CONFLITANTE cuja evidência indica
 *    este processo (`processo_indicado_id`, gravado pelo S6);
 *  - REFERENCIA_DESTE_MASTER: o S6, avaliando a referência da própria pendência,
 *    resolve para este Master ou o aponta como candidato.
 * Referência sem identidade (REFERENCIA_INCOMPLETA, PROCESSO_NAO_ENCONTRADO,
 * MASTER_NAO_ENCONTRADO sem candidato) não é ligada a processo nenhum.
 */
export interface PendenciaDeIdentidade {
  id: string;
  entidade: 'PROCESSO' | 'MASTER';
  motivo: string;
  estado: string;
  referencia: string;
  armador: string | null;
  observadaEm: string;
  fonte: string;
  evidenciaRef: string;
  relacao: 'REFERENCIA_DESTE_PROCESSO' | 'PROCESSO_INDICADO_PELA_EVIDENCIA' | 'REFERENCIA_DESTE_MASTER';
  /** ALIAS_CONFLITANTE: o outro processo do conflito, quando o S6 o identifica. */
  outroProcesso: { processoId: string; codigo: string | null } | null;
}

const COLUNAS_PENDENCIA = `id, entidade_tipo, motivo, estado, referencia_original, chave, armador_codigo, observado_em, fonte, evidencia_ref,
  processo_indicado_id`;

function pendencia(r: Record<string, any>, relacao: PendenciaDeIdentidade['relacao'], outro: PendenciaDeIdentidade['outroProcesso']):
  PendenciaDeIdentidade {
  return {
    id: r.id, entidade: r.entidade_tipo, motivo: r.motivo, estado: r.estado, referencia: r.referencia_original, armador: r.armador_codigo,
    observadaEm: new Date(r.observado_em).toISOString(), fonte: r.fonte, evidenciaRef: r.evidencia_ref, relacao, outroProcesso: outro,
  };
}

async function pendenciasDoProcesso(db: Db, organizationId: string, processoId: string): Promise<PendenciaDeIdentidade[]> {
  // Candidatas: chave entre as referências registradas do processo, ou o processo indicado pela evidência; depois o S6 confirma.
  const { rows } = await db.query(
    `SELECT ${COLUNAS_PENDENCIA} FROM identidade_pendencias
      WHERE organization_id = $1 AND entidade_tipo = 'PROCESSO' AND estado IN ('ABERTA', 'EM_ANALISE')
        AND (processo_indicado_id = $2
             OR chave IN (SELECT numero_processo FROM processos WHERE id = $2 AND organization_id = $1 AND numero_processo IS NOT NULL
                          UNION SELECT referencia FROM processo_referencias WHERE processo_id = $2 AND organization_id = $1))
      ORDER BY observado_em, criado_em, id`,
    [organizationId, processoId],
  );
  const out: PendenciaDeIdentidade[] = [];
  for (const r of rows) {
    const dono = await processoDaReferencia(db, organizationId, r.chave);
    if (r.processo_indicado_id === processoId) {
      out.push(pendencia(r, 'PROCESSO_INDICADO_PELA_EVIDENCIA', dono && dono !== processoId ? { processoId: dono, codigo: null } : null));
    } else if (dono === processoId) {
      out.push(pendencia(r, 'REFERENCIA_DESTE_PROCESSO', r.processo_indicado_id ? { processoId: r.processo_indicado_id, codigo: null } : null));
    }
  }
  const codigos = await codigosDosProcessos(db, organizationId, out.flatMap((p) => (p.outroProcesso ? [p.outroProcesso.processoId] : [])));
  for (const p of out) if (p.outroProcesso) p.outroProcesso.codigo = codigos[p.outroProcesso.processoId] ?? null;
  return out;
}

async function pendenciasDoMaster(db: Db, organizationId: string, masterId: string): Promise<PendenciaDeIdentidade[]> {
  const { rows } = await db.query(
    `SELECT ${COLUNAS_PENDENCIA} FROM identidade_pendencias
      WHERE organization_id = $1 AND entidade_tipo = 'MASTER' AND estado IN ('ABERTA', 'EM_ANALISE')
        AND chave IN (SELECT chave_canonica FROM master_referencias WHERE organization_id = $1 AND master_id = $2)
      ORDER BY observado_em, criado_em, id`,
    [organizationId, masterId],
  );
  const out: PendenciaDeIdentidade[] = [];
  for (const r of rows) {
    try {
      const s = await resolverMaster(db, organizationId, { mbl: r.referencia_original, armadorCodigo: r.armador_codigo });
      const deste = s.status === 'RESOLVIDO' ? s.masterId === masterId : s.candidatos.includes(masterId);
      if (deste) out.push(pendencia(r, 'REFERENCIA_DESTE_MASTER', null));
    } catch (err) {
      if (!(err instanceof ErroIdentidade)) throw err; // referência que o S6 recusa: fica sem ligação
    }
  }
  return out;
}

/* ------------------------------ Master, House e as três dimensões (N-17) ------------------------------ */

/**
 * As três dimensões do N-17 de um fato, prontas para exibir:
 *  1. estado oficial — a situação que a avaliação gravada (L2/L1a) tem;
 *  2. frescor — a ação original e a última confirmação (null = não há fato confirmado);
 *  3. disponibilidade da fonte — AGORA (dono: caixa monitorada) e como estava na avaliação.
 * Indisponibilidade nunca apaga nem substitui um fato confirmado: são campos separados.
 */
export interface TresDimensoes {
  estadoOficial: { tipo: string; motivo: string | null; confirmado: boolean };
  frescor: { acaoOriginalEm: string; ultimaConfirmacaoEm: string } | null;
  fonte: FonteCourierAgora & { naAvaliacao: EstadoDisponibilidadeCourier; mudouDesdeAAvaliacao: boolean };
}

function dimensoes(
  estadoOficial: TresDimensoes['estadoOficial'], frescor: TresDimensoes['frescor'], agora: FonteCourierAgora, p: ProjecaoLiberacao,
): TresDimensoes {
  const naAvaliacao = p.fontes.disponibilidadeCourier;
  return { estadoOficial, frescor, fonte: { ...agora, naAvaliacao, mudouDesdeAAvaliacao: agora.estado !== naAvaliacao } };
}

export interface ReferenciaDoMaster { mbl: string; armador: string | null }

export interface IdentidadeDoMaster {
  /** UUID do Master no S6. */
  id: string;
  /** Referências documentais ATIVAS no S6 (MBL e o armador DECLARADO pela fonte, ou null). */
  referencias: ReferenciaDoMaster[];
  /** Armadores declarados nas referências ativas — só o que o S6 sabe; nunca deduzido do prefixo nem da Demurrage. */
  armadores: string[];
  /** Processos com vínculo válido e publicado a este Master agora (S2). */
  processosVinculados: Array<{ processoId: string; codigo: string | null }>;
  pendencias: PendenciaDeIdentidade[];
}

export interface LeituraDoMaster {
  /** De onde vem o Master mostrado: da avaliação gravada, ou do vínculo atual do S2 quando ainda não há avaliação. */
  origem: 'AVALIACAO' | 'VINCULO_ATUAL' | null;
  /** Master do vínculo publicado (null sem vínculo ou em CONFLITO). */
  identidade: IdentidadeDoMaster | null;
  /** Vínculo em CONFLITO no S2: os Masters envolvidos, nenhum escolhido. */
  emConflito: IdentidadeDoMaster[];
  /** Resolução física (visão da L1a dentro da decisão gravada pela L2) com as três dimensões; null = ainda não avaliado. */
  fisico: {
    resolucao: ProjecaoLiberacao['avaliacao']['master']['l1a']['resolucao'];
    /** Processo cuja conferência estabeleceu o fato do Master (quando veio pelo vínculo). */
    origemDoFato: { processoId: string; codigo: string | null } | null;
    evidencia: EvidenciaLegivel | null;
    dimensoes: TresDimensoes;
  } | null;
}

export interface LeituraDaHouse {
  situacao: ProjecaoLiberacao['avaliacao']['house']['l1a'];
  evidencia: EvidenciaLegivel | null;
  dimensoes: TresDimensoes;
}

async function referenciasDoMaster(db: Db, organizationId: string, masterId: string): Promise<ReferenciaDoMaster[]> {
  const { rows } = await db.query(
    `SELECT mbl_original, armador_codigo FROM master_referencias WHERE organization_id = $1 AND master_id = $2 ORDER BY criado_em, id`,
    [organizationId, masterId],
  );
  const out: ReferenciaDoMaster[] = [];
  for (const r of rows) {
    // Só as referências que o S6 ainda resolve para este Master (referência invalidada não aparece).
    const s = await resolverMaster(db, organizationId, { mbl: r.mbl_original, armadorCodigo: r.armador_codigo });
    if (s.status === 'RESOLVIDO' && s.masterId === masterId && !out.some((x) => x.mbl === r.mbl_original && x.armador === r.armador_codigo)) {
      out.push({ mbl: r.mbl_original, armador: r.armador_codigo });
    }
  }
  return out;
}

async function identidadeDoMaster(db: Db, organizationId: string, masterId: string): Promise<IdentidadeDoMaster> {
  const referencias = await referenciasDoMaster(db, organizationId, masterId);
  const vinculados = (await processosVinculadosAoMaster(db, organizationId, masterId)).map((x) => x.processoId);
  const codigos = await codigosDosProcessos(db, organizationId, vinculados);
  return {
    id: masterId,
    referencias,
    armadores: [...new Set(referencias.flatMap((r) => (r.armador ? [r.armador] : [])))].sort(),
    processosVinculados: vinculados.map((id) => ({ processoId: id, codigo: codigos[id] ?? null })),
    pendencias: await pendenciasDoMaster(db, organizationId, masterId),
  };
}

async function codigosDosProcessos(db: Db, organizationId: string, ids: string[]): Promise<Record<string, string | null>> {
  const unicos = [...new Set(ids.filter(ehUuid))];
  if (!unicos.length) return {};
  const { rows } = await db.query(
    `SELECT id, numero_processo FROM processos WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [organizationId, unicos],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.numero_processo ?? null]));
}

/* ------------------------------------ detalhe ------------------------------------ */

export interface DetalheDaLiberacao {
  processoId: string;
  processo: { id: string; codigo: string | null; aliases: string[]; pendencias: PendenciaDeIdentidade[] };
  motivosDeInclusao: MotivoDeInclusao[];
  fonteCourier: FonteCourierAgora;
  /**
   * null = há contexto de Liberação, mas não há decisão vigente gravada: ainda não avaliado, ou avaliado por
   * versão anterior ao motor oficial (`reavaliacaoPendente`). Nenhuma avaliação é fabricada.
   */
  projecao: ProjecaoLiberacao | null;
  /** A avaliação gravada é anterior ao motor oficial (L1b) e não é exibida como decisão. */
  reavaliacaoPendente: boolean;
  /** Decisão operacional oficial (L1b) pronta para exibir; null sem decisão vigente. */
  decisao: DecisaoOperacional | null;
  master: LeituraDoMaster;
  house: LeituraDaHouse | null;
  contexto: {
    /** Código de cada processo citado na projeção (origem do fato do Master, vinculados na ação). */
    processos: Record<string, string | null>;
    /** Evidências citadas na projeção, legíveis. */
    evidencias: Record<string, EvidenciaLegivel>;
  };
}

export type ResultadoDetalhe =
  | { status: 'NAO_ENCONTRADO' }
  /** Processo da organização sem nenhum dos três fatos de Liberação: fica fora da Liberação. */
  | { status: 'SEM_CONTEXTO'; processo: { id: string; codigo: string | null } }
  | { status: 'OK'; detalhe: DetalheDaLiberacao };

/** Detalhe de UM processo da organização. Só leitura: nada é recalculado nem gravado. */
export async function detalharLiberacao(db: Db, organizationId: string, processoId: string): Promise<ResultadoDetalhe> {
  if (!ehUuid(processoId)) return { status: 'NAO_ENCONTRADO' };
  const { rows: [proc] } = await db.query(
    `SELECT id, numero_processo FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId],
  );
  if (!proc) return { status: 'NAO_ENCONTRADO' };
  const gravada = await obterLiberacaoDoProcesso(db, organizationId, processoId);
  // Só a decisão do motor oficial é decisão vigente; a linha antiga continua contexto, sem ser exibida como decisão.
  const projecao = gravada && ehDecisaoVigente(gravada) ? gravada : null;
  const reavaliacaoPendente = !!gravada && !projecao;
  const motivosDeInclusao = await motivosDoProcesso(db, organizationId, processoId, !!gravada);
  const identidadeCentral = { id: proc.id as string, codigo: (proc.numero_processo ?? null) as string | null };
  if (!motivosDeInclusao.length) return { status: 'SEM_CONTEXTO', processo: identidadeCentral };

  const { rows: refs } = await db.query(
    `SELECT DISTINCT referencia FROM processo_referencias WHERE processo_id = $1 AND organization_id = $2 AND tipo = 'ALIAS' ORDER BY referencia`,
    [processoId, organizationId],
  );
  const aliases: string[] = [];
  for (const { referencia } of refs) {
    // Só aliases vigentes no S6 (invalidado não aparece).
    const r = await resolverProcesso(db, organizationId, referencia);
    if (r.status === 'RESOLVIDO' && r.processoId === processoId && referencia !== proc.numero_processo) aliases.push(referencia);
  }
  const fonteCourier = await fonteCourierAgora(db, organizationId);

  // Master mostrado: o da avaliação gravada; sem avaliação, o do vínculo atual do S2 (identidade, sem resolução física).
  let situacao: { tipo: 'SEM_VINCULO' } | { tipo: 'VINCULADO'; masterId: string } | { tipo: 'CONFLITO'; masterIds: string[] };
  let origem: LeituraDoMaster['origem'];
  if (projecao) {
    const v = projecao.fontes.vinculo;
    situacao = v.situacao === 'VINCULADO' ? { tipo: 'VINCULADO', masterId: v.masterId }
      : v.situacao === 'CONFLITO' ? { tipo: 'CONFLITO', masterIds: v.masterIds } : { tipo: 'SEM_VINCULO' };
    origem = 'AVALIACAO';
  } else {
    const s = await vinculoDoProcesso(db, organizationId, processoId);
    situacao = s.tipo === 'VINCULADO' ? { tipo: 'VINCULADO', masterId: s.masterId }
      : s.tipo === 'CONFLITO' ? { tipo: 'CONFLITO', masterIds: s.masters.map((m) => m.masterId).sort() } : { tipo: 'SEM_VINCULO' };
    origem = s.tipo === 'SEM_VINCULO' ? null : 'VINCULO_ATUAL';
  }
  const master: LeituraDoMaster = {
    origem,
    identidade: situacao.tipo === 'VINCULADO' ? await identidadeDoMaster(db, organizationId, situacao.masterId) : null,
    emConflito: [],
    fisico: null,
  };
  if (situacao.tipo === 'CONFLITO') {
    for (const id of situacao.masterIds) master.emConflito.push(await identidadeDoMaster(db, organizationId, id));
  }

  const detalhe: DetalheDaLiberacao = {
    processoId,
    processo: { ...identidadeCentral, aliases, pendencias: await pendenciasDoProcesso(db, organizationId, processoId) },
    motivosDeInclusao, fonteCourier, projecao, reavaliacaoPendente, decisao: projecao ? decisaoOperacionalDe(projecao.avaliacao) : null,
    master, house: null, contexto: { processos: {}, evidencias: {} },
  };
  if (!projecao) return { status: 'OK', detalhe };

  const citados: string[] = [];
  if (projecao.fontes.masterFisico) citados.push(projecao.fontes.masterFisico.origemProcessoId);
  // Processos citados pela decisão: vinculados na ação, impactados pela ação de Master e os listados pelo N-13.
  const json = JSON.stringify(projecao.avaliacao);
  for (const m of json.matchAll(/"(?:processosVinculadosNaAcao|impacta)":\[([^\]]*)\]/g)) citados.push(...(m[1].match(/[0-9a-f-]{36}/g) ?? []));
  for (const m of json.matchAll(/"processoId":"([0-9a-f-]{36})"/g)) citados.push(m[1]);
  detalhe.contexto.processos = await codigosDosProcessos(db, organizationId, citados);
  detalhe.contexto.evidencias = await evidenciasLegiveis(db, organizationId, projecao);
  const evid = (ref: string | undefined) => (ref ? detalhe.contexto.evidencias[ref] ?? null : null);

  const r = projecao.avaliacao.master.l1a.resolucao;
  const mf = projecao.fontes.masterFisico;
  master.fisico = {
    resolucao: r,
    origemDoFato: r.tipo === 'RESOLVIDO' && r.via === 'MASTER_VINCULADO' && mf
      ? { processoId: mf.origemProcessoId, codigo: detalhe.contexto.processos[mf.origemProcessoId] ?? null } : null,
    evidencia: r.tipo === 'RESOLVIDO' ? evid(r.evidencia.ref) : null,
    dimensoes: dimensoes(
      { tipo: r.tipo, motivo: 'motivo' in r ? r.motivo : null, confirmado: r.tipo === 'RESOLVIDO' },
      r.tipo === 'RESOLVIDO' ? { acaoOriginalEm: r.resolvidoEm, ultimaConfirmacaoEm: r.ultimaConfirmacaoEm } : null,
      fonteCourier, projecao,
    ),
  };
  const h = projecao.avaliacao.house.l1a;
  detalhe.house = {
    situacao: h,
    evidencia: h.tipo === 'RESOLVIDO' ? evid(h.evidencia.ref) : null,
    dimensoes: dimensoes(
      { tipo: h.tipo, motivo: null, confirmado: h.tipo === 'RESOLVIDO' },
      h.tipo === 'RESOLVIDO' ? { acaoOriginalEm: h.resolvidoEm, ultimaConfirmacaoEm: h.ultimaConfirmacaoEm } : null,
      fonteCourier, projecao,
    ),
  };
  return { status: 'OK', detalhe };
}

/**
 * Processo de uma referência (código ou alias vigente), pela identidade
 * central do S6 — exata, nunca por base sem sufixo nem por semelhança.
 * Só leitura: não cria processo nem pendência.
 */
export async function processoDaReferencia(db: Db, organizationId: string, referencia: string): Promise<string | null> {
  try {
    const r = await resolverProcesso(db, organizationId, referencia);
    return r.status === 'RESOLVIDO' ? r.processoId : null;
  } catch (err) {
    // Referência vazia ou ilegível (recusa do S6): nenhum processo. Falha de banco não vira "não encontrado".
    if (err instanceof ErroIdentidade) return null;
    throw err;
  }
}
