import { Db } from '../../identidade';
import {
  AssuntoConferencia, FatoConferenciaCourier, FatosCourierDoProcesso, fatosCourierDoProcesso,
} from '../../couriers/fatos/courierFatos';
import { SituacaoVinculo, processosVinculadosAoMaster, vinculoDoProcesso } from '../../auditoria/fatos/vinculos';
import {
  ConferenciaHblOriginal, CourierDoProcesso, DisponibilidadeFonte, EntradaAvaliacao, EntradaDecisao, FatoDoMaster, FatoOficial, Instante, Liberado,
  SituacaoVinculoL1b, VinculoProcessoMaster, fatoFisicoDoMaster,
} from '../dominio';

/**
 * L2 — adaptador de entrada: reúne, para UM processo, os fatos vigentes dos
 * donos e os converte nos tipos do domínio. Não interpreta nada: quem decide é
 * a L1b, o motor oficial (chamado só pela projeção), sobre o fato físico do
 * Master da L1a (`fatoFisicoDoMaster`). Aqui não há regra de negócio, só
 * leitura e conversão de tipos:
 *  - identidade: `processos` (S6) — sem tabela própria de processo;
 *  - vínculo Processo↔Master: `vinculoDoProcesso` (S2). CONFLITO → nenhum
 *    Master escolhido (vínculo null para a L1a). `vinculadoEm` é quando a
 *    Priora estabeleceu o vínculo; a data antiga do documento (`observadoEm`)
 *    fica no S2 e nunca a substitui (N-15);
 *  - Courier: `fatosCourierDoProcesso` (S1), só linhas oficiais;
 *  - disponibilidade do Courier: estado da caixa monitorada em `email_caixas`
 *    (só a confirmada é disponível; desconhecida não);
 *  - terminal (LIBERADO): sem produtor na Vertical 1 (L5/SISCARGA, depois);
 *  - fontes posteriores à L1a (armador, procedimento, cliente, viagem,
 *    SISCARGA…): só pela porta `FontesPosteriores`, cujo padrão não fornece
 *    nenhuma — todas chegam à L1b como NAO_INTEGRADA (D-6).
 * Nada desconhecido vira fato: o que não tem fonte chega à L1b como "não integrada".
 */

/** Ponteiros (ids) para as linhas de origem usadas. Nunca os valores. */
export interface FontesDaAvaliacao {
  vinculo:
    | { situacao: 'SEM_VINCULO' }
    | { situacao: 'VINCULADO'; masterId: string; vinculoIds: string[]; extracaoIds: string[] }
    | { situacao: 'CONFLITO'; masterIds: string[]; vinculoIds: string[]; extracaoIds: string[] };
  courier: {
    mblFatoId: string | null;
    hblOriginalFatoId: string | null;
    /** Linha de estado que iniciou o recebimento do envelope usado (null = sem envelope recebido). */
    envelopeFatoId: string | null;
    /** Marcas preservadas pelo S1 sem efeito oficial (proveniência não verificada): não usadas. */
    naoPublicadosFatoIds: string[];
  };
  /** Fato físico do Master (escopo Master) quando há: a conferência de origem e o vínculo que a levou ao Master. */
  masterFisico: { courierFatoId: string; origemProcessoId: string; origemVinculoIds: string[] } | null;
  /** Caixas (`email_caixas`) cujo estado determinou a disponibilidade do Courier. */
  caixaIds: string[];
  /** Estado da caixa que a L2 viu. DESCONHECIDO chega à L1a como indisponível (N-17): desconhecido não é positivo. */
  disponibilidadeCourier: EstadoDisponibilidadeCourier;
}

export type EstadoDisponibilidadeCourier = 'DISPONIVEL' | 'INDISPONIVEL' | 'DESCONHECIDO';

/** Produtor do terminal LIBERADO. A Vertical 1 não tem nenhum: a conclusão é de fase posterior. */
export type FonteTerminal = (db: Db, organizationId: string, processoId: string) => Promise<Liberado | null>;
export const SEM_PRODUTOR_TERMINAL: FonteTerminal = async () => null;

/**
 * Fatos das fontes posteriores à L1a, no vocabulário da L1b. Campo ausente = fonte não integrada: vale o
 * padrão de `entradaSemIntegracoes`. Identidade, relógio, vínculo, Courier, fato do Master e terminal não
 * entram por aqui (vêm dos donos já lidos acima).
 */
