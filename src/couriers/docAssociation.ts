/**
 * Priora — Módulo Courier
 * ASS-010 (entrega parcial): evidência documental POR PROCESSO no e-mail do courier.
 *
 * Separa três coisas que não podem se confundir:
 *  - CONTEÚDO FÍSICO: a menção a OMBL/OHBL afirma que o documento vem NESTE
 *    envelope ("afirmado") ou não comprova isso ("nao-comprovado": negada, a
 *    seguir/pendente, liberação eletrônica, emissão no destino, cópia/anexo).
 *    Não comprovado NÃO quer dizer "não esperado";
 *  - ASSOCIAÇÃO: a qual processo do envelope a menção pertence, e com que
 *    segurança. "confirmada" só com IM único na mesma linha, referência de BL que
 *    aponta para um único processo em OUTRO e-mail, ou envelope de processo único
 *    sem referência em conflito nem referência compartilhada por processos demais.
 *    O resto fica "ambigua" (com candidatos) ou "sem-processo" — nunca é
 *    replicado para todos os IMs;
 *  - CONFERÊNCIA FÍSICA: são os registros do operador (courierStore). Nada aqui
 *    lê, muda ou apaga esses registros.
 *
 * Determinístico: sem rede, sem IA. Detecção determinística não prova que a fonte
 * é confiável nem que a atribuição está certa — só o que o texto diz.
 */
import { leituraDeMencao } from './docResolution';
import { associate, MAX_SHARED_PROCESSES, RefType, tokenize } from './referenceResolver';

export type TipoDocumento = 'OMBL' | 'OHBL';
export type MotivoNaoComprovado =
  | 'negado'
  | 'a-seguir-ou-pendente'
  | 'liberacao-eletronica'
  | 'emissao-no-destino'
  | 'copia-ou-anexo';

export interface MencaoDocumental {
  /** Estável enquanto a mensagem existir: `${messageId}#L${linha}:${tipo}:${ordem}`. */
  id: string;
  tipo: TipoDocumento;
  /** Origem: mensagem do Graph, linha (0-based) do corpo e o código de BL da linha. */
  fonte: { messageId: string; linha: number; ref: string | null };
  conteudo: { situacao: 'afirmado' | 'nao-comprovado'; motivo: MotivoNaoComprovado | null };
  associacao: {
    situacao: 'confirmada' | 'ambigua' | 'sem-processo';
    /** Só quando confirmada: o processo do envelope (como aparece na lista). */
    processo: string | null;
    via: 'linha' | 'referencia' | 'processo-unico' | null;
    /** Processos DO envelope implicados quando a associação não é segura. */
    candidatos: string[];
    /** Processos citados na linha (IM ou referência) que NÃO estão no envelope. */
    externos: string[];
    /**
     * Referências da linha ligadas a mais de MAX_SHARED_PROCESSES processos. Não
     * apontam processo nenhum, mas são incerteza: impedem confirmar a associação.
     */
    referenciasCompartilhadas: string[];
  };
}

export interface DocsEnvelope {
  mencoes: MencaoDocumental[];
}

/** Texto de UMA mensagem do courier (corpo + e-mails anexados), com o id do Graph. */
export interface FonteDocumental {
  messageId: string;
  texto: string;
}

/* ------------------------------------------------------------------ *
 * Índice de referências COM ORIGEM (para excluir o próprio courier)
 * ------------------------------------------------------------------ */

/**
 * Mesmo índice de buildRefIndex (referência → processos, por proximidade de linha
 * em cada e-mail que cita IM), guardando de qual mensagem veio cada ligação. Assim
 * a associação por referência usa só OUTROS e-mails: a proximidade de linha dentro
 * do próprio e-mail do courier não vira prova de qual IM é o documento.
 */
export type IndiceComOrigem = Map<string, { tipos: Map<RefType, Set<string>>; processos: Map<string, Set<string>> }>;

export function indiceComOrigem(msgs: Array<{ id: string; subject: string; body: string }>): IndiceComOrigem {
  const indice: IndiceComOrigem = new Map();
  for (const m of msgs) {
    const tok = tokenize(m.subject, m.body);
    if (tok.processes.length === 0) continue;
    for (const { ref, processes } of associate(tok)) {
      if (ref.type === 'CONTAINER') continue;
      let e = indice.get(ref.normalized);
      if (!e) indice.set(ref.normalized, (e = { tipos: new Map(), processos: new Map() }));
      (e.tipos.get(ref.type) || e.tipos.set(ref.type, new Set()).get(ref.type)!).add(m.id);
      for (const p of processes) (e.processos.get(p) || e.processos.set(p, new Set()).get(p)!).add(m.id);
    }
  }
  return indice;
}

