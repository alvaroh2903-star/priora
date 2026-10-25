/**
 * ASS-010 (entregas parciais) — tela do Courier: Telex Release Confirmado ×
 * Pendente e a regra de que a IA (Clara) NÃO encerra sozinha a expectativa do
 * OHBL/OMBL físico — nem por telex, nem por envio ao importador, emissão no
 * destino ou Wave BL — e de que expandir/recarregar a análise não muda a
 * resolução documental. Roda o script REAL de public/Courier Module.dc.html num
 * vm isolado (sem rede, sem DOM) e chama buildRow com couriers sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { indiceComOrigem, IndiceComOrigem, mencoesDocumentais } from './docAssociation';
import { pendenciasAbertas } from './pendenciasAbertas';
import { MAX_SHARED_PROCESSES } from './referenceResolver';

const HTML = path.join(__dirname, '..', '..', 'public', 'Courier Module.dc.html');
const SCRIPT = (() => {
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(HTML, 'utf8'));
  if (!m) throw new Error('script data-dc-script não encontrado');
  return m[1];
})();

/** Efeitos colaterais que buildRow NUNCA pode ter (conferência, rede). */
const efeitos = { setState: 0, fetch: 0 };

let Classe: any = null;
function componente() {
  if (Classe) return new Classe({});
  const ctx = vm.createContext({
    window: {},
    document: { visibilityState: 'visible' },
    fetch: () => {
      efeitos.fetch++;
      throw new Error('buildRow não deve fazer chamadas');
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console,
    Date,
  });
  class DCLogic {
    state: Record<string, unknown> = {};
    props: unknown;
    constructor(props: unknown) {
      this.props = props;
    }
    setState() {
      efeitos.setState++;
    }
  }
  Classe = vm.runInContext(`(function(DCLogic){${SCRIPT}\n;return Component;})`, ctx)(DCLogic);
  return new Classe({});
}

type Opcoes = {
  estado?: string;
  /** Mesma marcação de conferência gravada em todos os processos. */
  conf?: Record<string, string>;
  /** Marcações gravadas por processo (quando diferem). */
  confPor?: Record<string, Record<string, string>>;
  /** Follow-ups gravados por processo. */
  fupPor?: Record<string, Record<string, unknown>>;
  clara?: string | null;
  processos?: string[];
  /**
   * Corpo do e-mail do courier. O docsEnvelope sai do módulo REAL
   * (mencoesDocumentais). Padrão: "IMxxxx - OMBL / OHBL" para cada processo.
   */
  texto?: string;
  /** Resposta inteira de /analysis (hblResolution, processosDetalhe, processNumbers…). */
  analise?: Record<string, unknown>;
  /** Card aberto (expandedId), como depois do clique em "ver envelope". */
  expandido?: boolean;
  /** Índice de referências dos OUTROS e-mails (padrão: vazio). */
  indice?: IndiceComOrigem;
};
function montar(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const c = componente();
  const processos = op.processos || ['IM2101'];
  const texto = op.texto ?? processos.map((p) => `${p} - OMBL / OHBL`).join('\n');
  const courier = {
    carrier: 'FedEx',
    tracking: '770012345611',
    agente: 'Agente sintético',
    data: '2026-10-01T12:00:00.000Z',
    processos,
    // Citação no envelope inteiro: a tela NÃO a usa mais (fica "tudo citado" de propósito).
    docExpect: { mbl: true, hbl: true, anySeen: true },
    docResolution,
    docsEnvelope: mencoesDocumentais([{ messageId: 'msg-1', texto }], processos, op.indice || new Map()),
    conversationId: 'conv-1',
    estado: op.estado || 'Identificado',
    conferencia: op.confPor || (op.conf ? Object.fromEntries(processos.map((p) => [p, op.conf])) : {}),
    followups: op.fupPor || {},
    resolucao: { resolvidos: [], candidatos: [] },
    pendenciasAbertas: [] as unknown[],
  };
  // Como a rota faz: pendências abertas a partir dos registros (módulo real).
  courier.pendenciasAbertas = pendenciasAbertas(courier.conferencia as any, courier.docsEnvelope.mencoes, docResolution);
  const confAntes = JSON.stringify(courier.conferencia);
  const analise =
    op.analise || (op.clara !== undefined ? { hblResolution: op.clara, processosDetalhe: [], processNumbers: [] } : undefined);
  if (analise) {
    c.state.analysis = { 'conv-1': analise };
    c.state.aStatus = { 'conv-1': 'ok' };
  }
  if (op.expandido) c.state.expandedId = courier.tracking;
  const antes = { ...efeitos };
  const row = c.buildRow(courier);
  assert.deepEqual(efeitos, antes, 'buildRow alterou estado ou fez chamada');
  assert.equal(JSON.stringify(courier.conferencia), confAntes, 'buildRow alterou a conferência');
  return row;
}
/** Célula com os campos novos explícitos (false quando a revisão do front não os tem). */
const cel = (c: any) => Object.assign({ desconhecido: false, revisar: false, registro: false }, c);
function linhas(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  return Array.from(montar(docResolution, op).envelope, (env: any) => ({
    codigo: env.codigo as string,
    hbl: cel(env.hbl),
    mbl: cel(env.mbl),
    hblDoc: Array.from(env.docsEsperados as any[]).find((d: any) => d.label === 'HBL Original'),
    mblDoc: Array.from(env.docsEsperados as any[]).find((d: any) => d.label === 'MBL'),
    /** Pendências com sugestão de cobrança (tudo que não é conflito; vale também para o front antigo). */
    pendencias: Array.from(env.pendencias as any[]).filter((p: any) => !p.conflito).map((p: any) => p.docLabel),
    /** Registros "Não recebido" sem associação confirmada (sem cobrança automática). */
    conflitos: Array.from(env.pendencias as any[]).filter((p: any) => p.conflito),
    st: env.stLabel,
  }));
}
/**
 * Projeção DOCUMENTAL do card (sem funções): por processo, as células OMBL/OHBL,
 * a lista "Documentos esperados", as pendências e o status; e o rodapé.
 */
function projecao(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const row = montar(docResolution, op);
  return JSON.parse(
    JSON.stringify({
      envelope: Array.from(row.envelope, (env: any) => ({
        codigo: env.codigo,
        hbl: env.hbl,
        mbl: env.mbl,
        docs: env.docsEsperados,
        pendencias: env.pendencias,
        st: env.stLabel,
      })),
      footDiv: row.footDiv,
      footOk: row.footOk,
    }),
  );
}
const linha = (dr: Record<string, boolean>, op: Opcoes = {}) => linhas(dr, op)[0];

const sem = { telex: false, wave: false, destino: false, importador: false, telexPendente: false };
const confirmado = { ...sem, telex: true };
const pendente = { ...sem, telexPendente: true };
const PEND = 'Telex Release Pendente — aguardando confirmação';

/* ---------------- matriz motor documental × Clara (conformidade) ---------------- */

test('Clara × motor: telex confirmado pelo motor encerra o OHBL, com ou sem análise da Clara', () => {
  for (const clara of [undefined, 'Telex Release']) {
    const { hbl, hblDoc } = linha(confirmado, clara === undefined ? {} : { clara });
    assert.deepEqual([hbl.resolved, hbl.text, hbl.pend], [true, 'Telex Release Confirmado', false], String(clara));
    assert.equal(hblDoc.status, 'Telex Release Confirmado');
  }
});

test('Clara × motor: telex pendente no motor não é encerrado por nenhuma string de telex da Clara', () => {
  for (const clara of ['Telex Release', 'Telex release confirmed']) {
    const { hbl, hblDoc } = linha(pendente, { clara });
    assert.deepEqual([hbl.resolved, hbl.pend, hbl.pendText], [false, true, PEND], clara);
    assert.equal(hblDoc.status, PEND);
  }
});

test('Clara × motor: sem confirmação do motor, a Clara não encerra o OHBL ("pending", "Via Telex Release", "confirmed")', () => {
  for (const clara of ['Telex release pending payment', 'Via Telex Release', 'Telex release confirmed']) {
    const { hbl, hblDoc } = linha(sem, { clara });
    assert.equal(hbl.resolved, false, clara);
    assert.equal(hbl.pend, false, `${clara}: o aviso de pendência é só do motor`);
    assert.equal(hbl.waitText, 'Aguardando courier', clara);
    assert.equal(hblDoc.status, 'Aguardando courier', clara);
  }
});

test('Clara × motor: sem confirmação e sem análise, OMBL/OHBL afirmados para o processo aguardam o envelope', () => {
  const { hbl, hblDoc, mbl } = linha(sem);
  assert.deepEqual([hbl.resolved, hbl.desconhecido, hbl.wait, hbl.waitText, hbl.pend], [false, false, true, 'Aguardando courier', false]);
  assert.equal(hblDoc.status, 'Aguardando courier');
  assert.deepEqual([mbl.resolved, mbl.waitText], [false, 'Aguardando courier']);
});

test('Clara × motor: envio ao importador reconhecido pelo motor continua encerrando, mesmo com a Clara citando telex', () => {
  const { hbl } = linha({ ...sem, importador: true }, { clara: 'Telex Release' });
  assert.deepEqual([hbl.resolved, hbl.text], [true, 'Enviado ao importador']);
  const comPendencia = linha({ ...pendente, importador: true }, { clara: 'Telex Release' });
  assert.deepEqual([comPendencia.hbl.resolved, comPendencia.hbl.text, comPendencia.hbl.pend], [true, 'Enviado ao importador', false]);
});

test('Clara × motor: Wave BL e emissão no destino reconhecidos pelo motor seguem as regras de antes', () => {
  const destino = linha({ ...sem, destino: true }, { clara: 'Telex Release' });
  assert.deepEqual([destino.hbl.resolved, destino.hbl.text, destino.mbl.text], [true, 'Emitido no destino', 'Emitido no destino']);
  const wave = linha({ ...sem, wave: true }, { clara: 'Telex Release' });
  assert.deepEqual([wave.hbl.resolved, wave.hbl.text, wave.mbl.text], [true, 'Via Wave BL', 'Via Wave BL']);
});

test('critério essencial: nenhuma string de telex da Clara, sozinha, põe hbl.resolved = true', () => {
  const strings = [
    'Telex Release', 'Telex release', 'TELEX RELEASE', 'Via Telex Release', 'Telex release confirmed',
    'Telex released', 'Telex release completed', 'Telex release pending payment', 'Awaiting telex release',
    'HBL telex released', 'Telex liberado', 'Telex realizado', 'telex',
  ];
  for (const motor of [sem, pendente]) {
    for (const estado of ['Identificado', 'Recebido', 'Em Conferência', 'Divergência']) {
      for (const clara of strings) {
        const { hbl } = linha(motor, { clara, estado });
        assert.equal(hbl.resolved, false, `${clara} | ${estado} | pendente=${motor.telexPendente}`);
      }
    }
  }
});

/* ---------------- estados do envelope, conferência e cobrança ---------------- */

test('envelope em trânsito: OHBL sem confirmação aguarda o envelope (sem marcação)', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, st } = linha(motor, { clara: 'Telex Release', estado: 'Identificado' });
    assert.deepEqual([hbl.wait, hbl.conf, hbl.resolved], [true, false, false]);
    assert.equal(st, 'Em trânsito');
  }
});