export type FatosPosteriores = Partial<Omit<EntradaDecisao, 'processoId' | 'agora' | 'vinculo' | 'fatosDoMasterL1a' | 'courier' | 'liberado'>>;

/** Produtor das fontes posteriores de UM processo. A Vertical 1 não tem nenhum: tudo NAO_INTEGRADA. */
export type FontesPosteriores = (db: Db, organizationId: string, processoId: string) => Promise<FatosPosteriores>;
export const SEM_FONTES_POSTERIORES: FontesPosteriores = async () => ({});

/** O que a decisão de UM processo consome: os fatos já convertidos, o vínculo da L1b e as fontes posteriores. */
export interface ParticipanteDaDecisao {
  entrada: EntradaAvaliacao;
  /** Vínculo no vocabulário da L1b: o CONFLITO do S2 segue explícito (P3), sem nenhum Master escolhido. */
  vinculo: SituacaoVinculoL1b;
  posteriores: FatosPosteriores;
}

export interface EntradaCarregada extends ParticipanteDaDecisao {
  fontes: FontesDaAvaliacao;
  /** Assuntos de conferência do próprio processo (S1, append-only), para a divergência do físico (L4). */
  assuntos: AssuntoConferencia[];
  /** Os outros processos com vínculo válido e publicado ao mesmo Master (S2): o passo compartilhado do N-13 os considera. */
  vinculados: ParticipanteDaDecisao[];
}

const iso = (d: Date): Instante => d.toISOString();
const idDaEvidencia = (ref: string): string => ref.slice(ref.indexOf(':') + 1);

function fatoOficial<V>(f: FatoConferenciaCourier, valor: V): FatoOficial<V> {
  return { valor, vigenteDesde: iso(f.vigenteDesde), ultimaConfirmacaoEm: iso(f.confirmadoEm), evidencia: { ...f.evidencia } };
}

const HBL_ORIGINAL: Record<FatoConferenciaCourier['valor'], ConferenciaHblOriginal> = {
  RECEBIDO: 'RECEBIDO_E_CONFERIDO', // a conferência do HBL original pelo operador (caminho B)
  AUSENTE_NA_CONFERENCIA: 'AUSENTE_NA_CONFERENCIA',
};

/**
 * Converte os fatos oficiais do S1 no `CourierDoProcesso` da L1a.
 * Envelope: só ENTREGUE, e só com o recebimento confirmado pelo operador; o
 * S1 não tem produtor de EM_TRANSITO (V-2: "Identificado" não é trânsito).
 * Com mais de um envelope recebido, vale o recebimento mais antigo (o
 * instante é o início da sequência atual de estados recebidos, então trocar
 * Recebido → Em Conferência não é mudança do fato).
 */
export function courierParaL1a(f: FatosCourierDoProcesso, fonte: DisponibilidadeFonte): {
  courier: CourierDoProcesso; ponteiros: FontesDaAvaliacao['courier'];
} {
  const recebidos = f.envelopes
    .filter((e) => e.recebimento)
    .sort((a, b) => a.recebimento!.desde.getTime() - b.recebimento!.desde.getTime() || a.trackingChave.localeCompare(b.trackingChave));
  const env = recebidos[0];
  const envelope: CourierDoProcesso['envelope'] = env
    ? {
      valor: 'ENTREGUE', vigenteDesde: iso(env.recebimento!.desde), ultimaConfirmacaoEm: iso(env.desde ?? env.recebimento!.desde),
      evidencia: { fonte: 'courier', ref: `courier_fato:${env.recebimento!.fatoId}` },
    }
    : null;
  return {
    courier: {
      fonte: { ...fonte },
      envelope,
      mbl: f.mbl ? fatoOficial(f.mbl, f.mbl.valor) : null,
      hblOriginal: f.hblOriginal ? fatoOficial(f.hblOriginal, HBL_ORIGINAL[f.hblOriginal.valor]) : null,
    },
    ponteiros: {
      mblFatoId: f.mbl ? idDaEvidencia(f.mbl.evidencia.ref) : null,
      hblOriginalFatoId: f.hblOriginal ? idDaEvidencia(f.hblOriginal.evidencia.ref) : null,
      envelopeFatoId: env ? env.recebimento!.fatoId : null,
      naoPublicadosFatoIds: f.naoPublicados.map((n) => n.fatoId).sort(),
    },
  };
}

