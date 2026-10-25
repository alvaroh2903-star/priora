import { Pool, PoolClient } from 'pg';
import { lockProcesso } from '../closing/materialChangeGuard';
import { PAPEIS_RESOLUCAO_PENDENCIA, PendenciaResolucaoError } from '../registro/pendencias';

/**
 * Divergência SI × Master do Master Free Time — ações do gestor e entrega dos
 * avisos. Reconhecer/resolver muda só o estado corrente e grava evento
 * append-only; nunca apaga observações (o ledger e o histórico permanecem).
 *
 * Entregas: outbox PRÓPRIO (`ft_divergencia_entregas`). O outbox de incidentes
 * de tracking (`tracking_alert_deliveries` / `registrarEntregaOrg`) é atado a
 * `tracking_incidents` por FK e não é reutilizável aqui. O canal concreto é
 * injetado pela porta `AvisoDivergenciaTransport` (como `AlertTransport`).
 *
 * Fase D15-B (R55) — até aqui, `usuario` era um TEXT livre informado pelo
 * CHAMADOR (nenhum RBAC real) e `motivo` era opcional mesmo na resolução.
 * Agora `autorMembershipId` é resolvido contra `organization_memberships`
 * DENTRO da mesma transação (mesma régua de `resolverPendenciaManualComClient`,
 * `registro/pendencias.ts`) e `motivo` é OBRIGATÓRIO e não-vazio ao resolver
 * (reconhecer, que não encerra a divergência, continua com motivo opcional).
 *
 * Produção P1 (migration 0049) — membership DESATIVADO: não reconhece nem
 * resolve (o `FOR SHARE` do autor segura a desativação até o COMMIT) e não
 * recebe aviso — a entrega enfileirada antes da desativação nunca é
 * reivindicada nem lida para envio (fica PENDING até uma reativação; mesma
 * régua de `processarAvisosPendenciaPendentes` para o papel).
 *
 * Produção P1 (auditoria corretiva, migration 0050) — a entrega do
 * RESPONSÁVEL OPERACIONAL segue o responsável ATUAL do processo: uma
 * reatribuição vale imediatamente (`redirecionarAvisosDoResponsavelComClient`,
 * chamada na transação da atribuição e, de novo, pelo worker sob o lock do
 * processo antes de cada envio). Ver o cabeçalho de
 * `processarAvisosDivergenciaPendentes`.
 */

/** Papéis que recebem a entrega de GESTOR. */
const PAPEIS_GESTOR = ['MANAGER', 'ADMIN'];
/** Papéis internos (responsável operacional nunca é CLIENT — trigger 0007). */
const PAPEIS_INTERNOS = ['ANALYST', 'MANAGER', 'ADMIN'];

export interface ResultadoRedirecionamento {
  /** Entregas do(s) responsável(is) anterior(es) invalidadas (`SUPERADA`). */
  superadas: number;
  /** Entregas criadas para o responsável atual. */
  criadas: number;
  /** Entregas do responsável atual reativadas (ele já tinha uma superada desta ocorrência). */
  reativadas: number;
  /** Entregas do responsável anterior que continua gestor ativo: passam a ser a entrega de GESTOR dele. */
  convertidasParaGestor: number;
  /** Entrega de gestor do responsável atual (ainda não enviada) que passa a ser a de responsável. */
  convertidasParaResponsavel: number;
}

