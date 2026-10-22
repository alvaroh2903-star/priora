import type { TransportadorDoMbl } from '../../auditoria/parser/transportador';
import { normalizarNome } from '../../auditoria/parser/transportador';
import type { ArmadorDoMaster, EstadoOficial, Instante, Integrado } from '../dominio';
import type { FatosPosteriores } from './entrada';

/**
 * Regra de USO da Liberação para o armador do Master a partir do transportador DECLARADO no MBL (P1-A, preservada na
 * O2.1-C) — PURA e NÃO LIGADA: nenhum caminho de produção a importa, não há porta, chave, banco nem fonte documental
 * conectada. A L1b continua recebendo o armador como NAO_INTEGRADA, exatamente como antes da P1-A.
 *
 * Entrada: o contrato determinístico `transportadorDoMbl` (independente de fonte; a fonte prevista é a evidência de OCR
 * do Mistral, depois da convergência aprovada). Saída, quando um dia for ligada:
 *  - FATO: leituras concordantes, todas na lista fechada e no MESMO código → INTEGRADA com o oficial {masterId, codigo};
 *  - EXCECAO: há leitura, mas sem declaração aceita, ambígua, fora da lista, com transportadores diferentes ou com
 *    leituras divergentes do mesmo arquivo → INTEGRADA, disponível, sem oficial (a L1b mostraria P12, exceção visível);
 *  - NAO_OBSERVADO: nenhuma leitura com declarações → nada (NAO_INTEGRADA, como hoje).
 * Só tipos do domínio: a L1b continua chamada apenas pela projeção (R33). Nenhum OCR, IA, Graph ou e-mail.
 */

/**
 * Lista fechada — RASCUNHO (PROPOSTA, V3 da O2.1), NÃO APROVADA: só razões sociais, códigos exatamente os da matriz
 * congelada. Os nomes ainda serão conferidos com MBLs reais antes da aprovação (P1-B); incluir uma variante é decisão
 * registrada, nunca automática. Comparação EXATA sobre a forma normalizada (sem prefixo, substring ou aproximação);
 * marca sozinha ("MSC", "MAERSK"), outra entidade do grupo e transportador fora da matriz não entram.
 */
export const SITUACAO_DA_LISTA_DE_TRANSPORTADORES = 'PROPOSTA' as const;
export const LISTA_DE_TRANSPORTADORES: ReadonlyArray<{ nome: string; codigo: string }> = [
  { nome: 'MSC MEDITERRANEAN SHIPPING COMPANY S.A.', codigo: 'MSC' },
  { nome: 'MAERSK A/S', codigo: 'MAERSK' },
  { nome: 'A.P. MOLLER - MAERSK A/S', codigo: 'MAERSK' },
  { nome: 'HAPAG-LLOYD AG', codigo: 'HAPAG_LLOYD' },
  { nome: 'ZIM INTEGRATED SHIPPING SERVICES LTD.', codigo: 'ZIM' },
  { nome: 'EVERGREEN MARINE CORPORATION (TAIWAN) LTD.', codigo: 'EVERGREEN' },
  { nome: 'EVERGREEN MARINE CORP. (TAIWAN) LTD.', codigo: 'EVERGREEN' },
  { nome: 'CMA CGM S.A.', codigo: 'CMA_CGM' },
  { nome: 'COSCO SHIPPING LINES CO., LTD.', codigo: 'COSCO' },
  { nome: 'ORIENT OVERSEAS CONTAINER LINE LIMITED', codigo: 'OOCL' },
  { nome: 'OCEAN NETWORK EXPRESS PTE. LTD.', codigo: 'ONE' },
  { nome: 'PACIFIC INTERNATIONAL LINES (PTE) LTD', codigo: 'PIL' },
  { nome: 'HMM CO., LTD.', codigo: 'HMM' },
  { nome: 'HYUNDAI MERCHANT MARINE CO., LTD.', codigo: 'HMM' },
  { nome: 'YANG MING MARINE TRANSPORT CORPORATION', codigo: 'YANG_MING' },
];

const CODIGO_POR_NOME: ReadonlyMap<string, string> = new Map(LISTA_DE_TRANSPORTADORES.map((t) => [normalizarNome(t.nome), t.codigo]));

/** Código da lista para um nome já normalizado; fora da lista → null. */
export function codigoDaLista(normalizado: string): string | null {
  return CODIGO_POR_NOME.get(normalizado) ?? null;
}

export type MotivoDaExcecaoDoArmador =
  | 'LEITURAS_DIVERGENTES' | 'DECLARACAO_AMBIGUA' | 'NAO_DECLARADO' | 'NOME_FORA_DA_LISTA' | 'TRANSPORTADORES_DIVERGENTES';