/** Processos de uma referência, ignorando as ligações que vieram só de `excluir`. */
function processosDaReferencia(
  indice: IndiceComOrigem,
  normalized: string,
  excluir: Set<string>,
): { processos: string[]; booking: boolean } {
  const e = indice.get(normalized);
  if (!e) return { processos: [], booking: false };
  const valida = (ids: Set<string>) => Array.from(ids).some((id) => !excluir.has(id));
  const processos = Array.from(e.processos.entries()).filter(([, ids]) => valida(ids)).map(([p]) => p);
  const tipos = Array.from(e.tipos.entries()).filter(([, ids]) => valida(ids)).map(([t]) => t);
  // Mesmo critério de resolveRefs: rótulo HBL/MBL vence; Booking nunca é automático.
  const booking = tipos.includes('BOOKING') && !tipos.includes('HBL') && !tipos.includes('MBL');
  return { processos, booking };
}

/* ------------------------------------------------------------------ *
 * Conteúdo físico de cada menção
 * ------------------------------------------------------------------ */

const RE_MENCAO = /\b(O?MBL|MASTER\s*B\/?L)\b|\b(O?HBL|HOUSE\s*B\/?L)\b/gi;
const RE_IM = /\bIM\s*[-:]?\s*(\d{3,6})(?:-\d{2})?\b/gi;

