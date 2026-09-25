import { toOrdinal } from '../temporal/civilDate';
import { Badge, ContainerLifecycleFacts, ContainerStateResult, EstadoOperacional } from './types';

/**
 * Fase 7 — estado operacional do contêiner (Cap. 21), função PURA.
 *
 * Precedência (§4 da especificação v4):
 *   Empty Return → DEVOLVIDO_AGUARDANDO_TRATAMENTO (custo ou responsabilidade) | CONCLUIDO_PARA_ROCKET
 *   sem Empty Return, relógio válido vencido → EM_DEMURRAGE_CRITICO (≥7, escalation ≥15) | EM_DEMURRAGE_ATENCAO (1–6)
 *   nenhum relógio válido vencido → PENDENCIA_DE_DADOS | PRAZO_PROXIMO | TRACKING_DESATUALIZADO | MONITORAMENTO_SILENCIOSO
 *
 * Os dois relógios nunca se agregam: a severidade da faixa usa o relógio mais
 * avançado, mas cliente e Rocket seguem separados nos fatos/badges.
 */

/** Dias até o vencimento mais próximo entre relógios OK dentro do prazo (null se nenhum). */
function menorDiasAteVencimento(facts: ContainerLifecycleFacts): number | null {
  const hoje = toOrdinal(facts.hoje);
  const candidatos: number[] = [];
  for (const clock of [facts.clienteClock, facts.rocketClock]) {
    if (clock.status === 'OK' && clock.diasDemurrage === 0 && clock.ultimoDiaLivre) {
      const dias = toOrdinal(clock.ultimoDiaLivre) - hoje;
      if (dias >= 0) candidatos.push(dias);
    }
  }
  return candidatos.length ? Math.min(...candidatos) : null;
}

function ehPrazoProximo(facts: ContainerLifecycleFacts): boolean {
  // Limiar TBD (null) → PRAZO_PROXIMO nunca é emitido (§7): nada de valor arbitrário.
  if (facts.prazoProximoThresholdDias === null) return false;
  const dias = menorDiasAteVencimento(facts);
  return dias !== null && dias <= facts.prazoProximoThresholdDias;
}

function motivoDe(estado: EstadoOperacional, facts: ContainerLifecycleFacts, badges: Badge[], severidadeDias: number): string {
  const partes: string[] = [];
  switch (estado) {
    case 'EM_DEMURRAGE_CRITICO':
      partes.push(`Cliente/Rocket em demurrage (${severidadeDias} dias)`);
      if (severidadeDias >= 15) partes.push('escalada/contato obrigatório');
      break;
    case 'EM_DEMURRAGE_ATENCAO':
      partes.push(`Em demurrage (${severidadeDias} dias)`);
      break;
    case 'PRAZO_PROXIMO':
      partes.push('Vencimento próximo');
      break;
    case 'PENDENCIA_DE_DADOS':
      partes.push('Pendência de dados');
      break;
    case 'TRACKING_DESATUALIZADO':
      partes.push('Tracking desatualizado');
      break;
    case 'DEVOLVIDO_AGUARDANDO_TRATAMENTO':
      partes.push('Devolvido — tratamento pendente');
      break;
    case 'CONCLUIDO_PARA_ROCKET':
      partes.push('Concluído para a Rocket');
      break;
    case 'MONITORAMENTO_SILENCIOSO':
      partes.push('Monitoramento silencioso');
      break;
  }
  if (badges.includes('rocketExposta')) partes.push('Rocket já exposta');
  if (badges.includes('trackingDesatualizado') && estado !== 'TRACKING_DESATUALIZADO') partes.push('tracking desatualizado');
  if (badges.includes('pendenciaDadosCliente')) partes.push('House Free Time ausente');
  if (badges.includes('pendenciaDadosRocket')) partes.push('Master Free Time ausente');
  if (badges.includes('responsabilidadeEmAnalise')) partes.push('responsabilidade em análise');
  if (badges.includes('divergenciaValor')) partes.push('divergência de valor');
  return partes.join('; ');
}

export function derivarEstadoContainer(facts: ContainerLifecycleFacts): ContainerStateResult {
  const cliente = facts.clienteClock;
  const rocket = facts.rocketClock;

  const clienteEmDemurrage = cliente.status === 'OK' && cliente.diasDemurrage >= 1;
  const rocketExposta = rocket.status === 'OK' && rocket.diasDemurrage >= 1;
  const severidadeDias = Math.max(
    clienteEmDemurrage ? cliente.diasDemurrage : 0,
    rocketExposta ? rocket.diasDemurrage : 0,
  );
  const clientePendente = cliente.status !== 'OK';
  const rocketPendente = rocket.status !== 'OK';

  let estado: EstadoOperacional;
  let escalationRequired = false;

  if (facts.emptyReturn) {
    // Empty Return encerra o acúmulo (Cap. 19/23). Minuta pendente sozinha NÃO
    // segura em tratamento (§3): só custo ou responsabilidade em análise.
    estado = facts.custo || facts.responsabilidadeEmAnalise
      ? 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'
      : 'CONCLUIDO_PARA_ROCKET';
  } else if (severidadeDias >= 1) {
    // Relógio válido vencido ⇒ existe demurrage; o outro relógio ausente vira badge.
    estado = severidadeDias >= 7 ? 'EM_DEMURRAGE_CRITICO' : 'EM_DEMURRAGE_ATENCAO';
    escalationRequired = severidadeDias >= 15;
  } else if (clientePendente || rocketPendente) {
    // Nenhum relógio válido vencido, mas falta dado → pendência é o estado principal.
    estado = 'PENDENCIA_DE_DADOS';
  } else if (ehPrazoProximo(facts)) {
    estado = 'PRAZO_PROXIMO';
  } else if (facts.cadenciaVencida) {
    estado = 'TRACKING_DESATUALIZADO';
  } else {
    estado = 'MONITORAMENTO_SILENCIOSO';
  }

  const badges: Badge[] = [];
  if (clienteEmDemurrage) badges.push('clienteEmDemurrage');
  if (rocketExposta) badges.push('rocketExposta');
  if (facts.cadenciaVencida) badges.push('trackingDesatualizado');
  // Pendência de um relógio quando o OUTRO já determina o estado (demurrage) — badge.
  if (clientePendente && estado !== 'PENDENCIA_DE_DADOS') badges.push('pendenciaDadosCliente');
  if (rocketPendente && estado !== 'PENDENCIA_DE_DADOS') badges.push('pendenciaDadosRocket');
  if (escalationRequired) badges.push('escalationRequired');
  if (facts.responsabilidadeEmAnalise) badges.push('responsabilidadeEmAnalise');
  if (facts.divergenciaValor) badges.push('divergenciaValor');

  return {
    estado,
    escalationRequired,
    severidadeDias,
    clienteEmDemurrage,
    rocketExposta,
    badges,
    documentaryStatus: facts.documentaryStatus,
    motivo: motivoDe(estado, facts, badges, severidadeDias),
  };
}