/**
 * Alinha as entregas AINDA NÃO ENVIADAS do responsável operacional de um
 * processo ao responsável ATUAL. PRECONDIÇÃO: o chamador já adquiriu
 * `lockProcesso` e travou a linha do processo nesta transação (a atribuição
 * com `FOR UPDATE`, o worker com `FOR SHARE`) — as duas serializam aqui.
 *
 * Regra: em cada ocorrência, UMA entrega por pessoa (UNIQUE da 0024) e o
 * TIPO dela segue o papel de agora — `responsavel_operacional` para o
 * responsável atual, `gestor` para quem é MANAGER/ADMIN ativo e não é o
 * responsável, nenhuma (`SUPERADA`) para os demais.
 *
 *  - responsável atual R = o membership gravado no processo, se for interno,
 *    ATIVO e da MESMA organização; senão "sem responsável";
 *  - entrega `responsavel_operacional` deste processo endereçada a OUTRO
 *    membership, em PENDING/FAILED ou em PROCESSING ainda NÃO confirmado
 *    pelo worker: se o destinatário continua gestor ativo, vira a entrega de
 *    GESTOR dele (preserva as tentativas); senão vira `SUPERADA` (motivo,
 *    instante e a entrega que a substitui) — nunca será enviada. SENT e envio
 *    já confirmado não mudam (o envio confirmado foi decidido quando a pessoa
 *    era a responsável);
 *  - só a ocorrência VIGENTE de divergência não resolvida ganha a entrega de
 *    R; numa divergência resolvida (ou ocorrência anterior) as entregas do
 *    anterior viram `SUPERADA` com motivo `ocorrencia_encerrada`, sem
 *    substituta (uma reatribuição nunca cria aviso de divergência encerrada);
 *  - havendo R, cada ocorrência vigente afetada — inclusive a LACUNA de uma
 *    retirada: ocorrência que passou por "sem responsável" (evento
 *    `aviso_redirecionado` com destino `sem_responsavel`) e hoje não tem
 *    entrega de responsável não superada, seja porque a do anterior foi
 *    superada, seja porque virou a de gestor dele — ganha a entrega de R: reativa a que
 *    R já tinha e fora superada (preservando as tentativas — `FAILED` se já
 *    houve tentativa), converte a de gestor de R ainda não enviada, ou cria
 *    uma; se R já tem entrega enviada/confirmada/ativa daquela ocorrência,
 *    nada é criado. Reatribuições em sequência nunca multiplicam envios nem
 *    entram em laço;
 *  - cada ocorrência tratada grava o evento `aviso_redirecionado`.
 */
