import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { PapelRbac } from '../scheduler/failurePolicy';
import { lockProcesso, registrarFatoMaterialPosFinal } from './materialChangeGuard';
import { avaliarMinutaTecnicamente, dataLegivel, ResultadoAvaliacaoTecnica, textoArmazenavel } from './minutaValidation';
import { Minuta, mapRowMinuta } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { abrirPendenciaComClient, resolverPendenciasComClient, TIPOS_PENDENCIA_SO_RESOLUCAO_AUTOMATICA } from '../registro/pendencias';
import { recalcularApuracaoContainerComClient } from '../apuracao/recalcularApuracao';
import { LifecycleRepository } from '../persistence/lifecycleRepository';

/**
 * Produção P1 (reabertura controlada — correção de minuta). Fluxo ÚNICO de
 * registro e aceite técnico da minuta de devolução.
 *
 * Regras de produto:
 *  - o cliente envia a minuta fora do sistema; o ANALISTA (ou qualquer
 *    responsável interno — ANALYST/MANAGER/ADMIN) a registra com o documento
 *    real (referência auditável — ver `documentos`, migration 0048). Produção
 *    P1 (filas pessoais): é ação PESSOAL — o ANALYST só registra no processo
 *    atribuído a ele; MANAGER/ADMIN em qualquer processo da organização;
 *  - NÃO existe aprovação de MANAGER/ADMIN: a verificação técnica automática
 *    (`avaliarMinutaTecnicamente`) decide sozinha — ACEITA (coerente e igual
 *    à devolução do tracking), DIVERGENTE (coerente, data diferente),
 *    INCONSISTENTE (número/data/cronologia) ou RECEBIDA (ainda não
 *    verificável — sem devolução no tracking ou sem descarga);
 *  - a data do TRACKING é a devolução oficial — este fluxo nunca grava uma
 *    data em `containers.effective_return_date` e nunca fabrica devolução (só
 *    LIMPA a devolução efetiva legada cuja minuta foi substituída, em processo
 *    OPEN — `limparDevolucaoLegadaSubstituida`);
 *  - DIVERGENTE/INCONSISTENTE abrem pendência operacional para o analista
 *    (`minuta_divergente_tracking`/`minuta_inconsistente`), resolvida
 *    automaticamente quando uma minuta substituta coerente é registrada;
 *  - uma minuta nova SUBSTITUI toda minuta ainda não substituída do
 *    contêiner (inclusive legado), com evento de auditoria — o histórico
 *    nunca é apagado. Há no máximo UMA vigente (índice `minutas_vigente_unica`).
 *
 * Concorrência: mesmo protocolo universal de D15-A — identifica o processo
 * SEM lock de linha → `lockProcesso` → processo `FOR UPDATE` → contêiner
 * `FOR UPDATE` → minutas `FOR UPDATE` → escreve → COMMIT. Tudo (minuta,
 * documento, substituição, avaliação, pendência, evento) numa ÚNICA
 * transação: qualquer falha — inclusive ao gravar o documento — desfaz tudo.
 */

export const REGRA_AVALIACAO_MINUTA = 'minuta.tecnica.v1';

export const ORIGENS_DOCUMENTO_MINUTA = ['email_anexo', 'referencia_externa'] as const;
export type OrigemDocumentoMinuta = (typeof ORIGENS_DOCUMENTO_MINUTA)[number];

export const TIPOS_CONTEUDO_MINUTA = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp', 'image/heic'] as const;
export type TipoConteudoMinuta = (typeof TIPOS_CONTEUDO_MINUTA)[number];

/** Mesmo limite do CHECK `documentos_minuta_coerente` (50 MiB). */
export const TAMANHO_MAXIMO_DOCUMENTO_MINUTA = 52428800;

/**
 * Referência auditável do arquivo real da minuta. O sistema NÃO guarda o
 * binário (não existe armazenamento de arquivos na Priora — ver relatório):
 * guarda onde o arquivo está (`referencia`, ex.: o anexo do e-mail no Graph
 * ou a chave de um repositório externo) e o que ele é (hash SHA-256, nome,
 * tipo e tamanho), o bastante para provar depois que o arquivo é o mesmo.
 */
export interface DocumentoMinutaEntrada {
  origem: OrigemDocumentoMinuta;
  referencia: string;
  nomeArquivo: string;
  tipoConteudo: TipoConteudoMinuta;
  tamanhoBytes: number;
  hashConteudo: string;
}

export type ValidacaoDocumento =
  | { ok: true; documento: DocumentoMinutaEntrada }
  | { ok: false; motivo: 'documento_obrigatorio' | 'documento_invalido'; campo?: string };

