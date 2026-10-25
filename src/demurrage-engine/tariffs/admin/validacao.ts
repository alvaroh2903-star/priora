import {
  BASES_CONTAGEM, CodigoValidacao, ConteudoVersao, DimensaoTabela, ErroValidacao, FAIXAS_MAXIMAS, FaixaAdmin, MetadadosVersao,
  QUALIDADES, dataCivilValida, diaValido, instanteCanonico, moedaIsoValida, valorDiaCanonico,
} from './contrato';

/**
 * Produção P1 (administração tarifária) — validação PURA do conteúdo de uma
 * versão. Os erros são estruturados por campo e por faixa (índice no
 * conteúdo, 0-based), nunca uma mensagem livre.
 *
 * Rascunho é editável: a EDIÇÃO só recusa (422, sem gravar nada) o que está
 * malformado ou que o banco não consegue guardar — formato de número/data/
 * enum, valor negativo, faixas sobrepostas (EXCLUDE da 0037), vigência com
 * fim antes do início (CHECK da 0009). Todo o resto (equipamento fora do
 * catálogo, moeda, lacunas, progressão, regras do Termo por Embarque,
 * vigência ausente, conflito com versão ativa) pode ficar no rascunho
 * enquanto ele é trabalhado — aparece em `GET …/validacao` e na resposta de
 * cada edição — e BLOQUEIA a ativação, que roda tudo de novo dentro da
 * própria transação.
 */

export interface ContextoValidacao {
  /** `container_types.codigo` — catálogo oficial de equipamentos. */
  equipamentos: ReadonlySet<string>;
}

function erro(codigo: CodigoValidacao, campo: string, extra: Omit<ErroValidacao, 'codigo' | 'campo'> = {}): ErroValidacao {
  return { codigo, campo, ...extra };
}

/* ------------------------------------------------------------------ *
 * Leitura do corpo (formato) — faixas
 * ------------------------------------------------------------------ */

/**
 * Lê `faixas` do corpo da requisição. Valor em string decimal exata ou
 * número (convertido pela representação decimal, nunca `* 100`); moeda e
 * equipamento exatamente como recebidos (sem trim nem maiúscula automática —
 * um valor fora do catálogo é erro, nunca "corrigido").
 */
export function lerFaixasDoCorpo(bruto: unknown): { faixas: FaixaAdmin[]; erros: ErroValidacao[] } {
  const erros: ErroValidacao[] = [];
  if (!Array.isArray(bruto)) return { faixas: [], erros: [erro('campo_invalido', 'faixas')] };
  if (bruto.length > FAIXAS_MAXIMAS) return { faixas: [], erros: [erro('faixas_demais', 'faixas', { detalhe: { maximo: FAIXAS_MAXIMAS } })] };
  const faixas: FaixaAdmin[] = [];
  bruto.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      erros.push(erro('campo_invalido', 'faixas', { faixa: i }));
      return;
    }
    const f = item as Record<string, unknown>;
    const desconhecidos = Object.keys(f).filter((k) => !['equipamento', 'diaInicial', 'diaFinal', 'valorDia', 'moeda'].includes(k));
    if (desconhecidos.length) erros.push(erro('campo_invalido', `faixas.${desconhecidos[0]}`, { faixa: i }));
    const equipamento = typeof f.equipamento === 'string' && f.equipamento.length >= 1 && f.equipamento.length <= 20 ? f.equipamento : null;
    if (equipamento === null) erros.push(erro('campo_invalido', 'faixas.equipamento', { faixa: i }));
    const diaInicial = f.diaInicial;
    if (!diaValido(diaInicial)) erros.push(erro('numero_fora_do_formato', 'faixas.diaInicial', { faixa: i }));
    const diaFinal = f.diaFinal === undefined ? null : f.diaFinal;
    if (diaFinal !== null && !diaValido(diaFinal)) erros.push(erro('numero_fora_do_formato', 'faixas.diaFinal', { faixa: i }));
    // CHECK da 0009 (dia_final >= dia_inicial): nem chega a ser gravável.
    if (diaValido(diaInicial) && diaValido(diaFinal) && diaFinal < diaInicial) {
      erros.push(erro('progressao_invalida', 'faixas.diaFinal', { faixa: i, detalhe: { regra: 'dia_final_menor_que_inicial' } }));
    }
    const valor = valorDiaCanonico(f.valorDia);
    if (!valor.ok) erros.push(erro(valor.codigo, 'faixas.valorDia', { faixa: i }));
    let moeda: string | null = null;
    if (f.moeda === undefined || f.moeda === null || f.moeda === '') erros.push(erro('moeda_ausente', 'faixas.moeda', { faixa: i }));
    else if (typeof f.moeda !== 'string' || f.moeda.length > 10) erros.push(erro('moeda_invalida', 'faixas.moeda', { faixa: i }));
    else moeda = f.moeda;
    if (equipamento !== null && diaValido(diaInicial) && (diaFinal === null || diaValido(diaFinal)) && valor.ok && moeda !== null) {
      faixas.push({ equipamento, diaInicial, diaFinal: diaFinal as number | null, valorDia: valor.valor, moeda });
    }
  });
  return { faixas, erros };
}

