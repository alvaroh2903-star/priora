import {
  CampoComFonte, ContainerContrato, FONTES_POR_CAMPO, FonteContrato, Observado, hashEstavel, jsonEstavel,
  normalizarNumeroContainer, normalizarNumeroProcesso,
} from '../registro/contrato';

/**
 * Produção P1 (Entrega 1) — CONTRATO do handoff (`demurrage.handoff.v1`).
 *
 * Correção #5 do usuário: só carrega fatos de registro/preparação já
 * aceitos pelo contrato D10 (`demurrage.registro.v1`) — processo, HBL/MBL,
 * contêineres/equipamento, armador, House/Master Free Time, responsável
 * operacional. NUNCA descarga, Gate Out, Empty Return, ETA, chegada,
 * atracação, responsabilidade, minuta, tarifa ou fechamento — esses campos
 * não existem no contrato D10 em primeiro lugar, então `CAMPOS_TOPO` do D10
 * já os rejeitaria; aqui a lista é reafirmada EXPLICITAMENTE (com um código
 * de erro próprio, mais claro para quem integra) para o caso de um sistema a
 * montante enviar esses nomes por engano.
 *
 * Correção #4 do usuário: `manual_fallback` é uma ação GOVERNADA por humano
 * (justificativa + autor interno) — nunca aceita por um contrato automático.
 * O contrato D10 permite `manual_fallback` em House/Master Free Time; este
 * contrato de handoff RESTRINGE isso ainda mais, rejeitando `manual_fallback`
 * em QUALQUER campo, antes mesmo de chamar o validador do D10.
 *
 * Identidade do evento a montante (duas identidades distintas, conforme
 * instrução do usuário):
 *  - `origemProcessoId`: identificador ESTÁVEL do processo a montante —
 *    nunca derivado de MBL/HBL/número de contêiner/nome de cliente (campos
 *    comerciais mutáveis); é o handoffService que usa isso só para
 *    rastreabilidade, NUNCA para decidir identidade do processo Demurrage
 *    (essa decisão continua sendo `numeroProcesso`, como no D10);
 *  - `origemEventoId`: identificador IMUTÁVEL do evento/versão a montante —
 *    a chave de idempotência desta camada (ver `handoffService.ts`).
 */

export const CONTRATO_HANDOFF_V1 = 'demurrage.handoff.v1' as const;

/** Campos operacionais/decisórios EXPLICITAMENTE fora deste contrato (correção #5). */
const CAMPOS_OPERACIONAIS_PROIBIDOS = [
  'descarga', 'dataDescarga', 'gateOut', 'gateIn', 'emptyReturn', 'devolucaoVazio', 'eta', 'etb', 'ets',
  'chegada', 'atracacao', 'berthing', 'responsabilidade', 'decisaoResponsabilidade', 'minuta', 'minutaFechamento',
  'tarifa', 'tabelaTarifaria', 'fechamento', 'reabertura', 'finalizacao',
] as const;

const CAMPOS_TOPO_HANDOFF = new Set([
  'versao', 'origemSistema', 'origemProcessoId', 'origemEventoId', 'origemOcorridoEm', 'numeroProcesso',
  'cliente', 'house', 'mbl', 'armador', 'condicaoComercial', 'responsavelOperacionalMembershipId',
  'houseFreeTimeDays', 'masterFreeTimeDays', 'containers',
]);
const CAMPOS_CONTAINER_HANDOFF = new Set(['numero', 'tipoOriginal', 'houseFreeTimeDays', 'masterFreeTimeDays']);

export interface EntradaHandoffV1 {
  versao: typeof CONTRATO_HANDOFF_V1;
  origemSistema: string;
  /** Identificador ESTÁVEL do processo a montante (nunca um fato comercial mutável). */
  origemProcessoId: string;
  /** Identificador IMUTÁVEL do evento/versão a montante. */
  origemEventoId: string;
  /** Versão/ocorrência do evento a montante (ISO 8601) — texto livre do lado de quem chama, nunca uma data operacional. */
  origemOcorridoEm?: string | null;
  numeroProcesso: string;
  cliente?: Observado<string> | null;
  house?: Observado<string> | null;
  mbl?: Observado<string> | null;
  armador?: Observado<string> | null;
  condicaoComercial?: Observado<{ termoTipo: 'embarque' | 'unico'; tabelaId?: string | null; fonteDocumental?: string | null }> | null;
  responsavelOperacionalMembershipId?: Observado<string> | null;
  houseFreeTimeDays?: Observado<number> | null;
  masterFreeTimeDays?: Observado<number> | null;
  containers: ContainerContrato[];
}