/** Valida a FORMA do documento (o banco reforça com `documentos_minuta_coerente`). */
export function validarDocumentoMinuta(bruto: unknown): ValidacaoDocumento {
  if (bruto === undefined || bruto === null) return { ok: false, motivo: 'documento_obrigatorio' };
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, motivo: 'documento_invalido', campo: 'documento' };
  const d = bruto as Record<string, unknown>;
  const invalido = (campo: string): ValidacaoDocumento => ({ ok: false, motivo: 'documento_invalido', campo });
  if (!ORIGENS_DOCUMENTO_MINUTA.includes(d.origem as OrigemDocumentoMinuta)) return invalido('origem');
  if (typeof d.referencia !== 'string' || !d.referencia.trim() || d.referencia.length > 1000 || !textoArmazenavel(d.referencia)) return invalido('referencia');
  if (typeof d.nomeArquivo !== 'string' || !d.nomeArquivo.trim() || d.nomeArquivo.length > 255 || !textoArmazenavel(d.nomeArquivo)) return invalido('nomeArquivo');
  if (!TIPOS_CONTEUDO_MINUTA.includes(d.tipoConteudo as TipoConteudoMinuta)) return invalido('tipoConteudo');
  if (typeof d.tamanhoBytes !== 'number' || !Number.isInteger(d.tamanhoBytes) || d.tamanhoBytes < 1 || d.tamanhoBytes > TAMANHO_MAXIMO_DOCUMENTO_MINUTA) {
    return invalido('tamanhoBytes');
  }
  if (typeof d.hashConteudo !== 'string' || !/^[0-9a-f]{64}$/.test(d.hashConteudo)) return invalido('hashConteudo');
  return {
    ok: true,
    documento: {
      origem: d.origem as OrigemDocumentoMinuta, referencia: d.referencia.trim(), nomeArquivo: d.nomeArquivo.trim(),
      tipoConteudo: d.tipoConteudo as TipoConteudoMinuta, tamanhoBytes: d.tamanhoBytes, hashConteudo: d.hashConteudo,
    },
  };
}

function ehPapelInterno(papel: PapelRbac): boolean {
  return papel === 'ANALYST' || papel === 'MANAGER' || papel === 'ADMIN';
}

/* ------------------------------------------------------------------ *
 * Avaliação técnica de UMA minuta já travada (lock do processo detido).
 * ------------------------------------------------------------------ */

interface ContainerTravado {
  id: string;
  processo_id: string;
  organization_id: string;
  numero: string;
  discharge_date: CivilDate | null;
  gate_out_date: CivilDate | null;
  tracking_return_date: CivilDate | null;
  effective_return_date: CivilDate | null;
  effective_return_minuta_id: string | null;
}

export interface ContextoProcesso {
  processoId: string;
  organizationId: string;
  apuracaoStatus: 'OPEN' | 'FINAL';
}

/** Fatos usados na avaliação — persistidos para detectar avaliação desatualizada (mesma forma do `jsonb_build_object` da varredura). */
function fatosAvaliacao(c: ContainerTravado): { tracking: CivilDate | null; descarga: CivilDate | null; gateOut: CivilDate | null } {
  return { tracking: c.tracking_return_date ?? null, descarga: c.discharge_date ?? null, gateOut: c.gate_out_date ?? null };
}

function avaliar(minutaRow: any, c: ContainerTravado, hoje: CivilDate): ResultadoAvaliacaoTecnica {
  return avaliarMinutaTecnicamente({
    numeroInformado: minutaRow.numero_informado, numeroContainer: c.numero, dataInformada: minutaRow.data_informada,
    dischargeDate: c.discharge_date ?? null, gateOutDate: c.gate_out_date ?? null, trackingReturnDate: c.tracking_return_date ?? null, hoje,
  });
}

function colunasDoResultado(r: ResultadoAvaliacaoTecnica) {
  switch (r.estado) {
    case 'ACEITA': return { estado: 'ACEITA', motivo: null, dataTracking: r.dataTracking, aguardando: null, divergente: false };
    case 'DIVERGENTE': return { estado: 'DIVERGENTE', motivo: null, dataTracking: r.dataTracking, aguardando: null, divergente: true };
    case 'INCONSISTENTE': return { estado: 'INCONSISTENTE', motivo: r.motivo, dataTracking: null, aguardando: null, divergente: false };
    case 'RECEBIDA': return { estado: 'RECEBIDA', motivo: null, dataTracking: null, aguardando: r.aguardando, divergente: false };
  }
}

