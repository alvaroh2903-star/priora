import { CivilDate, fromOrdinal, toOrdinal } from '../temporal/civilDate';

/**
 * Fase D11 (Gates G1-G7) — CONTRATO e validação PURA da decisão de
 * Responsabilidade Rocket × Cliente. Nenhuma consulta ao banco aqui: só a
 * forma da entrada e a coerência interna (status × base × dias × períodos).
 * A validação que depende de fatos do banco (relógios, autoria, timing) é do
 * serviço transacional (`decidirResponsabilidade.ts`).
 *
 * Não há rota pública nem tela: só o serviço da aplicação (Gestor MANAGER/
 * ADMIN, via alguma automação futura de UI) e os testes da engine chamam isto.
 */

export type StatusResponsabilidade = 'CONFIRMADA_ROCKET' | 'CONFIRMADA_CLIENTE' | 'DIVIDIDA' | 'NAO_APLICAVEL';
export type BaseRelogio = 'RELOGIO_CLIENTE' | 'RELOGIO_ROCKET' | 'NAO_APLICAVEL';
export type MotivoEstruturado = 'DIFERENCA_COMERCIAL_FREE_TIME';
export type LadoResponsabilidade = 'ROCKET' | 'CLIENTE';

export interface PeriodoInput {
  lado: LadoResponsabilidade;
  inicio: CivilDate;
  fim: CivilDate;
}

export interface DecidirResponsabilidadeInput {
  organizationId: string;
  containerId: string;
  autorMembershipId: string;
  status: StatusResponsabilidade;
  baseRelogio: BaseRelogio;
  motivoEstruturado?: MotivoEstruturado | null;
  /** Períodos DECLARADOS pelo Gestor — vazio só é aceito para NAO_APLICAVEL. */
  periodos: PeriodoInput[];
  justificativa: string;
  evidenciaRef: string;
  /** Obrigatório numa correção (versão > 1); ausente na primeira decisão. */
  substituiDecisaoId?: string | null;
  motivoCorrecao?: string | null;
}

export type CodigoErroResponsabilidade =
  | 'CAMPO_OBRIGATORIO'
  | 'JUSTIFICATIVA_AUSENTE'
  | 'EVIDENCIA_AUSENTE'
  | 'STATUS_INCOERENTE'
  | 'PERIODOS_AUSENTES'
  | 'PERIODO_INVALIDO'
  | 'DIA_DUPLICADO'
  | 'SOBREPOSICAO'
  | 'LADO_INCOMPATIVEL_COM_BASE'
  | 'MOTIVO_CORRECAO_AUSENTE'
  // Erros próprios da validação transacional (decidirResponsabilidade.ts):
  | 'PROCESSO_NAO_ENCONTRADO'
  | 'CONTAINER_NAO_ENCONTRADO'
  | 'EXIGE_REABERTURA'
  | 'AUTOR_NAO_AUTORIZADO'
  | 'ANTES_DA_DEVOLUCAO'
  | 'SEM_APURACAO_DETERMINAVEL'
  | 'INTERVALO_ABERTO'
  | 'BASE_RELOGIO_INVALIDA'
  | 'VERSAO_DESATUALIZADA'
  | 'DIA_FORA_DA_BASE'
  | 'LACUNA';

export class ErroResponsabilidade extends Error {
  constructor(public readonly codigo: CodigoErroResponsabilidade, public readonly detalhe: Record<string, unknown> = {}) {
    super(`${codigo}${Object.keys(detalhe).length ? ` ${JSON.stringify(detalhe)}` : ''}`);
    this.name = 'ErroResponsabilidade';
  }
}

/** Um dia (CivilDate) com o lado a que foi atribuído, já expandido dos períodos. */
export interface DiaAtribuido {
  dia: CivilDate;
  lado: LadoResponsabilidade;
}

/**
 * Expande os períodos declarados em dias individuais, na ordem cronológica,
 * detectando duplicata/sobreposição (o MESMO dia não pode aparecer em dois
 * períodos, mesmo que do mesmo lado — cada período deve ser uma faixa
 * disjunta). Datas inválidas (fim < início) já são responsabilidade de quem
 * monta o período (fim < início é cedo demais para um erro de negócio — ver
 * `PERIODO_INVALIDO`).
 */
export function expandirPeriodos(periodos: PeriodoInput[]): DiaAtribuido[] {
  const vistos = new Set<string>();
  const dias: DiaAtribuido[] = [];
  for (const p of periodos) {
    const ini = toOrdinal(p.inicio);
    const fim = toOrdinal(p.fim);
    if (fim < ini) {
      throw new ErroResponsabilidade('PERIODO_INVALIDO', { periodo: p });
    }
    for (let o = ini; o <= fim; o++) {
      const dia = fromOrdinal(o);
      if (vistos.has(dia)) {
        throw new ErroResponsabilidade('SOBREPOSICAO', { dia });
      }
      vistos.add(dia);
      dias.push({ dia, lado: p.lado });
    }
  }
  return dias.sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}