export type ArmadorAutomatico =
  | { tipo: 'NAO_OBSERVADO'; masterId: string }
  | {
    tipo: 'FATO'; masterId: string; armador: ArmadorDoMaster; evidencias: string[];
    /** Primeira leitura com declarações (disponibilidade da fonte), documento mais antigo que declara e a confirmação mais recente. */
    fonteDesde: Date; vigenteDesde: Date; ultimaConfirmacaoEm: Date;
  }
  | { tipo: 'EXCECAO'; masterId: string; motivo: MotivoDaExcecaoDoArmador; evidencias: string[]; nomes: string[]; fonteDesde: Date };

const minimo = (ds: ReadonlyArray<Date>) => new Date(Math.min(...ds.map((d) => d.getTime())));
const maximo = (ds: ReadonlyArray<Date>) => new Date(Math.max(...ds.map((d) => d.getTime())));

/** Regra de uso sobre o contrato documental (pura, determinística; nada é escolhido entre versões). */
export function armadorAutomatico(t: TransportadorDoMbl): ArmadorAutomatico {
  const lidas = t.leituras.filter((l) => l.estado.tipo !== 'NAO_EXTRAIDO');
  if (!lidas.length) return { tipo: 'NAO_OBSERVADO', masterId: t.masterId };
  const fonteDesde = minimo(lidas.map((l) => l.extraidaEm));
  const excecao = (motivo: MotivoDaExcecaoDoArmador, de: ReadonlyArray<typeof lidas[number]>, nomes: string[] = []): ArmadorAutomatico => ({
    tipo: 'EXCECAO', masterId: t.masterId, motivo, evidencias: de.map((l) => l.evidenciaRef), nomes: [...new Set(nomes)].sort(), fonteDesde,
  });

  const divergentes = new Set(t.arquivos.filter((a) => a.situacao === 'LEITURAS_DIVERGENTES').flatMap((a) => a.evidenciaRefs));
  if (divergentes.size) return excecao('LEITURAS_DIVERGENTES', lidas.filter((l) => divergentes.has(l.evidenciaRef)));
  const ambiguas = lidas.filter((l) => l.estado.tipo === 'AMBIGUO');
  if (ambiguas.length) return excecao('DECLARACAO_AMBIGUA', ambiguas);
  const declaradas = lidas.flatMap((l) => (l.estado.tipo === 'DECLARADO' ? [{ l, nomes: l.estado.nomes }] : []));
  if (!declaradas.length) return excecao('NAO_DECLARADO', lidas);
  const fora = declaradas.filter((d) => d.nomes.some((n) => !codigoDaLista(n.normalizado)));
  if (fora.length) {
    return excecao('NOME_FORA_DA_LISTA', fora.map((d) => d.l), fora.flatMap((d) => d.nomes.filter((n) => !codigoDaLista(n.normalizado)).flatMap((n) => n.literais)));
  }
  const codigos = new Set(declaradas.flatMap((d) => d.nomes.map((n) => codigoDaLista(n.normalizado)!)));
  if (codigos.size > 1) return excecao('TRANSPORTADORES_DIVERGENTES', declaradas.map((d) => d.l), declaradas.flatMap((d) => d.nomes.flatMap((n) => n.literais)));
  return {
    tipo: 'FATO', masterId: t.masterId, armador: { masterId: t.masterId, codigo: [...codigos][0] }, evidencias: declaradas.map((d) => d.l.evidenciaRef),
    fonteDesde, vigenteDesde: minimo(declaradas.map((d) => d.l.observadaEm)), ultimaConfirmacaoEm: maximo(declaradas.map((d) => d.l.extraidaEm)),
  };
}

const iso = (d: Date): Instante => d.toISOString();

/**
 * O resultado no vocabulário da porta `armador` da L1b (para quando a fonte for ligada, com aprovação). NAO_OBSERVADO →
 * nada (a fonte segue NAO_INTEGRADA). `fonteDaEvidencia` identifica a origem documental na evidência do fato.
 */
export function armadorParaL1b(r: ArmadorAutomatico, fonteDaEvidencia: string): FatosPosteriores {
  if (r.tipo === 'NAO_OBSERVADO') return {};
  const valor: EstadoOficial<ArmadorDoMaster> = r.tipo === 'FATO'
    ? {
      oficial: {
        valor: { ...r.armador }, vigenteDesde: iso(r.vigenteDesde), ultimaConfirmacaoEm: iso(r.ultimaConfirmacaoEm),
        evidencia: { fonte: fonteDaEvidencia, ref: r.evidencias[0] },
      },
      historico: [],
    }
    : { oficial: null, historico: [] };
  const armador: Integrado<EstadoOficial<ArmadorDoMaster>> = { tipo: 'INTEGRADA', fonte: { disponivel: true, desde: iso(r.fonteDesde) }, valor };
  return { armador };
}
