import { TrackingEnrichResult, TrackingEventLike } from '../sources/armadorTrackingSource';
import { ConsultaRealizada } from '../scheduler/trackingScheduler';
import { normalizarArmador, normalizarNavio, normalizarViagem, normalizarPod } from './vesselIdentity';

/**
 * Fase 9 Bloco 2 v1.3 — validação ESTRUTURADA (pura) dos fatos compartilháveis de
 * uma consulta de referência antes de renovar cobertura. Substitui o antigo
 * `temFatoDeViagem(): boolean`. Não decide sozinha o encerramento nem a rolagem
 * (isso continua no orquestrador, que também olha associação ativa e saída): aqui
 * só se responde QUAIS campos a resposta sustenta, com valor/fonte/observado_em/
 * evidência, e se são COMPATÍVEIS com a identidade atual do VesselCall.
 *
 * Regras aprovadas:
 * - Para declarar navio/viagem/destino, o campo precisa estar EFETIVAMENTE
 *   presente na resposta (evento de viagem confirmado / discharge) e bater com a
 *   identidade normalizada do VesselCall. Nunca uma lista fixa de campos.
 * - ETA isolada: ETA estruturada e válida pode gerar cobertura SÓ do campo `eta`,
 *   e apenas quando a identidade do VesselCall já está confirmada e válida; sem
 *   proveniência ou ambígua, não gera cobertura.
 * - Divergência de armador/navio/viagem/destino → incompatível (sem cobertura).
 */

export type CampoCompartilhavel = 'navio' | 'viagem' | 'destino' | 'eta';

export interface CampoCompartilhado {
  campo: CampoCompartilhavel;
  valor: string;
  fonte: string;
  /** ISO do momento observado (proveniência). */
  observadoEm: string;
  /** Referência ao evento/observação originador (não o payload bruto). */
  evidencia: string;
}

export interface IdentidadeVesselCall {
  armador: string; // normalizado
  vessel: string;  // normalizado
  voyage: string;  // normalizado
  pod: string;     // normalizado
  /** Identidade previamente confirmada e válida (todos os componentes presentes). */
  identidadeConfirmada: boolean;
}

export interface FatosCompartilhados {
  /** Há ≥1 campo compartilhável VÁLIDO e a resposta é compatível com o VesselCall. */
  ok: boolean;
  /** Compatível com a identidade atual do VesselCall (nenhum campo presente diverge). */
  compativel: boolean;
  camposValidos: CampoCompartilhado[];
  /** Preenchido quando !ok/!compativel: motivo textual (para auditoria e desfecho). */
  motivoRejeicao?: string;
  /** Status/tipo do evento originador do vínculo de viagem (quando houver). */
  eventoOriginador?: string;
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}
function normContainer(s: string | null | undefined): string {
  return norm(s).replace(/[\s-]/g, '');
}

/**
 * Momento (data civil OU timestamp ISO) ESTRITAMENTE válido. Round-trip pelos
 * componentes UTC para rejeitar datas impossíveis (ex.: 2026-02-30, que o
 * Date.parse "corrige" para 02/03). Retorna a string original quando válida,
 * senão null. Pura e determinística — sem relógio atual.
 */
function momentoValido(s: string | null | undefined): string | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) return null;
  const yy = +m[1], MM = +m[2], dd = +m[3];
  const hh = m[4] === undefined ? 0 : +m[4];
  const mi = m[5] === undefined ? 0 : +m[5];
  const ss = m[6] === undefined ? 0 : +m[6];
  if (MM < 1 || MM > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(Date.UTC(yy, MM - 1, dd, hh, mi, ss));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== MM - 1 || dt.getUTCDate() !== dd) return null;
  return s;
}

/** Data civil (YYYY-MM-DD) ESTRITAMENTE válida (rejeita 30/02); senão null. */
function dataCivilValida(eta: string | null | undefined): string | null {
  const ok = momentoValido(eta);
  return ok ? ok.slice(0, 10) : null;
}

/**
 * Momento observado válido para o fato compartilhável, em ordem de origem
 * EXPLÍCITA (v1.4): (1) timestamp estruturado da resposta; (2) timestamp
 * persistido do TrackingFetch/evento originador (fornecido pelo chamador);
 * (3) data do evento originador presente na resposta. Nunca o relógio atual.
 */
function resolverObservadoEm(rAt: string | null | undefined, momentoPersistido: string | null | undefined, eventoData: string | null | undefined): string | null {
  return momentoValido(rAt) ?? momentoValido(momentoPersistido) ?? momentoValido(eventoData);
}

/**
 * Vínculo de viagem CONFIRMADO do contêiner: evento loaded/departed com
 * `statusPrevistoConfirmado === 'confirmado'` e navio OU viagem presentes.
 */