/**
 * Coerência PURA status × base × motivo × dias (mesmo formato do CHECK da
 * migration 0031 — validado aqui ANTES de ir ao banco, com erro legível).
 * `diasRocket`/`diasCliente` já vêm contados a partir de `expandirPeriodos`.
 */
export function validarCoerencia(input: {
  status: StatusResponsabilidade;
  baseRelogio: BaseRelogio;
  motivoEstruturado?: MotivoEstruturado | null;
  diasRocket: number;
  diasCliente: number;
}): void {
  const { status, baseRelogio, motivoEstruturado, diasRocket, diasCliente } = input;
  const ok =
    (status === 'CONFIRMADA_CLIENTE' && baseRelogio === 'RELOGIO_CLIENTE'
      && diasRocket === 0 && diasCliente >= 1 && !motivoEstruturado)
    || (status === 'CONFIRMADA_ROCKET' && (baseRelogio === 'RELOGIO_CLIENTE' || baseRelogio === 'RELOGIO_ROCKET')
      && diasRocket >= 1 && diasCliente === 0 && !motivoEstruturado)
    || (status === 'DIVIDIDA' && baseRelogio === 'RELOGIO_CLIENTE'
      && diasRocket >= 1 && diasCliente >= 1 && !motivoEstruturado)
    || (status === 'NAO_APLICAVEL' && baseRelogio === 'NAO_APLICAVEL'
      && diasRocket === 0 && diasCliente === 0 && motivoEstruturado === 'DIFERENCA_COMERCIAL_FREE_TIME');
  if (!ok) {
    throw new ErroResponsabilidade('STATUS_INCOERENTE', { status, baseRelogio, motivoEstruturado, diasRocket, diasCliente });
  }
}

/**
 * Valida a forma da entrada (campos obrigatórios, períodos, coerência) — a
 * PRIMEIRA linha de defesa, sem tocar o banco. Devolve os dias já expandidos
 * e ordenados, prontos para a validação transacional.
 */
export function validarEntrada(input: DecidirResponsabilidadeInput): { dias: DiaAtribuido[]; diasRocket: number; diasCliente: number } {
  if (!input.organizationId) throw new ErroResponsabilidade('CAMPO_OBRIGATORIO', { campo: 'organizationId' });
  if (!input.containerId) throw new ErroResponsabilidade('CAMPO_OBRIGATORIO', { campo: 'containerId' });
  if (!input.autorMembershipId) throw new ErroResponsabilidade('CAMPO_OBRIGATORIO', { campo: 'autorMembershipId' });
  if (!input.justificativa || !input.justificativa.trim()) throw new ErroResponsabilidade('JUSTIFICATIVA_AUSENTE');
  if (!input.evidenciaRef || !input.evidenciaRef.trim()) throw new ErroResponsabilidade('EVIDENCIA_AUSENTE');
  if (input.substituiDecisaoId && (!input.motivoCorrecao || !input.motivoCorrecao.trim())) {
    throw new ErroResponsabilidade('MOTIVO_CORRECAO_AUSENTE');
  }

  const periodos = input.periodos ?? [];
  if (input.status === 'NAO_APLICAVEL') {
    if (periodos.length > 0) throw new ErroResponsabilidade('PERIODO_INVALIDO', { motivo: 'NAO_APLICAVEL nao aceita periodos' });
  } else if (periodos.length === 0) {
    throw new ErroResponsabilidade('PERIODOS_AUSENTES');
  }

  // Ajuste 2/1: nunca misturar dias dos dois relógios — em RELOGIO_ROCKET só
  // existe o lado ROCKET (a decisão não tem o que atribuir ao cliente: o
  // cliente não tem dias nesse universo).
  if (input.baseRelogio === 'RELOGIO_ROCKET' && periodos.some((p) => p.lado === 'CLIENTE')) {
    throw new ErroResponsabilidade('LADO_INCOMPATIVEL_COM_BASE', { baseRelogio: input.baseRelogio });
  }

  const dias = expandirPeriodos(periodos);
  const diasRocket = dias.filter((d) => d.lado === 'ROCKET').length;
  const diasCliente = dias.filter((d) => d.lado === 'CLIENTE').length;
  validarCoerencia({ status: input.status, baseRelogio: input.baseRelogio, motivoEstruturado: input.motivoEstruturado, diasRocket, diasCliente });

  return { dias, diasRocket, diasCliente };
}
