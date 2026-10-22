import { Db } from '../../identidade';
import { LeitorDeEvidenciaOcr } from '../ocr/evidenciaOcr';
import { EvidenciaConferida, MotivoDeRecusaDaEvidencia, PedidoDeEvidencia, assinaturaDoPedido, conferirEvidencia } from '../ocr/identidadeDaEvidencia';
import { leiturasDoMblDoMaster } from './camposDoMbl';

/**
 * Leituras documentais (evidências de OCR JÁ existentes) dos arquivos do MBL de UM Master. Só leitura; nenhum OCR,
 * nenhuma IA, nenhuma interpretação, nenhuma escolha:
 *  - os documentos do Master são os do contrato E1 (`leiturasDoMblDoMaster`, critério já aprovado: MBL legível que
 *    sustenta um vínculo válido e publicado com ESTE Master, na própria organização);
 *  - o ARQUIVO é o `arquivo_sha256` (bytes): nomes iguais ou parecidos nunca juntam arquivos, e arquivos diferentes
 *    do mesmo Master ficam todos, lado a lado (nenhum vence por ordem de chegada);
 *  - a evidência só é pedida por assinatura exata, derivada da linha da própria organização (extração + caixa dela):
 *    nada é listado, nada de outra organização ou caixa é pedido;
 *  - cada captura (`capturaVersao`) é uma leitura própria; nenhuma substitui outra. Como não há listagem, as capturas
 *    1..MAX_CAPTURAS_SONDADAS são pedidas por chave; se a última existir, pode haver mais, e nada se conclui;
 *  - armazenamento sem resposta = INDISPONIVEL (nunca "sem evidência"); evidência que não confere = RECUSADA.
 */

export const MAX_CAPTURAS_SONDADAS = 5;

/** Onde o arquivo apareceu: cada extração da própria organização, com os processos que ela vincula ao Master. */
export interface OrigemDoArquivo {
  extracaoId: string;
  caixaId: string;
  messageId: string;
  attachmentId: string;
  recebidaEm: Date | null;
  processoIds: string[];
}

export interface LeituraDocumental {
  evidencia: EvidenciaConferida;
  /** Extrações cuja origem (mensagem + anexo) levou a esta evidência. */
  extracaoIds: string[];
}

export type SituacaoDoArquivo =
  /** Ao menos uma captura conferida, todas as consultas responderam e o limite de capturas não foi atingido. */
  | { tipo: 'COM_LEITURAS'; leituras: LeituraDocumental[] }
  /** O armazenamento respondeu "não há" para todas as capturas: este arquivo não tem leitura OCR. */
  | { tipo: 'SEM_EVIDENCIA' }
  /** Alguma consulta não foi respondida: o conjunto de capturas é desconhecido. */
  | { tipo: 'INDISPONIVEL' }
  /** A última captura consultada existe: pode haver capturas mais novas que não foram vistas. */
  | { tipo: 'CAPTURAS_ALEM_DO_LIMITE' }
  /** Alguma evidência devolvida não conferiu a identidade: o arquivo não é usado. */
  | { tipo: 'EVIDENCIA_RECUSADA'; motivos: MotivoDeRecusaDaEvidencia[] }
  /** A extração não tem o hash dos bytes (anterior à 0106): sem arquivo identificado, nada é pedido. */
  | { tipo: 'SEM_IDENTIDADE_DE_ARQUIVO' };

export interface ArquivoDoMaster {
  arquivoSha256: string | null;
  origens: OrigemDoArquivo[];
  situacao: SituacaoDoArquivo;
}

export interface LeiturasDocumentaisDoMaster {
  masterId: string;
  /** Um item por arquivo (hash dos bytes), em ordem determinística (não a de chegada). */
  arquivos: ArquivoDoMaster[];
}