const TIPO_PENDENCIA_POR_ESTADO: Record<string, string | undefined> = {
  DIVERGENTE: 'minuta_divergente_tracking',
  INCONSISTENTE: 'minuta_inconsistente',
};
const TIPOS_PENDENCIA_MINUTA = [...TIPOS_PENDENCIA_SO_RESOLUCAO_AUTOMATICA];

/**
 * Sincroniza as pendências de minuta do contêiner com a minuta VIGENTE:
 * resolve automaticamente toda pendência de minuta aberta que não
 * corresponde mais à vigente (outro tipo ou outra minuta) e abre a que
 * corresponde, quando a vigente é DIVERGENTE/INCONSISTENTE. Idempotente.
 */
async function sincronizarPendenciasMinuta(
  client: PoolClient, ctx: ContextoProcesso, containerId: string, vigente: { id: string; estado: string; contexto: Record<string, unknown> } | null,
): Promise<string | null> {
  const desejado = vigente ? TIPO_PENDENCIA_POR_ESTADO[vigente.estado] ?? null : null;
  const contextoDesejado: Record<string, unknown> = vigente ? { minutaId: vigente.id, ...vigente.contexto } : {};
  const { rows: abertas } = await client.query(
    `SELECT id, tipo, contexto FROM demurrage_pendencias
      WHERE processo_id = $1 AND container_id = $2 AND tipo = ANY($3::text[]) AND estado = 'aberta'`,
    [ctx.processoId, containerId, TIPOS_PENDENCIA_MINUTA],
  );
  // Comparação chave a chave (jsonb não preserva a ordem das chaves). A linha
  // de pendência nunca é editada: contexto desatualizado (ex.: a minuta segue
  // DIVERGENTE, mas o tracking mudou de data) resolve a antiga e abre outra —
  // o histórico guarda as duas.
  const mesmoContexto = (atual: Record<string, unknown> | null): boolean => {
    const a = atual ?? {};
    const chaves = new Set([...Object.keys(a), ...Object.keys(contextoDesejado)]);
    for (const k of chaves) if ((a[k] ?? null) !== (contextoDesejado[k] ?? null)) return false;
    return true;
  };
  const aResolver = abertas
    .filter((p) => p.tipo !== desejado || !mesmoContexto(p.contexto))
    .map((p) => p.tipo as string);
  if (aResolver.length) await resolverPendenciasComClient(client, ctx.processoId, containerId, Array.from(new Set(aResolver)));
  if (desejado && vigente) {
    await abrirPendenciaComClient(client, ctx.organizationId, ctx.processoId, containerId, desejado, contextoDesejado);
  }
  return desejado;
}

/**
 * LEGADO: a devolução efetiva que veio de uma minuta aprovada no fluxo antigo
 * perde a base quando essa minuta é substituída — a devolução volta a ser a
 * do tracking (a oficial). Só em processo OPEN (FINAL é congelado). Roda no
 * registro (logo depois da substituição) e em TODA reavaliação sob o lock:
 * assim, uma minuta legada substituída enquanto o processo estava FINAL deixa
 * de valer assim que ele é reaberto — nunca se re-encerra com relógios e
 * valores calculados sobre a data da minuta antiga. Precondição: lock do
 * processo detido e o contêiner travado. Devolve se limpou.
 */
async function limparDevolucaoLegadaSubstituida(
  client: PoolClient, ctx: ContextoProcesso, c: ContainerTravado, hoje: CivilDate,
): Promise<boolean> {
  if (ctx.apuracaoStatus !== 'OPEN' || !c.effective_return_minuta_id) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM minutas WHERE id = $1 AND substituida_por_id IS NOT NULL`,
    [c.effective_return_minuta_id],
  );
  if (!rows.length) return false;
  await client.query(`UPDATE containers SET effective_return_date = NULL, effective_return_minuta_id = NULL WHERE id = $1`, [c.id]);
  await new ClosingEventRepository(client as unknown as Pool).registrar({
    processoId: ctx.processoId, containerId: c.id, tipoEvento: 'RECALCULO', origem: 'automatico',
    payload: { motivo: 'devolucao_efetiva_legada_substituida', effectiveAnterior: c.effective_return_date, minutaLegadaId: c.effective_return_minuta_id },
  });
  await recalcularApuracaoContainerComClient(client, c.id, { dataReferencia: hoje });
  return true;
}

/**
 * Processo FINAL: uma minuta COERENTE cuja data difere da data final
 * CONGELADA no fechamento (relógio do cliente — a mesma referência de D15-A;
 * em fluxo normal é a própria devolução do tracking) é fato material
 * pós-FINAL e exige reabertura. Pura leitura.
 */
async function dataCongeladaDivergente(
  client: PoolClient, c: ContainerTravado, minutaRow: any, hoje: CivilDate,
): Promise<{ congelada: CivilDate } | null> {
  const previsto = avaliar(minutaRow, c, hoje).estado;
  if (previsto !== 'ACEITA' && previsto !== 'DIVERGENTE') return null;
  const { rows: rel } = await client.query(`SELECT data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [c.id]);
  const congelada: CivilDate | null = rel[0]?.data_final_apuracao ?? c.effective_return_date ?? c.tracking_return_date ?? null;
  return congelada !== null && minutaRow.data_informada !== congelada ? { congelada } : null;
}

