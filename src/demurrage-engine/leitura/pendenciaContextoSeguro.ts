/**
 * Produção P1 (Entrega 3) — mapeamento FECHADO de `demurrage_pendencias.contexto`
 * (JSONB persistido, bruto) para um contexto SEGURO, por tipo de pendência.
 *
 * Nunca devolve o JSON bruto: cada tipo tem uma lista EXPLÍCITA de campos
 * seguros (nome legível + valor), extraídos do `contexto` real que cada
 * caminho de produção grava (auditado em `registro/registrarProcessoDemurrage.ts`,
 * `registro/cronologia.ts`, `registro/pendencias.ts`, `apuracao/recalcularApuracao.ts`,
 * `persistence/containerRepository.ts`, `freeTime/masterFreeTimeService.ts`,
 * `freeTime/freeTimeTentativas.ts`, e o backfill da migration 0030) — nunca
 * um campo "pela metade" ou inventado.
 *
 * Os 14 tipos abaixo são o conjunto COMPLETO e atual de
 * `acoes/pendenciaCatalogo.ts` (`TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS`,
 * espelhando a CHECK da migration 0036) — a MESMA lista fechada que a
 * Entrega 2 já usa para decidir o que pode ser resolvido. Nenhum deles
 * carrega, em produção, uma referência a documento/evidência bruta — por
 * isso `temEvidencia` é sempre `false` aqui (honesto, não um placeholder).
 *
 * Um tipo FORA desta lista (desconhecido hoje, ou que uma fase futura venha
 * a introduzir sem atualizar este arquivo) cai no `GENERICO`: rótulo fixo
 * seguro, contexto VAZIO — nunca o JSON bruto, mesmo que o chamador não
 * tenha lembrado de registrar esse tipo aqui.
 */

export interface CampoSeguroPendencia {
  campo: string;
  rotulo: string;
  valor: string | number | boolean | null;
}

export interface ContextoSeguroPendencia {
  rotulo: string;
  campos: CampoSeguroPendencia[];
  /** Nenhum dos 14 tipos atuais carrega referência a evidência bruta em produção — sempre `false`, nunca um placeholder. */
  temEvidencia: boolean;
}

type Bruto = Record<string, unknown>;

function strOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Datas (`CivilDate`, `YYYY-MM-DD`) e valores de Free Time (number) já chegam seguros — sem PII, sem documento. */
function valorSimples(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return null;
}

function mapearCronologia(c: Bruto): CampoSeguroPendencia[] {
  return [
    { campo: 'campo', rotulo: 'Campo afetado', valor: strOuNull(c.campo) },
    { campo: 'valorNovo', rotulo: 'Valor que seria promovido', valor: valorSimples(c.valorNovo) },
    { campo: 'dischargeDate', rotulo: 'Data de descarga selecionada', valor: valorSimples(c.dischargeDate) },
    { campo: 'gateOutDate', rotulo: 'Gate Out selecionado', valor: valorSimples(c.gateOutDate) },
    { campo: 'trackingReturnDate', rotulo: 'Devolução (tracking) selecionada', valor: valorSimples(c.trackingReturnDate) },
  ];
}

interface DefinicaoTipoPendencia {
  rotulo: string;
  mapear: (contexto: Bruto) => CampoSeguroPendencia[];
}

