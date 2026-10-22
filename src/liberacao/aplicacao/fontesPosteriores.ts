import type { Db } from '../../identidade';
import type { FonteL1b, Integrado } from '../dominio';
import { FatosPosteriores, FontesPosteriores, SEM_FONTES_POSTERIORES } from './entrada';

/**
 * Combinador de produtores independentes das fontes posteriores da L1b (porta `FontesPosteriores`). Só monta a
 * entrada; não decide nada (quem decide é a L1b, chamada só pela projeção — R33) e não muda precedência, etapas ou
 * regras. Garantias:
 *  - cada produtor declara os campos que lhe pertencem; dois produtores nunca declaram o mesmo campo, e um produtor
 *    que devolve campo alheio é recusado (nunca sobrescreve);
 *  - campo não devolvido fica fora da entrada e chega à L1b como NAO_INTEGRADA (o padrão da própria L1b);
 *  - indisponibilidade esperada da fonte é responsabilidade do produtor, no vocabulário da L1b (INTEGRADA com a
 *    fonte indisponível: "não determinável", nem positivo nem negativo);
 *  - qualquer falha (exceção, campo alheio, valor fora do contrato) recusa a combinação INTEIRA com o nome do
 *    produtor: nada parcial, nada convertido em sucesso nem em "não integrada";
 *  - sem produtores, é exatamente `SEM_FONTES_POSTERIORES`.
 * Só aceita os campos `Integrado<…>` (as fontes posteriores à L1a). Os demais campos da entrada (overrides,
 * pagamentos executados, invalidações, verificação final, e-CAC, falha da Rocket) têm padrão vazio/null que não é
 * "não integrada", e por isso não entram por aqui.
 */

/** Campos da entrada da L1b que são fontes (`Integrado<…>`), calculados do próprio contrato da L1b. */
export type CampoDeFonte = {
  [K in keyof FatosPosteriores]-?: NonNullable<FatosPosteriores[K]> extends Integrado<unknown> ? K : never;
}[keyof FatosPosteriores];

/** Fonte semântica da L1b de cada campo (exaustivo: um campo novo no contrato exige uma linha aqui). */
export const FONTE_DO_CAMPO: Readonly<Record<CampoDeFonte, FonteL1b>> = Object.freeze({
  wave: 'EMAIL_WAVE',
  emissaoDestino: 'EMAIL_EMISSAO_DESTINO',
  preAlerta: 'PRE_ALERTA',
  modalidadeBl: 'MODALIDADE_BL',
  fotosHbl: 'PORTAL_FOTO_HBL',
  telex: 'EMAIL_TELEX',
  termoUnico: 'HEADCARGO_TERMO_UNICO',
  termoEmbarque: 'PORTAL_TERMO_EMBARQUE',
  financeiroCliente: 'HEADCARGO_FINANCEIRO_CLIENTE',
  armador: 'ARMADOR',
  procedimento: 'PROCEDIMENTO_AGENCIA',
  pagamentoArmador: 'HEADCARGO_PAGAMENTO_ARMADOR',
  viagem: 'VIAGEM',
  ceHouse: 'AUDITORIA_CE_HOUSE',
  siscargaFrete: 'SISCARGA_FRETE',
  siscargaFiscal: 'SISCARGA_FISCAL',
  rota: 'ROTA_E_RETIFICACAO',
});
export const CAMPOS_DE_FONTE = Object.freeze(Object.keys(FONTE_DO_CAMPO) as CampoDeFonte[]);

export interface ProdutorDeFatos<C extends CampoDeFonte = CampoDeFonte> {
  /** Nome do produtor (aparece nas falhas). */
  nome: string;
  /** Campos que pertencem a este produtor e a nenhum outro. */
  campos: ReadonlyArray<C>;
  produzir(db: Db, organizationId: string, processoId: string): Promise<Partial<Pick<FatosPosteriores, C>>>;
}