test('envelope recebido: OHBL sem confirmação segue conferível (Recebido/Não recebido)', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, pendencias, st } = linha(motor, { clara: 'Telex Release', estado: 'Recebido' });
    assert.deepEqual([hbl.conf, hbl.resolved], [true, false]);
    assert.deepEqual(pendencias, []);
    assert.equal(st, 'Recebido');
  }
});

test('OHBL marcado como recebido: conta na conferência e fecha como Conferido', () => {
  const { hbl, hblDoc, pendencias, st } = linha(sem, {
    clara: 'Telex Release', estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' },
  });
  assert.equal(hbl.conf, true);
  assert.equal(hbl.recBg, '#177D54', 'marcação "Recebido" selecionada');
  assert.equal(hblDoc.status, 'Recebido');
  assert.deepEqual(pendencias, []);
  assert.equal(st, 'Conferido');
});

test('OHBL marcado como não recebido: gera pendência e sugestão de cobrança, mesmo com a Clara citando telex', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, hblDoc, pendencias, st } = linha(motor, {
      clara: 'Telex release confirmed', estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' },
    });
    assert.equal(hbl.naoBg, '#C2333A', 'marcação "Não recebido" selecionada');
    assert.equal(hblDoc.status, 'Não recebido');
    assert.deepEqual(pendencias, ['OHBL']);
    assert.equal(st, 'Divergência');
  }
});