/** Palavra/expressão inteira (vale para letras acentuadas, onde \b falha). */
const termos = (fonte: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${fonte})(?![\\p{L}\\p{N}])`, 'iu');

/** Liberação sem o original físico: telex, surrender, express/sea waybill, Wave, e-BL. */
const RE_LIBERACAO = termos('telex|surrender(?:ed)?|express\\s+(?:release|b/?l)|sea\\s*-?\\s*way\\s*-?\\s*bill|seawaybill|wave|e-?b/?l');
/** Mesmo padrão de emissão no destino do motor documental. */
const RE_DESTINO = /destination\s+issuance|(?:emitid[oa]s?|issued)[^.\n]{0,30}(?:destino|destination)/i;
/** Cópia, rascunho ou anexo do e-mail não é o original dentro do envelope. */
const RE_COPIA = termos('cop(?:y|ies)|c[óo]pias?|draft|rascunhos?|scan(?:ned)?|digitalizad[oa]s?|pdf|attached|attachments?|anexos?|anexad[oa]s?');
/** "A seguir"/depois: o documento ainda não está neste envelope. ("a seguir" = "abaixo" fica de fora.) */
const RE_A_SEGUIR = termos(
  'to\\s+follow|will\\s+follow|follow(?:s|ing)?\\s+(?:later|separately|soon)|separately|later|separadamente|' +
    'posteriormente|seguir(?:á|a|ão|ao)|em\\s+breve|pr[óo]ximo\\s+(?:courier|envio|malote)|next\\s+(?:courier|shipment|dispatch)',
);

function conteudoDaMencao(linha: string, inicio: number, fim: number): MencaoDocumental['conteudo'] {
  const { negada, pendente, oracao } = leituraDeMencao(linha, inicio, fim);
  const motivo: MotivoNaoComprovado | null = negada
    ? 'negado'
    : RE_LIBERACAO.test(oracao)
      ? 'liberacao-eletronica'
      : RE_DESTINO.test(oracao)
        ? 'emissao-no-destino'
        : RE_COPIA.test(oracao)
          ? 'copia-ou-anexo'
          : pendente || RE_A_SEGUIR.test(oracao)
            ? 'a-seguir-ou-pendente'
            : null;
  return { situacao: motivo ? 'nao-comprovado' : 'afirmado', motivo };
}

/* ------------------------------------------------------------------ *
 * Associação documento → processo
 * ------------------------------------------------------------------ */

/** Base do processo: "IM2204-26" e "IM 2204" → "IM2204". */
const baseDe = (p: string) => p.toUpperCase().replace(/\s+/g, '').replace(/^IM[-:]?/, 'IM').replace(/-\d{2}$/, '');

export function mencoesDocumentais(
  fontes: FonteDocumental[],
  processos: string[],
  indice: IndiceComOrigem,
): DocsEnvelope {
  // Base → código como a lista mostra (o front casa a linha do envelope por ele).
  const envelope = new Map<string, string>();
  for (const p of processos) if (!envelope.has(baseDe(p))) envelope.set(baseDe(p), p.toUpperCase());
  const proprios = new Set(fontes.map((f) => f.messageId));
  const mencoes: MencaoDocumental[] = [];

  for (const fonte of fontes) {
    (fonte.texto || '').split(/\r?\n/).forEach((linha, i) => {
      const ocorrencias = Array.from(linha.matchAll(RE_MENCAO));
      if (ocorrencias.length === 0) return;

      // Evidência de processo NA LINHA: IMs escritos e referências de BL que, em
      // outros e-mails, apontam para processos.
      const evidencia = new Set<string>();
      for (const m of linha.matchAll(RE_IM)) evidencia.add(`IM${m[1]}`);
      const imNaLinha = evidencia.size > 0;
      const refs = tokenize('', linha).refs.filter((r) => r.type !== 'CONTAINER');
      let refInsegura = false;
      const compartilhadas: string[] = [];
      for (const r of refs) {
        const q = processosDaReferencia(indice, r.normalized, proprios);
        if (q.processos.length === 0) continue;
        // Ligada a processos demais (código genérico ou consolidação grande): não
        // aponta processo nenhum, mas também não é "sem evidência" — é incerteza.
        if (q.processos.length > MAX_SHARED_PROCESSES) {
          compartilhadas.push(r.raw);
          continue;
        }
        q.processos.forEach((p) => evidencia.add(baseDe(p)));
        if (q.booking || q.processos.length > 1) refInsegura = true;
      }
      const incerta = refInsegura || compartilhadas.length > 0;

      const noEnvelope = Array.from(evidencia).filter((b) => envelope.has(b)).map((b) => envelope.get(b)!);
      const externos = Array.from(evidencia).filter((b) => !envelope.has(b));
      const sem = { candidatos: [] as string[], externos: [] as string[], referenciasCompartilhadas: [] as string[] };
      let associacao: MencaoDocumental['associacao'];
      if (evidencia.size === 0 && !incerta) {
        associacao =
          envelope.size === 1
            ? { situacao: 'confirmada', processo: Array.from(envelope.values())[0], via: 'processo-unico', ...sem }
            : { situacao: 'sem-processo', processo: null, via: null, ...sem };
      } else if (evidencia.size === 1 && externos.length === 0 && !incerta) {
        associacao = { situacao: 'confirmada', processo: noEnvelope[0], via: imNaLinha ? 'linha' : 'referencia', ...sem };
      } else {
        // Vários IMs, IM/referência fora do envelope, referência 1:N ou referência
        // compartilhada por processos demais: fica para revisão. Num envelope de
        // processo único, ele segue como candidato — a referência em conflito não
        // vence nem é vencida pelo "processo único".
        const candidatos = envelope.size === 1 ? Array.from(new Set([...noEnvelope, ...envelope.values()])) : noEnvelope;
        associacao = { situacao: 'ambigua', processo: null, via: null, candidatos, externos, referenciasCompartilhadas: compartilhadas };
      }

      const ordem: Record<string, number> = {};
      for (const oc of ocorrencias) {
        const tipo: TipoDocumento = oc[1] ? 'OMBL' : 'OHBL';
        const n = (ordem[tipo] = (ordem[tipo] ?? -1) + 1);
        const inicio = oc.index ?? 0;
        const refDoTipo = refs.find((r) => r.type === (tipo === 'OMBL' ? 'MBL' : 'HBL')) || refs[0];
        mencoes.push({
          id: `${fonte.messageId}#L${i}:${tipo}:${n}`,
          tipo,
          fonte: { messageId: fonte.messageId, linha: i, ref: refDoTipo ? refDoTipo.raw : null },
          conteudo: conteudoDaMencao(linha, inicio, inicio + oc[0].length),
          associacao: {
            ...associacao,
            candidatos: [...associacao.candidatos],
            externos: [...associacao.externos],
            referenciasCompartilhadas: [...associacao.referenciasCompartilhadas],
          },
        });
      }
    });
  }
  return { mencoes };
}