export async function redirecionarAvisosDoResponsavelComClient(
  client: PoolClient,
  input: { organizationId: string; processoId: string; autor: string },
): Promise<ResultadoRedirecionamento> {
  const out: ResultadoRedirecionamento = { superadas: 0, criadas: 0, reativadas: 0, convertidasParaGestor: 0, convertidasParaResponsavel: 0 };
  const { rows: pr } = await client.query(
    `SELECT p.responsavel_operacional_membership_id AS gravado, m.id AS ativo
       FROM processos p
       LEFT JOIN organization_memberships m
              ON m.id = p.responsavel_operacional_membership_id AND m.organization_id = p.organization_id
             AND m.desativado_em IS NULL AND m.papel::text = ANY($3::text[])
      WHERE p.id = $1 AND p.organization_id = $2`,
    [input.processoId, input.organizationId, PAPEIS_INTERNOS],
  );
  if (!pr.length) return out;
  const gravado: string | null = pr[0].gravado ?? null;
  const atual: string | null = pr[0].ativo ?? null;
  // (a) entregas de responsável ainda não enviadas de OUTRA pessoa.
  const { rows: linhas } = await client.query(
    `SELECT e.id, e.divergencia_id, e.ocorrencia_seq, e.destinatario_membership_id, e.status,
            (d.estado <> 'resolvida' AND e.ocorrencia_seq = d.ocorrencia_seq) AS vigente,
            (m.desativado_em IS NULL AND m.papel::text = ANY($4::text[])) AS gestor_ativo,
            false AS orfa
       FROM ft_divergencia_entregas e
       JOIN ft_divergencias d ON d.id = e.divergencia_id AND d.organization_id = e.organization_id
       JOIN organization_memberships m ON m.id = e.destinatario_membership_id AND m.organization_id = e.organization_id
      WHERE d.processo_id = $1 AND e.organization_id = $2
        AND e.destinatario_tipo = 'responsavel_operacional'
        AND e.destinatario_membership_id IS DISTINCT FROM $3::uuid
        AND (e.status IN ('PENDING', 'FAILED') OR (e.status = 'PROCESSING' AND e.envio_confirmado_em IS NULL))
      ORDER BY e.id
      FOR UPDATE OF e`,
    [input.processoId, input.organizationId, gravado, PAPEIS_GESTOR],
  );
  // (b) com R: as LACUNAS de uma retirada — ocorrência vigente que já passou por
  // "sem responsável" (evento `aviso_redirecionado` com destino `sem_responsavel`)
  // e hoje não tem NENHUMA entrega de responsável não superada (o anterior foi
  // superado, ou ficou com a entrega convertida para gestor). Suas órfãs
  // (SUPERADA por `sem_responsavel`, sem substituta) vão junto, travadas.
  const lacunas = atual === null ? [] : (await client.query(
    `SELECT d.id AS divergencia_id, d.ocorrencia_seq
       FROM ft_divergencias d
      WHERE d.processo_id = $1 AND d.organization_id = $2 AND d.estado <> 'resolvida'
        AND EXISTS (SELECT 1 FROM ft_divergencia_eventos ev
                     WHERE ev.divergencia_id = d.id AND ev.ocorrencia_seq = d.ocorrencia_seq
                       AND ev.tipo = 'aviso_redirecionado' AND ev.detalhe->>'destino' = 'sem_responsavel')
        AND NOT EXISTS (SELECT 1 FROM ft_divergencia_entregas e
                         WHERE e.divergencia_id = d.id AND e.ocorrencia_seq = d.ocorrencia_seq
                           AND e.destinatario_tipo = 'responsavel_operacional' AND e.status <> 'SUPERADA')
        -- R já recebeu esta ocorrência (como gestor): coberta — nunca reprocessada a cada chamada.
        AND NOT EXISTS (SELECT 1 FROM ft_divergencia_entregas e
                         WHERE e.divergencia_id = d.id AND e.ocorrencia_seq = d.ocorrencia_seq
                           AND e.destinatario_membership_id = $3::uuid AND (e.status = 'SENT' OR e.envio_confirmado_em IS NOT NULL))
      ORDER BY d.id`,
    [input.processoId, input.organizationId, atual],
  )).rows;
  if (!linhas.length && !lacunas.length) return out;

  const porOcorrencia = new Map<string, Array<Record<string, any>>>();
  for (const l of linhas) {
    const k = `${l.divergencia_id}|${l.ocorrencia_seq}`;
    porOcorrencia.set(k, [...(porOcorrencia.get(k) ?? []), l]);
  }
  for (const lac of lacunas) {
    const k = `${lac.divergencia_id}|${lac.ocorrencia_seq}`;
    const { rows: orfas } = await client.query(
      `SELECT id, divergencia_id, ocorrencia_seq, destinatario_membership_id, status, true AS vigente, false AS gestor_ativo, true AS orfa
         FROM ft_divergencia_entregas
        WHERE divergencia_id = $1 AND ocorrencia_seq = $2 AND destinatario_tipo = 'responsavel_operacional'
          AND status = 'SUPERADA' AND superada_motivo = 'sem_responsavel' AND substituida_por_id IS NULL
        ORDER BY id FOR UPDATE`,
      [lac.divergencia_id, lac.ocorrencia_seq],
    );
    // Grupo da lacuna: as órfãs, ou só a marca da ocorrência (o anterior virou gestor).
    porOcorrencia.set(k, [...(porOcorrencia.get(k) ?? []), ...(orfas.length ? orfas
      : [{ id: null, divergencia_id: lac.divergencia_id, ocorrencia_seq: lac.ocorrencia_seq, vigente: true, gestor_ativo: false, orfa: true }])]);
  }
  for (const grupo of porOcorrencia.values()) {
    const { divergencia_id: divergenciaId, ocorrencia_seq: ocorrenciaSeq, vigente } = grupo[0];
    const antigas = grupo.filter((g) => !g.orfa);
    const orfas = grupo.filter((g) => g.orfa);
    // Quem continua gestor ativo (e só numa ocorrência vigente) fica com a entrega, agora de GESTOR.
    const paraGestor = vigente ? antigas.filter((g) => g.gestor_ativo) : [];
    const paraSuperar = antigas.filter((g) => !paraGestor.includes(g));
    let destinoId: string | null = null;
    let destino: 'criada' | 'reativada' | 'convertida' | 'ja_coberta' | 'sem_responsavel' | 'ocorrencia_encerrada' =
      vigente ? 'sem_responsavel' : 'ocorrencia_encerrada';
    if (vigente && atual) {
      const { rows: ex } = await client.query(
        `SELECT id, status, destinatario_tipo, envio_confirmado_em FROM ft_divergencia_entregas
          WHERE divergencia_id = $1 AND ocorrencia_seq = $2 AND destinatario_membership_id = $3 FOR UPDATE`,
        [divergenciaId, ocorrenciaSeq, atual],
      );
      const r = ex[0];
      if (!r) {
        const { rows: ins } = await client.query(
          `INSERT INTO ft_divergencia_entregas (organization_id, divergencia_id, ocorrencia_seq, destinatario_tipo, destinatario_membership_id)
           VALUES ($1, $2, $3, 'responsavel_operacional', $4) RETURNING id`,
          [input.organizationId, divergenciaId, ocorrenciaSeq, atual],
        );
        destinoId = ins[0].id; destino = 'criada'; out.criadas++;
      } else if (r.status === 'SUPERADA') {
        await client.query(
          `UPDATE ft_divergencia_entregas
              SET status = CASE WHEN tentativas > 0 THEN 'FAILED' ELSE 'PENDING' END,
                  superada_em = NULL, superada_motivo = NULL, substituida_por_id = NULL, atualizado_em = now()
            WHERE id = $1`,
          [r.id],
        );
        destinoId = r.id; destino = 'reativada'; out.reativadas++;
      } else if (r.destinatario_tipo === 'gestor' && r.status !== 'SENT' && r.envio_confirmado_em === null) {
        // R tinha a entrega de gestor desta ocorrência, ainda não enviada: ela passa a ser a de
        // responsável (entregável a qualquer papel interno) — R pode não ser mais gestor.
        await client.query(
          `UPDATE ft_divergencia_entregas SET destinatario_tipo = 'responsavel_operacional', atualizado_em = now() WHERE id = $1`,
          [r.id],
        );
        destinoId = r.id; destino = 'convertida'; out.convertidasParaResponsavel++;
      } else {
        destinoId = r.id; destino = 'ja_coberta';
      }
    }
    if (paraGestor.length) {
      await client.query(
        `UPDATE ft_divergencia_entregas
            SET destinatario_tipo = 'gestor',
                status = CASE WHEN status = 'PROCESSING' THEN (CASE WHEN tentativas > 0 THEN 'FAILED' ELSE 'PENDING' END) ELSE status END,
                claim_token = NULL, worker_id = NULL, expira_em = NULL, envio_confirmado_em = NULL, atualizado_em = now()
          WHERE id = ANY($1::uuid[])`,
        [paraGestor.map((g) => g.id as string)],
      );
      out.convertidasParaGestor += paraGestor.length;
    }
    if (paraSuperar.length) {
      await client.query(
        `UPDATE ft_divergencia_entregas
            SET status = 'SUPERADA', superada_em = now(), superada_motivo = $2, substituida_por_id = $3,
                claim_token = NULL, worker_id = NULL, expira_em = NULL, envio_confirmado_em = NULL, atualizado_em = now()
          WHERE id = ANY($1::uuid[])`,
        [paraSuperar.map((g) => g.id as string), !vigente ? 'ocorrencia_encerrada' : atual ? 'responsavel_reatribuido' : 'sem_responsavel', destinoId],
      );
      out.superadas += paraSuperar.length;
    }
    // Órfãs de uma retirada passam a apontar para a entrega que agora cobre a ocorrência.
    const orfasAtendidas = destinoId ? orfas.filter((o) => o.id && o.id !== destinoId).map((o) => o.id as string) : [];
    if (orfasAtendidas.length) {
      await client.query(
        `UPDATE ft_divergencia_entregas SET substituida_por_id = $2, atualizado_em = now() WHERE id = ANY($1::uuid[])`,
        [orfasAtendidas, destinoId],
      );
    }
    await client.query(
      `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
       VALUES ($1, $2, $3, 'aviso_redirecionado', $4, $5)`,
      [input.organizationId, divergenciaId, ocorrenciaSeq, input.autor, JSON.stringify({
        de: antigas.map((g) => g.destinatario_membership_id), para: vigente ? atual : null,
        entregasSuperadas: paraSuperar.map((g) => g.id), convertidasParaGestor: paraGestor.map((g) => g.id),
        orfasAtendidas, entregaDestino: destinoId, destino,
      })],
    );
  }
  return out;
}

