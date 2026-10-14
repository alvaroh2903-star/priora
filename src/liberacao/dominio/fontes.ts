import { DisponibilidadeFonte, FatoOficial } from './tipos';

/**
 * L1b — fontes semânticas. Cada fonte tem significado de negócio próprio,
 * mesmo que várias venham a compartilhar a mesma infraestrutura técnica (a
 * mesma caixa de e-mail, o mesmo HeadCargo). A L1b nunca funde o significado
 * delas. Integração ausente é DEPENDÊNCIA TÉCNICA PENDENTE: a fonte chega
 * como NAO_INTEGRADA e o resultado que dependia dela é "não determinável"
 * (D-6) — nunca um negativo.
 */
export type FonteL1b =
  | 'COURIER' // S1: conferência física (Master físico, HBL original)
  | 'MODALIDADE_BL' // informação de modalidade do HBL/MBL dada pelo agente e o pedido dela
  | 'PRE_ALERTA' // confirmação do pré-alerta
  | 'EMAIL_WAVE' // Wave confirmado por e-mail válido do agente (cap. 23)
  | 'EMAIL_EMISSAO_DESTINO' // emissão no destino: anúncio, consulta e autorização (cap. 24)
  | 'EMAIL_TELEX' // Telex Release por e-mail válido do agente (cap. 16)
  | 'PORTAL_FOTO_HBL' // HBL físico pelo caminho A: foto no Portal + Analista (cap. 15)
  | 'HEADCARGO_TERMO_UNICO' // Termo Único (cap. 17)
  | 'PORTAL_TERMO_EMBARQUE' // Termo por Embarque + procuração (cap. 18)
  | 'HEADCARGO_FINANCEIRO_CLIENTE' // pagamento/prazo do cliente (cap. 19)
  | 'ARMADOR' // armador do Master, fato confiável do dono futuro (nunca deduzido)
  | 'PROCEDIMENTO_AGENCIA' // agendamento, memorando, envio e apresentação (cap. 26–30)
  | 'HEADCARGO_PAGAMENTO_ARMADOR' // pagamento ao armador (cap. 31, N-9)
  | 'VIAGEM' // VesselCall/tracking: ETA, ATA, atracação, viagem por contêiner (S3)
  | 'ROTA_E_RETIFICACAO' // alteração de rota e retificações de CE (cap. 13)
  | 'AUDITORIA_CE_HOUSE' // desconsolidação e CE House (cap. 8, S2 completo)
  | 'SISCARGA_FRETE' // pendência de frete/pagamento (cap. 11)
  | 'SISCARGA_FISCAL'; // pendência fiscal (cap. 11, 12)

/** Fonte ainda sem integração, ou integrada com a disponibilidade atual (3ª dimensão do N-17). */
export type Integrado<T> =
  | { tipo: 'NAO_INTEGRADA' }
  | { tipo: 'INTEGRADA'; fonte: DisponibilidadeFonte; valor: T };

export const NAO_INTEGRADA: { tipo: 'NAO_INTEGRADA' } = { tipo: 'NAO_INTEGRADA' };

/**
 * Estado oficial de um fato (N-16/N-17): o oficial vigente (com frescor) e os
 * oficiais substituídos por mudança da própria fonte. A disponibilidade fica
 * no `Integrado` que o envolve. Sem oficial = nunca houve observação válida.
 */
export interface EstadoOficial<V> {
  oficial: FatoOficial<V> | null;
  historico: ReadonlyArray<FatoOficial<V>>;
}

/** "Não determinável com as fontes atuais" (D-6): o que falta, o que está fora e o que não observou nada. */
export interface IndeterminacaoL1b {
  tipo: 'NAO_DETERMINAVEL';
  semFonteIntegrada: FonteL1b[];
  fontesIndisponiveis: FonteL1b[];
  semObservacao: FonteL1b[];
}

const unicos = <T>(lista: ReadonlyArray<T>): T[] => [...new Set(lista)];

export function indeterminacao(
  semFonteIntegrada: ReadonlyArray<FonteL1b> = [], fontesIndisponiveis: ReadonlyArray<FonteL1b> = [],
  semObservacao: ReadonlyArray<FonteL1b> = [],
): IndeterminacaoL1b {
  return {
    tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: unicos(semFonteIntegrada), fontesIndisponiveis: unicos(fontesIndisponiveis),
    semObservacao: unicos(semObservacao),
  };
}

/** Une indeterminações preservando a ordem de chegada. */
export function juntar(...partes: ReadonlyArray<IndeterminacaoL1b | null | undefined>): IndeterminacaoL1b {
  const presentes = partes.filter((p): p is IndeterminacaoL1b => !!p);
  return indeterminacao(
    presentes.flatMap((p) => p.semFonteIntegrada), presentes.flatMap((p) => p.fontesIndisponiveis),
    presentes.flatMap((p) => p.semObservacao),
  );
}

export const vazia = (i: IndeterminacaoL1b): boolean =>
  i.semFonteIntegrada.length === 0 && i.fontesIndisponiveis.length === 0 && i.semObservacao.length === 0;

/**
 * Leitura em três valores de uma fonte de fato oficial:
 *  - NAO_INTEGRADA → não determinável (falta a fonte);
 *  - oficial presente → conhecido, mesmo com a fonte fora (N-17: indisponibilidade não apaga o fato);
 *  - sem oficial e fonte disponível → ausência OBSERVÁVEL;
 *  - sem oficial e fonte fora → não determinável (fonte indisponível, sem fato anterior).
 */
export type Leitura<V> =
  | { tipo: 'CONHECIDO'; fato: FatoOficial<V>; fonte: DisponibilidadeFonte; historico: ReadonlyArray<FatoOficial<V>> }
  | { tipo: 'AUSENTE'; fonte: DisponibilidadeFonte }
  | { tipo: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

export function ler<V>(chave: FonteL1b, entrada: Integrado<EstadoOficial<V>>): Leitura<V> {
  if (entrada.tipo === 'NAO_INTEGRADA') return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([chave]) };
  const { oficial, historico } = entrada.valor;
  if (oficial) return { tipo: 'CONHECIDO', fato: oficial, fonte: entrada.fonte, historico };
  if (entrada.fonte.disponivel) return { tipo: 'AUSENTE', fonte: entrada.fonte };
  return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([], [chave]) };
}

/** Fonte de registros (listas de eventos): integrada e com o que já se sabe; fora sem nada → não determinável. */
export function lerRegistros<T>(chave: FonteL1b, entrada: Integrado<ReadonlyArray<T>>):
  | { tipo: 'CONHECIDO'; registros: ReadonlyArray<T>; fonte: DisponibilidadeFonte }
  | { tipo: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b } {
  if (entrada.tipo === 'NAO_INTEGRADA') return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([chave]) };
  if (entrada.valor.length === 0 && !entrada.fonte.disponivel) return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([], [chave]) };
  return { tipo: 'CONHECIDO', registros: entrada.valor, fonte: entrada.fonte };
}
