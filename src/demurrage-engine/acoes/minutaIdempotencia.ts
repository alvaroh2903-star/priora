import { Pool } from 'pg';
import { hashEstavel } from '../registro/contrato';
import { Minuta } from '../persistence/minutaRepository';
import { ClosingService, ResultadoEncerramentoAutomatico } from '../closing/closingService';
import { DocumentoRegistrado } from '../closing/minutaTecnica';
import { CivilDate } from '../temporal/civilDate';

/**
 * Produção P1 (Entrega 2 v1.1, corretiva — achado #2; reaberta na correção
 * de minuta) — adaptador IDEMPOTENTE da rota de registro de minuta.
 *
 * Entrega 2 v1.1: a identidade de idempotência (`idempotencia_organizacao_id`/
 * `_rota`/`_chave`/`_hash`, migration 0043) vive nas MESMAS colunas da linha
 * de `minutas` que ela protege, gravada pelo MESMO `INSERT ... ON CONFLICT DO
 * NOTHING` da escrita de negócio — não há duas transações, logo não há
 * janela entre a escrita e a reivindicação da chave (prova estrutural).
 *
 * Correção de minuta (P1): o INSERT agora acontece dentro do fluxo ÚNICO
 * `closing/minutaTecnica.ts` (documento, substituição da vigente, aceite
 * técnico e pendência na MESMA transação, sob o lock do processo). Este
 * adaptador só calcula o hash canônico, rejeita chaves legadas da tabela
 * genérica (0042) e delega a `ClosingService.registrarMinuta` — nenhuma
 * escrita própria (auditoria estática de `acoesSemLogicaDeNegocio.test.ts`).
 *
 * Hash v2 (`acoes.registrar_minuta.v2`): o pedido agora carrega o DOCUMENTO
 * (referência + hash SHA-256 + nome + tipo + tamanho) — entra no hash tudo
 * que muda o significado de negócio do registro. Uma chave gravada com o
 * hash v1 (antes desta correção, sem documento) não bate com o v2 e é
 * tratada como reutilizada (409) — nunca devolve um resultado de um pedido
 * de formato diferente.
 */

const VERSAO_HASH_REGISTRO_MINUTA = 'acoes.registrar_minuta.v2';

/**
 * Mesma normalização de número de contêiner/minuta usada pela verificação
 * técnica (`closing/minutaValidation.ts`): maiúsculas, sem espaços nem
 * hifens — diferenças de transporte nunca entram no hash.
 */
function normalizarNumeroCanonico(s: string | null | undefined): string | null {
  const n = String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
  return n || null;
}

/** Texto livre: só espaço de transporte é insignificante; o valor é sensível a caixa (pode ser URL/ID). */
function normalizarTextoCanonico(s: unknown): string | null {
  if (s === undefined || s === null) return null;
  const n = String(s).trim();
  return n || null;
}

export interface CamposRegistroMinuta {
  organizationId: string;
  containerId: string;
  numeroInformado: string | null;
  dataInformada: string | null;
  evidenciaRef: string | null;
  /** Documento como chegou (forma validada pelo serviço). */
  documento: unknown;
}

/**
 * Hash canônico do PEDIDO de registro — organização, versão do contrato,
 * contêiner, número (normalizado), data informada, evidência textual e o
 * documento inteiro. NUNCA inclui o ator: o mesmo pedido, reenviado por
 * outro responsável interno depois de uma resposta perdida, é a MESMA
 * operação lógica; o autor real fica em `minutas.recebida_por`/
 * `documentos.incluido_por_membership_id`, nunca reescritos por um replay.
 */
export function calcularHashRegistroMinuta(campos: CamposRegistroMinuta): string {
  const d = (campos.documento && typeof campos.documento === 'object' && !Array.isArray(campos.documento))
    ? campos.documento as Record<string, unknown> : null;
  return hashEstavel({
    versao: VERSAO_HASH_REGISTRO_MINUTA,
    organizationId: campos.organizationId,
    containerId: campos.containerId,
    numeroInformado: normalizarNumeroCanonico(campos.numeroInformado),
    dataInformada: campos.dataInformada ?? null,
    evidenciaRef: normalizarTextoCanonico(campos.evidenciaRef),
    documento: d ? {
      origem: normalizarTextoCanonico(d.origem), referencia: normalizarTextoCanonico(d.referencia),
      nomeArquivo: normalizarTextoCanonico(d.nomeArquivo), tipoConteudo: normalizarTextoCanonico(d.tipoConteudo),
      tamanhoBytes: typeof d.tamanhoBytes === 'number' ? d.tamanhoBytes : normalizarTextoCanonico(d.tamanhoBytes),
      hashConteudo: normalizarTextoCanonico(d.hashConteudo),
    } : null,
  });
}