test('Telex Release Confirmado pelo motor: OHBL sai da conferência sem cobrança nova, mas a marcação "Não recebido" gravada continua visível', () => {
  const { hbl, pendencias, conflitos, st } = linha(confirmado, { estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' } });
  assert.deepEqual([hbl.resolved, hbl.conf, hbl.registro, hbl.registroText], [true, false, true, 'Registro: Não recebido']);
  assert.deepEqual(pendencias, []);
  assert.deepEqual(conflitos.map((c: any) => c.docLabel), ['OHBL']);
  assert.equal(st, 'Divergência', 'a divergência registrada não é dada como resolvida');
});

/* ---------------- resolução do envelope × registro humano do processo ---------------- */

test('resolução eletrônica do envelope com dois IMs: a marcação "Não recebido" e o follow-up do processo seguem visíveis, a revisar', () => {
  const op: Opcoes = {
    estado: 'Divergência',
    processos: ['IM2301', 'IM2302'],
    confPor: { IM2301: { mbl: 'recebido', hbl: 'nao_recebido' } },
    fupPor: { IM2301: { hbl: { via: 'manual', at: '2026-10-02T10:00:00.000Z' } } },
  };
  const l = Object.fromEntries(linhas(confirmado, op).map((x) => [x.codigo, x]));
  const h = l.IM2301.hbl;
  // Resolução inferida e registro humano aparecem separados, na mesma célula.
  assert.deepEqual([h.resolved, h.text, h.registro, h.registroText, h.registroNota, h.conf], [
    true, 'Telex Release Confirmado', true, 'Registro: Não recebido', 'Resolução do e-mail vale para o envelope inteiro — revisar', false,
  ]);
  assert.equal(l.IM2301.hblDoc.status, 'Telex Release Confirmado · Registro: Não recebido (Resolução do e-mail vale para o envelope inteiro — revisar)');
  // A divergência histórica continua; sem cobrança nova; o follow-up aparece.
  assert.equal(l.IM2301.st, 'Divergência');
  assert.deepEqual(l.IM2301.pendencias, []);
  assert.deepEqual(
    l.IM2301.conflitos.map((c: any) => [c.docLabel, c.fupDone, c.fupPend, typeof c.onGerarEmail, c.titulo]),
    [['OHBL', true, false, 'undefined', 'Não recebido registrado — resolução do e-mail a revisar (OHBL)']],
  );
  assert.match(l.IM2301.conflitos[0].nota, /envelope inteiro.*registro deste processo foi mantido.*cobrança fica suspensa/);
  // O outro IM, sem registro, só mostra a resolução.
  assert.deepEqual([l.IM2302.hbl.resolved, l.IM2302.hbl.registro, l.IM2302.conflitos], [true, false, []]);
  // Wave BL (resolve os dois documentos): o registro do OMBL também fica visível.
  const w = linhas({ ...sem, wave: true }, { ...op, confPor: { IM2301: { mbl: 'nao_recebido' } }, fupPor: {} })[0];
  assert.deepEqual([w.mbl.resolved, w.mbl.registroText, w.st, w.pendencias, w.conflitos.map((c: any) => c.docLabel)], [
    true, 'Registro: Não recebido', 'Divergência', [], ['OMBL'],
  ]);
});

/* ---------------- HIS-004: concluído com pendência aberta ---------------- */

test('HIS-004: concluído com "Não recebido" + follow-up mostra registro, follow-up e aviso — sem controles nem cobrança', () => {
  const op: Opcoes = {
    estado: 'Concluído',
    processos: ['IM2501', 'IM2502'],
    confPor: { IM2501: { mbl: 'recebido', hbl: 'nao_recebido' } },
    fupPor: { IM2501: { hbl: { via: 'manual', at: '2026-10-02T10:00:00.000Z' } } },
  };
  const row = montar(sem, op);
  const l = Object.fromEntries(linhas(sem, op).map((x) => [x.codigo, x]));
  const h = l.IM2501.hbl;
  assert.deepEqual([h.registro, h.registroText, h.registroNota, h.conf, h.onRecebido], [
    true, 'Registro: Não recebido', 'Divergência registrada — courier concluído', false, undefined,
  ]);
  assert.deepEqual([l.IM2501.mbl.registroText, l.IM2501.mbl.conf], ['Registro: Recebido', false]);
  assert.equal(l.IM2501.st, 'Divergência', 'a divergência registrada não é dada como resolvida');
  assert.deepEqual(l.IM2501.pendencias, [], 'sem cobrança sugerida');
  assert.deepEqual(l.IM2501.conflitos.map((c: any) => [c.titulo, c.fupDone, typeof c.onGerarEmail]), [
    ['Não recebido registrado — courier concluído (OHBL)', true, 'undefined'],
  ]);
  assert.deepEqual([row.footConcluido, row.footOk, row.footDiv, row.footWait], [true, false, false, false]);
  assert.match((Array.from(row.envelope) as any[])[0].claraNote, /concluído: os registros ficam como estão/);
  assert.deepEqual(Array.from(row.pendAbertas, (p: any) => p.texto), ['IM2501 · OHBL — Registro: Não recebido (ausência registrada)']);
  // Processo sem registro: nada conferível, sem controles.
  assert.deepEqual([l.IM2502.hbl.wait, l.IM2502.hbl.waitText, l.IM2502.hbl.conf], [true, 'Não conferido', false]);
});

test('HIS-004: concluído com conflito de resolução ou de associação também mostra o aviso', () => {
  const telex = montar(confirmado, { estado: 'Concluído', conf: { hbl: 'nao_recebido' } });
  assert.deepEqual(Array.from(telex.pendAbertas, (p: any) => p.texto), ['IM2101 · OHBL — Registro: Não recebido (resolução do e-mail a revisar)']);
  const assoc = montar(sem, { estado: 'Concluído', texto: 'IM2503 - OMBL\nIM2504 - OHBL', processos: ['IM2503', 'IM2504'], confPor: { IM2503: { hbl: 'recebido' } } });
  assert.deepEqual(Array.from(assoc.pendAbertas, (p: any) => p.texto), ['IM2503 · OHBL — Registro: Recebido (associação a revisar)']);
  assert.equal(assoc.footConcluido, true);
});

test('HIS-004: expectativa desconhecida sem registro não é ausência — concluído sem pendência não pede revisão', () => {
  const row = montar(sem, { estado: 'Concluído', texto: 'Favor confirmar.' });
  assert.deepEqual([Array.from(row.pendAbertas).length, row.footConcluido], [0, false]);
});

test('HIS-004: a tela e o backend concordam sobre o que é pendência aberta', () => {
  // Para cada registro: pendente no backend ⇔ a tela mostra "Não recebido" ou um
  // registro com aviso de conflito/resolução (fora do concluído).
  const textos = ['IM2101 - OMBL / OHBL', 'IM2101 - OMBL', 'Favor confirmar.', 'IM2101 OHBL to follow', 'IM2101 - OMBL\nIM2102 - OHBL', 'IM2101 / IM2102 - OHBL'];
  const motores = [sem, confirmado, { ...sem, wave: true }, { ...sem, importador: true }];
  const marcas = ['recebido', 'nao_recebido'];
  let casos = 0;
  for (const texto of textos)
    for (const dr of motores)
      for (const m of marcas)
        for (const n of marcas) {
          const confPor = { IM2101: { mbl: m, hbl: n } };
          const op: Opcoes = { estado: 'Em Conferência', texto, processos: ['IM2101', 'IM2102'], confPor };
          const back = pendenciasAbertas(confPor, mencoesDocumentais([{ messageId: 'msg-1', texto }], ['IM2101', 'IM2102'], new Map()).mencoes, dr);
          const l = linhas(dr, op).find((x) => x.codigo === 'IM2101')!;
          for (const [doc, c, v] of [['mbl', l.mbl, m], ['hbl', l.hbl, n]] as const) {
            const tela = v === 'nao_recebido' || (c.registro && c.registroNota !== 'Sem menção no e-mail — revisar');
            const id = JSON.stringify({ texto, dr, doc, v });
            assert.equal(back.some((p) => p.documento === doc), tela, id);
            casos++;
          }
        }
  assert.equal(casos, 6 * 4 * 4 * 2);
});

test('rodapé do courier recebido só diz "Documentos disponíveis para conferência" quando há documento conferível', () => {
  const rodape = (op: Opcoes) => montar(sem, { estado: 'Recebido', ...op }).footOkText;
  assert.equal(rodape({}), 'Courier recebido. Documentos disponíveis para conferência.');
  assert.equal(rodape({ texto: 'Favor confirmar o recebimento.' }), 'Courier recebido. Nenhum documento com expectativa confirmada para conferir neste envelope.');
  assert.equal(
    rodape({ texto: 'IM2101 / IM2102 - OHBL', processos: ['IM2101', 'IM2102'] }),
    'Courier recebido. Nenhum documento com expectativa confirmada para conferir neste envelope — veja os itens a revisar.',
  );
  assert.equal(
    rodape({ texto: 'OHBL SHYY1234567 enclosed', processos: ['IM2101', 'IM2102'] }),
    'Courier recebido. Nenhum documento com expectativa confirmada para conferir neste envelope — veja os itens a revisar.',
  );
  // Finalizar continua disponível como antes: o ciclo do courier não muda.
  assert.equal(montar(sem, { estado: 'Recebido', texto: '' }).footOk, true);
});

test('referência ligada a processos demais não confirma pelo processo único — fica a revisar, com a incerteza visível', () => {
  const indice = indiceComOrigem(
    Array.from({ length: MAX_SHARED_PROCESSES + 1 }, (_, k) => ({ id: `pre-${k}`, subject: `Pre-alert IM${2331 + k}`, body: 'HBL SHGEN00000001' })),
  );
  const row = montar(sem, { estado: 'Recebido', texto: 'OHBL SHGEN00000001 enclosed', processos: ['IM2101'], indice });
  const h = cel((Array.from(row.envelope) as any[])[0].hbl);
  assert.deepEqual([h.revisar, h.revisarText, h.conf], [true, 'A revisar — processo não confirmado', false]);
  assert.deepEqual(Array.from(row.semProcesso, (s: any) => s.detalhe), [
    'Processos possíveis: IM2101 · referência ligada a muitos processos: SHGEN00000001',
  ]);
});

/* ---------------- caracterização: limitações conhecidas (fora do escopo) ---------------- */

test('caracterização (limitação conhecida, sem atribuição por IM): confirmação do motor vale para todos os processos do envelope', () => {
  // O motor resolve por envelope; atribuir a confirmação ao IM certo é outra etapa. NÃO é conformidade.
  const todos = linhas(confirmado, { processos: ['IM2101', 'IM2102'] });
  assert.deepEqual(todos.map((l) => l.hbl.resolved), [true, true]);
  const pendentes = linhas(pendente, { processos: ['IM2101', 'IM2102'], clara: 'Telex Release' });
  assert.deepEqual(pendentes.map((l) => [l.hbl.resolved, l.hbl.pend]), [[false, true], [false, true]]);
});

test('caracterização (limitação conhecida, sem atribuição por IM): envio ao importador, destino e Wave do motor valem para todos os processos do envelope', () => {
  // Detecção determinística não prova que o documento é deste processo. NÃO é conformidade.
  for (const [motor, texto] of [[{ ...sem, importador: true }, 'Enviado ao importador'], [{ ...sem, wave: true }, 'Via Wave BL'], [{ ...sem, destino: true }, 'Emitido no destino']] as const) {
    const todos = linhas(motor, { processos: ['IM2101', 'IM2102'] });
    assert.deepEqual(todos.map((l) => [l.hbl.resolved, l.hbl.text]), [[true, texto], [true, texto]], texto);
  }
});

test('vários processos no envelope: a afirmação só da IA não encerra o OHBL/OMBL de nenhum deles', () => {
  for (const clara of ['Telex release to consignee', 'Wave BL', 'Destination Release']) {
    const ia = linhas(sem, { processos: ['IM2101', 'IM2102'], clara });
    assert.deepEqual(ia.map((l) => [l.hbl.resolved, l.mbl.resolved]), [[false, false], [false, false]], clara);
  }
});

/* ---------------- IA sem autoridade: importador, destino e Wave BL (conformidade) ---------------- */

/** Afirmações que só a IA (hblResolution da Clara) faz sobre destinatário, destino ou Wave. */
const SO_DA_IA = [
  'Telex release to consignee', 'Original HBL sent to consignee', 'HBL sent to client', 'OHBL enviado ao cliente',
  'Enviado ao importador', 'Sent to importer', 'Wave BL', 'Via Wave BL', 'Destination Release', 'Emitido no destino',
  'BL issued at destination', 'Wave BL — emitido no destino, enviado ao cliente',
];
const RESOLVIDOS = ['Telex Release Confirmado', 'Enviado ao importador', 'Emitido no destino', 'Via Wave BL'];

test('aceite: "Telex release to consignee" só da Clara não contorna a proteção do telex pela regra do destinatário', () => {
  const s = linha(sem, { clara: 'Telex release to consignee' });
  assert.deepEqual([s.hbl.resolved, s.hbl.wait, s.hbl.waitText, s.hbl.pend], [false, true, 'Aguardando courier', false]);
  assert.equal(s.hblDoc.status, 'Aguardando courier');
  const p = linha(pendente, { clara: 'Telex release to consignee' });
  assert.deepEqual([p.hbl.resolved, p.hbl.pend, p.hbl.pendText], [false, true, PEND]);
  assert.equal(p.hblDoc.status, PEND);
  // Recebido o envelope, o OHBL segue conferível.
  const r = linha(sem, { clara: 'Telex release to consignee', estado: 'Recebido' });
  assert.deepEqual([r.hbl.resolved, r.hbl.conf], [false, true]);
});

test('aceite: afirmação só da IA sobre destinatário, destino ou Wave não resolve OHBL nem OMBL', () => {
  for (const motor of [sem, pendente]) {
    for (const estado of ['Identificado', 'Recebido', 'Em Conferência', 'Divergência']) {
      for (const clara of SO_DA_IA) {
        const l = linha(motor, { clara, estado });
        const id = `${clara} | ${estado} | pendente=${motor.telexPendente}`;
        assert.deepEqual([l.hbl.resolved, l.mbl.resolved, l.hbl.desconhecido, l.mbl.desconhecido], [false, false, false, false], id);
        assert.ok(!RESOLVIDOS.includes(l.hblDoc.status) && !RESOLVIDOS.includes(l.mblDoc.status), id);
      }
    }
  }
});

test('aceite: regras determinísticas preservadas — mesma precedência e mesmos documentos, com ou sem string da Clara', () => {
  // Referência: as regras do motor como eram (telex > importador > destino > Wave no
  // OHBL; Wave > destino no OMBL; importador nunca resolve o OMBL).
  const ref = (dr: Record<string, boolean>) => ({
    hbl: dr.telex ? 'Telex Release Confirmado' : dr.importador ? 'Enviado ao importador' : dr.destino ? 'Emitido no destino' : dr.wave ? 'Via Wave BL' : '',
    mbl: dr.wave ? 'Via Wave BL' : dr.destino ? 'Emitido no destino' : '',
  });
  let casos = 0;
  for (const telex of ['nenhum', 'confirmado', 'pendente'])
    for (const wave of [false, true])
      for (const destino of [false, true])
        for (const importador of [false, true]) {
          const dr = { telex: telex === 'confirmado', telexPendente: telex === 'pendente', wave, destino, importador };
          const r = ref(dr);
          for (const clara of [undefined, 'Telex release confirmed', ...SO_DA_IA]) {
            const { hbl, mbl, hblDoc, mblDoc } = linha(dr, clara === undefined ? {} : { clara });
            const id = `${JSON.stringify(dr)} | ${clara}`;
            assert.deepEqual([hbl.resolved, hbl.text, mbl.resolved, mbl.text], [!!r.hbl, r.hbl, !!r.mbl, r.mbl], id);
            assert.equal(hbl.pend, !r.hbl && telex === 'pendente', id);
            if (r.hbl) assert.equal(hblDoc.status, r.hbl, id);
            if (r.mbl) assert.equal(mblDoc.status, r.mbl, id);
            casos++;
          }
        }
  assert.equal(casos, 24 * 14);
});

test('aceite: conferência física intacta — com a Clara citando destinatário/destino/Wave, as marcações valem', () => {
  const clara = 'Wave BL — emitido no destino, enviado ao cliente';
  const nao = linha(sem, { clara, estado: 'Divergência', conf: { mbl: 'nao_recebido', hbl: 'nao_recebido' } });
  assert.deepEqual([nao.mblDoc.status, nao.hblDoc.status], ['Não recebido', 'Não recebido']);
  assert.deepEqual(nao.pendencias, ['OMBL', 'OHBL']);
  assert.equal(nao.st, 'Divergência');
  const ok = linha(sem, { clara, estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' } });
  assert.deepEqual([ok.mblDoc.status, ok.hblDoc.status, ok.st], ['Recebido', 'Recebido', 'Conferido']);
  assert.deepEqual(ok.pendencias, []);
});

test('aceite: resolução determinística segue tirando da conferência só o documento da regra', () => {
  const conf = { mbl: 'nao_recebido', hbl: 'nao_recebido' };
  // Envio ao importador encerra o OHBL; o OMBL continua conferível e cobrável.
  const imp = linha({ ...sem, importador: true }, { estado: 'Divergência', conf });
  assert.deepEqual([imp.hbl.resolved, imp.mbl.conf, imp.pendencias, imp.st], [true, true, ['OMBL'], 'Divergência']);
  // Wave BL e emissão no destino encerram os dois.
  for (const motor of [{ ...sem, wave: true }, { ...sem, destino: true }]) {
    const l = linha(motor, { estado: 'Divergência', conf });
    assert.deepEqual([l.hbl.resolved, l.mbl.resolved, l.pendencias], [true, true, []]);
  }
});

/* ---------------- expandir/recarregar a análise não muda a resolução documental ---------------- */

/** Respostas de /analysis sintéticas: string da Clara + mapa por processo (processosDetalhe). */
const ANALISES: Array<Record<string, unknown>> = [
  { hblResolution: 'Telex release to consignee', processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: false }], processNumbers: ['IM2101'] },
  {
    hblResolution: 'Wave BL',
    processosDetalhe: [{ codigo: 'IM2101', mbl: false, hbl: true }, { codigo: 'IM2102', mbl: true, hbl: false }],
    processNumbers: [],
  },
  { hblResolution: 'Destination Release', processosDetalhe: [{ codigo: 'IM2101', mbl: false, hbl: false }], processNumbers: ['IM2101-26'] },
  // processNumbers só com processos que já estão na lista (as linhas novas são o achado caracterizado abaixo).
  { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: true }, { codigo: 'IM2102', mbl: true, hbl: true }], processNumbers: ['IM2101'] },
  {
    hblResolution: 'Original HBL sent to consignee',
    processosDetalhe: [],
    processNumbers: [],
    expectativa: { documentos: [], observacoes: ['Clara identificou menção a envio do OHBL ao cliente.'], revisao: [] },
    evidences: [{ conclusion: 'OHBL enviado ao cliente', snippet: 'sintético' }],
    resumo: ['Resumo sintético.'],
    confidence: 0.95,
  },
];

