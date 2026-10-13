import { Pool } from 'pg';
import { resolverProcesso } from '../../identidade';
import { referenciasConferidasNoEnvelope } from '../../couriers/fatos/courierFatos';
import { ResultadoPersistencia } from '../../auditoria/fatos/extracoes';
import { GatilhoRecalculo, recalcularAfetadosPeloProcesso } from './projecao';

/**
 * Gatilhos da L2: os pontos onde um fato durável dos donos acabou de mudar
 * (depois do COMMIT do dono). Recálculo por evento — sem polling, sem
 * varredura, sem job recorrente — e sem ator humano inventado. Falha aqui
 * nunca desfaz nem bloqueia o fato de origem: é registrada no log e a projeção
 * se refaz no próximo gatilho ou por `recalcularLiberacaoProcesso`
 * (idempotente).
 *
 * Só são chamados nos ramos duráveis das rotas (chave `PRIORA_FATOS_DURAVEIS`).
 *
 * Passagem de identidade (S6): uma pendência resolvida torna utilizáveis, na
 * leitura, fatos S1/S2 antes não publicados. O caminho que existe hoje — o
 * processo criado pela Auditoria (DOCUMENTAL) — está ligado aqui. O registro
 * de alias do S6 ainda não tem chamador de produção; quando tiver, ele chama
 * `recalcularAfetadosPeloProcesso(pool, org, processoId, 'IDENTIDADE_RESOLVIDA')`
 * para o processo resolvido.
 */
export interface GatilhosLiberacao {
  /** Uma linha de conferência (MBL / HBL original) foi gravada pelo S1. */
  conferenciaRegistrada(organizationId: string, courierFatoId: string): Promise<void>;
  /** Uma linha de estado de envelope foi gravada pelo S1. */
  envelopeRegistrado(organizationId: string, courierFatoId: string): Promise<void>;
  /** A Auditoria persistiu extrações (S2): vínculo novo/confirmado ou processo criado. */
  extracoesPersistidas(organizationId: string, resultados: ReadonlyArray<ResultadoPersistencia>): Promise<void>;
}

async function semFalhar(rotulo: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[liberacao] recálculo adiado (${rotulo}):`, (err as Error).message);
  }
}

export function gatilhosLiberacaoPadrao(pool: () => Pool): GatilhosLiberacao {
  const recalcular = async (organizationId: string, processoIds: Iterable<string>, gatilho: GatilhoRecalculo) => {
    for (const processoId of [...new Set(processoIds)].sort()) {
      await recalcularAfetadosPeloProcesso(pool(), organizationId, processoId, gatilho);
    }
  };
  /** Processo da referência EXATA gravada pelo S1, resolvido agora pelo S6 (nunca criado). */
  const processosDasReferencias = async (organizationId: string, refs: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const ref of refs) {
      const r = await resolverProcesso(pool(), organizationId, ref);
      if (r.status === 'RESOLVIDO') out.push(r.processoId);
    }
    return out;
  };

  return {
    conferenciaRegistrada: (organizationId, courierFatoId) => semFalhar('courier/conferência', async () => {
      const { rows: [f] } = await pool().query(
        `SELECT processo_ref FROM courier_fatos WHERE id = $1 AND organization_id = $2 AND tipo = 'CONFERENCIA_DOCUMENTO'`,
        [courierFatoId, organizationId],
      );
      if (!f) return;
      await recalcular(organizationId, await processosDasReferencias(organizationId, [f.processo_ref]), 'COURIER_CONFERENCIA');
    }),

    envelopeRegistrado: (organizationId, courierFatoId) => semFalhar('courier/envelope', async () => {
      const { rows: [f] } = await pool().query(
        `SELECT tracking_chave FROM courier_fatos WHERE id = $1 AND organization_id = $2 AND tipo = 'ESTADO_ENVELOPE'`,
        [courierFatoId, organizationId],
      );
      if (!f) return;
      const refs = await referenciasConferidasNoEnvelope(pool(), organizationId, f.tracking_chave);
      await recalcular(organizationId, await processosDasReferencias(organizationId, refs), 'COURIER_ENVELOPE');
    }),

    extracoesPersistidas: (organizationId, resultados) => semFalhar('auditoria', async () => {
      const vinculados: string[] = [];
      const criados: string[] = [];
      for (const r of resultados) {
        if (!('vinculacao' in r)) continue;
        const p = r.vinculacao.processo;
        if (p.tipo !== 'REGISTRADO' || p.resultado.status !== 'RESOLVIDO') continue;
        if (r.vinculacao.vinculo) vinculados.push(p.resultado.processoId);
        else if (p.resultado.via === 'CRIADO') criados.push(p.resultado.processoId);
      }
      await recalcular(organizationId, vinculados, 'AUDITORIA_VINCULO');
      await recalcular(organizationId, criados.filter((id) => !vinculados.includes(id)), 'IDENTIDADE_RESOLVIDA');
    }),
  };
}