export interface EntradaRegistroMinutaIdempotente extends CamposRegistroMinuta {
  /** Membership REAL da sessão (o serviço resolve usuário e papel sob lock). */
  membershipId: string;
  idempotenciaRota: string;
  idempotenciaChave: string;
  hoje: CivilDate;
}

export type ResultadoRegistroMinutaIdempotente =
  | {
      ok: true; minuta: Minuta; novo: boolean; processoId: string; substituidas: string[]; pendencia: string | null;
      exigeReabertura: boolean; documento: DocumentoRegistrado | null; encerramento: ResultadoEncerramentoAutomatico;
    }
  /** Mesma chave já usada para outro contêiner, outro conteúdo ou outro documento — ZERO escrita. */
  | { ok: false; motivo: 'idempotency_key_reutilizada' }
  /**
   * A mesma (organização, rota, chave) já existe na tabela GENÉRICA antiga
   * (`demurrage_acoes_idempotencia`, migration 0042), sem hash de pedido nem
   * amarração a contêiner — nunca "adivinhamos" o pedido original: a chave
   * antiga é REJEITADA; o chamador precisa de uma chave NOVA.
   */
  | { ok: false; motivo: 'idempotency_key_legado_sem_hash' }
  | { ok: false; motivo: 'container_nao_encontrado' | 'ator_nao_autorizado' | 'ator_nao_responsavel' | 'documento_obrigatorio' | 'documento_invalido'; campo?: string };

async function existeChaveLegado0042(pool: Pool, organizationId: string, rota: string, chave: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM demurrage_acoes_idempotencia WHERE organization_id = $1 AND rota = $2 AND chave = $3`,
    [organizationId, rota, chave],
  );
  return rows.length > 0;
}

export interface OpcoesRegistroMinutaIdempotente {
  /** SÓ TESTE — dispara com tudo escrito e ANTES do COMMIT, para provar que uma falha nesse ponto não deixa minuta, documento nem chave persistidos. Nenhuma rota o expõe. */
  _testeFalhaAntesDoCommit?: () => void | Promise<void>;
  /** SÓ TESTE — dispara imediatamente antes de gravar o documento. */
  _testeFalhaAoGravarDocumento?: () => void | Promise<void>;
}

/** Registro de minuta idempotente — único ponto de chamada da rota HTTP. */
export async function registrarMinutaIdempotente(
  pool: Pool, entrada: EntradaRegistroMinutaIdempotente, opcoes: OpcoesRegistroMinutaIdempotente = {},
): Promise<ResultadoRegistroMinutaIdempotente> {
  if (await existeChaveLegado0042(pool, entrada.organizationId, entrada.idempotenciaRota, entrada.idempotenciaChave)) {
    return { ok: false, motivo: 'idempotency_key_legado_sem_hash' };
  }
  const hash = calcularHashRegistroMinuta(entrada);
  const r = await new ClosingService(pool).registrarMinuta({
    containerId: entrada.containerId, membershipId: entrada.membershipId,
    numeroInformado: entrada.numeroInformado, dataInformada: entrada.dataInformada,
    evidenciaRef: entrada.evidenciaRef, documento: entrada.documento, config: { hoje: entrada.hoje },
    idempotencia: { organizationId: entrada.organizationId, rota: entrada.idempotenciaRota, chave: entrada.idempotenciaChave, hash },
    _testeAntesDoCommit: opcoes._testeFalhaAntesDoCommit, _testeFalhaAoGravarDocumento: opcoes._testeFalhaAoGravarDocumento,
  });
  if (!r.ok) return r;
  return {
    ok: true, minuta: r.minuta, novo: r.novo, processoId: r.processoId, substituidas: r.substituidas, pendencia: r.pendencia,
    exigeReabertura: r.exigeReabertura, documento: r.documento, encerramento: r.encerramento,
  };
}