const DEFINICOES: Record<string, DefinicaoTipoPendencia> = {
  armador_ausente: { rotulo: 'Armador ausente', mapear: () => [] },
  armador_nao_cadastrado: {
    rotulo: 'Armador não cadastrado',
    mapear: (c) => [{ campo: 'codigo', rotulo: 'Código informado', valor: strOuNull(c.codigo) }],
  },
  armador_sem_tracking: {
    rotulo: 'Armador sem tracking',
    mapear: (c) => [{ campo: 'codigo', rotulo: 'Código do armador', valor: strOuNull(c.codigo) }],
  },
  mbl_ausente: { rotulo: 'MBL ausente', mapear: () => [] },
  tipo_ausente: { rotulo: 'Tipo de equipamento ausente', mapear: () => [] },
  tipo_nao_reconhecido: {
    rotulo: 'Tipo de equipamento não reconhecido',
    mapear: (c) => [
      { campo: 'tipoOriginal', rotulo: 'Tipo informado', valor: strOuNull(c.tipoOriginal) },
      { campo: 'fonte', rotulo: 'Fonte', valor: strOuNull(c.fonte) },
    ],
  },
  tipo_selecao_sem_observacao: {
    rotulo: 'Seleção de equipamento sem observação vinculada',
    mapear: (c) => {
      const legado = (c.selecaoLegada && typeof c.selecaoLegada === 'object') ? c.selecaoLegada as Bruto : {};
      return [
        { campo: 'motivo', rotulo: 'Motivo', valor: strOuNull(c.motivo) },
        { campo: 'tipoOriginalLegado', rotulo: 'Tipo original (registro legado)', valor: strOuNull(legado.tipoOriginal) },
        { campo: 'fonteLegado', rotulo: 'Fonte (registro legado)', valor: strOuNull(legado.fonte) },
      ];
    },
  },
  retorno_vazio_antes_descarga: { rotulo: 'Devolução vazia antes da descarga', mapear: mapearCronologia },
  cronologia_gate_out_antes_descarga: { rotulo: 'Gate Out antes da descarga', mapear: mapearCronologia },
  cronologia_retorno_antes_gate_out: { rotulo: 'Devolução antes do Gate Out', mapear: mapearCronologia },
  condicao_comercial_ausente: {
    rotulo: 'Condição comercial ausente',
    mapear: (c) => [{ campo: 'diasDemurrageCliente', rotulo: 'Dias de demurrage do cliente', valor: numOuNull(c.diasDemurrageCliente) }],
  },
  conflito_mesma_fonte: {
    rotulo: 'Conflito na mesma fonte',
    mapear: (c) => [
      { campo: 'campo', rotulo: 'Campo afetado', valor: strOuNull(c.campo) },
      { campo: 'fonte', rotulo: 'Fonte', valor: strOuNull(c.fonte) },
      { campo: 'valorRegistrado', rotulo: 'Valor já registrado', valor: valorSimples(c.valorRegistrado) },
      { campo: 'valorConflitante', rotulo: 'Valor conflitante', valor: valorSimples(c.valorConflitante) },
    ],
  },
  fallback_manual_superado: {
    rotulo: 'Fallback manual superado por fonte mais forte',
    mapear: (c) => [
      { campo: 'campo', rotulo: 'Campo afetado', valor: strOuNull(c.campo) },
      { campo: 'valorManual', rotulo: 'Valor manual vigente', valor: valorSimples(c.valorManual) },
      { campo: 'valorNovo', rotulo: 'Valor novo (fonte mais forte)', valor: valorSimples(c.valorNovo) },
      { campo: 'fonteNova', rotulo: 'Fonte nova', valor: strOuNull(c.fonteNova) },
    ],
  },
  free_time_ausente: {
    rotulo: 'Free Time ausente',
    mapear: (c) => [
      { campo: 'campo', rotulo: 'Campo', valor: strOuNull(c.campo) },
      { campo: 'motivo', rotulo: 'Motivo', valor: strOuNull(c.motivo) },
    ],
  },
};

const GENERICO: DefinicaoTipoPendencia = { rotulo: 'Pendência', mapear: () => [] };

/**
 * Traduz `tipo` + `contexto` BRUTO (JSONB persistido) para o contrato
 * seguro. Um tipo fora de `DEFINICOES` (desconhecido ou futuro, ainda sem
 * entrada aqui) nunca causa o JSON bruto ser devolvido — cai no rótulo
 * genérico com contexto vazio.
 */
export function contextoSeguroPendencia(tipo: string, contextoBruto: unknown): ContextoSeguroPendencia {
  const def = DEFINICOES[tipo] ?? GENERICO;
  const contexto = (contextoBruto && typeof contextoBruto === 'object' && !Array.isArray(contextoBruto))
    ? contextoBruto as Bruto
    : {};
  return { rotulo: def.rotulo, campos: def.mapear(contexto), temEvidencia: false };
}

/** Tipos com definição explícita nesta allowlist — usado só por testes/diagnóstico, nunca para decidir uma ação. */
export const TIPOS_COM_CONTEXTO_SEGURO_DEFINIDO = Object.keys(DEFINICOES);
