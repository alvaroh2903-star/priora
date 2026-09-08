/**
 * PB-002 — CE Mercante · Motor determinístico (Fase 1)
 *
 * Audita o CE Mercante contra os documentos de transporte, REUTILIZANDO as
 * primitivas do PB-001 (normalização, comparadores exatos, estados). Relações:
 *   CE Master ↔ MBL   |   CE House ↔ HBL   |   Σ CE Houses ↔ CE Master
 *
 * Princípios do blueprint aplicados:
 *  - Pareamento por NÚMERO DE CONTAINER (nunca pela ordem do Item — 0001/0002 é
 *    só posição interna). Uso de conjuntos → part lot (mesmo container em vários
 *    Houses) NÃO é duplicidade.
 *  - Determinístico, zero tolerância numérica (Q6).
 *  - Portos do manifesto NÃO são comparados cegamente (transbordo) → fora do v1.
 *  - Campo ausente/ilegível → NaoAvaliada (nunca "divergência" automática).
 *
 * v1 cobre: identificação/relacionamento, containers, peso bruto, cubagem, NCM e
 * consolidação (Σ Houses = Master). Participantes/CNPJ, frete, tipo de container
 * e wooden packaging ficam para a Fase 2 (exigem campos novos na extração).
 */
import { consolidar, comparaPrioridade, Criticidade, ResultadoValidacao } from '../preAlerta/estados';
import { cmpCodigo, cmpNumeroExato } from '../preAlerta/comparadores';
import { normalizarCodigo } from '../preAlerta/normalizacao';
import { DocPreAlerta, Evidencia, ResultadoFamilia } from '../preAlerta/modelo';

/**
 * Um arquivo é COMPONENTE do CE Mercante? Na operação real o CE chega como
 * "<nº do BL> dados básicos.pdf" e "<nº do BL> item N.pdf" (NUNCA com a palavra
 * "CE"). Detectamos por esses descritores — não pela palavra CE (BI-001 §1.39).
 */
export function ehComponenteCE(nome: string): boolean {
  // "item N", "itemN" (sem espaço) e o plural "itens" — o nome varia na operação
  // real. (item = ...m; itens = ...ns → precisa cobrir os dois radicais.)
  return /dados?\s*b[aá]sicos?/i.test(nome) || /\bite(?:m|ns)\s*\d+/i.test(nome);
}

/**
 * Extrai o NÚMERO-BASE do BL contido no nome do arquivo, removendo descritores
 * (dados básicos, item N) e sufixos (-OMBL/-OHBL/-MBL/-HBL) e normalizando. É a
 * chave que liga um componente do CE ao seu BL (BI-001 §1.13: usar o número já
 * conhecido do processo, sem IA). Ex.: "SHYY26010120 item 1.pdf" → SHYY26010120;
 * "263463180-OMBL.pdf" → 263463180.
 */
