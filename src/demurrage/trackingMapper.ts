import { TrackingResult } from '../browser/carriers';
import { ContainerInfo } from '../browser/carriers/types';
import { DemurrageContainer } from './demurrageParser';

/**
 * Priora — Ponte entre o resultado do BOT (rastreio no portal do armador) e o
 * formato de contêiner do módulo Demurrage (que o cálculo já consome).
 *
 * O portal fornece as DATAS DE MOVIMENTO (retirada do cheio / devolução do
 * vazio). O free time e a diária são CONTRATUAIS e continuam vindo do e-mail
 * (Clara) — aqui ficam null para serem mesclados depois. Nada é inventado.
 */

/** Converte os contêineres do rastreio para o formato do módulo Demurrage. */
export function trackingToDemurrageContainers(
  result: TrackingResult,
): DemurrageContainer[] {
  return result.containers.map((c: ContainerInfo) => ({
    numero: c.numero || result.reference,
    dataRetirada: c.gateOut, // saída do cheio do terminal = retirada
    freeTimeDias: null, // contratual → vem do e-mail
    diaria: null, // contratual → vem do e-mail
    moeda: null,
    dataDevolucao: c.emptyReturn, // devolução do vazio
    minutaRecebida: null,
  }));
}

/**
 * Mescla o contêiner do e-mail (Clara) com o do portal, preferindo as DATAS do
 * portal (fonte de origem) e mantendo free time/diária/moeda do e-mail.
 */
export function mergeEmailAndPortal(
  email: DemurrageContainer,
  portal: DemurrageContainer,
): DemurrageContainer {
  return {
    numero: email.numero || portal.numero,
    // Datas: o portal (movimento real) tem prioridade; e-mail como fallback.
    dataRetirada: portal.dataRetirada ?? email.dataRetirada,
    dataDevolucao: portal.dataDevolucao ?? email.dataDevolucao,
    // Contratual: só o e-mail tem.
    freeTimeDias: email.freeTimeDias,
    diaria: email.diaria,
    moeda: email.moeda,
    minutaRecebida: email.minutaRecebida,
  };
}