test('aceite: expandir ou recarregar a análise não muda, sozinho, a resolução, a associação nem a expectativa', () => {
  // Corpos do e-mail do courier: padrão (os dois por processo), só OMBL, cruzado,
  // sem IM, sem menção, "to follow" e linha com dois IMs.
  const textos = [
    undefined,
    'IM2101 - OMBL',
    'IM2101 - OHBL\nIM2102 - OMBL',
    'OMBL e OHBL',
    '',
    'IM2101 OHBL to follow\nIM2101 - OMBL',
    'IM2101 / IM2102 - OHBL',
  ];
  const motores = [sem, pendente, confirmado, { ...sem, importador: true }, { ...sem, wave: true }, { ...sem, destino: true }];
  const cenarios: Opcoes[] = [
    { estado: 'Identificado' },
    { estado: 'Recebido' },
    { estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' } },
    { estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' } },
  ];
  let casos = 0;
  for (const texto of textos)
    for (const motor of motores)
      for (const cen of cenarios)
        for (const processos of [['IM2101'], ['IM2101', 'IM2102']]) {
          const base = { ...cen, texto, processos };
          const recolhido = projecao(motor, base);
          for (const analise of ANALISES)
            for (const expandido of [true, false]) {
              const id = JSON.stringify({ texto, motor, cen, processos, analise: analise.hblResolution, expandido });
              assert.deepEqual(projecao(motor, { ...base, analise, expandido }), recolhido, id);
              casos++;
            }
        }
  assert.equal(casos, textos.length * 6 * 4 * 2 * ANALISES.length * 2);
});

test('aceite: o mapa por processo da análise não cria nem remove expectativa física', () => {
  // Antes, depois de expandir, processosDetalhe tornava o OHBL "Não esperado" num
  // processo (ou passava a esperá-lo onde o e-mail do courier não o citava).
  const remover = linhas(sem, {
    estado: 'Recebido',
    analise: { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: false }], processNumbers: [] },
    expandido: true,
  })[0];
  assert.deepEqual([remover.hbl.conf, remover.hblDoc.status], [true, 'Não recebido']);
  const criar = linhas(sem, {
    estado: 'Recebido',
    texto: 'IM2101 - OMBL',
    analise: { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: true }], processNumbers: [] },
    expandido: true,
  })[0];
  assert.deepEqual([criar.hbl.desconhecido, criar.hbl.conf, criar.hblDoc.status], [true, false, 'Não informado']);
});