function eventoEmbarqueConfirmado(result: TrackingEnrichResult, numero: string): TrackingEventLike | null {
  const n = normContainer(numero);
  return (
    result.events.find(
      (e) => (e.type === 'loaded' || e.type === 'departed') && e.statusPrevistoConfirmado === 'confirmado' &&
        normContainer(e.container) === n && (e.vessel || e.voyage),
    ) ?? null
  );
}

/** Evento de descarga do contêiner com localização (destino observado). */
function eventoDescarga(result: TrackingEnrichResult, numero: string): TrackingEventLike | null {
  const n = normContainer(numero);
  return result.events.find((e) => e.type === 'discharge' && normContainer(e.container) === n && e.location) ?? null;
}

export function validarFatosCompartilhados(input: {
  numero: string;
  consulta: ConsultaRealizada;
  identidade: IdentidadeVesselCall;
  /**
   * Momento persistido do TrackingFetch (ou evento originador) fornecido pelo
   * chamador — 2ª origem de `observado_em`. Mantém a função PURA (não consulta o
   * banco): quem tem o Pool resolve o timestamp e o injeta aqui.
   */
  momentoPersistido?: string | null;
}): FatosCompartilhados {
  const { numero, consulta, identidade } = input;
  if (!consulta.ok) return { ok: false, compativel: false, camposValidos: [], motivoRejeicao: 'consulta_falhou' };

  const r = consulta.result;
  const evento = eventoEmbarqueConfirmado(r, numero);
  // Momento observado NUNCA fabricado (v1.4): resposta → fetch/evento persistido →
  // data do evento originador; sem nenhum válido, rejeita o compartilhamento.
  const observadoEm = resolverObservadoEm(r.at, input.momentoPersistido, evento?.date);
  if (!observadoEm) return { ok: false, compativel: true, camposValidos: [], motivoRejeicao: 'observado_em_ausente', eventoOriginador: evento?.status };

  const fonte = 'tracking_service';
  const campos: CampoCompartilhado[] = [];
  let incompat: string | undefined;

  // Armador (proveniente do carrier da resposta). Só rejeita quando ambos os
  // lados são não-vazios e divergem — nunca por ausência.
  const carrierNorm = normalizarArmador(r.carrier?.id || r.carrier?.name || '');
  if (carrierNorm && identidade.armador && carrierNorm !== identidade.armador) incompat = 'armador_divergente';

  if (evento) {
    const navio = normalizarNavio(evento.vessel);
    const viagem = normalizarViagem(evento.voyage);
    const refEvento = `evento=${evento.type};status=${evento.status}`;
    if (navio) {
      if (identidade.vessel && navio !== identidade.vessel) incompat = incompat ?? 'navio_divergente';
      else campos.push({ campo: 'navio', valor: String(evento.vessel), fonte, observadoEm, evidencia: refEvento });
    }
    if (viagem) {
      if (identidade.voyage && viagem !== identidade.voyage) incompat = incompat ?? 'viagem_divergente';
      else campos.push({ campo: 'viagem', valor: String(evento.voyage), fonte, observadoEm, evidencia: refEvento });
    }
  }

  // Destino: só de um evento de DESCARGA com localização (arrival no POD). Loaded
  // em porto de origem NÃO é destino. Divergência de POD → incompatível.
  const desc = eventoDescarga(r, numero);
  if (desc && desc.location) {
    const destino = normalizarPod(desc.location);
    if (identidade.pod && destino !== identidade.pod) incompat = incompat ?? 'destino_divergente';
    else campos.push({ campo: 'destino', valor: String(desc.location), fonte, observadoEm, evidencia: `evento=discharge;status=${desc.status}` });
  }

  // ETA estruturada válida (data civil estrita: rejeita 30/02 etc.).
  const eta = dataCivilValida(r.etaPrevista);
  if (eta) campos.push({ campo: 'eta', valor: eta, fonte, observadoEm, evidencia: `etaPrevista;ref=${consulta.referenceValueCanonical}` });

  if (incompat) return { ok: false, compativel: false, camposValidos: [], motivoRejeicao: incompat, eventoOriginador: evento?.status };

  const temViagem = campos.some((c) => c.campo === 'navio' || c.campo === 'viagem' || c.campo === 'destino');
  const temEta = campos.some((c) => c.campo === 'eta');

  // ETA isolada: sem fato de viagem, só ETA → exige identidade previamente confirmada.
  if (!temViagem && temEta) {
    if (!identidade.identidadeConfirmada) {
      return { ok: false, compativel: true, camposValidos: [], motivoRejeicao: 'eta_sem_identidade_confirmada' };
    }
    return { ok: true, compativel: true, camposValidos: campos.filter((c) => c.campo === 'eta'), eventoOriginador: evento?.status };
  }

  if (!campos.length) return { ok: false, compativel: true, camposValidos: [], motivoRejeicao: 'sem_fatos_de_viagem' };
  return { ok: true, compativel: true, camposValidos: campos, eventoOriginador: evento?.status };
}