/* ------------------------------------------------------------------ *
 * Leitura do corpo (formato) — metadados
 * ------------------------------------------------------------------ */

const CAMPOS_METADADOS = ['vigenciaInicio', 'vigenciaFim', 'qualidadeFonte', 'dayCountBasis', 'fonte', 'verificadaEm'] as const;

/**
 * Lê os metadados do corpo. `parcial` (PATCH): só os campos presentes; um
 * campo ausente mantém o valor atual. Campo desconhecido (inclusive a
 * dimensão, que não muda depois de criada) é recusado — nunca ignorado.
 */
export function lerMetadadosDoCorpo(
  corpo: Record<string, unknown>, parcial: boolean, permitidosExtra: readonly string[] = [],
): { metadados: Partial<MetadadosVersao>; erros: ErroValidacao[] } {
  const erros: ErroValidacao[] = [];
  const m: Partial<MetadadosVersao> = {};
  for (const k of Object.keys(corpo)) {
    if (!(CAMPOS_METADADOS as readonly string[]).includes(k) && !permitidosExtra.includes(k)) erros.push(erro('campo_invalido', k));
  }
  const presente = (k: string) => Object.prototype.hasOwnProperty.call(corpo, k);
  if (presente('vigenciaInicio')) {
    const v = corpo.vigenciaInicio;
    if (v === null) m.vigenciaInicio = null;
    else if (dataCivilValida(v)) m.vigenciaInicio = v;
    else erros.push(erro('data_invalida', 'vigenciaInicio'));
  } else if (!parcial) m.vigenciaInicio = null;
  if (presente('vigenciaFim')) {
    const v = corpo.vigenciaFim;
    if (v === null) m.vigenciaFim = null;
    else if (dataCivilValida(v)) m.vigenciaFim = v;
    else erros.push(erro('data_invalida', 'vigenciaFim'));
  } else if (!parcial) m.vigenciaFim = null;
  if (presente('qualidadeFonte') || !parcial) {
    if ((QUALIDADES as readonly unknown[]).includes(corpo.qualidadeFonte)) m.qualidadeFonte = corpo.qualidadeFonte as MetadadosVersao['qualidadeFonte'];
    else erros.push(erro('campo_invalido', 'qualidadeFonte'));
  }
  if (presente('dayCountBasis') || !parcial) {
    if ((BASES_CONTAGEM as readonly unknown[]).includes(corpo.dayCountBasis)) m.dayCountBasis = corpo.dayCountBasis as MetadadosVersao['dayCountBasis'];
    else erros.push(erro('campo_invalido', 'dayCountBasis'));
  }
  if (presente('fonte') || !parcial) {
    const f = corpo.fonte;
    if (typeof f === 'string' && f.trim() && f.length <= 500) m.fonte = f.trim();
    else erros.push(erro('texto_invalido', 'fonte'));
  }
  if (presente('verificadaEm') || !parcial) {
    const v = instanteCanonico(corpo.verificadaEm);
    if (v) m.verificadaEm = v;
    else erros.push(erro('verificada_em_invalida', 'verificadaEm'));
  }
  return { metadados: m, erros };
}

/* ------------------------------------------------------------------ *
 * Regras de conteúdo (motor) e completude
 * ------------------------------------------------------------------ */

/**
 * Valida o conteúdo COMPLETO de uma versão contra as regras do motor. Os
 * índices de faixa referem-se a `conteudo.faixas` na ordem recebida.
 */
