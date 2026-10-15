import { Pool } from 'pg';
import { hashEstavel } from '../registro/contrato';
import { Minuta } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';

/**
 * Produção P1 (Entrega 2 v1.1, corretiva — achado #2 da auditoria) —
 * registro de minuta IDEMPOTENTE e ATÔMICO.
 *
 * O desenho anterior (`acoes/idempotencia.ts`'s `comIdempotencia()`, sobre
 * a tabela genérica `demurrage_acoes_idempotencia`, migration 0042) fazia a
 * escrita de negócio (INSERT em `minutas`, dentro de
 * `ClosingService.registrarMinuta`, pelo pool compartilhado) numa
 * transação, e a escrita da identidade de idempotência (INSERT na tabela
 * genérica, por uma conexão dedicada) numa transação SEPARADA, depois que o
 * serviço já tinha retornado. Entre o COMMIT de uma e o COMMIT da outra
 * havia uma janela real: um crash do processo, ou uma falha pontual nesse
 * segundo INSERT, deixava a minuta persistida SEM nenhuma chave de
 * idempotência associada — um retry com a MESMA chave não encontrava nada
 * e criava uma SEGUNDA minuta (dual-write). A chave também não amarrava a
 * NENHUM contêiner nem ao conteúdo do pedido: a mesma chave reaproveitada
 * com outro contêiner, outro número informado, outra data ou outra
 * evidência devolvia o resultado antigo sem nenhuma verificação.
 *
 * Correção estrutural (migration 0043): a identidade de idempotência
 * (`idempotencia_organizacao_id`/`_rota`/`_chave`/`_hash`) vive nas MESMAS
 * colunas da própria linha de `minutas` que ela protege — `container_id`
 * já é a própria linha, então a amarração ao contêiner-alvo é automática.
 * Um ÚNICO `INSERT ... ON CONFLICT (...) DO NOTHING RETURNING *` faz a
 * escrita de negócio E a reivindicação da chave no MESMO statement: não há
 * duas transações, e portanto não há NENHUMA janela entre elas — isto é
 * uma prova ESTRUTURAL (a janela não existe, por construção), não apenas
 * uma prova estatística de que um teste de corrida não a alcançou.
 *
 * `MinutaRepository.criarRecebida`/`ClosingService.registrarMinuta`
 * continuam INTOCADOS — todo chamador pré-existente sem idempotência
 * (D15-A, D16, qualquer teste) segue criando uma nova minuta a cada
 * chamada, exatamente como sempre. Esta função é um adaptador PARALELO,
 * nunca uma reescrita do serviço congelado.
 */

const VERSAO_HASH_REGISTRO_MINUTA = 'acoes.registrar_minuta.v1';

/**
 * Mesma normalização de número de contêiner/minuta já usada por
 * `closing/minutaValidation.ts`'s `normalizarNumero` (função privada
 * daquele módulo, NUNCA importada aqui — reimplementada, não copiada por
 * cima de uma dependência, para não acoplar este adaptador a um símbolo
 * interno do serviço congelado). Mantém a MESMA regra de equivalência que o
 * próprio contrato já usa para comparar números: maiúsculas, sem espaços
 * nem hifens — diferenças de formatação puramente de transporte (que o
 * contrato já trata como o mesmo número) nunca entram no hash.
 */
function normalizarNumeroCanonico(s: string | null | undefined): string | null {
  const n = String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
  return n || null;
}

/** Evidência: só espaço de transporte (indentação/trailing) é insignificante; o valor em si é sensível a caixa (pode ser uma URL/ID). */
function normalizarEvidenciaCanonica(s: string | null | undefined): string | null {
  const n = String(s ?? '').trim();
  return n || null;
}

export interface CamposRegistroMinuta {
  organizationId: string;
  containerId: string;
  numeroInformado: string | null;
  dataInformada: string | null;
  evidenciaRef: string | null;
}

/**
 * Hash canônico do PEDIDO de registro de minuta — entra no hash todo campo
 * que muda o SIGNIFICADO de negócio do registro: organização, versão do
 * contrato desta rota (permite invalidar hashes antigos se o contrato
 * mudar de forma), contêiner-alvo, número informado (normalizado), data
 * informada (já canônica, 'AAAA-MM-DD') e referência de evidência
 * (normalizada). NUNCA inclui o ator (membership/usuário) autenticado: o
 * AUTOR real da sessão sempre grava `recebida_por` fresco a cada ESCRITA
 * (nunca aceito do corpo — ver a rota), mas duas chamadas com o MESMO
 * conteúdo de negócio, vindas de atores internos DIFERENTES (ex.: um
 * colega reexecuta a mesma automação com a mesma Idempotency-Key depois de
 * uma resposta perdida), ainda são a MESMA operação lógica — incluir o
 * ator no hash faria esse retry legítimo colidir como se fosse um pedido
 * diferente. A auditoria de "quem criou" fica preservada em
 * `minutas.recebida_por`, imutável por natureza (nunca reescrita por um
 * replay, que nunca grava de novo).
 */
export function calcularHashRegistroMinuta(campos: CamposRegistroMinuta): string {
  return hashEstavel({
    versao: VERSAO_HASH_REGISTRO_MINUTA,
    organizationId: campos.organizationId,
    containerId: campos.containerId,
    numeroInformado: normalizarNumeroCanonico(campos.numeroInformado),
    dataInformada: campos.dataInformada ?? null,
    evidenciaRef: normalizarEvidenciaCanonica(campos.evidenciaRef),
  });
}