export interface AvisoDivergencia {
  entregaId: string;
  organizationId: string;
  divergenciaId: string;
  ocorrenciaSeq: number;
  destinatarioTipo: 'responsavel_operacional' | 'gestor';
  destinatarioEmail: string | null;
  destinatarioNome: string | null;
  processo: string | null;
  mbl: string | null;
  container: string;
  valorShippingInstructions: number;
  valorMasterBl: number;
}

export interface ResultadoEnvioAviso {
  ok: boolean;
  erro?: string;
}

export interface AvisoDivergenciaTransport {
  enviar(aviso: AvisoDivergencia): Promise<ResultadoEnvioAviso>;
}

async function alterarEstado(
  pool: Pool,
  input: { divergenciaId: string; organizationId: string; autorMembershipId: string; motivo?: string },
  alvo: 'reconhecida' | 'resolvida',
): Promise<boolean> {
  if (alvo === 'resolvida' && !(input.motivo ?? '').trim()) {
    throw new PendenciaResolucaoError('MOTIVO_OBRIGATORIO');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: autor } = await client.query(
      `SELECT papel FROM organization_memberships WHERE id = $1 AND organization_id = $2 AND desativado_em IS NULL FOR SHARE`,
      [input.autorMembershipId, input.organizationId],
    );
    if (!autor.length || !PAPEIS_RESOLUCAO_PENDENCIA.includes(autor[0].papel)) {
      throw new PendenciaResolucaoError('AUTOR_NAO_AUTORIZADO', { autorMembershipId: input.autorMembershipId });
    }
    const { rows } = await client.query(
      `SELECT * FROM ft_divergencias WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.divergenciaId, input.organizationId],
    );
    const d = rows[0];
    const permitido = d && (alvo === 'reconhecida' ? ['aberta', 'reaberta'].includes(d.estado) : d.estado !== 'resolvida');
    if (!permitido) { await client.query('ROLLBACK'); return false; }
    if (alvo === 'reconhecida') {
      await client.query(
        `UPDATE ft_divergencias SET estado = 'reconhecida', reconhecida_por = $2, reconhecida_em = now(), atualizado_em = now() WHERE id = $1`,
        [d.id, input.autorMembershipId],
      );
    } else {
      await client.query(
        `UPDATE ft_divergencias SET estado = 'resolvida', resolvida_por = $2, resolvida_em = now(),
           resolvida_motivo = 'manual', atualizado_em = now() WHERE id = $1`,
        [d.id, input.autorMembershipId],
      );
    }
    await client.query(
      `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.organization_id, d.id, d.ocorrencia_seq, alvo, input.autorMembershipId, JSON.stringify({ motivo: input.motivo ?? null, valorSi: d.valor_si, valorMaster: d.valor_master })],
    );
    await client.query('COMMIT');
    return true;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

