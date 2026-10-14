import { Evidencia, Instante } from './tipos';
import { AcaoSobreponivel } from './operacao';
import { ResultadoDimensao } from './house';

/**
 * L1b — override (cap. 6, 14, 38; H-16; N-13; P5). Contrato puro: a
 * solicitação e a decisão chegam como fatos registrados (fase futura L9); a
 * L1b só decide se um override VALE para (processo, pendência/episódio, ação).
 *  - Escopo: processo + pendência específica (episódio) + ação específica.
 *    INICIAR_PROCEDIMENTO não autoriza APRESENTAR.
 *  - Não resolve nem apaga a pendência original; não é global; não existe
 *    override de Master; só obrigações do cliente (Termo, Financeiro, House)
 *    são sobreponíveis — impossibilidade externa nunca (Evergreen antes da
 *    atracação, Master não resolvido, evidência de apresentação ausente).
 *  - Condição desconhecida/indisponível só é coberta quando a solicitação a
 *    identifica explicitamente E o aprovador aceita expressamente essa
 *    premissa. O desconhecido continua desconhecido. Fonte não integrada não
 *    é coberta (D-6).
 *  - Deixa de valer quando a ação autorizada é executada, quando a pendência
 *    se resolve ou quando ela muda materialmente (outro episódio). Sem prazo
 *    artificial.
 *  - ANALYST solicita; MANAGER ou ADMIN aprova/rejeita; solicitante e
 *    aprovador são pessoas diferentes.
 */

export type DimensaoCliente = 'TERMO' | 'FINANCEIRO' | 'HOUSE';
export type PapelNaOrganizacao = 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT';

export interface Override {
  id: string;
  processoId: string;
  pendencia: { dimensao: DimensaoCliente; episodio: string };
  acao: AcaoSobreponivel;
  /** A solicitação identifica explicitamente uma condição desconhecida/indisponível (P5). */
  cobreCondicaoDesconhecida: boolean;
  justificativa: string;
  evidencias: ReadonlyArray<Evidencia>;
  solicitadoPor: { pessoaId: string; papel: PapelNaOrganizacao };
  solicitadoEm: Instante;
  decisao: null | {
    tipo: 'APROVADO' | 'REJEITADO';
    por: { pessoaId: string; papel: PapelNaOrganizacao };
    em: Instante;
    justificativa: string;
    /** O aprovador aceita expressamente a premissa da condição desconhecida. */
    aceitaCondicaoDesconhecida: boolean;
  };
  /** A ação autorizada já foi executada (registrada por fase futura): o override deixa de valer. */
  executadoEm: Instante | null;
}

export type ProblemaDoOverride =
  | 'SOLICITANTE_NAO_E_ANALYST'
  | 'DECISAO_SEM_PAPEL_DE_GESTOR'
  | 'SOLICITANTE_E_APROVADOR_SAO_A_MESMA_PESSOA'
  | 'SEM_JUSTIFICATIVA'
  | 'SEM_EVIDENCIA'
  | 'DECISAO_SEM_JUSTIFICATIVA';

const preenchido = (t: string | null | undefined) => String(t ?? '').trim() !== '';

export function problemasDoOverride(o: Override): ProblemaDoOverride[] {
  const p: ProblemaDoOverride[] = [];
  if (o.solicitadoPor.papel !== 'ANALYST') p.push('SOLICITANTE_NAO_E_ANALYST');
  if (!preenchido(o.justificativa)) p.push('SEM_JUSTIFICATIVA');
  if (!o.evidencias.length) p.push('SEM_EVIDENCIA');
  if (o.decisao) {
    if (o.decisao.por.papel !== 'MANAGER' && o.decisao.por.papel !== 'ADMIN') p.push('DECISAO_SEM_PAPEL_DE_GESTOR');
    if (o.decisao.por.pessoaId === o.solicitadoPor.pessoaId) p.push('SOLICITANTE_E_APROVADOR_SAO_A_MESMA_PESSOA');
    if (!preenchido(o.decisao.justificativa)) p.push('DECISAO_SEM_JUSTIFICATIVA');
  }
  return p;
}

/** O override autoriza AGORA esta ação sobre esta pendência deste processo? */
export function overrideCobre(o: Override, processoId: string, dimensao: DimensaoCliente, atual: ResultadoDimensao, acao: AcaoSobreponivel): boolean {
  if (problemasDoOverride(o).length) return false;
  if (o.processoId !== processoId || o.acao !== acao || o.pendencia.dimensao !== dimensao) return false;
  if (o.decisao?.tipo !== 'APROVADO' || o.executadoEm) return false;
  if (atual.estado === 'PENDENTE') return o.pendencia.episodio === atual.episodio;
  if (atual.estado === 'DESCONHECIDO') {
    return o.pendencia.episodio === atual.episodio && o.cobreCondicaoDesconhecida && o.decisao.aceitaCondicaoDesconhecida;
  }
  return false; // RESOLVIDO não precisa; NAO_DETERMINAVEL (fonte não integrada) não é coberto
}

export type SituacaoDoOverride = 'VALIDO_E_APLICAVEL' | 'AGUARDANDO_APROVACAO' | 'REJEITADO' | 'INVALIDO' | 'SEM_EFEITO';

/** Leitura de cada override deste processo para exibição/atenção (nunca altera a pendência). */
export function situacaoDoOverride(
  o: Override, processoId: string, dimensoes: Readonly<Record<DimensaoCliente, ResultadoDimensao>>,
): SituacaoDoOverride {
  if (o.processoId !== processoId) return 'SEM_EFEITO';
  if (problemasDoOverride(o).length) return 'INVALIDO';
  if (!o.decisao) return 'AGUARDANDO_APROVACAO';
  if (o.decisao.tipo === 'REJEITADO') return 'REJEITADO';
  return overrideCobre(o, processoId, o.pendencia.dimensao, dimensoes[o.pendencia.dimensao], o.acao) ? 'VALIDO_E_APLICAVEL' : 'SEM_EFEITO';
}