export type CodigoErroContratoHandoff =
  | 'VERSAO_NAO_SUPORTADA' | 'CAMPO_OBRIGATORIO' | 'CAMPO_NAO_ACEITO' | 'CAMPO_OPERACIONAL_NAO_ACEITO'
  | 'ORGANIZATION_ID_NAO_ACEITO_NA_ENTRADA' | 'FONTE_MANUAL_FALLBACK_NAO_ACEITA_NO_HANDOFF' | 'CONTAINER_NUMERO_INVALIDO'
  | 'CONTAINER_DUPLICADO_NA_ENTRADA';

export class ErroContratoHandoff extends Error {
  constructor(public readonly codigo: CodigoErroContratoHandoff, public readonly detalhe: Record<string, unknown> = {}) {
    super(`${codigo}${Object.keys(detalhe).length ? ` ${JSON.stringify(detalhe)}` : ''}`);
    this.name = 'ErroContratoHandoff';
  }
}

export interface EntradaHandoffNormalizada {
  entrada: EntradaHandoffV1;
  origemSistema: string;
  origemProcessoId: string;
  origemEventoId: string;
  origemOcorridoEm: string | null;
  numeroProcesso: string;
  containers: Array<ContainerContrato & { numeroNormalizado: string }>;
  /** Hash canônico do payload de NEGÓCIO (sem o envelope de identidade do evento) — usado pela camada A para detectar conflito/replay. */
  payloadHash: string;
}

function rejeitarManualFallback(nomeErro: string, o: Observado<unknown> | null | undefined): void {
  if (o && (o as { fonte?: unknown }).fonte === 'manual_fallback') {
    throw new ErroContratoHandoff('FONTE_MANUAL_FALLBACK_NAO_ACEITA_NO_HANDOFF', { campo: nomeErro });
  }
}

/**
 * Validação/normalização PURA do contrato de handoff (sem banco). Lança
 * `ErroContratoHandoff`. Não repete a validação de fonte×campo do D10 (fonte
 * documental válida, `observadoEm`, etc.) — isso é responsabilidade de
 * `validarRegistro` do D10, chamado depois por `handoffService.ts` com a
 * entrada já traduzida; esta função só garante o ENVELOPE do handoff e as
 * restrições PRÓPRIAS desta camada (organizationId fora, manual_fallback fora).
 */
