import { PoolClient } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { abrirPendenciaComClient, resolverPendenciasComClient } from './pendencias';

/**
 * Fase D15-B (R08/R39/R40) — violações de cronologia na PROMOÇÃO de
 * `gateOutDate`/`trackingReturnDate`. Puramente a direção literal do
 * Blueprint: a observação NOVA é comparada contra as datas JÁ selecionadas
 * no MESMO contêiner (lidas sob o MESMO `FOR UPDATE` do protocolo universal
 * de lock — nenhuma consulta extra, nenhuma mudança de ordem de lock).
 *
 * Deliberadamente NÃO verificado (limite de escopo, documentado na entrega):
 * a direção inversa — uma NOVA `dischargeDate` que tornaria um
 * `gateOutDate`/`trackingReturnDate` JÁ selecionado retroativamente
 * inválido. O Blueprint (31.2, 31.6/31.7) não exige essa direção, e D15-A já
 * tem cobertura extensa e congelada do caminho de promoção de descarga —
 * adicionar uma checagem ali seria reabrir superfície congelada sem mandato
 * explícito. Caso o armador corrija a descarga depois, o PRÓXIMO
 * Gate Out/Empty Return re-ingerido (mesma janela de tracking autorizada,
 * nenhum fetch extra) é reavaliado contra a descarga corrigida.
 */
export type TipoCronologia = 'retorno_vazio_antes_descarga' | 'cronologia_gate_out_antes_descarga' | 'cronologia_retorno_antes_gate_out';

export interface FatosCronologia {
  dischargeDate: CivilDate | null;
  gateOutDate: CivilDate | null;
  trackingReturnDate: CivilDate | null;
}

/**
 * Função PURA (sem banco): decide se promover `campo = novoValor` violaria a
 * cronologia contra os fatos JÁ selecionados. `retorno_vazio_antes_descarga`
 * (R08/31.5) é verificado ANTES de `cronologia_retorno_antes_gate_out`
 * (R40) — uma violação contra a descarga é sempre a mais grave das duas
 * quando ambas se aplicariam ao mesmo valor.
 */
export function violacaoCronologia(campo: 'gateOutDate' | 'trackingReturnDate', novoValor: CivilDate, fatos: FatosCronologia): TipoCronologia | null {
  if (campo === 'gateOutDate') {
    if (fatos.dischargeDate && novoValor < fatos.dischargeDate) return 'cronologia_gate_out_antes_descarga';
    return null;
  }
  // trackingReturnDate (Empty Return).
  if (fatos.dischargeDate && novoValor < fatos.dischargeDate) return 'retorno_vazio_antes_descarga';
  if (fatos.gateOutDate && novoValor < fatos.gateOutDate) return 'cronologia_retorno_antes_gate_out';
  return null;
}

/** Abre a pendência de cronologia correspondente, preservando a evidência bruta (já gravada no ledger pelo chamador) — nunca promove o valor. */
export async function abrirPendenciaCronologia(
  db: PoolClient, input: { organizationId: string; processoId: string; containerId: string; tipo: TipoCronologia; campo: string; valorNovo: CivilDate; fatos: FatosCronologia; observationId: string },
): Promise<{ id: string | null }> {
  return abrirPendenciaComClient(db, input.organizationId, input.processoId, input.containerId, input.tipo, {
    campo: input.campo, valorNovo: input.valorNovo, observationId: input.observationId,
    dischargeDate: input.fatos.dischargeDate, gateOutDate: input.fatos.gateOutDate, trackingReturnDate: input.fatos.trackingReturnDate,
  });
}

/** Resolve a pendência de cronologia do TIPO dado para este contêiner — chamado quando uma promoção do mesmo campo é aceita sem violação. */
export function resolverPendenciaCronologia(db: PoolClient, processoId: string, containerId: string, tipo: TipoCronologia): Promise<number> {
  return resolverPendenciasComClient(db, processoId, containerId, [tipo]);
}
