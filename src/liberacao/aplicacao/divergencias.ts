import { ConferenciaRegistrada, DocumentoConferido } from '../../couriers/fatos/courierFatos';
import {
  ConferenciaHblOriginal, ConferenciaMbl, DisponibilidadeFonte, Divergencia, EstadoDoFato, FatoOficial, aplicarObservacao, estadoInicial,
} from '../dominio';

/**
 * L4 — divergência do físico (cap. 5, 22; N-14; N-16), com a máquina da L1a
 * (`aplicarObservacao`). Nenhuma regra nova: as marcas do S1 de cada assunto
 * (envelope, documento, referência exata) são reaplicadas em ordem:
 *  - marca CITADA → observação OFICIAL (mesmo valor só avança o frescor;
 *    valor novo é mudança oficial e resolve a divergência que ele elimina);
 *    desmarcar CITADA retrai o fato oficial;
 *  - marca NÃO oficial (linha inferida, ambígua, Clara ou não verificada) →
 *    evidência NÃO OFICIAL. É válida: é a marca explícita de uma pessoa
 *    autenticada (S4), com autoria, sobre um assunto explícito — e só diverge
 *    quando o MESMO assunto já tem fato oficial, ou seja, quando o vínculo do
 *    envelope com o processo já está comprovado. Desmarcar sem proveniência
 *    oficial não retrai nada e não é evidência contrária.
 * O fato oficial nunca é sobrescrito por evidência; a divergência fica ABERTA
 * enquanto as duas continuarem válidas e incompatíveis.
 */

export type ValorConferido = ConferenciaMbl | ConferenciaHblOriginal;

export interface DivergenciaDeConferencia {
  documento: DocumentoConferido;
  /** Fato oficial vigente do assunto no Courier (null se foi retraído depois). */
  oficial: FatoOficial<ValorConferido> | null;
  divergencia: Divergencia<ValorConferido>;
}

const VALOR: Record<DocumentoConferido, Record<'RECEBIDO' | 'AUSENTE_NA_CONFERENCIA', ValorConferido>> = {
  MBL: { RECEBIDO: 'RECEBIDO', AUSENTE_NA_CONFERENCIA: 'AUSENTE_NA_CONFERENCIA' },
  HBL_ORIGINAL: { RECEBIDO: 'RECEBIDO_E_CONFERIDO', AUSENTE_NA_CONFERENCIA: 'AUSENTE_NA_CONFERENCIA' },
};

export function divergenciasDoCourier(
  historico: ReadonlyArray<ConferenciaRegistrada>, fonte: DisponibilidadeFonte,
): DivergenciaDeConferencia[] {
  const porAssunto = new Map<string, ConferenciaRegistrada[]>();
  for (const l of historico) {
    const chave = `${l.trackingChave}|${l.documento}|${l.processoRef}`;
    porAssunto.set(chave, [...(porAssunto.get(chave) ?? []), l]);
  }
  const out: DivergenciaDeConferencia[] = [];
  for (const linhas of porAssunto.values()) {
    let estado: EstadoDoFato<ValorConferido> = estadoInicial(fonte);
    for (const l of linhas) {
      const observadoEm = l.registradoEm.toISOString();
      const evidencia = { fonte: 'courier', ref: `courier_fato:${l.fatoId}` };
      if (l.valor === 'DESMARCADO') {
        if (l.associacao === 'CITADA') estado = estadoInicial(estado.fonte);
        continue;
      }
      const valor = VALOR[l.documento][l.valor];
      estado = aplicarObservacao(estado, l.associacao === 'CITADA'
        ? { tipo: 'OFICIAL', valor, observadoEm, evidencia }
        : { tipo: 'NAO_OFICIAL', valor, observadoEm, evidencia, valida: true }).estado;
    }
    for (const divergencia of estado.divergencias) out.push({ documento: linhas[0].documento, oficial: estado.oficial, divergencia });
  }
  return out;
}
