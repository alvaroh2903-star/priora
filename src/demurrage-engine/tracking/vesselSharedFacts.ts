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

/** ETA estruturada válida: string de data ISO (YYYY-MM-DD) parseável; senão null. */
function etaValida(eta: string | null | undefined): string | null {
  if (!eta || typeof eta !== 'string') return null;
  const m = eta.match(/^\d{4}-\d{2}-\d{2}/);
  if (!m) return null;
  const t = Date.parse(eta.length === 10 ? eta + 'T00:00:00Z' : eta);
  return Number.isNaN(t) ? null : eta.slice(0, 10);
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
}): FatosCompartilhados {
  const { numero, consulta, identidade } = input;
  if (!consulta.ok) return { ok: false, compativel: false, camposValidos: [], motivoRejeicao: 'consulta_falhou' };

  const r = consulta.result;
  const observadoEm = r.at ?? new Date().toISOString();
  const fonte = 'tracking_service';
  const campos: CampoCompartilhado[] = [];
  let incompat: string | undefined;

  // Armador (proveniente do carrier da resposta). Só rejeita quando ambos os
  // lados são não-vazios e divergem — nunca por ausência.
  const carrierNorm = normalizarArmador(r.carrier?.id || r.carrier?.name || '');
  if (carrierNorm && identidade.armador && carrierNorm !== identidade.armador) incompat = 'armador_divergente';

  const evento = eventoEmbarqueConfirmado(r, numero);
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

  // ETA estruturada válida.
  const eta = etaValida(r.etaPrevista);
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