/**
 * Disponibilidade do Courier pelo estado da caixa monitorada no servidor
 * (`email_caixas`). Só é disponível o que está CONFIRMADO: caixa ativa com o
 * token verificado como utilizável (`token_estado = 'disponivel'`). Token
 * nunca verificado (`desconhecido`) não é prova de disponibilidade (N-17):
 * vai à L1a como indisponível, e a distinção fica em `estado`. Token
 * indisponível, caixa pausada ou removida, ou nenhuma caixa: indisponível.
 * `desde` é o último instante registrado desse estado (frescor; não é material).
 */
export async function disponibilidadeDoCourier(db: Db, organizationId: string): Promise<{
  fonte: DisponibilidadeFonte; caixaIds: string[]; estado: EstadoDisponibilidadeCourier;
}> {
  const { rows } = await db.query(
    `SELECT id, estado, token_estado, vinculada_em, token_verificado_em, atualizado_em, removida_em
       FROM email_caixas WHERE organization_id = $1 ORDER BY vinculada_em, id`,
    [organizationId],
  );
  const confirmadas = rows.filter((r) => r.estado === 'ativa' && r.token_estado === 'disponivel');
  if (confirmadas.length) {
    const desde = Math.min(...confirmadas.map((r) => new Date(r.vinculada_em).getTime()));
    return { fonte: { disponivel: true, desde: iso(new Date(desde)) }, caixaIds: confirmadas.map((r) => r.id), estado: 'DISPONIVEL' };
  }
  const naoVerificadas = rows.filter((r) => r.estado === 'ativa' && r.token_estado === 'desconhecido');
  if (naoVerificadas.length) {
    // Nunca verificada desde o vínculo: sem confirmação desde então.
    const desde = Math.min(...naoVerificadas.map((r) => new Date(r.token_verificado_em ?? r.vinculada_em).getTime()));
    return { fonte: { disponivel: false, desde: iso(new Date(desde)) }, caixaIds: naoVerificadas.map((r) => r.id), estado: 'DESCONHECIDO' };
  }
  const vigentes = rows.filter((r) => r.estado !== 'removida');
  const instantes = vigentes.length
    ? vigentes.map((r) => new Date(r.estado === 'ativa' ? (r.token_verificado_em ?? r.atualizado_em) : r.atualizado_em).getTime())
    : rows.map((r) => new Date(r.removida_em).getTime());
  if (instantes.length) {
    return {
      fonte: { disponivel: false, desde: iso(new Date(Math.max(...instantes))) }, caixaIds: (vigentes.length ? vigentes : rows).map((r) => r.id),
      estado: 'INDISPONIVEL',
    };
  }
  // Organização que nunca vinculou caixa: indisponível desde que existe.
  const { rows: [org] } = await db.query(`SELECT criado_em FROM organizations WHERE id = $1`, [organizationId]);
  return { fonte: { disponivel: false, desde: iso(new Date(org.criado_em)) }, caixaIds: [], estado: 'INDISPONIVEL' };
}

function vinculoParaL1a(s: Extract<SituacaoVinculo, { tipo: 'VINCULADO' }>): VinculoProcessoMaster {
  return { processoId: s.processoId, masterId: s.masterId, vinculadoEm: iso(s.vinculadoEm), evidencia: { ...s.evidencia } };
}

function ponteirosDoVinculo(s: SituacaoVinculo): FontesDaAvaliacao['vinculo'] {
  if (s.tipo === 'SEM_VINCULO') return { situacao: 'SEM_VINCULO' };
  const evidencias = s.tipo === 'VINCULADO' ? s.evidencias : s.masters.flatMap((m) => m.evidencias);
  const vinculoIds = evidencias.map((e) => e.vinculoId).sort();
  const extracaoIds = [...new Set(evidencias.map((e) => e.extracaoId))].sort();
  return s.tipo === 'VINCULADO'
    ? { situacao: 'VINCULADO', masterId: s.masterId, vinculoIds, extracaoIds }
    : { situacao: 'CONFLITO', masterIds: s.masters.map((m) => m.masterId).sort(), vinculoIds, extracaoIds };
}