/** Gestor reconhece a divergência (continua visível; cálculo segue com o Master). */
export function reconhecerDivergencia(pool: Pool, input: { divergenciaId: string; organizationId: string; autorMembershipId: string; motivo?: string }): Promise<boolean> {
  return alterarEstado(pool, input, 'reconhecida');
}

/** Gestor resolve a divergência. Reprocessar o mesmo par de valores não reabre. Motivo OBRIGATÓRIO (R55). */
export function resolverDivergencia(pool: Pool, input: { divergenciaId: string; organizationId: string; autorMembershipId: string; motivo: string }): Promise<boolean> {
  return alterarEstado(pool, input, 'resolvida');
}

export interface ProcessarAvisosInput {
  pool: Pool;
  transport: AvisoDivergenciaTransport;
  workerId: string;
  /** Prazo da posse: PROCESSING vencido é recuperável por outro processo. */
  ttlMs?: number;
  maxTentativas?: number;
  limite?: number;
  /** SÓ TESTE — dispara logo depois de cada claim, antes da revalidação sob lock. */
  _testeAposClaim?: (entregaId: string) => void | Promise<void>;
  /** SÓ TESTE — dispara dentro da transação do redirecionamento (lançar simula falha). */
  _testeNoRedirecionamento?: (entregaId: string) => void | Promise<void>;
}

export interface ProcessarAvisosResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  /** Envios cuja finalização foi recusada: a posse expirou e foi assumida por outro. */
  possePerdida: number;
  /** Entregas do responsável anterior invalidadas no envio (reatribuição) — nunca enviadas. */
  redirecionadas: number;
  /** Destinatário inelegível no instante do envio (desativado/sem papel): posse devolvida, sem enviar. */
  devolvidas: number;
  /** Redirecionamentos que falharam (posse devolvida com a tentativa; refeito na próxima execução). */
  falhasRedirecionamento: number;
  /** Entregas ainda entregáveis ao fim da etapa (não SENT, abaixo do máximo de tentativas). */
  restantes: number;
  /** Entregas FAILED que atingiram o máximo de tentativas (não são mais reivindicadas automaticamente). */
  esgotadas: number;
}

/**
 * Devolve a posse sem enviar e sem consumir a tentativa do claim (o envio não
 * foi tentado): `tentativas` volta EXATAMENTE ao valor de antes do claim. Já
 * no limite (entrega esgotada reivindicada para redirecionar, ou posse vencida
 * recuperada no limite), a entrega fica FAILED — contada como esgotada, nunca
 * um PENDING que nenhum claim alcança.
 */