export function validarEntradaHandoff(entradaBruta: unknown): EntradaHandoffNormalizada {
  if (!entradaBruta || typeof entradaBruta !== 'object') throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'entrada' });
  const entrada = entradaBruta as Record<string, unknown>;
  if (entrada.versao !== CONTRATO_HANDOFF_V1) throw new ErroContratoHandoff('VERSAO_NAO_SUPORTADA', { versao: entrada.versao });

  // organizationId NUNCA é aceito no corpo (nem em qualquer outro lugar da
  // entrada) — a organização só vem do contexto autenticado (ver handoffService.ts).
  if ('organizationId' in entrada) throw new ErroContratoHandoff('ORGANIZATION_ID_NAO_ACEITO_NA_ENTRADA');

  for (const k of Object.keys(entrada)) {
    if ((CAMPOS_OPERACIONAIS_PROIBIDOS as readonly string[]).includes(k)) {
      throw new ErroContratoHandoff('CAMPO_OPERACIONAL_NAO_ACEITO', { campo: k });
    }
    if (!CAMPOS_TOPO_HANDOFF.has(k)) throw new ErroContratoHandoff('CAMPO_NAO_ACEITO', { campo: k });
  }

  const origemSistema = typeof entrada.origemSistema === 'string' ? entrada.origemSistema.trim() : '';
  if (!origemSistema) throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'origemSistema' });
  const origemProcessoId = typeof entrada.origemProcessoId === 'string' ? entrada.origemProcessoId.trim() : '';
  if (!origemProcessoId) throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'origemProcessoId' });
  const origemEventoId = typeof entrada.origemEventoId === 'string' ? entrada.origemEventoId.trim() : '';
  if (!origemEventoId) throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'origemEventoId' });
  let origemOcorridoEm: string | null = null;
  if (entrada.origemOcorridoEm !== undefined && entrada.origemOcorridoEm !== null) {
    if (typeof entrada.origemOcorridoEm !== 'string' || Number.isNaN(Date.parse(entrada.origemOcorridoEm))) {
      throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'origemOcorridoEm' });
    }
    origemOcorridoEm = entrada.origemOcorridoEm;
  }

  const numeroProcesso = normalizarNumeroProcesso(String(entrada.numeroProcesso ?? ''));
  if (!numeroProcesso) throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'numeroProcesso' });

  for (const campo of ['cliente', 'house', 'mbl', 'armador', 'condicaoComercial', 'responsavelOperacionalMembershipId'] as const) {
    rejeitarManualFallback(campo, entrada[campo] as Observado<unknown> | null | undefined);
  }
  rejeitarManualFallback('houseFreeTimeDays', entrada.houseFreeTimeDays as Observado<unknown> | null | undefined);
  rejeitarManualFallback('masterFreeTimeDays', entrada.masterFreeTimeDays as Observado<unknown> | null | undefined);

  if (!Array.isArray(entrada.containers)) throw new ErroContratoHandoff('CAMPO_OBRIGATORIO', { campo: 'containers' });
  const vistos = new Set<string>();
  const containers = (entrada.containers as Array<Record<string, unknown>>).map((c, i) => {
    for (const k of Object.keys(c ?? {})) if (!CAMPOS_CONTAINER_HANDOFF.has(k)) throw new ErroContratoHandoff('CAMPO_NAO_ACEITO', { campo: `containers[${i}].${k}` });
    const numeroNormalizado = normalizarNumeroContainer(String(c?.numero ?? ''));
    if (!numeroNormalizado) throw new ErroContratoHandoff('CONTAINER_NUMERO_INVALIDO', { numero: c?.numero });
    if (vistos.has(numeroNormalizado)) throw new ErroContratoHandoff('CONTAINER_DUPLICADO_NA_ENTRADA', { numero: numeroNormalizado });
    vistos.add(numeroNormalizado);
    rejeitarManualFallback(`containers[${i}].houseFreeTimeDays`, c.houseFreeTimeDays as Observado<unknown> | null | undefined);
    rejeitarManualFallback(`containers[${i}].masterFreeTimeDays`, c.masterFreeTimeDays as Observado<unknown> | null | undefined);
    return { ...(c as unknown as ContainerContrato), numeroNormalizado };
  });

  // Hash canônico do payload de NEGÓCIO: todo o envelope MENOS as próprias
  // identidades do evento (origemEventoId é a chave de camada A; incluí-lo
  // no hash faria duas entregas do MESMO evento com QUALQUER diferença de
  // identidade nunca convergirem — mas elas já não convergem, por
  // definição, na UNIQUE de `demurrage_handoff_eventos`). origemOcorridoEm
  // fica DE FORA do hash por ser só metadado de versão/ordem, não um fato
  // de negócio em si — duas entregas do MESMO evento com o mesmo payload de
  // negócio mas timestamps de observação ligeiramente diferentes na
  // retransmissão da fonte não devem ser tratadas como payloads divergentes.
  const { versao: _v, origemSistema: _os, origemProcessoId: _op, origemEventoId: _oe, origemOcorridoEm: _oo, ...payloadNegocio } = entrada;
  const payloadHash = hashEstavel(payloadNegocio);

  return {
    entrada: entrada as unknown as EntradaHandoffV1,
    origemSistema, origemProcessoId, origemEventoId, origemOcorridoEm, numeroProcesso, containers, payloadHash,
  };
}

// Reexporta para quem só importa daqui (evita dois lugares para o mesmo tipo).
export type { CampoComFonte, FonteContrato };
export { FONTES_POR_CAMPO, jsonEstavel };