/**
 * Aplica a avaliação técnica à minuta (já travada) e mantém evento e
 * pendência coerentes. NO-OP estrito quando o resultado não mudou (nenhum
 * UPDATE, nenhum evento). Precondição: o chamador detém `lockProcesso` e as
 * linhas do processo/contêiner/minuta travadas, nesta ordem.
 */
async function aplicarAvaliacao(
  client: PoolClient, ctx: ContextoProcesso, c: ContainerTravado, minutaRow: any, hoje: CivilDate,
): Promise<{ mudou: boolean; resultado: ResultadoAvaliacaoTecnica; pendencia: string | null }> {
  const resultado = avaliar(minutaRow, c, hoje);
  const col = colunasDoResultado(resultado);
  const fatos = fatosAvaliacao(c);
  const mesmoEstado = minutaRow.estado_minuta === col.estado
    && (minutaRow.motivo_rejeicao ?? null) === col.motivo
    && (minutaRow.data_tracking_comparada ?? null) === col.dataTracking
    && (minutaRow.aguardando ?? null) === col.aguardando
    && minutaRow.avaliada_em !== null;
  const anteriores = (minutaRow.fatos_avaliacao ?? {}) as Record<string, unknown>;
  const mesmosFatos = minutaRow.fatos_avaliacao != null
    && (anteriores.tracking ?? null) === fatos.tracking
    && (anteriores.descarga ?? null) === fatos.descarga
    && (anteriores.gateOut ?? null) === fatos.gateOut;

  if (!mesmoEstado || !mesmosFatos) {
    await client.query(
      `UPDATE minutas SET estado_minuta = $2, motivo_rejeicao = $3, data_tracking_comparada = $4, aguardando = $5,
              divergente_do_tracking = $6, fatos_avaliacao = $7, avaliada_em = now(), atualizado_em = now()
        WHERE id = $1`,
      [minutaRow.id, col.estado, col.motivo, col.dataTracking, col.aguardando, col.divergente, JSON.stringify(fatos)],
    );
  }
  if (!mesmoEstado) {
    const tipoEvento = col.estado === 'ACEITA' ? 'MINUTA_ACEITA' : col.estado === 'DIVERGENTE' ? 'MINUTA_DIVERGENTE'
      : col.estado === 'INCONSISTENTE' ? 'MINUTA_INCONSISTENTE' : null;
    if (tipoEvento) {
      await new ClosingEventRepository(client as unknown as Pool).registrar({
        processoId: ctx.processoId, containerId: c.id, tipoEvento, origem: 'automatico',
        payload: {
          minutaId: minutaRow.id, regra: REGRA_AVALIACAO_MINUTA, estadoAnterior: minutaRow.estado_minuta,
          dataMinuta: minutaRow.data_informada ?? null, dataTracking: c.tracking_return_date ?? null, motivo: col.motivo,
        },
      });
    }
  }
  const contexto: Record<string, unknown> = resultado.estado === 'DIVERGENTE'
    ? { dataMinuta: resultado.dataMinuta, dataTracking: resultado.dataTracking }
    : resultado.estado === 'INCONSISTENTE' ? { motivo: resultado.motivo } : {};
  const pendencia = await sincronizarPendenciasMinuta(client, ctx, c.id, { id: minutaRow.id, estado: col.estado, contexto });
  return { mudou: !mesmoEstado, resultado, pendencia };
}

/* ------------------------------------------------------------------ *
 * Registro (único ponto de escrita de minuta do fluxo vigente).
 * ------------------------------------------------------------------ */

export interface IdempotenciaRegistroMinuta {
  organizationId: string;
  rota: string;
  chave: string;
  hash: string;
}