test('aceite: IM sugerido só pela IA não vira processo do courier nem expectativa — fica como sugestão não confirmada', () => {
  const op: Opcoes = { estado: 'Recebido' };
  const antes = montar(sem, op);
  const depois = montar(sem, {
    ...op,
    analise: { hblResolution: null, processosDetalhe: [], processNumbers: ['IM2101-26', 'IM9999', 'IM2210'], processosNaConversa: ['IM2101', 'IM2210'] },
    expandido: true,
  });
  assert.deepEqual(Array.from(depois.envelope, (e: any) => e.codigo), ['IM2101']);
  assert.deepEqual([depois.procLabel, Array.from(depois.chips, (c: any) => c.codigo)], [antes.procLabel, ['IM2101']]);
  // O IM na conversa também é só sugestão: aparecer no texto não prova que é deste courier.
  assert.deepEqual(Array.from(depois.sugestoes, (s: any) => [s.codigo, s.origem]), [['IM9999', 'só a Clara'], ['IM2210', 'citado na conversa']]);
  assert.equal(antes.hasSugestoes, false);
});

/* ---------------- associação documento → processo (decisões de 25/10) ---------------- */

const envelope = (texto: string, processos: string[], op: Opcoes = {}) => linhas(sem, { estado: 'Recebido', ...op, texto, processos });
/** Envelope de um processo só (IM2101): a linha dele. */
const unico = (texto: string, op: Opcoes = {}) => envelope(texto, ['IM2101'], op)[0];
const porCodigo = (ls: ReturnType<typeof linhas>) => Object.fromEntries(ls.map((l) => [l.codigo, l]));

