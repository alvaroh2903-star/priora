import { createHash } from 'crypto';
import { FieldObservationSource } from '../domain/types';

/**
 * Fase D10 — CONTRATO TÉCNICO de entrada da Demurrage (`demurrage.registro.v1`).
 *
 * Tipado, versionado e independente de HTTP: é a porta pela qual a futura
 * integração entre módulos (Auditoria/pré-alerta) registra um processo e seus
 * contêineres na Demurrage. NÃO existe rota pública nem botão que o chame —
 * só código de aplicação (e os testes da engine).
 *
 * Regras do contrato:
 *  - o código do processo é preservado INTEGRALMENTE (IM3126-26 ≠ IM3126 ≠
 *    IM3126-25): a normalização só remove espaços e padroniza caixa;
 *  - NÃO aceita data de descarga, ETA, chegada, atracação, Gate Out ou
 *    qualquer data operacional: a descarga só entra pelo tracking do armador
 *    (`eventIngestion`), e os relógios só começam nela;
 *  - toda informação carrega fonte, data de observação e evidência;
 *  - `tracking_service` e `email_heuristic` não são fontes aceitas aqui.
 *
 * v1.1 — MATRIZ de fontes por campo (não é mais uma allowlist genérica): cada
 * campo só aceita as fontes documentais que plausivelmente o comprovam.
 * `manual_fallback` é exclusivo de House/Master Free Time (Blueprint Cap. 4:
 * "MANUAL_FALLBACK como último recurso auditado") e exige governança própria
 * (`Observado.manualFallback`: justificativa + autor). `outro` nunca é aceito
 * como atalho genérico de Free Time — só nos demais campos, onde já era usado
 * como fonte de prioridade mínima (ex.: MBL por uma fonte não estruturada).
 * Combinação campo×fonte fora desta matriz é rejeitada (conservador por
 * padrão) — nunca ampliada silenciosamente.
 */

export const CONTRATO_REGISTRO_DEMURRAGE_V1 = 'demurrage.registro.v1' as const;

/** Fontes aceitas pelo contrato (tracking só pela ingestão; heurística de e-mail nunca). */
export type FonteContrato = Exclude<FieldObservationSource, 'tracking_service' | 'email_heuristic'>;

/** Campos do contrato que carregam `Observado<T>` (nível processo ou contêiner — mesmo nome nos dois). */
export type CampoComFonte =
  | 'cliente' | 'house' | 'mbl' | 'armador' | 'condicaoComercial' | 'responsavelOperacionalMembershipId'
  | 'tipoOriginal' | 'houseFreeTimeDays' | 'masterFreeTimeDays';

/**
 * Matriz EXPLÍCITA campo → fontes autorizadas (v1.1). Cada linha é justificada
 * pelo documento/fonte que plausivelmente atesta aquele fato:
 *  - `house` (HBL) vem do próprio documento House; `mbl` vem do Master BL —
 *    nunca o document do OUTRO lado (um não atesta o número do outro);
 *  - `armador`, `cliente`, `condicaoComercial` vêm de instruções/SI, do
 *    HeadCargo (contingência financeira) ou de `outro` (fonte não estruturada,
 *    prioridade mínima já existente na hierarquia);
 *  - `responsavelOperacionalMembershipId` é designação INTERNA (um UUID de
 *    membership) — nenhum documento externo o atesta; só `outro`;
 *  - `tipoOriginal` (equipamento) pode vir de qualquer documento operacional;
 *  - `houseFreeTimeDays`/`masterFreeTimeDays`: hierarquia já congelada em
 *    `masterFreeTimeService.ts`/gap analysis (House/SI/HeadCargo/MANUAL_FALLBACK
 *    para o House; Master BL/SI/HeadCargo/MANUAL_FALLBACK para o Master) — sem
 *    `outro` (nunca atalho genérico de Free Time) e sem cruzar House↔Master.
 */
export const FONTES_POR_CAMPO: Readonly<Record<CampoComFonte, ReadonlySet<FonteContrato>>> = {
  cliente: new Set<FonteContrato>(['shipping_instructions', 'headcargo', 'outro']),
  house: new Set<FonteContrato>(['house_document', 'shipping_instructions', 'headcargo', 'outro']),
  mbl: new Set<FonteContrato>(['master_bl', 'shipping_instructions', 'headcargo', 'outro']),
  armador: new Set<FonteContrato>(['master_bl', 'shipping_instructions', 'headcargo', 'outro']),
  condicaoComercial: new Set<FonteContrato>(['shipping_instructions', 'headcargo', 'outro']),
  responsavelOperacionalMembershipId: new Set<FonteContrato>(['outro']),
  tipoOriginal: new Set<FonteContrato>(['house_document', 'master_bl', 'shipping_instructions', 'headcargo', 'outro']),
  houseFreeTimeDays: new Set<FonteContrato>(['house_document', 'shipping_instructions', 'headcargo', 'manual_fallback']),
  masterFreeTimeDays: new Set<FonteContrato>(['master_bl', 'shipping_instructions', 'headcargo', 'manual_fallback']),
};

