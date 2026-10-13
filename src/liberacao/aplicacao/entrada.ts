import { Db } from '../../identidade';
import { FatoConferenciaCourier, FatosCourierDoProcesso, fatosCourierDoProcesso } from '../../couriers/fatos/courierFatos';
import { SituacaoVinculo, processosVinculadosAoMaster, vinculoDoProcesso } from '../../auditoria/fatos/vinculos';
import {
  ConferenciaHblOriginal, CourierDoProcesso, DisponibilidadeFonte, EntradaAvaliacao, FatoDoMaster, FatoOficial, Instante, Liberado,
  VinculoProcessoMaster, fatoFisicoDoMaster,
} from '../dominio';

/**
 * L2 — adaptador de entrada: reúne, para UM processo, os fatos vigentes dos
 * donos e os converte nos tipos da L1a. Não interpreta nada: quem decide é a
 * L1a (`avaliarProcesso`, `fatoFisicoDoMaster`). Aqui não há regra de
 * negócio, só leitura e conversão de tipos:
 *  - identidade: `processos` (S6) — sem tabela própria de processo;
 *  - vínculo Processo↔Master: `vinculoDoProcesso` (S2). CONFLITO → nenhum
 *    Master escolhido (vínculo null para a L1a). `vinculadoEm` é quando a
 *    Priora estabeleceu o vínculo; a data antiga do documento (`observadoEm`)
 *    fica no S2 e nunca a substitui (N-15);
 *  - Courier: `fatosCourierDoProcesso` (S1), só linhas oficiais;
 *  - disponibilidade do Courier: estado da caixa monitorada em `email_caixas`
 *    (só a confirmada é disponível; desconhecida não);
 *  - terminal (LIBERADO): sem produtor na Vertical 1 (L5/SISCARGA, depois).
 * Nada desconhecido vira fato: o que não tem fonte chega à L1a como ausência.
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

export interface EntradaCarregada {
  entrada: EntradaAvaliacao;
  fontes: FontesDaAvaliacao;
}

const iso = (d: Date): Instante => d.toISOString();
const idDaEvidencia = (ref: string): string => ref.slice(ref.indexOf(':') + 1);

function fatoOficial<V>(f: FatoConferenciaCourier, valor: V): FatoOficial<V> {
  // O S1 não grava reconfirmação do mesmo valor: a última confirmação é a própria marca.
  return { valor, vigenteDesde: iso(f.vigenteDesde), ultimaConfirmacaoEm: iso(f.vigenteDesde), evidencia: { ...f.evidencia } };
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
 * Entrada da L1a para (organização, processo), ou null se o processo não
 * existe NESSA organização. `db` deve ser o mesmo cliente da transação do
 * recálculo, para ler tudo sob o mesmo bloqueio.
 */
export async function carregarEntrada(
  db: Db, organizationId: string, processoId: string, terminal: FonteTerminal = SEM_PRODUTOR_TERMINAL,
): Promise<EntradaCarregada | null> {
  const { rows: [proc] } = await db.query(`SELECT id FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId]);
  if (!proc) return null;

  const { fonte, caixaIds, estado: disponibilidadeCourier } = await disponibilidadeDoCourier(db, organizationId);
  const proprios = await fatosCourierDoProcesso(db, organizationId, processoId);
  const { courier, ponteiros } = courierParaL1a(proprios, fonte);
  const situacao = await vinculoDoProcesso(db, organizationId, processoId);

  let vinculo: VinculoProcessoMaster | null = null;
  const fatosDoMaster: FatoDoMaster[] = [];
  let masterFisico: FontesDaAvaliacao['masterFisico'] = null;
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
  }
  // CONFLITO: nenhum Master é escolhido (nem o mais novo, nem o mais antigo, nem o primeiro).

  return {
    entrada: { processoId, vinculo, fatosDoMaster, courier, liberado: await terminal(db, organizationId, processoId) },
    fontes: { vinculo: ponteirosDoVinculo(situacao), courier: ponteiros, masterFisico, caixaIds, disponibilidadeCourier },
  };
}