export function validarConteudo(conteudo: ConteudoVersao, ctx: ContextoValidacao): ErroValidacao[] {
  const erros: ErroValidacao[] = [];
  const { dimensao } = conteudo;
  const embarque = dimensao.tipo === 'rocket_cliente' && dimensao.termoComercial === 'embarque';

  // Dimensão (defensivo: a criação já a validou).
  if (dimensao.tipo === 'armador' && !dimensao.armadorId) erros.push(erro('dimensao_obrigatoria_ausente', 'armadorId'));
  if (dimensao.tipo === 'rocket_cliente' && !dimensao.termoComercial) erros.push(erro('dimensao_obrigatoria_ausente', 'termoComercial'));

  // Vigência.
  // Termo por Embarque: a versão é fixada por ID na condição e o motor ignora
  // a vigência — ela é só informativa (validada quanto à coerência).
  if (conteudo.vigenciaInicio === null) {
    if (!embarque) erros.push(erro('vigencia_inicio_ausente', 'vigenciaInicio'));
  } else if (!dataCivilValida(conteudo.vigenciaInicio)) erros.push(erro('data_invalida', 'vigenciaInicio'));
  if (conteudo.vigenciaFim !== null && !dataCivilValida(conteudo.vigenciaFim)) erros.push(erro('data_invalida', 'vigenciaFim'));
  if (conteudo.vigenciaInicio !== null && conteudo.vigenciaFim !== null && conteudo.vigenciaFim < conteudo.vigenciaInicio) {
    erros.push(erro('vigencia_incoerente', 'vigenciaFim', { detalhe: { vigenciaInicio: conteudo.vigenciaInicio, vigenciaFim: conteudo.vigenciaFim } }));
  }
  if (!instanteCanonico(conteudo.verificadaEm)) erros.push(erro('verificada_em_invalida', 'verificadaEm'));
  if (!(QUALIDADES as readonly string[]).includes(conteudo.qualidadeFonte)) erros.push(erro('campo_invalido', 'qualidadeFonte'));
  if (!(BASES_CONTAGEM as readonly string[]).includes(conteudo.dayCountBasis)) erros.push(erro('campo_invalido', 'dayCountBasis'));
  if (!conteudo.fonte || !conteudo.fonte.trim() || conteudo.fonte.length > 500) erros.push(erro('texto_invalido', 'fonte'));
  // O Termo por Embarque nunca recebe a qualidade da fonte: uma tabela
  // provisória sairia como ESTIMADO (nunca ESTIMADO_PROVISORIO) — enganoso.
  if (embarque && conteudo.qualidadeFonte === 'PROVISORIA_INCOMPLETA') {
    erros.push(erro('qualidade_incompativel', 'qualidadeFonte', { detalhe: { termoComercial: 'embarque' } }));
  }

  // Faixas.
  const faixas = conteudo.faixas;
  if (faixas.length === 0) erros.push(erro('tabela_sem_faixas', 'faixas'));
  if (faixas.length > FAIXAS_MAXIMAS) erros.push(erro('faixas_demais', 'faixas', { detalhe: { maximo: FAIXAS_MAXIMAS } }));
  const moedas = new Set<string>();
  faixas.forEach((f, i) => {
    if (!ctx.equipamentos.has(f.equipamento)) erros.push(erro('equipamento_invalido', 'faixas.equipamento', { faixa: i, equipamento: f.equipamento }));
    if (!diaValido(f.diaInicial)) erros.push(erro('numero_fora_do_formato', 'faixas.diaInicial', { faixa: i }));
    if (f.diaFinal !== null && !diaValido(f.diaFinal)) erros.push(erro('numero_fora_do_formato', 'faixas.diaFinal', { faixa: i }));
    if (f.diaFinal !== null && diaValido(f.diaFinal) && f.diaFinal < f.diaInicial) {
      erros.push(erro('progressao_invalida', 'faixas.diaFinal', { faixa: i, equipamento: f.equipamento, detalhe: { regra: 'dia_final_menor_que_inicial' } }));
    }
    const v = valorDiaCanonico(f.valorDia);
    if (!v.ok) erros.push(erro(v.codigo, 'faixas.valorDia', { faixa: i }));
    if (!f.moeda) erros.push(erro('moeda_ausente', 'faixas.moeda', { faixa: i }));
    else if (!moedaIsoValida(f.moeda)) erros.push(erro('moeda_invalida', 'faixas.moeda', { faixa: i, detalhe: { moeda: f.moeda } }));
    else moedas.add(f.moeda);
  });
  // "Cada tabela mantém sua moeda original": uma moeda por versão.
  if (moedas.size > 1) erros.push(erro('moeda_divergente_na_tabela', 'faixas.moeda', { detalhe: { moedas: [...moedas].sort() } }));

  // Progressão por equipamento (índices originais preservados).
  const porEquipamento = new Map<string, Array<{ f: FaixaAdmin; i: number }>>();
  faixas.forEach((f, i) => {
    if (!porEquipamento.has(f.equipamento)) porEquipamento.set(f.equipamento, []);
    porEquipamento.get(f.equipamento)!.push({ f, i });
  });
  for (const [equipamento, lista] of porEquipamento) {
    lista.sort((a, b) => a.f.diaInicial - b.f.diaInicial || a.i - b.i);
    if (embarque && lista.length > 1) {
      // O motor do Termo por Embarque usa só a primeira faixa do equipamento e
      // ignora a base de contagem: mais de uma faixa = seleção ambígua.
      erros.push(erro('ambiguidade_selecao', 'faixas', { faixa: lista[1].i, equipamento, detalhe: { regra: 'termo_embarque_uma_faixa_por_equipamento' } }));
    }
    const primeira = lista[0].f;
    if (primeira.diaInicial > 1 && (embarque || conteudo.dayCountBasis === 'excess_over_free_time')) {
      erros.push(erro('lacuna_inicial', 'faixas.diaInicial', { faixa: lista[0].i, equipamento, detalhe: { primeiroDia: primeira.diaInicial } }));
    }
    for (let k = 1; k < lista.length; k++) {
      const ant = lista[k - 1].f;
      const cur = lista[k].f;
      if (ant.diaFinal === null || ant.diaFinal >= cur.diaInicial) {
        erros.push(erro('faixas_sobrepostas', 'faixas', { faixa: lista[k].i, equipamento, detalhe: { com: lista[k - 1].i } }));
      } else if (ant.diaFinal + 1 < cur.diaInicial) {
        erros.push(erro('lacuna_entre_faixas', 'faixas', { faixa: lista[k].i, equipamento, detalhe: { de: ant.diaFinal + 1, ate: cur.diaInicial - 1 } }));
      }
    }
    const ultima = lista[lista.length - 1];
    if (ultima.f.diaFinal !== null) {
      // Um dia além da última faixa fechada tornaria o cálculo inteiro
      // INDISPONÍVEL (o motor nunca usa a faixa vizinha).
      erros.push(erro('progressao_invalida', 'faixas.diaFinal', { faixa: ultima.i, equipamento, detalhe: { regra: 'ultima_faixa_deve_ser_aberta' } }));
    }
  }
  return erros;
}