/** Governança do `manual_fallback` (Free Time apenas): justificativa + autor identificado, sempre auditável. */
export interface ManualFallbackGovernanca {
  justificativa: string;
  /** organization_memberships.id de quem autorizou o fallback manual (nunca um texto livre). */
  autorMembershipId: string;
}

/** Um valor com a sua proveniência. `observadoEm` = quando a FONTE afirmou o valor (ISO 8601). */
export interface Observado<T> {
  valor: T;
  fonte: FonteContrato;
  observadoEm: string;
  evidenciaRef?: string | null;
  /** OBRIGATÓRIO quando `fonte === 'manual_fallback'`; rejeitado com qualquer outra fonte. */
  manualFallback?: ManualFallbackGovernanca | null;
}

export interface CondicaoComercialContrato {
  termoTipo: 'embarque' | 'unico';
  /** Tabela FIXADA na condição (obrigatória no Termo por Embarque; ignorada no Termo Único). */
  tabelaId?: string | null;
  fonteDocumental?: string | null;
}

export interface ContainerContrato {
  numero: string;
  /** Tipo de equipamento como veio da fonte (ex.: "40HC", "40' HIGH CUBE"). */
  tipoOriginal?: Observado<string> | null;
  /** Sobrepõe o Free Time do processo para este contêiner. */
  houseFreeTimeDays?: Observado<number> | null;
  masterFreeTimeDays?: Observado<number> | null;
}

export interface RegistroProcessoDemurrageV1 {
  versao: typeof CONTRATO_REGISTRO_DEMURRAGE_V1;
  organizationId: string;
  numeroProcesso: string;
  /** Default: hash do payload (reprocessar a MESMA entrada é no-op). */
  chaveIdempotencia?: string | null;
  /** Quem chamou (ex.: 'auditoria-pre-alerta' na integração futura; 'teste' na engine). */
  origem: { sistema: string; referencia?: string | null };
  cliente?: Observado<string> | null;
  /** House (HBL). */
  house?: Observado<string> | null;
  mbl?: Observado<string> | null;
  /** Código interno do armador (`armadores.codigo_interno`, ex.: 'MAERSK'). */
  armador?: Observado<string> | null;
  condicaoComercial?: Observado<CondicaoComercialContrato> | null;
  responsavelOperacionalMembershipId?: Observado<string> | null;
  /** Free Time do nível do processo (vale para os contêineres sem sobreposição). */
  houseFreeTimeDays?: Observado<number> | null;
  masterFreeTimeDays?: Observado<number> | null;
  containers: ContainerContrato[];
}

export type CodigoErroContrato =
  | 'VERSAO_NAO_SUPORTADA' | 'CAMPO_OBRIGATORIO' | 'CAMPO_NAO_ACEITO' | 'NUMERO_PROCESSO_INVALIDO'
  | 'CONTAINER_NUMERO_INVALIDO' | 'CONTAINER_DUPLICADO_NA_ENTRADA' | 'FONTE_NAO_ACEITA' | 'OBSERVADO_EM_INVALIDO'
  | 'FREE_TIME_INVALIDO' | 'CONDICAO_INVALIDA' | 'CONTAINER_EM_OUTRO_PROCESSO' | 'CHAVE_IDEMPOTENCIA_REUTILIZADA'
  | 'PROCESSO_FINAL' | 'ORGANIZACAO_INEXISTENTE' | 'MANUAL_FALLBACK_INCOMPLETO' | 'MANUAL_FALLBACK_NAO_ACEITO';

export class ErroContratoDemurrage extends Error {
  constructor(public readonly codigo: CodigoErroContrato, public readonly detalhe: Record<string, unknown> = {}) {
    super(`${codigo}${Object.keys(detalhe).length ? ` ${JSON.stringify(detalhe)}` : ''}`);
    this.name = 'ErroContratoDemurrage';
  }
}