async function devolverPosse(pool: Pool, claim: { id: string; claim_token: string; tentativas_antes: number }, max: number): Promise<void> {
  await pool.query(
    `UPDATE ft_divergencia_entregas
        SET status = CASE WHEN $3::int >= $4::int THEN 'FAILED' ELSE 'PENDING' END,
            erro = CASE WHEN $3::int >= $4::int THEN COALESCE(erro, 'destinatario_inelegivel_no_envio') ELSE erro END,
            tentativas = $3, claim_token = NULL, worker_id = NULL, expira_em = NULL, envio_confirmado_em = NULL, atualizado_em = now()
      WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
    [claim.id, claim.claim_token, claim.tentativas_antes, max],
  );
}

/**
 * Processa entregas em QUATRO passos, sem nenhuma transação ou lock do
 * PostgreSQL aberto durante o envio externo:
 *
 * 1. CLAIM persistente de EXATAMENTE UMA entrega (UPDATE autocommit com
 *    `FOR UPDATE SKIP LOCKED`): PENDING, FAILED retentável ou PROCESSING com
 *    posse vencida vira PROCESSING com `claim_token` novo, `worker_id` e
 *    `expira_em` — SEM contar tentativa (contada só na confirmação do passo 2). Só é reivindicada entrega de destinatário ELEGÍVEL (gestor:
 *    MANAGER/ADMIN ativo; responsável: interno ativo) ou entrega do
 *    responsável que precisa ser REDIRECIONADA (o processo mudou de
 *    responsável). O ciclo se repete até `limite` ou até não haver entrega.
 * 2. REVALIDAÇÃO numa transação curta, sob `lockProcesso` + a linha do
 *    processo (`FOR SHARE` — serializa com a atribuição): posse ainda
 *    vigente; mesma ORGANIZAÇÃO da entrega, do processo e do membership;
 *    membership ATIVO e com o papel do tipo da entrega; e, para o
 *    responsável, que ele AINDA é o responsável do processo. Se não for
 *    mais, a entrega é redirecionada (`redirecionarAvisosDoResponsavelComClient`)
 *    e nunca enviada a ele; inelegível temporário (desativado) → posse
 *    devolvida sem consumir a tentativa. Elegível → `envio_confirmado_em` +
 *    leitura do conteúdo + a tentativa contada, COMMIT. Entrega esgotada
 *    reivindicada para redirecionar nunca é enviada além do limite.
 * 3. ENVIO pelo transporte, fora de transação.
 * 4. FINALIZAÇÃO numa transação nova, aceita só se o `claim_token` ainda for o
 *    vigente: SENT, ou FAILED + evento `aviso_falhou`. Se a posse expirou e foi
 *    assumida por outro processo, nada é gravado (o dono atual finaliza).
 *
 * Ponto de linearização entre reatribuição e envio: a confirmação do passo 2.
 * Uma reatribuição que comita ANTES dela redireciona a entrega (o anterior
 * nunca a recebe; o atual recebe). Uma que comita DEPOIS encontra a entrega
 * já confirmada — envio decidido enquanto a pessoa era a responsável — e não
 * a toca: ela é o aviso de responsável daquela ocorrência (como uma já SENT),
 * e nenhuma entrega nova é criada (o novo responsável vê a divergência aberta
 * na própria fila). Se esse envio confirmado FALHAR, a entrega volta FAILED
 * ainda endereçada ao anterior e a próxima execução a redireciona ao atual.
 * Em qualquer ordem: no máximo um aviso de responsável entregue por
 * ocorrência e nenhuma pessoa recebe a mesma ocorrência duas vezes (UNIQUE).
 *
 * Semântica "ao menos uma vez": se o processo morrer depois de enviar e antes
 * de finalizar, a entrega é recuperada ao vencer o prazo e pode ser reenviada
 * (revalidada de novo no passo 2).
 */
export async function processarAvisosDivergenciaPendentes(input: ProcessarAvisosInput): Promise<ProcessarAvisosResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosResultado = {
    reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0, redirecionadas: 0, devolvidas: 0, falhasRedirecionamento: 0,
    restantes: 0, esgotadas: 0,
  };

  // UMA entrega por ciclo interno: reivindica exatamente uma, revalida, envia,
  // finaliza e só então reivindica a próxima. Uma entrega já tratada NESTA
  // execução não é reivindicada de novo nela (o retry de FAILED fica para as
  // próximas execuções; uma entrega redirecionada para quem acabou de ser
  // criada/reativada é outra linha e pode sair na mesma execução).
  const processadas: string[] = [];
  for (let i = 0; i < limite; i++) {
    const { rows: claims } = await input.pool.query(
      `WITH alvo AS (
          SELECT x.id, x.tentativas AS tentativas_antes, x.status AS status_antes,
                 (x.envio_confirmado_em IS NOT NULL) AS confirmado_antes FROM ft_divergencia_entregas x
            JOIN ft_divergencias d ON d.id = x.divergencia_id
            JOIN processos p ON p.id = d.processo_id
            JOIN organization_memberships m ON m.id = x.destinatario_membership_id
           WHERE NOT (x.id = ANY($4::uuid[]))
             AND (
               -- posse vencida: recuperada (a revalidação decide o que fazer)
               (x.status = 'PROCESSING' AND x.expira_em < now())
               -- entrega do responsável ANTERIOR: redirecionada, qualquer que seja o número de tentativas
               OR (x.status IN ('PENDING', 'FAILED') AND x.destinatario_tipo = 'responsavel_operacional'
                   AND p.responsavel_operacional_membership_id IS DISTINCT FROM x.destinatario_membership_id)
               -- envio normal: abaixo do limite e destinatário elegível AGORA
               OR (x.status IN ('PENDING', 'FAILED') AND x.tentativas < $3 AND m.desativado_em IS NULL AND (
                    (x.destinatario_tipo = 'gestor' AND m.papel::text = ANY($5::text[]))
                    OR (x.destinatario_tipo = 'responsavel_operacional' AND m.papel::text = ANY($6::text[])
                        AND p.responsavel_operacional_membership_id = x.destinatario_membership_id)))
             )
           ORDER BY x.criado_em, x.id
           FOR UPDATE OF x SKIP LOCKED
           LIMIT 1)
       UPDATE ft_divergencia_entregas e
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1, envio_confirmado_em = NULL,
              expira_em = now() + ($2 || ' seconds')::interval, atualizado_em = now()
         FROM alvo
        WHERE e.id = alvo.id
        RETURNING e.id, e.claim_token, alvo.tentativas_antes, alvo.status_antes, alvo.confirmado_antes`,
      [input.workerId, String(ttl), max, processadas, PAPEIS_GESTOR, PAPEIS_INTERNOS],
    );
    const claim = claims[0];
    if (!claim) break; // nada elegível
    out.reivindicadas++;
    processadas.push(claim.id);
    if (input._testeAposClaim) await input._testeAposClaim(claim.id);

    // 2) REVALIDAÇÃO sob o lock do processo. O processo da entrega é
    //    estável (a FK da divergência nunca muda) — lido sem lock para
    //    adquirir o consultivo ANTES de qualquer linha (ordem universal).
    const { rows: rota } = await input.pool.query(
      `SELECT d.processo_id FROM ft_divergencia_entregas e JOIN ft_divergencias d ON d.id = e.divergencia_id WHERE e.id = $1`,
      [claim.id],
    );
    if (!rota.length) { await devolverPosse(input.pool, claim, max); out.devolvidas++; continue; }
    const processoId: string = rota[0].processo_id;

    let e: any = null;
    const client = await input.pool.connect();
    try {
      await client.query('BEGIN');
      await lockProcesso(client, processoId);
      const { rows: ent } = await client.query(
        `SELECT * FROM ft_divergencia_entregas WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2 FOR UPDATE`,
        [claim.id, claim.claim_token],
      );
      if (!ent.length) {
        // A posse acabou (outra execução recuperou a entrega, ou uma
        // reatribuição a superou enquanto este worker esperava o lock).
        await client.query('ROLLBACK');
        out.possePerdida++;
        continue;
      }
      const entrega = ent[0];
      const { rows: pr } = await client.query(
        `SELECT p.responsavel_operacional_membership_id AS responsavel
           FROM processos p WHERE p.id = $1 AND p.organization_id = $2 FOR SHARE`,
        [processoId, entrega.organization_id],
      );
      const { rows: dst } = await client.query(
        `SELECT m.papel::text AS papel, m.desativado_em, u.email, u.nome
           FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id
          WHERE m.id = $1 AND m.organization_id = $2`,
        [entrega.destinatario_membership_id, entrega.organization_id],
      );
      const papeisDoTipo = entrega.destinatario_tipo === 'gestor' ? PAPEIS_GESTOR : PAPEIS_INTERNOS;
      const elegivel = pr.length > 0 && dst.length > 0 && dst[0].desativado_em === null && papeisDoTipo.includes(dst[0].papel);
      const aindaResponsavel = pr.length > 0 && pr[0].responsavel === entrega.destinatario_membership_id;

      if (entrega.destinatario_tipo === 'responsavel_operacional' && !aindaResponsavel) {
        // Reatribuído (ou sem responsável): nunca envia ao anterior.
        try {
          if (input._testeNoRedirecionamento) await input._testeNoRedirecionamento(claim.id);
          await redirecionarAvisosDoResponsavelComClient(client, {
            organizationId: entrega.organization_id, processoId, autor: `worker:${input.workerId}`,
          });
          await client.query('COMMIT');
          out.redirecionadas++;
        } catch {
          await client.query('ROLLBACK').catch(() => undefined);
          // A falha do redirecionamento nunca consome a tentativa: a posse
          // volta (PENDING, tentativa devolvida) e a próxima execução refaz.
          await devolverPosse(input.pool, claim, max);
          out.falhasRedirecionamento++;
        }
        continue;
      }
      // Entrega no limite nunca é enviada de novo — salvo a recuperação de uma posse
      // vencida cujo envio JÁ tinha sido confirmado ("ao menos uma vez": o envio
      // pode ter saído sem a finalização). Uma esgotada reivindicada para
      // redirecionar (ou uma posse vencida que nunca confirmou) volta a FAILED.
      const esgotada = claim.tentativas_antes >= max && !(claim.status_antes === 'PROCESSING' && claim.confirmado_antes);
      if (!elegivel || esgotada) {
        await client.query('ROLLBACK');
        await devolverPosse(input.pool, claim, max);
        out.devolvidas++;
        continue;
      }
      const { rows: det } = await client.query(
        `SELECT d.valor_si, d.valor_master, c.numero AS container_numero, p.numero_processo, p.mbl
           FROM ft_divergencias d
           JOIN containers c ON c.id = d.container_id AND c.organization_id = d.organization_id
           JOIN processos p ON p.id = d.processo_id AND p.organization_id = d.organization_id
          WHERE d.id = $1 AND d.organization_id = $2`,
        [entrega.divergencia_id, entrega.organization_id],
      );
      if (!det.length) {
        await client.query('ROLLBACK');
        await devolverPosse(input.pool, claim, max);
        out.devolvidas++;
        continue;
      }
      // A tentativa é contada AQUI, quando o envio é decidido — nunca no claim: uma
      // entrega reivindicada e depois superada, devolvida ou redirecionada não
      // carrega uma tentativa que não aconteceu.
      await client.query(
        `UPDATE ft_divergencia_entregas SET envio_confirmado_em = now(), tentativas = LEAST(tentativas + 1, $3)
          WHERE id = $1 AND claim_token = $2`,
        [claim.id, claim.claim_token, max],
      );
      await client.query('COMMIT');
      e = { ...entrega, ...det[0], email: dst[0].email, nome: dst[0].nome };
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw erro;
    } finally {
      client.release();
    }

    // 3) ENVIO fora de qualquer transação.
    let r: ResultadoEnvioAviso;
    try {
      r = await input.transport.enviar({
        entregaId: e.id, organizationId: e.organization_id, divergenciaId: e.divergencia_id, ocorrenciaSeq: e.ocorrencia_seq,
        destinatarioTipo: e.destinatario_tipo, destinatarioEmail: e.email ?? null, destinatarioNome: e.nome ?? null,
        processo: e.numero_processo ?? null, mbl: e.mbl ?? null, container: e.container_numero,
        valorShippingInstructions: e.valor_si, valorMasterBl: e.valor_master,
      });
    } catch (erro: any) {
      r = { ok: false, erro: String(erro?.message ?? erro) };
    }

    // 4) FINALIZAÇÃO condicionada ao token vigente.
    const fin = await input.pool.connect();
    try {
      await fin.query('BEGIN');
      const fim = r.ok
        ? await fin.query(
            `UPDATE ft_divergencia_entregas SET status = 'SENT', claim_token = NULL, expira_em = NULL, erro = NULL,
               envio_confirmado_em = NULL, enviado_em = now(), atualizado_em = now()
             WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
            [claim.id, claim.claim_token],
          )
        : await fin.query(
            `UPDATE ft_divergencia_entregas SET status = 'FAILED', claim_token = NULL, expira_em = NULL, envio_confirmado_em = NULL,
               erro = $3, atualizado_em = now()
             WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
            [claim.id, claim.claim_token, (r.erro ?? 'falha').slice(0, 500)],
          );
      if ((fim.rowCount ?? 0) === 0) {
        await fin.query('ROLLBACK');
        out.possePerdida++;
        continue;
      }
      if (!r.ok) {
        await fin.query(
          `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
           VALUES ($1, $2, $3, 'aviso_falhou', 'transporte', $4)`,
          [e.organization_id, e.divergencia_id, e.ocorrencia_seq, JSON.stringify({ entregaId: e.id, erro: r.erro ?? 'falha' })],
        );
      }
      await fin.query('COMMIT');
      if (r.ok) out.enviadas++; else out.falhadas++;
    } catch (erro) {
      await fin.query('ROLLBACK');
      throw erro;
    } finally {
      fin.release();
    }
  }
  return out;
}