export interface EntradaRegistroMinutaIdempotente extends CamposRegistroMinuta {
  recebidaPor: string | null;
  idempotenciaRota: string;
  idempotenciaChave: string;
}

export type ResultadoRegistroMinutaIdempotente =
  | { ok: true; minuta: Minuta; novo: boolean }
  /** Mesma chave já usada para outro contêiner, outro número, outra data ou outra evidência — ZERO escrita. */
  | { ok: false; motivo: 'idempotency_key_reutilizada' }
  /**
   * A mesma (organização, rota, chave) já existe na tabela GENÉRICA antiga
   * (`demurrage_acoes_idempotencia`, migration 0042) — gravada por uma
   * chamada ANTERIOR a esta corretiva, sem hash de pedido nem amarração a
   * contêiner. Não há como provar identidade de um jeito seguro: nunca
   * "adivinhamos" o contêiner/conteúdo original — a chave antiga é
   * REJEITADA explicitamente; o chamador precisa de uma chave NOVA.
   */
  | { ok: false; motivo: 'idempotency_key_legado_sem_hash' };

function mapRowMinuta(r: any): Minuta {
  return {
    id: r.id, containerId: r.container_id, estado: r.estado_minuta,
    numeroInformado: r.numero_informado, dataInformada: r.data_informada,
    dataValidada: r.data_validada, divergenteDoTracking: r.divergente_do_tracking,
    motivoRejeicao: r.motivo_rejeicao, evidenciaRef: r.evidencia_ref,
    recebidaPor: r.recebida_por, validadaPor: r.validada_por, supersedesId: r.supersedes_id,
  };
}

async function existeChaveLegado0042(pool: Pool, organizationId: string, rota: string, chave: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM demurrage_acoes_idempotencia WHERE organization_id = $1 AND rota = $2 AND chave = $3`,
    [organizationId, rota, chave],
  );
  return rows.length > 0;
}

export interface OpcoesRegistroMinutaIdempotente {
  /** SÓ TESTE — dispara depois do INSERT (se novo) e ANTES do COMMIT, para provar que uma falha nesse ponto não deixa minuta nem chave persistidas. Nunca usado em produção, nenhuma rota o expõe. */
  _testeFalhaAntesDoCommit?: () => void | Promise<void>;
}

/**
 * Registro de minuta ATÔMICO e idempotente. Único ponto de chamada desta
 * entrega para o registro de minuta via rota HTTP — ver cabeçalho do
 * arquivo para o desenho completo.
 */
export async function registrarMinutaIdempotente(
  pool: Pool, entrada: EntradaRegistroMinutaIdempotente, opcoes: OpcoesRegistroMinutaIdempotente = {},
): Promise<ResultadoRegistroMinutaIdempotente> {
  if (await existeChaveLegado0042(pool, entrada.organizationId, entrada.idempotenciaRota, entrada.idempotenciaChave)) {
    return { ok: false, motivo: 'idempotency_key_legado_sem_hash' };
  }

  const hash = calcularHashRegistroMinuta(entrada);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: inseridas } = await client.query(
      `INSERT INTO minutas (
         container_id, estado_minuta, numero_informado, data_informada, evidencia_ref, recebida_por,
         idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash
       ) VALUES ($1, 'RECEBIDA', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave) WHERE idempotencia_chave IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        entrada.containerId, entrada.numeroInformado, entrada.dataInformada, entrada.evidenciaRef, entrada.recebidaPor,
        entrada.organizationId, entrada.idempotenciaRota, entrada.idempotenciaChave, hash,
      ],
    );

    if (inseridas.length === 1) {
      const m = mapRowMinuta(inseridas[0]);
      const { rows: ci } = await client.query(`SELECT processo_id FROM containers WHERE id = $1`, [entrada.containerId]);
      await new ClosingEventRepository(client as unknown as Pool).registrar({
        processoId: ci[0]?.processo_id ?? null, containerId: entrada.containerId,
        tipoEvento: 'MINUTA_RECEBIDA', origem: 'humano', atorUsuarioId: entrada.recebidaPor,
        evidenciaRef: entrada.evidenciaRef, payload: { minutaId: m.id },
      });
      if (opcoes._testeFalhaAntesDoCommit) await opcoes._testeFalhaAntesDoCommit();
      await client.query('COMMIT');
      return { ok: true, minuta: m, novo: true };
    }

    // Conflito: já existe uma linha com esta (organização, rota, chave) —
    // relê-a DENTRO da mesma transação e compara o hash do pedido atual.
    const { rows: existentes } = await client.query(
      `SELECT * FROM minutas
        WHERE idempotencia_organizacao_id = $1 AND idempotencia_rota = $2 AND idempotencia_chave = $3`,
      [entrada.organizationId, entrada.idempotenciaRota, entrada.idempotenciaChave],
    );
    await client.query('COMMIT');
    const existente = existentes[0];
    if (!existente || existente.idempotencia_hash !== hash) {
      return { ok: false, motivo: 'idempotency_key_reutilizada' };
    }
    return { ok: true, minuta: mapRowMinuta(existente), novo: false };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}