const CAMPOS_TOPO = new Set([
  'versao', 'organizationId', 'numeroProcesso', 'chaveIdempotencia', 'origem', 'cliente', 'house', 'mbl', 'armador',
  'condicaoComercial', 'responsavelOperacionalMembershipId', 'houseFreeTimeDays', 'masterFreeTimeDays', 'containers',
]);
const CAMPOS_CONTAINER = new Set(['numero', 'tipoOriginal', 'houseFreeTimeDays', 'masterFreeTimeDays']);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Código do processo normalizado SEM perder o sufixo: remove espaços e padroniza
 * caixa (" im3126-26 " → "IM3126-26"). Nenhuma outra transformação — em
 * particular, nunca remove "-26".
 */
export function normalizarNumeroProcesso(v: string): string {
  return String(v ?? '').toUpperCase().replace(/\s+/g, '');
}

const ISO6346_LETRA: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20, K: 21, L: 23, M: 24,
  N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

/** Dígito verificador ISO 6346 dos 10 primeiros caracteres (4 letras + 6 dígitos). */
export function digitoVerificadorIso6346(prefixo10: string): number {
  let soma = 0;
  for (let i = 0; i < 10; i++) {
    const ch = prefixo10[i];
    const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ISO6346_LETRA[ch];
    soma += v * 2 ** i;
  }
  return (soma % 11) % 10;
}

/** Número de contêiner normalizado (maiúsculas, sem separadores) e válido em ISO 6346; senão null. */
export function normalizarNumeroContainer(v: string): string | null {
  const n = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{4}\d{7}$/.test(n)) return null;
  return digitoVerificadorIso6346(n.slice(0, 10)) === Number(n[10]) ? n : null;
}

/** JSON estável (chaves ordenadas) para hash de payload/fatos. */
export function jsonEstavel(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(jsonEstavel).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${jsonEstavel(o[k])}`).join(',')}}`;
}

export function hashEstavel(v: unknown): string {
  return createHash('sha256').update(jsonEstavel(v)).digest('hex');
}

/**
 * Valida um `Observado<T>` contra a MATRIZ do campo (v1.1) — não mais uma
 * allowlist genérica. `campoMatriz` identifica a entrada de `FONTES_POR_CAMPO`
 * (o mesmo nome no processo e no contêiner, ex.: `houseFreeTimeDays`);
 * `nomeErro` é só o rótulo usado nas mensagens de erro (ex.:
 * `containers[0].houseFreeTimeDays`).
 */
function validarObservado(nomeErro: string, campoMatriz: CampoComFonte, o: Observado<unknown> | null | undefined): void {
  if (o === null || o === undefined) return;
  if (typeof o !== 'object' || !('valor' in o)) throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: `${nomeErro}.valor` });
  if (!FONTES_POR_CAMPO[campoMatriz].has(o.fonte)) {
    throw new ErroContratoDemurrage('FONTE_NAO_ACEITA', { campo: nomeErro, fonte: o.fonte });
  }
  const t = Date.parse(o.observadoEm);
  if (!o.observadoEm || Number.isNaN(t)) throw new ErroContratoDemurrage('OBSERVADO_EM_INVALIDO', { campo: nomeErro });
  // Governança do manual_fallback (Free Time apenas — a matriz já garante que
  // só chega aqui para houseFreeTimeDays/masterFreeTimeDays): justificativa +
  // autor identificado sempre presentes; nunca aceito com outra fonte.
  if (o.fonte === 'manual_fallback') {
    const mf = o.manualFallback;
    if (!mf || typeof mf.justificativa !== 'string' || !mf.justificativa.trim() || !mf.autorMembershipId) {
      throw new ErroContratoDemurrage('MANUAL_FALLBACK_INCOMPLETO', { campo: nomeErro });
    }
    if (!RE_UUID.test(mf.autorMembershipId)) {
      throw new ErroContratoDemurrage('MANUAL_FALLBACK_INCOMPLETO', { campo: `${nomeErro}.manualFallback.autorMembershipId` });
    }
  } else if (o.manualFallback) {
    throw new ErroContratoDemurrage('MANUAL_FALLBACK_NAO_ACEITO', { campo: nomeErro, fonte: o.fonte });
  }
}

function validarFreeTime(nomeErro: string, campoMatriz: 'houseFreeTimeDays' | 'masterFreeTimeDays', o: Observado<number> | null | undefined): void {
  validarObservado(nomeErro, campoMatriz, o);
  if (o && !(Number.isInteger(o.valor) && o.valor >= 0)) throw new ErroContratoDemurrage('FREE_TIME_INVALIDO', { campo: nomeErro, valor: o.valor });
}

export interface RegistroNormalizado {
  entrada: RegistroProcessoDemurrageV1;
  numeroProcesso: string;
  /** Contêineres com número normalizado, na ordem da entrada. */
  containers: Array<ContainerContrato & { numeroNormalizado: string }>;
  payloadHash: string;
  chaveIdempotencia: string;
}

