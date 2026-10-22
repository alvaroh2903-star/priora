/**
 * Produção P1 (Entrega 2) — catálogo FECHADO de comandos de pendência
 * suportados por esta entrega. Nenhuma rota genérica sobre tabela
 * arbitrária: só uma família (`demurrage_pendencia`, tabela
 * `demurrage_pendencias`) e uma ação (`resolver`, delegando sempre a
 * `resolverPendenciaManual`, D15-B R45/R56 — já congelado). Qualquer
 * combinação família/ação/tipo fora deste catálogo é rejeitada ANTES de
 * qualquer leitura ou escrita.
 *
 * Deliberadamente DE FORA desta entrega (ver docs/demurrage-producao-p1-entrega-2.md
 * §pendências para a justificativa de cada exclusão):
 *  - `vessel_call_pendencias` (administração de VesselCall — explicitamente
 *    adiada pelo usuário);
 *  - atualização manual de tracking (explicitamente adiada);
 *  - administração de tarifa (explicitamente adiada);
 *  - `ft_divergencias` (reconhecer/resolver divergência de Free Time —
 *    diagnóstico P1 §3 item 4b, marcado "não obrigatório nesta entrega").
 *
 * Os 14 tipos abaixo são o conjunto da restrição CHECK de
 * `demurrage_pendencias.tipo` da migration 0036 — todos passam pela MESMA
 * governança (`resolverPendenciaManual`: motivo obrigatório, autor validado
 * contra `organization_memberships`, resolução idempotente/append-only).
 * Nenhum deles ganha um comportamento especial aqui — o catálogo só prova
 * que a lista é FECHADA e documentada, nunca "qualquer tipo que o chamador
 * mandar".
 *
 * Produção P1 (correção de minuta, migration 0048): os dois tipos novos —
 * `minuta_inconsistente` e `minuta_divergente_tracking` — ficam
 * DELIBERADAMENTE FORA deste catálogo. Eles espelham o estado da minuta
 * vigente; só se resolvem (automaticamente) quando o analista registra uma
 * minuta substituta coerente. Resolvê-los "à mão" deixaria a pendência
 * resolvida com a minuta ainda DIVERGENTE/INCONSISTENTE — o encerramento
 * continuaria bloqueado pela minuta, e a fila mostraria um estado falso.
 */
export const FAMILIAS_PENDENCIA_SUPORTADAS = ['demurrage_pendencia'] as const;
export type FamiliaPendencia = (typeof FAMILIAS_PENDENCIA_SUPORTADAS)[number];

export const ACOES_PENDENCIA_SUPORTADAS = ['resolver'] as const;
export type AcaoPendencia = (typeof ACOES_PENDENCIA_SUPORTADAS)[number];

export const TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS = [
  'armador_ausente', 'armador_nao_cadastrado', 'armador_sem_tracking',
  'mbl_ausente', 'tipo_ausente', 'tipo_nao_reconhecido', 'tipo_selecao_sem_observacao',
  'retorno_vazio_antes_descarga', 'cronologia_gate_out_antes_descarga', 'cronologia_retorno_antes_gate_out',
  'condicao_comercial_ausente', 'conflito_mesma_fonte', 'fallback_manual_superado', 'free_time_ausente',
] as const;
export type TipoDemurragePendencia = (typeof TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS)[number];

/** Verifica a combinação família+ação+tipo ANTES de qualquer leitura/escrita — `null` quando é exatamente o suportado, uma string explicando a rejeição quando não é. */
export function validarComandoPendencia(input: { familia: unknown; acao: unknown; tipo: unknown }): string | null {
  if (!FAMILIAS_PENDENCIA_SUPORTADAS.includes(input.familia as FamiliaPendencia)) return 'familia_nao_suportada';
  if (!ACOES_PENDENCIA_SUPORTADAS.includes(input.acao as AcaoPendencia)) return 'acao_nao_suportada';
  if (!TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS.includes(input.tipo as TipoDemurragePendencia)) return 'tipo_nao_suportado';
  return null;
}