/**
 * Entrada da decisão para (organização, processo), ou null se o processo não
 * existe NESSA organização. `db` deve ser o mesmo cliente da transação do
 * recálculo, para ler tudo sob o mesmo bloqueio. Com vínculo publicado, traz
 * também os outros processos vinculados ao mesmo Master (mesmas leituras que o
 * fato físico do Master já fazia), para o passo compartilhado do N-13.
 */
export async function carregarEntrada(
  db: Db, organizationId: string, processoId: string, terminal: FonteTerminal = SEM_PRODUTOR_TERMINAL,
  posteriores: FontesPosteriores = SEM_FONTES_POSTERIORES,
): Promise<EntradaCarregada | null> {
  const { rows: [proc] } = await db.query(`SELECT id FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId]);
  if (!proc) return null;

  const { fonte, caixaIds, estado: disponibilidadeCourier } = await disponibilidadeDoCourier(db, organizationId);
  const proprios = await fatosCourierDoProcesso(db, organizationId, processoId);
  const { courier, ponteiros } = courierParaL1a(proprios, fonte);
  const situacao = await vinculoDoProcesso(db, organizationId, processoId);

  let vinculo: VinculoProcessoMaster | null = null;
  // CONFLITO: nenhum Master é escolhido (nem o mais novo, nem o mais antigo, nem o primeiro); a L1b o recebe como tal (P3).
  const vinculoL1b: SituacaoVinculoL1b = situacao.tipo === 'CONFLITO'
    ? { tipo: 'CONFLITO', masterIds: situacao.masters.map((m) => m.masterId).sort() } : { tipo: 'SEM_VINCULO' };
  const fatosDoMaster: FatoDoMaster[] = [];
  let masterFisico: FontesDaAvaliacao['masterFisico'] = null;
  const participantes: ParticipanteDaDecisao[] = [];
  if (situacao.tipo === 'VINCULADO') {
    vinculo = vinculoParaL1a(situacao);
    // Fato de escopo Master: a L1a deriva das conferências de MBL dos processos vinculados ao mesmo Master.
    const outros = (await processosVinculadosAoMaster(db, organizationId, situacao.masterId)).filter((v) => v.processoId !== processoId);
    const vinculados = [situacao, ...outros];
    const courierPorProcesso = new Map<string, CourierDoProcesso>([[processoId, courier]]);
    for (const v of outros) {
      courierPorProcesso.set(v.processoId, courierParaL1a(await fatosCourierDoProcesso(db, organizationId, v.processoId), fonte).courier);
    }
    const fisico = fatoFisicoDoMaster(situacao.masterId, vinculados.map(vinculoParaL1a), courierPorProcesso);
    if (fisico) {
      fatosDoMaster.push(fisico);
      if (fisico.tipo === 'MASTER_FISICO_RECEBIDO') {
        const origem = vinculados.find((v) => v.processoId === fisico.origemProcessoId)!;
        masterFisico = {
          courierFatoId: idDaEvidencia(fisico.evidencia.ref), origemProcessoId: fisico.origemProcessoId,
          origemVinculoIds: origem.evidencias.map((e) => e.vinculoId).sort(),
        };
      }
    }
    for (const v of outros) {
      participantes.push({
        entrada: {
          processoId: v.processoId, vinculo: vinculoParaL1a(v), fatosDoMaster, courier: courierPorProcesso.get(v.processoId)!,
          liberado: await terminal(db, organizationId, v.processoId),
        },
        vinculo: { tipo: 'VINCULADO', vinculo: vinculoParaL1a(v) },
        posteriores: await posteriores(db, organizationId, v.processoId),
      });
    }
  }

  return {
    entrada: { processoId, vinculo, fatosDoMaster, courier, liberado: await terminal(db, organizationId, processoId) },
    vinculo: vinculo ? { tipo: 'VINCULADO', vinculo } : vinculoL1b,
    posteriores: await posteriores(db, organizationId, processoId),
    fontes: { vinculo: ponteirosDoVinculo(situacao), courier: ponteiros, masterFisico, caixaIds, disponibilidadeCourier },
    assuntos: proprios.assuntos,
    vinculados: participantes,
  };
}