export interface RegistrarMinutaTecnicaInput {
  containerId: string;
  /**
   * Membership REAL e ATIVO de quem registra (ANALYST/MANAGER/ADMIN da
   * organização do contêiner) — nunca papel informado. ANALYST só no
   * processo atribuído a ele (`ator_nao_responsavel`).
   */
  membershipId: string;
  numeroInformado: string | null;
  dataInformada: string | null;
  documento: unknown;
  /** Texto livre legado (observação) — opcional; o documento é a evidência. */
  evidenciaRef?: string | null;
  hoje: CivilDate;
  idempotencia?: IdempotenciaRegistroMinuta | null;
  /** SÓ TESTE — dispara imediatamente antes de gravar o documento (simula falha do armazenamento da referência). */
  _testeFalhaAoGravarDocumento?: () => void | Promise<void>;
  /** SÓ TESTE — dispara antes do COMMIT, com tudo escrito e o lock retido. */
  _testeAntesDoCommit?: () => void | Promise<void>;
}

export interface DocumentoRegistrado {
  id: string;
  versaoMinuta: number;
  hashConteudo: string;
}

export type ResultadoRegistroMinutaTecnica =
  | {
      ok: true;
      novo: boolean;
      minuta: Minuta;
      processoId: string;
      organizationId: string;
      apuracaoStatus: 'OPEN' | 'FINAL';
      substituidas: string[];
      pendencia: string | null;
      exigeReabertura: boolean;
      documento: DocumentoRegistrado | null;
    }
  | {
      ok: false;
      motivo: 'container_nao_encontrado' | 'ator_nao_autorizado' | 'ator_nao_responsavel' | 'documento_obrigatorio' | 'documento_invalido' | 'idempotency_key_reutilizada';
      campo?: string;
    };

async function documentoDaMinuta(db: Pool | PoolClient, minutaId: string): Promise<DocumentoRegistrado | null> {
  const { rows } = await db.query(`SELECT id, versao_minuta, hash_conteudo FROM documentos WHERE minuta_id = $1`, [minutaId]);
  return rows.length ? { id: rows[0].id, versaoMinuta: rows[0].versao_minuta, hashConteudo: rows[0].hash_conteudo } : null;
}

async function replayIdempotente(
  db: Pool | PoolClient, idem: IdempotenciaRegistroMinuta,
): Promise<ResultadoRegistroMinutaTecnica | null> {
  const { rows } = await db.query(
    `SELECT m.*, c.processo_id, c.organization_id, p.apuracao_status
       FROM minutas m JOIN containers c ON c.id = m.container_id JOIN processos p ON p.id = c.processo_id
      WHERE m.idempotencia_organizacao_id = $1 AND m.idempotencia_rota = $2 AND m.idempotencia_chave = $3`,
    [idem.organizationId, idem.rota, idem.chave],
  );
  if (!rows.length) return null;
  const r = rows[0];
  if (r.idempotencia_hash !== idem.hash) return { ok: false, motivo: 'idempotency_key_reutilizada' };
  // A resposta original é reconstruída do evento de registro (append-only):
  // quais minutas esta substituiu e se ela exigiu reabertura — um retry depois
  // de uma resposta perdida nunca diz "não precisa reabrir" quando precisava.
  const { rows: ev } = await db.query(
    `SELECT payload FROM closing_events
      WHERE container_id = $1 AND tipo_evento = 'MINUTA_RECEBIDA' AND payload->>'minutaId' = $2::text
      ORDER BY criado_em LIMIT 1`,
    [r.container_id, r.id],
  );
  const payload = (ev[0]?.payload ?? {}) as { substituiu?: unknown; exigeReabertura?: unknown };
  return {
    ok: true, novo: false, minuta: mapRowMinuta(r), processoId: r.processo_id, organizationId: r.organization_id,
    apuracaoStatus: r.apuracao_status,
    substituidas: Array.isArray(payload.substituiu) ? payload.substituiu.map(String) : [],
    pendencia: TIPO_PENDENCIA_POR_ESTADO[r.estado_minuta] ?? null,
    exigeReabertura: payload.exigeReabertura === true, documento: await documentoDaMinuta(db, r.id),
  };
}

