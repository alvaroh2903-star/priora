import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { ArmazenamentoObjetos, codigoDeFalhaArmazenamento, ErroArmazenamento, PREFIXO_CHAVE_DOCUMENTO } from './armazenamento';
import { registrarEventoDocumento } from './eventos';
import { VerificadorDownload } from './fluxos';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { hojeOperacional } from '../time/operationalDate';

/**
 * Produção P1 (arquivos de minuta) — RECONCILIAÇÃO banco × armazenamento e
 * limpeza de uploads abandonados.
 *
 * Regras (nunca relaxadas por nenhum modo):
 *  - documento confirmado (vinculado a minuta, DISPONIVEL, SUBSTITUIDO) NUNCA
 *    tem o objeto apagado; linha nenhuma é apagada (trigger);
 *  - só se removem objetos de chaves que o PRÓPRIO banco registrou como
 *    descartáveis: tentativa de envio DESCARTADA, ou documento FALHOU (nunca
 *    vinculado — expirado, recusado, não confirmado). Ordem: o banco registra
 *    o estado (COMMIT), DEPOIS o `apagar`, DEPOIS a marca de remoção — uma
 *    queda no meio deixa só remoção pendente, retomada no próximo ciclo;
 *  - objeto ÓRFÃO (chave no armazenamento que o banco não conhece) é só
 *    RELATADO, nunca apagado automaticamente: pode ser o arquivo de um
 *    documento confirmado de um banco restaurado de backup. Relatado por
 *    impressão (SHA-256 da chave, 16 hex) — a chave nunca vai para log;
 *  - "objeto ausente" só é marcado no modo `corrigir`, com o bucket
 *    confirmado acessível (o provedor S3 faz HEAD do bucket antes de
 *    responder "não existe") e abaixo de um limite de proporção (muitos
 *    ausentes de uma vez = configuração errada, não perda); a marca é
 *    reversível quando o objeto reaparece íntegro (`OBJETO_RESTABELECIDO`);
 *  - toda transação que trava linhas de documento usa `SKIP LOCKED` em ordem
 *    de id (nunca espera um registro de minuta em curso, nunca deadlock entre
 *    a CLI e o tick) e nenhuma E/S de rede acontece dentro de transação;
 *  - CARÊNCIA (banco restaurado de backup): a limpeza AUTOMÁTICA só remove na
 *    hora objetos de tentativas recusadas ou incompletas (conteúdo recusado,
 *    origem interrompida, falha do provedor). Objeto COMPLETO de tentativa não
 *    aceita (banco falhou, posse perdida, abandonada) e objeto de documento
 *    FALHOU com conteúdo só saem depois da carência — numa linha do tempo
 *    perdida pela restauração ele pode ter virado documento confirmado. O
 *    `corrigir` (operador, auditado) pode remover antes;
 *  - o `corrigir` só ESCREVE depois de a sanidade passar: bucket acessível e,
 *    havendo documentos confirmados, ao menos um objeto confirmado encontrado
 *    (um `.env` apontando para outro bucket aborta tudo, sem nenhuma escrita).
 */

export interface DepsReconciliacao {
  pool: Pool;
  armazenamento: ArmazenamentoObjetos;
  naoVinculadoExpiraMs: number;
  /** Carência da remoção AUTOMÁTICA de objeto completo nunca vinculado (padrão 30 dias). */
  carenciaRemocaoMs?: number;
}

export const CARENCIA_REMOCAO_PADRAO_MS = 30 * 86_400_000;
/** Motivos de descarte em que a tentativa NÃO deixou objeto completo aceitável: remoção imediata. */
const MOTIVOS_SEM_OBJETO_VALIDO = ['formato_proibido', 'tipo_divergente', 'conteudo_incompativel', 'hash_divergente', 'origem_interrompida', 'armazenamento_falhou'];