/** Configuração inválida: detectada ao montar o combinador, antes de qualquer processo. */
export class ErroDeComposicao extends Error {
  constructor(readonly codigo: 'SEM_NOME' | 'NOME_REPETIDO' | 'SEM_CAMPOS' | 'CAMPO_DESCONHECIDO' | 'CAMPO_REPETIDO' | 'CAMPO_COM_DOIS_DONOS', readonly detalhe: string) {
    super(`${codigo}: ${detalhe}`);
    this.name = 'ErroDeComposicao';
  }
}

/** Falha de um produtor durante a combinação: recusa a combinação inteira. */
export class FalhaDoProdutor extends Error {
  constructor(
    readonly produtor: string, readonly codigo: 'EXCECAO' | 'RESPOSTA_INVALIDA' | 'CAMPO_ALHEIO' | 'VALOR_FORA_DO_CONTRATO',
    readonly campo: string | null = null, readonly causa?: unknown,
  ) {
    super(`produtor ${produtor}: ${codigo}${campo ? ` (${campo})` : ''}`);
    this.name = 'FalhaDoProdutor';
  }
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** O mínimo do contrato `Integrado<T>` que o combinador confere (o valor em si é do produtor e da L1b). */
function ehIntegrado(v: unknown): boolean {
  if (!obj(v)) return false;
  if (v.tipo === 'NAO_INTEGRADA') return Object.keys(v).length === 1;
  return v.tipo === 'INTEGRADA' && obj(v.fonte) && typeof v.fonte.disponivel === 'boolean' && typeof v.fonte.desde === 'string' && 'valor' in v;
}

export function combinarFontesPosteriores(produtores: ReadonlyArray<ProdutorDeFatos>): FontesPosteriores {
  const nomes = new Set<string>();
  const donos = new Map<string, string>();
  for (const p of produtores) {
    if (!p.nome) throw new ErroDeComposicao('SEM_NOME', 'produtor sem nome');
    if (nomes.has(p.nome)) throw new ErroDeComposicao('NOME_REPETIDO', p.nome);
    nomes.add(p.nome);
    if (!p.campos.length) throw new ErroDeComposicao('SEM_CAMPOS', p.nome);
    const proprios = new Set<string>();
    for (const campo of p.campos) {
      if (!(CAMPOS_DE_FONTE as ReadonlyArray<string>).includes(campo)) throw new ErroDeComposicao('CAMPO_DESCONHECIDO', `${p.nome}.${campo}`);
      if (proprios.has(campo)) throw new ErroDeComposicao('CAMPO_REPETIDO', `${p.nome}.${campo}`);
      proprios.add(campo);
      const outro = donos.get(campo);
      if (outro) throw new ErroDeComposicao('CAMPO_COM_DOIS_DONOS', `${campo}: ${outro} e ${p.nome}`);
      donos.set(campo, p.nome);
    }
  }
  if (!produtores.length) return SEM_FONTES_POSTERIORES;
  const lista = [...produtores];

  return async (db, organizationId, processoId) => {
    const resultados = await Promise.allSettled(lista.map((p) => p.produzir(db, organizationId, processoId)));
    const fatos: Record<string, unknown> = {};
    resultados.forEach((r, i) => {
      const p = lista[i];
      if (r.status === 'rejected') throw new FalhaDoProdutor(p.nome, 'EXCECAO', null, r.reason);
      if (!obj(r.value)) throw new FalhaDoProdutor(p.nome, 'RESPOSTA_INVALIDA');
      for (const [campo, valor] of Object.entries(r.value)) {
        if (!p.campos.includes(campo as CampoDeFonte)) throw new FalhaDoProdutor(p.nome, 'CAMPO_ALHEIO', campo);
        if (valor === undefined) continue; // não fornecido: fica a NAO_INTEGRADA padrão da L1b
        if (!ehIntegrado(valor)) throw new FalhaDoProdutor(p.nome, 'VALOR_FORA_DO_CONTRATO', campo);
        fatos[campo] = valor;
      }
    });
    return fatos as FatosPosteriores;
  };
}