export function numeroBaseDoNome(nome: string): string {
  let s = (nome || '').replace(/\.[a-z0-9]+$/i, '');
  s = s.replace(/dados?\s*b[aá]sicos?/gi, '');
  s = s.replace(/\bite(?:m|ns)\s*\d+/gi, '');
  s = s.replace(/[-_ ]*(o?mbl|o?hbl|master|house)\b/gi, '');
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Operação do CE Mercante: BLs (referência) + CE Mercante (auditado). */
export interface OperacaoCE {
  processo: string;
  mbl: DocPreAlerta | null;
  hbls: DocPreAlerta[];
  ceMaster: DocPreAlerta | null;
  ceHouses: DocPreAlerta[];
}

export interface ResultadoCeMercante {
  processo: string;
  familias: ResultadoFamilia[];
  evidencias: Evidencia[]; // achatadas e ordenadas por prioridade
  resultado: ResultadoValidacao;
}

function ev(
  subvalidacao: string,
  campo: string,
  resultado: ResultadoValidacao,
  criticidade: Criticidade,
  fonteDaVerdade: string,
  houseId: string | null,
  container: string | null,
  valores: Evidencia['valores'],
  motivo: string,
): Evidencia {
  return { subvalidacao, campo, resultado, criticidade, fonteDaVerdade, houseId, container, valores, motivo };
}

/** Números de container normalizados de um documento (evidência). */
function nums(d: DocPreAlerta): string[] {
  return d.containers.map((c) => (c.numero ? normalizarCodigo(c.numero) : '')).filter(Boolean);
}

/** Conjunto de NCMs (nível do conhecimento + por container), só dígitos. */
function ncmSet(d: DocPreAlerta): Set<string> {
  const todos = [...(d.ncm || []), ...d.containers.flatMap((c) => c.ncm || [])];
  return new Set(todos.map((x) => String(x).replace(/\D/g, '')).filter(Boolean));
}

/**
 * Compara um conhecimento do CE (alvo) contra o BL correspondente (fonte):
 * containers (existência), peso bruto total, cubagem total e conjunto de NCM.
 * Uma família por par (V-002 = Master↔MBL; V-003 = House↔HBL).
 */
function compararConhecimentos(
  familia: string,
  fonteLabel: string,
  alvoLabel: string,
  houseId: string | null,
  fonte: DocPreAlerta,
  alvo: DocPreAlerta,
): ResultadoFamilia {
  const out: Evidencia[] = [];

  if (!fonte.legivel || !alvo.legivel) {
    out.push(ev(`${familia}.1`, 'Containers', 'NaoAvaliada', 'Alta', fonteLabel, houseId, null, [], `${fonteLabel} ou ${alvoLabel} ilegível — comparação não avaliada.`));
    return { familia, resultado: 'NaoAvaliada', evidencias: out };
  }

  // .1 — Containers (pareados por número; ordem/Item irrelevantes)
  const setF = new Set(nums(fonte));
  const setA = new Set(nums(alvo));
  if (setF.size === 0 && setA.size === 0) {
    out.push(ev(`${familia}.1`, 'Containers', 'NaoAvaliada', 'Alta', fonteLabel, houseId, null, [], 'Nenhum container lido nos documentos.'));
  } else {
    for (const n of setF) {
      const ok = setA.has(n);
      out.push(ev(`${familia}.1`, 'Container', ok ? 'Consistente' : 'Divergencia', 'Critica', fonteLabel, houseId, n,
        [{ doc: fonteLabel, valor: n }, { doc: alvoLabel, valor: ok ? n : '—' }],
        ok ? `Container ${n} presente no ${fonteLabel} e no ${alvoLabel}.` : `Container ${n} do ${fonteLabel} ausente no ${alvoLabel}.`));
    }
    for (const n of setA) {
      if (!setF.has(n)) {
        out.push(ev(`${familia}.1`, 'Container', 'Divergencia', 'Critica', fonteLabel, houseId, n,
          [{ doc: fonteLabel, valor: '—' }, { doc: alvoLabel, valor: n }], `Container ${n} do ${alvoLabel} não consta no ${fonteLabel}.`));
      }
    }
  }

  // .2/.3 — Totais numéricos (zero tolerância)
  const numericos: Array<{ sub: string; rot: string; u: string; get: (d: DocPreAlerta) => number | null }> = [
    { sub: `${familia}.2`, rot: 'Peso Bruto Total', u: 'kg', get: (d) => d.pesoBrutoTotalKg },
    { sub: `${familia}.3`, rot: 'Cubagem Total', u: 'm³', get: (d) => d.cubagemTotalM3 },
  ];
  for (const c of numericos) {
    const vf = c.get(fonte);
    const va = c.get(alvo);
    const cmp = cmpNumeroExato(vf, va, c.u);
    out.push(ev(c.sub, c.rot, cmp.resultado, 'Alta', fonteLabel, houseId, null,
      [{ doc: fonteLabel, valor: vf == null ? '—' : `${vf} ${c.u}` }, { doc: alvoLabel, valor: va == null ? '—' : `${va} ${c.u}` }], cmp.motivo));
  }

  // .4 — NCM (conjunto)
  const nf = ncmSet(fonte);
  const na = ncmSet(alvo);
  if (nf.size === 0 && na.size === 0) {
    out.push(ev(`${familia}.4`, 'NCM', 'NaoAvaliada', 'Media', fonteLabel, houseId, null, [], 'NCM ausente nos documentos.'));
  } else {
    const faltam = [...nf].filter((x) => !na.has(x));
    const extras = [...na].filter((x) => !nf.has(x));
    const ok = faltam.length === 0 && extras.length === 0;
    out.push(ev(`${familia}.4`, 'NCM', ok ? 'Consistente' : 'Divergencia', 'Media', fonteLabel, houseId, null,
      [{ doc: fonteLabel, valor: [...nf].join(', ') || '—' }, { doc: alvoLabel, valor: [...na].join(', ') || '—' }],
      ok ? 'Conjunto de NCM confere.' : `NCM divergente — faltam no ${alvoLabel}: [${faltam.join(', ') || '—'}]; extras: [${extras.join(', ') || '—'}].`));
  }

  return { familia, resultado: consolidar(out.map((e) => e.resultado)), evidencias: out };
}

/**
 * Pareia CE Houses com HBLs: 1º por nº de conhecimento; 2º por container em
 * comum; 3º pela ordem. Sobras (CE House sem HBL, ou HBL sem filhote) viram par
 * meio-vazio para sinalização.
 */
function parear(ces: DocPreAlerta[], bls: DocPreAlerta[]): Array<{ ce: DocPreAlerta | null; bl: DocPreAlerta | null }> {
  const pares: Array<{ ce: DocPreAlerta | null; bl: DocPreAlerta | null }> = [];
  const usados = new Set<number>();
  for (const ce of ces) {
    let idx = -1;
    const cn = ce.conhecimentoNumero ? normalizarCodigo(ce.conhecimentoNumero) : '';
    if (cn) idx = bls.findIndex((b, i) => !usados.has(i) && b.conhecimentoNumero && normalizarCodigo(b.conhecimentoNumero) === cn);
    if (idx < 0) {
      const cns = new Set(nums(ce));
      idx = bls.findIndex((b, i) => !usados.has(i) && nums(b).some((n) => cns.has(n)));
    }
    if (idx < 0) idx = bls.findIndex((_, i) => !usados.has(i));
    if (idx >= 0) usados.add(idx);
    pares.push({ ce, bl: idx >= 0 ? bls[idx] : null });
  }
  bls.forEach((b, i) => {
    if (!usados.has(i)) pares.push({ ce: null, bl: b });
  });
  return pares;
}

/** Consolidação (V-015): Σ CE Houses = CE Master (peso bruto + união de containers). */
function consolidacao(op: OperacaoCE): ResultadoFamilia {
  const master = op.ceMaster!;
  const evc: Evidencia[] = [];

  // Peso bruto: soma dos Houses = total do Master (part lot: rateio soma no todo).
  const totM = master.pesoBrutoTotalKg;
  const somas = op.ceHouses.map((h) => h.pesoBrutoTotalKg);
  const soma = somas.every((v) => v != null) ? (somas as number[]).reduce((a, b) => a + b, 0) : null;
  if (totM == null || soma == null) {
    evc.push(ev('V-015.1', 'Peso Bruto (Σ Houses = Master)', 'NaoAvaliada', 'Alta', 'CE Master', null, null,
      [{ doc: 'CE Master', valor: totM == null ? '—' : `${totM} kg` }, { doc: 'Σ CE Houses', valor: soma == null ? '—' : `${soma} kg` }],
      'Peso bruto total ausente no CE Master ou em algum CE House.'));
  } else {
    const cmp = cmpNumeroExato(totM, soma, 'kg');
    evc.push(ev('V-015.1', 'Peso Bruto (Σ Houses = Master)', cmp.resultado, 'Alta', 'CE Master', null, null,
      [{ doc: 'CE Master', valor: `${totM} kg` }, { doc: 'Σ CE Houses', valor: `${soma} kg` }], cmp.motivo));
  }

  // Containers: todo container do Master aparece em algum House (part lot → set).
  const setM = new Set(nums(master));
  const uni = new Set(op.ceHouses.flatMap((h) => nums(h)));
  if (setM.size === 0 && uni.size === 0) {
    evc.push(ev('V-015.2', 'Containers (Master = Σ Houses)', 'NaoAvaliada', 'Critica', 'CE Master', null, null, [], 'Nenhum container lido no CE Master/Houses.'));
  } else {
    const faltam = [...setM].filter((n) => !uni.has(n));
    const extras = [...uni].filter((n) => !setM.has(n));
    const ok = faltam.length === 0 && extras.length === 0;
    evc.push(ev('V-015.2', 'Containers (Master = Σ Houses)', ok ? 'Consistente' : 'Divergencia', 'Critica', 'CE Master', null, null,
      [{ doc: 'CE Master', valor: [...setM].join(', ') || '—' }, { doc: 'Σ CE Houses', valor: [...uni].join(', ') || '—' }],
      ok ? 'Todos os containers do CE Master aparecem nos CE Houses (part lot considerado).' : `Divergência de containers — faltam nos Houses: [${faltam.join(', ') || '—'}]; extras: [${extras.join(', ') || '—'}].`));
  }

  return { familia: 'V-015', resultado: consolidar(evc.map((e) => e.resultado)), evidencias: evc };
}

/** Executa o PB-002 sobre a operação já extraída. STATELESS (como o PB-001). */
export function executarCeMercante(op: OperacaoCE): ResultadoCeMercante {
  const familias: ResultadoFamilia[] = [];

  // V-001 — Identificação e relacionamento estrutural.
  const evId: Evidencia[] = [];
  if (!op.ceMaster) evId.push(ev('V-001.1', 'CE Master', 'NaoAvaliada', 'Alta', 'CE Master', null, null, [], 'CE Master ausente — auditoria do CE não pode ser concluída.'));
  if (!op.mbl) evId.push(ev('V-001.1', 'MBL', 'NaoAvaliada', 'Alta', 'MBL', null, null, [], 'MBL ausente — sem fonte para conferir o CE Master.'));
  if (op.ceMaster && op.mbl) {
    const cmp = cmpCodigo(op.mbl.conhecimentoNumero ?? null, op.ceMaster.conhecimentoNumero ?? null);
    // Vínculo Master↔MBL: divergência de número vira Validação Humana (o número
    // pode estar formatado diferente entre CE e BL) — não reprova sozinho.
    const r: ResultadoValidacao = cmp.resultado === 'Divergencia' ? 'ValidacaoHumana' : cmp.resultado;
    evId.push(ev('V-001.2', 'Nº do conhecimento (Master ↔ MBL)', r, 'Alta', 'MBL', null, null,
      [{ doc: 'MBL', valor: op.mbl.conhecimentoNumero ?? '—' }, { doc: 'CE Master', valor: op.ceMaster.conhecimentoNumero ?? '—' }],
      cmp.resultado === 'Divergencia' ? `Número do conhecimento diverge — confirmar o vínculo CE Master ↔ MBL.` : cmp.motivo));
  }
  const qtdOk = op.ceHouses.length === op.hbls.length;
  evId.push(ev('V-001.3', 'Quantidade de Houses (filhotes)',
    op.ceHouses.length === 0 || op.hbls.length === 0 ? 'NaoAvaliada' : qtdOk ? 'Consistente' : 'Divergencia',
    'Media', '—', null, null,
    [{ doc: 'HBLs', valor: String(op.hbls.length) }, { doc: 'CE Houses', valor: String(op.ceHouses.length) }],
    `HBLs presentes: ${op.hbls.length} × CE Houses presentes: ${op.ceHouses.length}.`));
  familias.push({ familia: 'V-001', resultado: consolidar(evId.map((e) => e.resultado)), evidencias: evId });

  // V-002 — CE Master × MBL.
  if (op.ceMaster && op.mbl) familias.push(compararConhecimentos('V-002', 'MBL', 'CE Master', null, op.mbl, op.ceMaster));

  // V-003 — cada CE House × HBL.
  parear(op.ceHouses, op.hbls).forEach((p, i) => {
    const houseId = p.ce?.nome || p.bl?.nome || `House ${i + 1}`;
    if (p.ce && p.bl) {
      familias.push(compararConhecimentos('V-003', 'HBL', 'CE House', houseId, p.bl, p.ce));
    } else if (p.ce) {
      familias.push({ familia: 'V-003', resultado: 'NaoAvaliada', evidencias: [ev('V-003.0', 'CE House sem HBL', 'NaoAvaliada', 'Alta', 'HBL', houseId, null, [], `CE House "${houseId}" sem HBL correspondente para conferir.`)] });
    } else if (p.bl) {
      familias.push({ familia: 'V-003', resultado: 'Divergencia', evidencias: [ev('V-003.0', 'HBL sem CE House', 'Divergencia', 'Alta', 'HBL', houseId, null, [], `HBL "${houseId}" sem CE House (filhote) correspondente no CE Mercante.`)] });
    }
  });

  // V-015 — Consolidação Σ CE Houses ↔ CE Master.
  if (op.ceMaster && op.ceHouses.length > 0) familias.push(consolidacao(op));

  const evidencias = familias.flatMap((f) => f.evidencias).sort(comparaPrioridade);
  const resultado = consolidar(familias.map((f) => f.resultado));
  return { processo: op.processo, familias, evidencias, resultado };
}