test('aceite: IM2204 com OMBL e IM2205 com OHBL — sem atribuição cruzada', () => {
  const l = porCodigo(envelope('IM2204 - OMBL\nIM2205 - OHBL', ['IM2204', 'IM2205']));
  assert.deepEqual([l.IM2204.mbl.conf, l.IM2204.hbl.conf, l.IM2204.hbl.desconhecido], [true, false, true]);
  assert.deepEqual([l.IM2205.hbl.conf, l.IM2205.mbl.conf, l.IM2205.mbl.desconhecido], [true, false, true]);
  assert.deepEqual([l.IM2204.hblDoc.status, l.IM2205.mblDoc.status], ['Não informado', 'Não informado']);
  // Sem expectativa, sem controle: a marcação não pode criar a associação.
  assert.equal(l.IM2204.hbl.onRecebido, undefined);
  assert.equal(l.IM2205.mbl.onNao, undefined);
});

test('aceite: documento associado a outro processo não vira "não esperado"; dois documentos do mesmo tipo valem', () => {
  const um = porCodigo(envelope('IM2205 - OHBL', ['IM2204', 'IM2205']));
  assert.equal(um.IM2204.hblDoc.status, 'Não informado');
  assert.ok(!JSON.stringify(montar(sem, { estado: 'Recebido', texto: 'IM2205 - OHBL', processos: ['IM2204', 'IM2205'] }).envelope).includes('Não esperado'));
  const dois = porCodigo(envelope('IM2204 - OHBL\nIM2205 - OHBL', ['IM2204', 'IM2205']));
  assert.deepEqual([dois.IM2204.hbl.conf, dois.IM2205.hbl.conf], [true, true]);
});