const porTexto = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function leiturasDocumentaisDoMaster(
  db: Db, organizationId: string, masterId: string, leitor: LeitorDeEvidenciaOcr,
): Promise<LeiturasDocumentaisDoMaster> {
  const mbls = await leiturasDoMblDoMaster(db, organizationId, masterId);
  if (!mbls.length) return { masterId, arquivos: [] };
  // A caixa (e o escopo) vêm da PRÓPRIA linha da extração, na mesma organização (FK caixa_id + organization_id).
  const { rows } = await db.query(
    `SELECT e.id, e.caixa_id, c.home_account_id
       FROM auditoria_extracoes e
       JOIN email_caixas c ON c.id = e.caixa_id AND c.organization_id = e.organization_id
      WHERE e.organization_id = $1 AND e.id = ANY($2::uuid[])`,
    [organizationId, mbls.map((l) => l.extracaoId)],
  );
  const caixaDe = new Map<string, { caixaId: string; escopo: string }>(rows.map((r) => [r.id, { caixaId: r.caixa_id, escopo: r.home_account_id }]));

  const grupos = new Map<string, Array<{ origem: OrigemDoArquivo; escopo: string }>>();
  const semHash: ArquivoDoMaster[] = [];
  for (const l of mbls) {
    const caixa = caixaDe.get(l.extracaoId);
    if (!caixa) throw new Error('extração do Master sem caixa na própria organização');
    const origem: OrigemDoArquivo = {
      extracaoId: l.extracaoId, caixaId: caixa.caixaId, messageId: l.origem.messageId, attachmentId: l.origem.attachmentId,
      recebidaEm: l.origem.recebidaEm, processoIds: [...l.processoIds].sort(porTexto),
    };
    const hash = l.origem.arquivoSha256;
    if (!hash) {
      semHash.push({ arquivoSha256: null, origens: [origem], situacao: { tipo: 'SEM_IDENTIDADE_DE_ARQUIVO' } });
      continue;
    }
    grupos.set(hash, [...(grupos.get(hash) ?? []), { origem, escopo: caixa.escopo }]);
  }

  const arquivos: ArquivoDoMaster[] = [];
  for (const [hash, membros] of grupos) {
    // Uma consulta por origem distinta (conta da caixa + mensagem + anexo) e por captura.
    const origensDistintas = new Map<string, { escopo: string; messageId: string; attachmentId: string; extracaoIds: string[] }>();
    for (const { origem, escopo } of membros) {
      const k = JSON.stringify([escopo, origem.messageId, origem.attachmentId]);
      const o = origensDistintas.get(k) ?? { escopo, messageId: origem.messageId, attachmentId: origem.attachmentId, extracaoIds: [] };
      o.extracaoIds.push(origem.extracaoId);
      origensDistintas.set(k, o);
    }
    const leituras: LeituraDocumental[] = [];
    const motivos = new Set<MotivoDeRecusaDaEvidencia>();
    let indisponivel = false;
    let alemDoLimite = false;
    for (const o of origensDistintas.values()) {
      for (let capturaVersao = 1; capturaVersao <= MAX_CAPTURAS_SONDADAS; capturaVersao++) {
        const pedido: PedidoDeEvidencia = {
          organizationId, escopo: o.escopo, messageId: o.messageId, attachmentId: o.attachmentId, contentHash: hash, capturaVersao,
        };
        const r = await leitor.porAssinatura(assinaturaDoPedido(pedido));
        if (r.tipo === 'INDISPONIVEL') { indisponivel = true; continue; }
        if (r.tipo === 'AUSENTE') continue;
        if (capturaVersao === MAX_CAPTURAS_SONDADAS) alemDoLimite = true;
        const c = conferirEvidencia(pedido, r.bruto);
        if (c.tipo === 'RECUSADA') motivos.add(c.motivo);
        else leituras.push({ evidencia: c.evidencia, extracaoIds: [...o.extracaoIds].sort(porTexto) });
      }
    }
    const situacao: SituacaoDoArquivo = motivos.size ? { tipo: 'EVIDENCIA_RECUSADA', motivos: [...motivos].sort(porTexto) }
      : indisponivel ? { tipo: 'INDISPONIVEL' }
        : alemDoLimite ? { tipo: 'CAPTURAS_ALEM_DO_LIMITE' }
          : leituras.length ? { tipo: 'COM_LEITURAS', leituras: leituras.sort((a, b) => porTexto(a.evidencia.assinatura, b.evidencia.assinatura)) }
            : { tipo: 'SEM_EVIDENCIA' };
    arquivos.push({ arquivoSha256: hash, origens: membros.map((m) => m.origem).sort((a, b) => porTexto(a.extracaoId, b.extracaoId)), situacao });
  }
  arquivos.sort((a, b) => porTexto(a.arquivoSha256 ?? '', b.arquivoSha256 ?? ''));
  semHash.sort((a, b) => porTexto(a.origens[0].extracaoId, b.origens[0].extracaoId));
  return { masterId, arquivos: [...arquivos, ...semHash] };
}