/** Validação/normalização PURA do contrato (sem banco). Lança ErroContratoDemurrage. */
export function validarRegistro(entrada: RegistroProcessoDemurrageV1): RegistroNormalizado {
  if (!entrada || typeof entrada !== 'object') throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: 'registro' });
  if (entrada.versao !== CONTRATO_REGISTRO_DEMURRAGE_V1) throw new ErroContratoDemurrage('VERSAO_NAO_SUPORTADA', { versao: entrada.versao });
  for (const k of Object.keys(entrada)) {
    // Rejeita qualquer campo fora do contrato — em especial datas operacionais
    // (descarga, ETA, chegada, atracação, Gate Out): a descarga só vem do tracking.
    if (!CAMPOS_TOPO.has(k)) throw new ErroContratoDemurrage('CAMPO_NAO_ACEITO', { campo: k });
  }
  if (!entrada.organizationId || !RE_UUID.test(entrada.organizationId)) throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: 'organizationId' });
  if (!entrada.origem || !entrada.origem.sistema) throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: 'origem.sistema' });
  const numeroProcesso = normalizarNumeroProcesso(entrada.numeroProcesso);
  if (!numeroProcesso || !/^[A-Z0-9][A-Z0-9./-]*$/.test(numeroProcesso)) {
    throw new ErroContratoDemurrage('NUMERO_PROCESSO_INVALIDO', { numeroProcesso: entrada.numeroProcesso });
  }
  for (const campo of ['cliente', 'house', 'mbl', 'armador', 'condicaoComercial', 'responsavelOperacionalMembershipId'] as const) {
    validarObservado(campo, campo, entrada[campo] as Observado<unknown> | null | undefined);
  }
  if (entrada.condicaoComercial) {
    const c = entrada.condicaoComercial.valor;
    if (!c || (c.termoTipo !== 'embarque' && c.termoTipo !== 'unico')) throw new ErroContratoDemurrage('CONDICAO_INVALIDA', { termoTipo: c?.termoTipo });
    if (c.tabelaId && !RE_UUID.test(c.tabelaId)) throw new ErroContratoDemurrage('CONDICAO_INVALIDA', { tabelaId: c.tabelaId });
  }
  if (entrada.responsavelOperacionalMembershipId && !RE_UUID.test(entrada.responsavelOperacionalMembershipId.valor)) {
    throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: 'responsavelOperacionalMembershipId.valor' });
  }
  validarFreeTime('houseFreeTimeDays', 'houseFreeTimeDays', entrada.houseFreeTimeDays);
  validarFreeTime('masterFreeTimeDays', 'masterFreeTimeDays', entrada.masterFreeTimeDays);
  if (!Array.isArray(entrada.containers)) throw new ErroContratoDemurrage('CAMPO_OBRIGATORIO', { campo: 'containers' });
  const vistos = new Set<string>();
  const containers = entrada.containers.map((c, i) => {
    for (const k of Object.keys(c ?? {})) if (!CAMPOS_CONTAINER.has(k)) throw new ErroContratoDemurrage('CAMPO_NAO_ACEITO', { campo: `containers[${i}].${k}` });
    const numeroNormalizado = normalizarNumeroContainer(c?.numero);
    if (!numeroNormalizado) throw new ErroContratoDemurrage('CONTAINER_NUMERO_INVALIDO', { numero: c?.numero });
    if (vistos.has(numeroNormalizado)) throw new ErroContratoDemurrage('CONTAINER_DUPLICADO_NA_ENTRADA', { numero: numeroNormalizado });
    vistos.add(numeroNormalizado);
    validarObservado(`containers[${i}].tipoOriginal`, 'tipoOriginal', c.tipoOriginal);
    validarFreeTime(`containers[${i}].houseFreeTimeDays`, 'houseFreeTimeDays', c.houseFreeTimeDays);
    validarFreeTime(`containers[${i}].masterFreeTimeDays`, 'masterFreeTimeDays', c.masterFreeTimeDays);
    return { ...c, numeroNormalizado };
  });
  const { chaveIdempotencia: _ignorada, ...semChave } = entrada;
  const payloadHash = hashEstavel(semChave);
  return {
    entrada, numeroProcesso, containers, payloadHash,
    chaveIdempotencia: entrada.chaveIdempotencia && entrada.chaveIdempotencia.trim() ? entrada.chaveIdempotencia.trim() : `payload:${payloadHash}`,
  };
}