test('aceite: documento com IM desconhecido fica sem processo, listado uma vez, sem associação inventada', () => {
  const row = montar(sem, { estado: 'Recebido', texto: 'OHBL SHYY1234567 enclosed', processos: ['IM2204', 'IM2205'] });
  for (const e of Array.from(row.envelope) as any[]) {
    const h = cel(e.hbl);
    assert.deepEqual([h.conf, h.revisar, h.desconhecido], [false, false, true], e.codigo);
  }
  const sp = Array.from(row.semProcesso || [], (s: any) => [s.tipo, s.ref, s.detalhe]);
  assert.deepEqual(sp, [['OHBL', 'SHYY1234567', 'Nenhum processo identificado']]);
});

test('aceite: envio negado, "to follow" e liberação eletrônica não provam que o documento está no envelope', () => {
  for (const texto of ['IM2101 OHBL not sent', 'IM2101 OHBL to follow', 'OHBL will follow by next courier', 'No original OHBL in this envelope', 'OHBL telex released', 'OHBL copy attached']) {
    const { hbl, hblDoc, pendencias } = unico(texto);
    assert.deepEqual([hbl.revisar, hbl.conf, hbl.desconhecido], [true, false, false], texto);
    assert.equal(hblDoc.status, 'A revisar — presença não comprovada', texto);
    assert.deepEqual(pendencias, [], texto);
  }
  // Não comprovado não vira "não esperado" nem cancela expectativa sustentada por outra menção.
  for (const texto of ['IM2101 - OHBL\nIM2101 OHBL to follow', 'OHBL enclosed. OHBL not sent to consignee', 'IM2101 - OMBL / OHBL\nTelex release requested for OHBL']) {
    assert.equal(unico(texto).hbl.conf, true, texto);
  }
  const misto = unico('OMBL enclosed, OHBL to follow');
  assert.deepEqual([misto.mbl.conf, misto.hbl.revisar], [true, true]);
});