/**
 * Sobreposição entre faixas do MESMO equipamento — o banco recusaria a
 * gravação (EXCLUDE `tariff_brackets_sem_sobreposicao`); detectada antes,
 * com o índice da faixa, em vez de virar erro de banco.
 */
export function sobreposicoes(faixas: readonly FaixaAdmin[]): ErroValidacao[] {
  const erros: ErroValidacao[] = [];
  const porEquipamento = new Map<string, Array<{ f: FaixaAdmin; i: number }>>();
  faixas.forEach((f, i) => {
    if (!porEquipamento.has(f.equipamento)) porEquipamento.set(f.equipamento, []);
    porEquipamento.get(f.equipamento)!.push({ f, i });
  });
  for (const [equipamento, lista] of porEquipamento) {
    lista.sort((a, b) => a.f.diaInicial - b.f.diaInicial || a.i - b.i);
    for (let k = 1; k < lista.length; k++) {
      const ant = lista[k - 1].f;
      if (ant.diaFinal === null || ant.diaFinal >= lista[k].f.diaInicial) {
        erros.push(erro('faixas_sobrepostas', 'faixas', { faixa: lista[k].i, equipamento, detalhe: { com: lista[k - 1].i } }));
      }
    }
  }
  return erros;
}

export function dimensaoEhEmbarque(d: DimensaoTabela): boolean {
  return d.tipo === 'rocket_cliente' && d.termoComercial === 'embarque';
}