export async function registrarMinutaTecnica(pool: Pool, input: RegistrarMinutaTecnicaInput): Promise<ResultadoRegistroMinutaTecnica> {
  const doc = validarDocumentoMinuta(input.documento);
  if (!doc.ok) return doc;
  // Data que não é um dia civil real ('2026-02-30', texto) nunca vira erro de
  // banco (500): é exatamente o caso DATA_ILEGIVEL da verificação técnica —
  // a minuta é registrada sem data e fica INCONSISTENTE, com o texto bruto
  // preservado (limitado) no evento de registro.
  const dataBruta = input.dataInformada ?? null;
  const dataInformada = dataBruta !== null && dataLegivel(dataBruta) ? dataBruta : null;
  // (texto bruto só como evidência: caracteres que o jsonb recusa viram U+FFFD)
  const dataIlegivel = dataBruta !== null && dataInformada === null
    ? Array.from(String(dataBruta).slice(0, 40)).map((ch) => (textoArmazenavel(ch) ? ch : '\uFFFD')).join('')
    : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) processo pelo contêiner, SEM lock de linha mutável.
    const { rows: idRows } = await client.query(`SELECT processo_id FROM containers WHERE id = $1`, [input.containerId]);
    if (!idRows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'container_nao_encontrado' }; }
    const processoId: string = idRows[0].processo_id;

    // 2) lock consultivo → 3) processo → 4) contêiner.
    await lockProcesso(client, processoId);
    const { rows: pr } = await client.query(
      `SELECT organization_id, apuracao_status, responsavel_operacional_membership_id FROM processos WHERE id = $1 FOR UPDATE`,
      [processoId],
    );
    const ctx: ContextoProcesso = { processoId, organizationId: pr[0].organization_id, apuracaoStatus: pr[0].apuracao_status };
    const { rows: cr } = await client.query(
      `SELECT id, processo_id, organization_id, numero, discharge_date, gate_out_date, tracking_return_date,
              effective_return_date, effective_return_minuta_id
         FROM containers WHERE id = $1 FOR UPDATE`,
      [input.containerId],
    );
    const c = cr[0] as ContainerTravado;

    // 5) ator REAL — qualquer papel interno ATIVO da organização do contêiner
    //    (Produção P1: membership desativado = não autorizado; `FOR SHARE`
    //    segura a desativação até o COMMIT).
    const { rows: ator } = await client.query(
      `SELECT usuario_id, papel FROM organization_memberships
        WHERE id = $1 AND organization_id = $2 AND desativado_em IS NULL FOR SHARE`,
      [input.membershipId, ctx.organizationId],
    );
    if (!ator.length || !ehPapelInterno(ator[0].papel as PapelRbac)) {
      await client.query('ROLLBACK');
      return { ok: false, motivo: 'ator_nao_autorizado' };
    }
    // 5b) ação PESSOAL (Produção P1, filas pessoais): ANALYST só registra em
    //     processo ATRIBUÍDO a ele (sem responsável = nenhum ANALYST);
    //     MANAGER/ADMIN em qualquer processo da organização. Sob o lock
    //     consultivo + `FOR UPDATE` do processo (a atribuição toma o MESMO
    //     lock — nenhuma reatribuição passa entre a checagem e a escrita) e
    //     ANTES da réplica idempotente: quem não pode agir aqui nunca recebe a
    //     resposta de um registro anterior. Nunca exige aprovação de gestor.
    if (ator[0].papel === 'ANALYST' && pr[0].responsavel_operacional_membership_id !== input.membershipId) {
      await client.query('ROLLBACK');
      return { ok: false, motivo: 'ator_nao_responsavel' };
    }
    const usuarioId: string = ator[0].usuario_id;

    // 6) idempotência: chave já usada → réplica exata ou conflito, ZERO escrita.
    if (input.idempotencia) {
      const replay = await replayIdempotente(client, input.idempotencia);
      if (replay) { await client.query('ROLLBACK'); return replay; }
    }

    // 7) toda minuta ainda não substituída do contêiner (fluxo técnico e legado).
    const { rows: anteriores } = await client.query(
      `SELECT id, estado_minuta, regra_avaliacao FROM minutas
        WHERE container_id = $1 AND substituida_por_id IS NULL AND estado_minuta <> 'SUBSTITUIDA'
        ORDER BY criado_em, id FOR UPDATE`,
      [c.id],
    );
    const { rows: cont } = await client.query(`SELECT count(*)::int AS n FROM minutas WHERE container_id = $1`, [c.id]);
    const versao = cont[0].n + 1;
    const novaId = randomUUID();
    const eventos = new ClosingEventRepository(client as unknown as Pool);

    // 8) substitui ANTES do INSERT (o índice de vigência nunca vê duas vigentes;
    //    o FK adiável de `substituida_por_id` é conferido no COMMIT).
    for (const a of anteriores) {
      await client.query(
        `UPDATE minutas SET estado_minuta = 'SUBSTITUIDA', substituida_por_id = $2, substituida_em = now(), atualizado_em = now() WHERE id = $1`,
        [a.id, novaId],
      );
      await eventos.registrar({
        processoId, containerId: c.id, tipoEvento: 'MINUTA_SUBSTITUIDA', origem: 'automatico',
        payload: { minutaId: a.id, substituidaPor: novaId, estadoAnterior: a.estado_minuta, legado: a.regra_avaliacao === null },
      });
    }

    // 9) a nova minuta (RECEBIDA até a avaliação logo abaixo, na MESMA transação).
    const idem = input.idempotencia ?? null;
    const { rows: ins } = await client.query(
      `INSERT INTO minutas (
         id, container_id, estado_minuta, numero_informado, data_informada, evidencia_ref, recebida_por, supersedes_id,
         regra_avaliacao, versao, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash
       ) VALUES ($1, $2, 'RECEBIDA', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave) WHERE idempotencia_chave IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        novaId, c.id, input.numeroInformado ?? null, dataInformada, input.evidenciaRef ?? null, usuarioId,
        anteriores.length ? anteriores[anteriores.length - 1].id : null, REGRA_AVALIACAO_MINUTA, versao,
        idem?.organizationId ?? null, idem?.rota ?? null, idem?.chave ?? null, idem?.hash ?? null,
      ],
    );
    if (!ins.length) {
      // A mesma chave foi reivindicada por uma transação concorrente (de OUTRO
      // processo — no mesmo processo o lock consultivo já serializou). Desfaz
      // tudo e responde pela linha vencedora — lida pela MESMA conexão (fora de
      // transação): nunca uma segunda conexão do pool enquanto esta está retida.
      await client.query('ROLLBACK');
      const replay = await replayIdempotente(client, idem!);
      return replay ?? { ok: false, motivo: 'idempotency_key_reutilizada' };
    }
    const novaRow = ins[0];

    // 10) documento — referência auditável do arquivo real (append-only).
    if (input._testeFalhaAoGravarDocumento) await input._testeFalhaAoGravarDocumento();
    const d = doc.documento;
    // Processo FINAL: decide AGORA (antes do evento de registro, que guarda a
    // resposta para réplica idempotente) se a minuta é fato material pós-FINAL.
    const fatoPosFinal = ctx.apuracaoStatus === 'FINAL' ? await dataCongeladaDivergente(client, c, novaRow, input.hoje) : null;
    const exigeReabertura = fatoPosFinal !== null;
    const { rows: docRows } = await client.query(
      `INSERT INTO documentos (
         processo_id, container_id, organization_id, minuta_id, versao_minuta, tipo, origem,
         referencia_armazenamento, nome_arquivo, tipo_conteudo, tamanho_bytes, hash_conteudo,
         incluido_por, incluido_por_membership_id
       ) VALUES ($1, $2, $3, $4, $5, 'minuta_devolucao', $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [processoId, c.id, ctx.organizationId, novaId, versao, d.origem, d.referencia, d.nomeArquivo, d.tipoConteudo, d.tamanhoBytes, d.hashConteudo, usuarioId, input.membershipId],
    );
    await eventos.registrar({
      processoId, containerId: c.id, tipoEvento: 'MINUTA_RECEBIDA', origem: 'humano', atorUsuarioId: usuarioId,
      payload: {
        minutaId: novaId, versao, documentoId: docRows[0].id, hashConteudo: d.hashConteudo, substituiu: anteriores.map((a) => a.id),
        exigeReabertura,
        ...(dataIlegivel !== null ? { dataInformadaIlegivel: dataIlegivel } : {}),
      },
    });

    // 11) LEGADO: se a devolução efetiva vinha de uma minuta agora substituída
    //     (aprovação humana do fluxo antigo), ela perde a base — a devolução
    //     volta a ser a do tracking. Só em processo OPEN (FINAL é congelado).
    await limparDevolucaoLegadaSubstituida(client, ctx, c, input.hoje);

    // 12) verificação técnica automática + pendência; o estado documental do
    //     contêiner (documentary_status/badges, só cache — nenhum relógio) é
    //     re-derivado e o processo reconsolidado, como no fluxo anterior.
    const aval = await aplicarAvaliacao(client, ctx, c, novaRow, input.hoje);
    await new LifecycleRepository(client as unknown as Pool).derivarContainerEConsolidar(c.id, processoId, { hoje: input.hoje });

    // 13) processo FINAL: minuta coerente com data diferente da CONGELADA no
    //     fechamento (decidido acima, `dataCongeladaDivergente`) é fato
    //     material pós-FINAL — as duas evidências ficam registradas e a
    //     mudança exige reabertura. Nada do estado congelado é tocado.
    if (fatoPosFinal) {
      await registrarFatoMaterialPosFinal(client, {
        processoId, containerId: c.id, campo: 'minutaDivergente', valorAnterior: fatoPosFinal.congelada, valorNovo: novaRow.data_informada as CivilDate,
        origem: 'humano', atorUsuarioId: usuarioId, extra: { minutaId: novaId, trackingReturnDate: c.tracking_return_date ?? null },
      });
    }

    // Estado final lido ANTES do COMMIT, pela mesma conexão: nada depois do
    // COMMIT pode falhar (nunca 500 com tudo gravado) e nunca se pede uma
    // segunda conexão ao pool com esta retida (N registros concorrentes num
    // pool de N conexões travariam o pool inteiro — achado da revisão).
    const { rows: final } = await client.query(`SELECT * FROM minutas WHERE id = $1`, [novaId]);
    if (input._testeAntesDoCommit) await input._testeAntesDoCommit();
    await client.query('COMMIT');

    return {
      ok: true, novo: true, minuta: mapRowMinuta(final[0]), processoId, organizationId: ctx.organizationId,
      apuracaoStatus: ctx.apuracaoStatus, substituidas: anteriores.map((a) => a.id), pendencia: aval.pendencia,
      exigeReabertura, documento: { id: docRows[0].id, versaoMinuta: versao, hashConteudo: d.hashConteudo },
    };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Reavaliação (fatos mudaram: devolução/descarga/Gate Out).
 * ------------------------------------------------------------------ */

/**
 * Reavalia, SOB O LOCK DO CHAMADOR, a minuta VIGENTE do fluxo técnico de cada
 * contêiner do processo contra os fatos atuais (ex.: o tracking acabou de
 * confirmar a devolução de uma minuta RECEBIDA, ou corrigiu a data — ou a
 * descarga/Gate Out — de uma ACEITA) e limpa a devolução efetiva LEGADA cuja
 * minuta já foi substituída. Usada DENTRO da transação do encerramento, antes
 * do gate: o gate nunca decide sobre uma avaliação velha (achado da revisão
 * adversarial — antes rodava numa transação própria, com janela entre as
 * duas). Processo FINAL é congelado: NO-OP (fato posterior ao FINAL segue o
 * caminho de fato material + reabertura). Minutas legadas nunca são
 * reavaliadas. Idempotente: nada muda quando os fatos não mudaram.
 * Precondição: `lockProcesso` detido e a linha do processo travada.
 */
export async function reavaliarMinutasComClient(client: PoolClient, ctx: ContextoProcesso, hoje: CivilDate): Promise<{ reavaliadas: number }> {
  if (ctx.apuracaoStatus !== 'OPEN') return { reavaliadas: 0 };
  const { rows: conts } = await client.query(
    `SELECT id, processo_id, organization_id, numero, discharge_date, gate_out_date, tracking_return_date,
            effective_return_date, effective_return_minuta_id
       FROM containers WHERE processo_id = $1 ORDER BY id FOR UPDATE`,
    [ctx.processoId],
  );
  let reavaliadas = 0;
  for (const c of conts as ContainerTravado[]) {
    const limpou = await limparDevolucaoLegadaSubstituida(client, ctx, c, hoje);
    const { rows: vig } = await client.query(
      `SELECT * FROM minutas WHERE container_id = $1 AND regra_avaliacao IS NOT NULL AND substituida_por_id IS NULL FOR UPDATE`,
      [c.id],
    );
    const r = vig.length ? await aplicarAvaliacao(client, ctx, c, vig[0], hoje) : null;
    if (r?.mudou) reavaliadas++;
    if (r?.mudou || limpou) {
      await new LifecycleRepository(client as unknown as Pool).derivarContainerEConsolidar(c.id, ctx.processoId, { hoje });
    }
  }
  return { reavaliadas };
}

/** `reavaliarMinutasComClient` numa transação própria (mesmo protocolo de lock). */
export async function reavaliarMinutasDoProcesso(pool: Pool, processoId: string, hoje: CivilDate): Promise<{ reavaliadas: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockProcesso(client, processoId);
    const { rows: pr } = await client.query(`SELECT organization_id, apuracao_status FROM processos WHERE id = $1 FOR UPDATE`, [processoId]);
    if (!pr.length) { await client.query('ROLLBACK'); return { reavaliadas: 0 }; }
    const r = await reavaliarMinutasComClient(client, { processoId, organizationId: pr[0].organization_id, apuracaoStatus: pr[0].apuracao_status }, hoje);
    await client.query('COMMIT');
    return r;
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}