test('aceite: sem menção a documento, a expectativa é desconhecida — nada de OMBL e OHBL fabricados', () => {
  const { mbl, hbl, st, pendencias } = unico('');
  assert.deepEqual([mbl.desconhecido, hbl.desconhecido, mbl.conf, hbl.conf], [true, true, false, false]);
  assert.equal(st, 'Recebido');
  assert.deepEqual(pendencias, []);
});

test('aceite: processo único não vence IM ou BL em conflito — fica a revisar, sem controles', () => {
  const row = montar(sem, { estado: 'Recebido', texto: 'IM2299 - OHBL', processos: ['IM2101'] });
  const e = (Array.from(row.envelope) as any[])[0];
  assert.deepEqual([e.hbl.revisar, e.hbl.revisarText, e.hbl.conf], [true, 'A revisar — processo não confirmado', false]);
  assert.deepEqual(Array.from(row.semProcesso, (s: any) => s.detalhe), ['Processos possíveis: IM2101 · citado fora do envelope: IM2299']);
});

test('decisão 1 (A): associação não confirmada aparece "A revisar" sem Recebido/Não recebido', () => {
  const l = porCodigo(envelope('IM2101 / IM2102 - OHBL', ['IM2101', 'IM2102']));
  for (const p of ['IM2101', 'IM2102']) {
    assert.deepEqual([l[p].hbl.revisar, l[p].hbl.conf, l[p].hbl.onRecebido, l[p].hbl.onNao], [true, false, undefined, undefined], p);
    assert.equal(l[p].hblDoc.status, 'A revisar — processo não confirmado');
  }
});

test('decisão 2 (B): marcação e follow-up já gravados ficam visíveis como conflito, sem nova cobrança e sem resolver', () => {
  // OHBL do IM2204 marcado "Não recebido" (com follow-up) quando o OHBL valia para os dois processos.
  const op: Opcoes = {
    estado: 'Divergência',
    confPor: { IM2204: { mbl: 'recebido', hbl: 'nao_recebido' }, IM2205: { hbl: 'recebido' } },
    fupPor: { IM2204: { hbl: { via: 'manual', at: '2026-10-02T10:00:00.000Z' } } },
  };
  const l = porCodigo(envelope('IM2204 - OMBL\nIM2205 - OHBL', ['IM2204', 'IM2205'], op));
  const h = l.IM2204.hbl;
  assert.deepEqual([h.registro, h.registroText, h.registroNota, h.conf], [true, 'Registro: Não recebido', 'Conflito de associação — revisar', false]);
  assert.equal(l.IM2204.hblDoc.status, 'Registro: Não recebido (Conflito de associação — revisar)');
  // A divergência continua visível; a cobrança automática fica suspensa; o follow-up aparece.
  assert.equal(l.IM2204.st, 'Divergência');
  assert.deepEqual(l.IM2204.pendencias, []);
  assert.deepEqual(l.IM2204.conflitos.map((c: any) => [c.docLabel, c.fupDone, c.fupPend, typeof c.onGerarEmail]), [['OHBL', true, false, 'undefined']]);
  assert.equal(l.IM2205.st, 'Conferido');
  // Registro "Recebido" sem menção no e-mail: também preservado, a revisar.
  const semMencao = unico('', { estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' } });
  assert.deepEqual([semMencao.mbl.registroText, semMencao.mbl.registroNota, semMencao.st], ['Registro: Recebido', 'Sem menção no e-mail — revisar', 'Conferido']);
});