export function impressaoChave(chave: string): string {
  return createHash('sha256').update(chave).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Fase de BANCO (rápida, transacional): estados terminais de abandono.
 * ------------------------------------------------------------------ */

export interface ResultadoExpiracao {
  pendentesExpirados: number;
  naoVinculadosExpirados: number;
  tentativasDescartadas: number;
}

async function comTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Expira (sem tocar o armazenamento): PENDENTE vencido com posse livre, e
 * DISPONIVEL nunca vinculado mais velho que o prazo; descarta tentativas de
 * envio cuja posse venceu (processo caiu no meio do PUT). Tudo vira estado
 * "removível" — a remoção dos objetos é a fase seguinte.
 */
export async function expirarAbandonados(
  deps: Pick<DepsReconciliacao, 'pool' | 'naoVinculadoExpiraMs'>, opts: { limite: number; operador?: string | null },
): Promise<ResultadoExpiracao> {
  return comTransacao(deps.pool, async (client) => {
    const { rows: pend } = await client.query(
      `WITH alvo AS (
         SELECT id FROM documentos_armazenados
          WHERE estado = 'PENDENTE' AND expira_em < now() AND (envio_posse_ate IS NULL OR envio_posse_ate < now())
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE documentos_armazenados d
          SET estado = 'FALHOU', motivo_falha = 'upload_abandonado', falhou_em = now(), envio_token = NULL, envio_posse_ate = NULL
         FROM alvo WHERE d.id = alvo.id
       RETURNING d.id, d.organization_id, d.correlacao_id, d.recebido_em`,
      [opts.limite],
    );
    const { rows: naoVinc } = await client.query(
      `WITH alvo AS (
         SELECT id FROM documentos_armazenados
          WHERE estado = 'DISPONIVEL' AND minuta_id IS NULL AND disponivel_em < now() - ($2::bigint * interval '1 millisecond')
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE documentos_armazenados d SET estado = 'FALHOU', motivo_falha = 'upload_abandonado', falhou_em = now()
         FROM alvo WHERE d.id = alvo.id
       RETURNING d.id, d.organization_id, d.correlacao_id, d.recebido_em`,
      [opts.limite, deps.naoVinculadoExpiraMs],
    );
    for (const r of [...pend.map((x) => ({ ...x, origem: 'pendente' })), ...naoVinc.map((x) => ({ ...x, origem: 'nao_vinculado' }))]) {
      await registrarEventoDocumento(client, {
        organizationId: r.organization_id, documentoId: r.id, tipo: 'UPLOAD_ABANDONADO_EXPIRADO', operador: opts.operador ?? null,
        correlacaoId: r.correlacao_id, detalhes: { origem: r.origem, conteudoRecebido: r.recebido_em !== null },
      });
    }
    // Tentativas EM_ANDAMENTO sem posse vigente (documento expirado acima, ou
    // a posse venceu e ninguém reassumiu): descartadas — a chave fica
    // removível — e a posse vencida liberada. Mesma ordem de travas do PUT
    // (documento → tentativa): primeiro os DOCUMENTOS, com SKIP LOCKED (um
    // documento travado por um PUT em curso fica para o próximo ciclo — o
    // próprio PUT descarta a tentativa vencida); depois só as tentativas e a
    // posse desses documentos.
    const { rows: docsTravados } = await client.query(
      `SELECT d.id FROM documentos_armazenados d
        WHERE (d.estado = 'PENDENTE' AND d.envio_posse_ate < now())
           OR EXISTS (SELECT 1 FROM documentos_armazenados_envios e
                       WHERE e.documento_id = d.id AND e.estado = 'EM_ANDAMENTO'
                         AND (d.envio_token IS DISTINCT FROM e.token OR d.envio_posse_ate < now() OR d.estado <> 'PENDENTE'))
        ORDER BY d.id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [opts.limite],
    );
    const ids = docsTravados.map((r) => r.id as string);
    const { rows: tent } = ids.length ? await client.query(
      `UPDATE documentos_armazenados_envios e SET estado = 'DESCARTADO', motivo = 'abandonado', encerrado_em = now()
         FROM documentos_armazenados d
        WHERE d.id = ANY($1::uuid[]) AND e.documento_id = d.id AND e.estado = 'EM_ANDAMENTO'
          AND (d.envio_token IS DISTINCT FROM e.token OR d.envio_posse_ate < now() OR d.estado <> 'PENDENTE')
       RETURNING e.id`,
      [ids],
    ) : { rows: [] as Array<{ id: string }> };
    if (ids.length) {
      await client.query(
        `UPDATE documentos_armazenados SET envio_token = NULL, envio_posse_ate = NULL
          WHERE id = ANY($1::uuid[]) AND estado = 'PENDENTE' AND envio_posse_ate < now()`,
        [ids],
      );
    }
    return { pendentesExpirados: pend.length, naoVinculadosExpirados: naoVinc.length, tentativasDescartadas: tent.length };
  });
}

/* ------------------------------------------------------------------ *
 * Fase de ARMAZENAMENTO (melhor esforço, com orçamento): remoções.
 * ------------------------------------------------------------------ */

export interface ResultadoRemocao {
  objetosRemovidos: number;
  remocoesPendentes: number;
  /** Primeira falha do provedor interrompe a fase (circuito aberto até o próximo ciclo). */
  interrompidaPor: string | null;
}

export async function removerObjetosDescartaveis(
  deps: Pick<DepsReconciliacao, 'pool' | 'armazenamento'>,
  opts: { limite: number; orcamentoMs: number; operador?: string | null; carenciaMs: number },
): Promise<ResultadoRemocao> {
  const inicio = Date.now();
  const r: ResultadoRemocao = { objetosRemovidos: 0, remocoesPendentes: 0, interrompidaPor: null };
  const { rows: tent } = await deps.pool.query(
    `SELECT e.id, e.chave_objeto FROM documentos_armazenados_envios e
      WHERE e.estado = 'DESCARTADO' AND e.objeto_removido_em IS NULL
        AND (e.motivo = ANY($2::text[]) OR e.encerrado_em < now() - ($3::bigint * interval '1 millisecond'))
        AND NOT EXISTS (SELECT 1 FROM documentos_armazenados d WHERE d.chave_objeto = e.chave_objeto)
      ORDER BY e.encerrado_em, e.id LIMIT $1`,
    [opts.limite, MOTIVOS_SEM_OBJETO_VALIDO, opts.carenciaMs],
  );
  const { rows: docs } = await deps.pool.query(
    `SELECT id, organization_id, correlacao_id, chave_objeto FROM documentos_armazenados
      WHERE estado = 'FALHOU' AND minuta_id IS NULL AND chave_objeto IS NOT NULL AND objeto_removido_em IS NULL
        AND (motivo_falha IN ('conteudo_incompativel', 'hash_divergente') OR falhou_em < now() - ($2::bigint * interval '1 millisecond'))
      ORDER BY falhou_em, id LIMIT $1`,
    [opts.limite, opts.carenciaMs],
  );
  const fila = [
    ...tent.map((t) => ({ tipo: 'tentativa' as const, id: t.id as string, chave: t.chave_objeto as string, org: null as string | null, corr: null as string | null })),
    ...docs.map((d) => ({ tipo: 'documento' as const, id: d.id as string, chave: d.chave_objeto as string, org: d.organization_id as string, corr: d.correlacao_id as string })),
  ];
  for (const item of fila) {
    if (Date.now() - inicio > opts.orcamentoMs) { r.remocoesPendentes = fila.length - r.objetosRemovidos; break; }
    try {
      await deps.armazenamento.apagar(item.chave);
    } catch (err) {
      r.interrompidaPor = codigoDeFalhaArmazenamento(err);
      r.remocoesPendentes = fila.length - r.objetosRemovidos;
      break;
    }
    if (item.tipo === 'tentativa') {
      await deps.pool.query(
        `UPDATE documentos_armazenados_envios SET objeto_removido_em = now() WHERE id = $1 AND estado = 'DESCARTADO' AND objeto_removido_em IS NULL`,
        [item.id],
      );
    } else {
      const { rows } = await deps.pool.query(
        `UPDATE documentos_armazenados SET objeto_removido_em = now()
          WHERE id = $1 AND estado = 'FALHOU' AND minuta_id IS NULL AND objeto_removido_em IS NULL RETURNING id`,
        [item.id],
      );
      if (rows.length) {
        await registrarEventoDocumento(deps.pool, {
          organizationId: item.org!, documentoId: item.id, tipo: 'OBJETO_REMOVIDO', operador: opts.operador ?? null, correlacaoId: item.corr,
          detalhes: { motivo: 'nunca_vinculado' },
        });
      }
    }
    r.objetosRemovidos++;
  }
  return r;
}

/* ------------------------------------------------------------------ *
 * Etapa isolada do tick: expiração + remoção, com orçamento.
 * ------------------------------------------------------------------ */

export interface ResultadoLimpezaTick extends ResultadoExpiracao, ResultadoRemocao {
  executada: boolean;
  erro?: string;
}

export async function limpezaAutomaticaDocumentos(
  deps: DepsReconciliacao, opts: { limite?: number; orcamentoMs?: number } = {},
): Promise<ResultadoLimpezaTick> {
  const limite = opts.limite ?? 50;
  const exp = await expirarAbandonados(deps, { limite });
  const rem = await removerObjetosDescartaveis(deps, {
    limite, orcamentoMs: opts.orcamentoMs ?? 20_000, carenciaMs: deps.carenciaRemocaoMs ?? CARENCIA_REMOCAO_PADRAO_MS,
  });
  return { executada: true, ...exp, ...rem };
}

/* ------------------------------------------------------------------ *
 * Diagnóstico e correção (CLI).
 * ------------------------------------------------------------------ */

export interface ProblemaDocumento {
  documentoId: string;
  organizationId: string;
  estado: string;
  vinculado: boolean;
  problema: 'objeto_ausente' | 'tamanho_divergente' | 'hash_divergente' | 'objeto_reapareceu';
}

export interface Diagnostico {
  provedor: string;
  leituraAnonima: 'recusada' | 'PERMITIDA' | 'nao_verificada';
  pendentesExpirados: number;
  possesVencidas: number;
  tentativasAbandonadas: number;
  remocoesPendentes: { tentativas: number; documentos: number };
  naoVinculadosExpirados: number;
  confirmadosVerificados: number;
  problemas: ProblemaDocumento[];
  marcadosAusentes: number;
  orfaos: Array<{ impressao: string; tamanho: number; modificadoEm: string | null }>;
  objetosListados: number;
  /**
   * Contêineres COM demurrage (status derivado dos relógios, hoje operacional)
   * de processos OPEN cuja evidência é LEGADA (minuta técnica só com
   * referência externa, ou só aprovação humana antiga) — bloqueiam o
   * encerramento até o envio do arquivo. Consulta obrigatória do pré-deploy
   * (runbook). `devolucaoSoLegada`: a devolução usada pelos relógios existe só
   * na validação humana antiga (tracking ausente ou diferente) — registrar nova
   * versão a limpa (regra congelada da substituição) e o contêiner passa a
   * esperar a devolução do tracking.
   */
  legadoBloqueante: Array<{
    processoId: string; numeroProcesso: string | null; containerId: string;
    categoria: 'REFERENCIA_EXTERNA' | 'LEGADO_SEM_ARQUIVO'; devolucaoSoLegada: boolean;
  }>;
  /**
   * Contêineres COM demurrage de processos OPEN cuja minuta vigente tem
   * arquivo INTERNO que não está disponível (objeto marcado ausente, inspeção
   * reprovada/pendente, estado) — incidente, não legado.
   */
  arquivoIndisponivelBloqueante: Array<{
    processoId: string; numeroProcesso: string | null; containerId: string; documentoId: string;
    motivo: 'objeto_ausente' | 'inspecao' | 'estado';
  }>;
  /** Objetos de documentos confirmados efetivamente encontrados nesta execução (sanidade do `corrigir`). */
  confirmadosPresentes: number;
  /** Processos OPEN cuja última avaliação de encerramento bloqueou por `minuta_sem_arquivo_disponivel`. */
  bloqueadosSemArquivo: number;
  documentosLegados: number;
}

async function contar(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Lê o objeto inteiro (streaming) e confere SHA-256 e tamanho. */
async function hashConfere(armazenamento: ArmazenamentoObjetos, chave: string, sha256: string, tamanho: number): Promise<boolean> {
  const { corpo } = await armazenamento.ler(chave);
  const v = new VerificadorDownload(sha256, tamanho);
  try {
    await new Promise<void>((resolve, reject) => {
      corpo.on('error', reject);
      v.on('error', reject);
      v.on('finish', resolve);
      v.resume();
      corpo.pipe(v);
    });
    return true;
  } catch {
    corpo.destroy();
    return false;
  }
}

export async function diagnosticar(deps: DepsReconciliacao, opts: { verificarHash?: boolean; listarOrfaos?: boolean } = {}): Promise<Diagnostico> {
  const { pool, armazenamento } = deps;
  const d: Diagnostico = {
    provedor: armazenamento.nome,
    leituraAnonima: 'nao_verificada',
    pendentesExpirados: await contar(pool, `SELECT count(*) n FROM documentos_armazenados WHERE estado = 'PENDENTE' AND expira_em < now()`),
    possesVencidas: await contar(pool, `SELECT count(*) n FROM documentos_armazenados WHERE estado = 'PENDENTE' AND envio_posse_ate < now()`),
    tentativasAbandonadas: await contar(pool,
      `SELECT count(*) n FROM documentos_armazenados_envios e JOIN documentos_armazenados d ON d.id = e.documento_id
        WHERE e.estado = 'EM_ANDAMENTO' AND (d.envio_token IS DISTINCT FROM e.token OR d.envio_posse_ate < now() OR d.estado <> 'PENDENTE')`),
    remocoesPendentes: {
      tentativas: await contar(pool, `SELECT count(*) n FROM documentos_armazenados_envios WHERE estado = 'DESCARTADO' AND objeto_removido_em IS NULL`),
      documentos: await contar(pool, `SELECT count(*) n FROM documentos_armazenados WHERE estado = 'FALHOU' AND chave_objeto IS NOT NULL AND objeto_removido_em IS NULL`),
    },
    naoVinculadosExpirados: await contar(pool,
      `SELECT count(*) n FROM documentos_armazenados WHERE estado = 'DISPONIVEL' AND minuta_id IS NULL
        AND disponivel_em < now() - ($1::bigint * interval '1 millisecond')`, [deps.naoVinculadoExpiraMs]),
    confirmadosVerificados: 0,
    problemas: [],
    marcadosAusentes: await contar(pool, `SELECT count(*) n FROM documentos_armazenados WHERE objeto_ausente_em IS NOT NULL`),
    orfaos: [],
    objetosListados: 0,
    legadoBloqueante: [],
    arquivoIndisponivelBloqueante: [],
    confirmadosPresentes: 0,
    bloqueadosSemArquivo: await contar(pool,
      `SELECT count(*) n FROM processos WHERE apuracao_status = 'OPEN' AND encerramento_bloqueio = 'minuta_sem_arquivo_disponivel'`),
    documentosLegados: await contar(pool, `SELECT count(*) n FROM documentos WHERE minuta_id IS NOT NULL AND armazenado_id IS NULL`),
  };

  // Registros confirmados × objeto (HEAD um a um; --verificar-hash lê e confere o SHA-256).
  const { rows: confirmados } = await pool.query(
    `SELECT id, organization_id, estado, minuta_id, chave_objeto, tamanho_bytes, sha256, objeto_ausente_em
       FROM documentos_armazenados WHERE estado IN ('DISPONIVEL', 'SUBSTITUIDO', 'QUARENTENA') ORDER BY id`,
  );
  const presentes: string[] = [];
  for (const c of confirmados) {
    const i = await armazenamento.inspecionar(c.chave_objeto);
    d.confirmadosVerificados++;
    const base = { documentoId: c.id, organizationId: c.organization_id, estado: c.estado, vinculado: c.minuta_id !== null };
    if (!i.existe) {
      if (c.objeto_ausente_em === null) d.problemas.push({ ...base, problema: 'objeto_ausente' });
      continue;
    }
    d.confirmadosPresentes++;
    presentes.push(c.chave_objeto);
    if (i.tamanho !== Number(c.tamanho_bytes)) { d.problemas.push({ ...base, problema: 'tamanho_divergente' }); continue; }
    if (opts.verificarHash && !(await hashConfere(armazenamento, c.chave_objeto, c.sha256, Number(c.tamanho_bytes)))) {
      d.problemas.push({ ...base, problema: 'hash_divergente' });
      continue;
    }
    if (c.objeto_ausente_em !== null) d.problemas.push({ ...base, problema: 'objeto_reapareceu' });
  }

  // Privacidade: GET sem assinatura num objeto que EXISTE precisa ser recusado.
  const amostra = presentes[0];
  const anonimo = (armazenamento as { leituraAnonimaRecusada?: (chave: string) => Promise<boolean> }).leituraAnonimaRecusada;
  if (amostra && typeof anonimo === 'function') {
    d.leituraAnonima = (await anonimo.call(armazenamento, amostra)) ? 'recusada' : 'PERMITIDA';
  }

  // Órfãos: chaves no armazenamento que o banco não conhece (só relatados).
  if (opts.listarOrfaos !== false) {
    const { rows: conhecidas } = await pool.query(
      `SELECT chave_objeto FROM documentos_armazenados WHERE chave_objeto IS NOT NULL
       UNION SELECT chave_objeto FROM documentos_armazenados_envios`,
    );
    const set = new Set(conhecidas.map((r) => r.chave_objeto as string));
    let continuacao: string | null = null;
    do {
      const pagina = await armazenamento.listar(PREFIXO_CHAVE_DOCUMENTO, continuacao);
      for (const item of pagina.itens) {
        d.objetosListados++;
        if (!set.has(item.chave)) d.orfaos.push({ impressao: impressaoChave(item.chave), tamanho: item.tamanho, modificadoEm: item.modificadoEm?.toISOString() ?? null });
      }
      continuacao = pagina.continuacao;
    } while (continuacao);
  }

  // Contêineres cuja evidência não tem arquivo disponível (pré-deploy e
  // acompanhamento) — mesmo predicado de arquivo do gate de encerramento. A
  // categoria vem do DOCUMENTO da minuta vigente: sem `armazenado_id` é legado
  // por referência; com `armazenado_id` é arquivo interno indisponível
  // (incidente, lista própria); sem minuta técnica vigente, aprovação antiga.
  const { rows: leg } = await pool.query(
    `SELECT p.id AS processo_id, p.numero_processo, c.id AS container_id, vig.id AS minuta_id,
            arq.id AS documento_id, arq.estado AS arquivo_estado, arq.objeto_ausente_em, arq.inspecao,
            (c.effective_return_date IS NOT NULL AND c.tracking_return_date IS DISTINCT FROM c.effective_return_date) AS devolucao_so_legada
       FROM processos p JOIN containers c ON c.processo_id = p.id
       LEFT JOIN LATERAL (
         SELECT m.id FROM minutas m WHERE m.container_id = c.id AND m.regra_avaliacao IS NOT NULL AND m.substituida_por_id IS NULL LIMIT 1
       ) vig ON true
       LEFT JOIN LATERAL (
         SELECT a.id, a.estado, a.objeto_ausente_em, a.inspecao
           FROM documentos dd JOIN documentos_armazenados a ON a.id = dd.armazenado_id AND a.minuta_id = dd.minuta_id
          WHERE dd.minuta_id = vig.id LIMIT 1
       ) arq ON true
      WHERE p.apuracao_status = 'OPEN'
        AND (
          (vig.id IS NOT NULL AND NOT (arq.id IS NOT NULL AND arq.estado = 'DISPONIVEL' AND arq.objeto_ausente_em IS NULL
                                       AND arq.inspecao IN ('NAO_REALIZADA', 'APROVADA')))
          OR (vig.id IS NULL AND EXISTS (
             SELECT 1 FROM minutas ml WHERE ml.container_id = c.id AND ml.regra_avaliacao IS NULL AND ml.estado_minuta = 'VALIDADA')))
      ORDER BY p.id, c.id`,
  );
  // Só bloqueia contêiner COM demurrage (o status é derivado dos relógios — mesmo derivador do gate).
  const pacotes = leg.length ? await new LifecycleRepository(pool).derivarEmLote(leg.map((r) => r.container_id), { hoje: hojeOperacional() }) : new Map();
  for (const r of leg) {
    if (pacotes.get(r.container_id)?.facts.apuracaoDemurrageStatus !== 'DEMURRAGE_CONFIRMADA') continue;
    const id = { processoId: r.processo_id as string, numeroProcesso: r.numero_processo as string | null, containerId: r.container_id as string };
    if (r.documento_id) {
      d.arquivoIndisponivelBloqueante.push({
        ...id, documentoId: r.documento_id,
        motivo: r.objeto_ausente_em !== null ? 'objeto_ausente' : r.arquivo_estado !== 'DISPONIVEL' ? 'estado' : 'inspecao',
      });
    } else {
      d.legadoBloqueante.push({ ...id, categoria: r.minuta_id ? 'REFERENCIA_EXTERNA' : 'LEGADO_SEM_ARQUIVO', devolucaoSoLegada: r.devolucao_so_legada });
    }
  }
  return d;
}

export interface OpcoesCorrecao {
  operador: string;
  motivo: string;
  /** Proporção máxima de confirmados marcados ausentes numa execução (acima disso: configuração errada — aborta a marcação). */
  limiteAusentes?: number;
  verificarHash?: boolean;
  limite?: number;
}

export interface ResultadoCorrecao {
  /** Sanidade reprovada: NENHUMA escrita foi feita (nem expiração, nem remoção, nem marcação). */
  abortado: null | 'armazenamento_inacessivel' | 'nenhum_objeto_confirmado_encontrado';
  expiracao: ResultadoExpiracao | null;
  remocao: ResultadoRemocao | null;
  ausentesMarcados: number;
  restabelecidos: number;
  marcacaoAbortada: boolean;
  diagnostico: Diagnostico | null;
}

/**
 * Correção CONTROLADA (operador e motivo obrigatórios; auditada por evento).
 * Ordem: sanidade (somente leitura) → expiração → remoção (sem carência:
 * decisão do operador) → marcação/desmarcação de ausência.
 */
export async function corrigir(deps: DepsReconciliacao, opts: OpcoesCorrecao): Promise<ResultadoCorrecao> {
  if (!opts.operador?.trim() || !opts.motivo?.trim()) throw new Error('operador e motivo são obrigatórios');
  const operador = opts.operador.trim().slice(0, 200);
  const limite = opts.limite ?? 500;
  const vazio = { expiracao: null, remocao: null, ausentesMarcados: 0, restabelecidos: 0, marcacaoAbortada: false };

  // 1) Sanidade ANTES de qualquer escrita.
  try {
    await deps.armazenamento.verificarAcesso();
  } catch {
    return { abortado: 'armazenamento_inacessivel', ...vazio, diagnostico: null };
  }
  const diag = await diagnosticar(deps, { verificarHash: opts.verificarHash, listarOrfaos: true });
  if (diag.confirmadosVerificados > 0 && diag.confirmadosPresentes === 0) {
    return { abortado: 'nenhum_objeto_confirmado_encontrado', ...vazio, diagnostico: diag };
  }

  // 2) Expiração e remoção de objetos de chaves descartáveis (nunca vinculadas).
  const expiracao = await expirarAbandonados(deps, { limite, operador });
  const remocao = await removerObjetosDescartaveis(deps, { limite, orcamentoMs: 10 * 60_000, operador, carenciaMs: 0 });

  // 3) Ausência: marca (abaixo do limite de proporção) e desmarca o que reapareceu íntegro.
  const ausentes = diag.problemas.filter((p) => p.problema === 'objeto_ausente');
  const proporcao = diag.confirmadosVerificados ? ausentes.length / diag.confirmadosVerificados : 0;
  const limiteAusentes = opts.limiteAusentes ?? 0.2;
  // Muitos "ausentes" de uma vez é sinal de bucket/endpoint errado, não de perda.
  const marcacaoAbortada = ausentes.length > 1 && proporcao > limiteAusentes;
  let ausentesMarcados = 0;
  if (!marcacaoAbortada) {
    for (const p of ausentes) {
      const { rows } = await deps.pool.query(
        `UPDATE documentos_armazenados SET objeto_ausente_em = now()
          WHERE id = $1 AND objeto_ausente_em IS NULL AND estado IN ('DISPONIVEL', 'SUBSTITUIDO', 'QUARENTENA') RETURNING correlacao_id`,
        [p.documentoId],
      );
      if (!rows.length) continue;
      ausentesMarcados++;
      await registrarEventoDocumento(deps.pool, {
        organizationId: p.organizationId, documentoId: p.documentoId, tipo: 'OBJETO_AUSENTE_CONFIRMADO', operador,
        correlacaoId: rows[0].correlacao_id, detalhes: { motivo: opts.motivo.slice(0, 500), vinculado: p.vinculado },
      });
    }
  }
  let restabelecidos = 0;
  for (const p of diag.problemas.filter((x) => x.problema === 'objeto_reapareceu')) {
    const { rows } = await deps.pool.query(
      `UPDATE documentos_armazenados SET objeto_ausente_em = NULL WHERE id = $1 AND objeto_ausente_em IS NOT NULL RETURNING correlacao_id`,
      [p.documentoId],
    );
    if (!rows.length) continue;
    restabelecidos++;
    await registrarEventoDocumento(deps.pool, {
      organizationId: p.organizationId, documentoId: p.documentoId, tipo: 'OBJETO_RESTABELECIDO', operador,
      correlacaoId: rows[0].correlacao_id, detalhes: { motivo: opts.motivo.slice(0, 500), hashVerificado: Boolean(opts.verificarHash) },
    });
  }
  for (const p of diag.problemas.filter((x) => x.problema === 'hash_divergente' || x.problema === 'tamanho_divergente')) {
    await registrarEventoDocumento(deps.pool, {
      organizationId: p.organizationId, documentoId: p.documentoId, tipo: 'INTEGRIDADE_DIVERGENTE', operador,
      detalhes: { origem: 'reconciliacao', problema: p.problema },
    });
  }
  return { abortado: null, expiracao, remocao, ausentesMarcados, restabelecidos, marcacaoAbortada, diagnostico: diag };
}

export { ErroArmazenamento };
