import { Instante } from './tipos';

/**
 * L1b — vocabulário operacional comum: quem age, qual ação, qual classe da
 * Fila (N-11, D-1) e em qual visão (cap. 35, 37). Etapa ≠ bloqueador /
 * responsável ≠ próxima ação (cap. 4): aqui só ficam bloqueadores e ações.
 */

export type Responsavel =
  | 'ROCKET' // Analista / operação da Rocket
  | 'ROCKET_FINANCEIRO' // pagamento ao armador pendente do lado da Rocket (P7)
  | 'GESTOR' // aprovação de override (H-16)
  | 'CLIENTE'
  | 'AGENTE'
  | 'ARMADOR'
  | 'AGENCIA'
  | 'DESCONSOLIDACAO'
  | 'TERCEIRO'; // espera externa sem parte identificável com segurança (ex.: documento em trânsito)

/** A — ação da Rocket já devida (só N-10 e a cobrança da H-10); B — risco iminente; C — ação Rocket disponível; D — bloqueio externo. */
export type Classe = 'A' | 'B' | 'C' | 'D';
export const ORDEM_CLASSE: Record<Classe, number> = { A: 0, B: 1, C: 2, D: 3 };

export type Visao = 'FILA_PRINCIPAL' | 'ACOMPANHAMENTO';

export type CodigoAcao =
  // Master
  | 'VERIFICAR_SITUACAO_DO_MASTER'
  | 'SOLICITAR_MODALIDADE_AO_AGENTE'
  | 'AGUARDAR_RESPOSTA_DE_MODALIDADE'
  | 'RESOLVER_CONFLITO_DE_IDENTIDADE_DO_MASTER'
  | 'AGUARDAR_MASTER_FISICO_EM_TRANSITO'
  | 'CONFERIR_MBL_NO_COURIER'
  | 'ACOMPANHAR_MBL_AUSENTE_COM_O_AGENTE'
  | 'AGUARDAR_CONFIRMACAO_DO_WAVE'
  | 'CONSULTAR_ARMADOR_EMISSAO_DESTINO'
  | 'AGUARDAR_AUTORIZACAO_DA_ORIGEM'
  // House
  | 'VALIDAR_HBL_FISICO'
  | 'AGUARDAR_NOVA_FOTO_DO_HBL'
  | 'AGUARDAR_FOTO_DO_HBL'
  | 'AGUARDAR_TELEX_DO_AGENTE'
  | 'CONFERIR_HBL_NO_COURIER'
  | 'AGUARDAR_HBL_FISICO'
  | 'ACOMPANHAR_HBL_AUSENTE_COM_O_AGENTE'
  | 'IDENTIFICAR_MODALIDADE_DO_HOUSE'
  // Termo e financeiro do cliente
  | 'AGUARDAR_TERMO_DO_CLIENTE'
  | 'REVISAR_TERMO_POR_EMBARQUE'
  | 'AGUARDAR_CORRECAO_DO_TERMO'
  | 'AGUARDAR_NOVO_TERMO_DO_CLIENTE'
  | 'AGUARDAR_PAGAMENTO_OU_PRAZO_DO_CLIENTE'
  // Agência e apresentação
  | 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO'
  | 'IDENTIFICAR_ARMADOR_DO_MASTER'
  | 'AGENDAR_NO_PORTAL'
  | 'AGUARDAR_CONFIRMACAO_DO_AGENDAMENTO'
  | 'APRESENTAR_MASTER'
  | 'AGUARDAR_STATUS_FINALIZADO'
  | 'PREPARAR_MEMORANDO'
  | 'ENVIAR_PARA_APRESENTACAO'
  | 'AGUARDAR_MEMORANDO_CARIMBADO'
  | 'PREPARAR_MEMORANDO_E_AVISAR_APRESENTACAO'
  | 'AGUARDAR_ATRACACAO'
  | 'APRESENTAR_EVERGREEN'
  | 'AGUARDAR_PROTOCOLO_CARIMBADO'
  | 'CONFIRMAR_APRESENTACAO'
  | 'ANALISAR_ENCAMINHAMENTO_INCOMPATIVEL'
  // Armador e desbloqueio
  | 'PAGAR_ARMADOR'
  | 'AGUARDAR_CONFIRMACAO_DO_PAGAMENTO_AO_ARMADOR'
  | 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA'
  | 'COBRAR_ARMADOR_DESBLOQUEIO'
  | 'AGUARDAR_CE_HOUSE'
  // Viagem
  | 'VERIFICAR_POSSIVEL_ROLAGEM'
  // CE / prazos regulatórios (visão própria; nunca classe da Fila)
  | 'VERIFICAR_DESCONSOLIDACAO'
  | 'SOLICITAR_DESBLOQUEIO_FISCAL_NO_ECAC'
  | 'RECONSULTAR_PENDENCIA_FISCAL'
  | 'AGUARDAR_RETIFICACAO_DO_CE_MASTER'
  | 'RETIFICAR_CE_HOUSE';

/** Ação de Master compartilhada sujeita ao portão do N-13 (procedimento/apresentação). */
export type AcaoSobreponivel = 'INICIAR_PROCEDIMENTO' | 'APRESENTAR';

/**
 * Um bloqueador e o que fazer com ele. `classe` null = não entra na Fila
 * Principal (P9: indisponibilidade não vira classe; procedimento não
 * mapeado: nada se recomenda).
 */
export interface ItemOperacional {
  motivo: string;
  /** BLOQUEIO: algo impede o avanço (de quem quer que seja); ACAO: nada impede, a Rocket tem o que fazer. */
  natureza: 'BLOQUEIO' | 'ACAO';
  responsavel: Responsavel | null;
  acao: CodigoAcao | null;
  classe: Classe | null;
  escopo: 'PROCESSO' | 'MASTER';
  visao: Visao;
  /** Desde quando a ação está disponível / o bloqueio existe (5º desempate). */
  desde: Instante | null;
  /** Ação de Master de procedimento/apresentação: exige o portão do N-13 para a ação indicada. */
  exigePortaoN13?: AcaoSobreponivel;
  detalhe?: Readonly<Record<string, unknown>>;
}
