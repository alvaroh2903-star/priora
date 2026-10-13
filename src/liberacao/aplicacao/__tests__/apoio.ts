import '../../../operacional/__tests__/ambiente';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { LogisticsSummary } from '../../../graph/graphService';
import { registrarReferenciaProcesso } from '../../../identidade';
import { resolverContextoOperacional } from '../../../operacional/contexto';
import { FatosDuraveisDeps } from '../../../operacional/requisicao';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { servir } from '../../../operacional/__tests__/http';
import { CourierEstado } from '../../../couriers/courierStore';
import { DocumentoConferido, ValorConferencia, registrarConferenciaCourier, registrarEstadoEnvelope } from '../../../couriers/fatos/courierFatos';
import { AssociacaoVerificada } from '../../../couriers/fatos/linha';
import { ResultadoPersistencia, persistirExtracoesAuditoria } from '../../../auditoria/fatos/extracoes';
import { criarRequireAuth } from '../../../middleware/requireAuth';
import { criarLiberacaoRouter } from '../../../routes/liberacaoRoutes';
import { GatilhosLiberacao, ProjecaoLiberacao, gatilhosLiberacaoPadrao, obterLiberacaoDoProcesso } from '..';

/** Apoio compartilhado pelos testes de banco da L2 e da L4 (só fatos gravados pelos donos; nada de Graph, OCR ou app). */

export async function preparar(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

/* ------------------------------- fatos de origem (pelos donos) ------------------------------- */

/** Processo central criado pelo S6 (origem documental), como a Auditoria faria. */
export async function processo(pool: Pool, c: Cenario, codigo: string): Promise<string> {
  const r = await registrarReferenciaProcesso(pool, c.orgId, codigo, {
    tipo: 'DOCUMENTAL', fonte: 'teste', evidenciaRef: `teste:${codigo}`, observadoEm: new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(r.status, 'RESOLVIDO');
  return (r as { processoId: string }).processoId;
}

export async function conferir(
  pool: Pool, c: Cenario, tracking: string, ref: string, documento: DocumentoConferido, valor: ValorConferencia,
  associacao: AssociacaoVerificada = 'CITADA',
): Promise<string> {
  const r = await registrarConferenciaCourier(pool, c.ctx, {
    trackingBruto: tracking, processoRef: ref, documento, valor,
    proveniencia: { associacao, brutas: associacao === 'CITADA' ? [ref] : [], emitidaEm: new Date() },
  });
  assert.equal(r.status, 'REGISTRADO');
  return (r as { fatoId: string }).fatoId;
}

export async function envelope(pool: Pool, c: Cenario, tracking: string, estado: CourierEstado): Promise<string> {
  const r = await registrarEstadoEnvelope(pool, c.ctx, { trackingBruto: tracking, estado });
  assert.equal(r.status, 'REGISTRADO');
  return (r as { fatoId: string }).fatoId;
}

/** Extração de MBL legível de um e-mail que cita o processo → vínculo S2 (cria o processo se preciso). */
export async function vincular(
  pool: Pool, c: Cenario, ref: string, mbl: string, opcoes: { messageId?: string; recebidaEm?: string } = {},
): Promise<ResultadoPersistencia[]> {
  return persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: opcoes.messageId ?? `msg-${ref}-${mbl}`, internetMessageId: null, attachmentId: `anexo-${mbl}`, attachmentNome: 'MBL.pdf',
      contentType: 'application/pdf', remetente: 'agente@agente.com',
      recebidaEm: new Date(opcoes.recebidaEm ?? '2026-09-01T08:00:00Z'), referenciasBrutas: [ref], associacao: 'CITADA',
    },
    resultado: { tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: true, conhecimento: mbl },
    modelo: 'modelo-teste', extraidaEm: new Date('2026-09-01T09:00:00Z'),
  }]);
}

export const idDoProcesso = async (pool: Pool, c: Cenario, codigo: string): Promise<string> =>
  (await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`, [c.orgId, codigo])).rows[0].id;

export const eventos = (pool: Pool, processoId: string) =>
  contar(pool, `SELECT count(*) n FROM liberacao_avaliacao_eventos WHERE processo_id = $1`, [processoId]);

export async function projecao(pool: Pool, c: Cenario, processoId: string): Promise<ProjecaoLiberacao> {
  const p = await obterLiberacaoDoProcesso(pool, c.orgId, processoId);
  assert.ok(p, 'projeção existe');
  return p!;
}

export const gatilhos = (pool: Pool): GatilhosLiberacao => gatilhosLiberacaoPadrao(() => pool);

/**
 * Cenário com o token da caixa monitorada CONFIRMADO utilizável (o que a
 * verificação de token do servidor registra). Sem isso a caixa nasce
 * `desconhecido`, que a L2 trata como indisponível (teste 21).
 */
export async function cenarioConfirmado(pool: Pool, slug: string): Promise<Cenario> {
  const c = await cenario(pool, slug);
  await pool.query(`UPDATE email_caixas SET token_estado = 'disponivel', token_verificado_em = now() WHERE id = $1`, [c.caixaId]);
  return c;
}

/** Nada de defaults inventados para integrações futuras. */
export const INVENTADOS = ['NAO_PAGO', 'SEM_PRAZO', 'SEM_TERMO', 'SEM_TELEX', 'MASTER_NAO_LOCALIZADO', 'APRESENTACAO_PENDENTE', 'CE_AUSENTE', 'FISCAL_PENDENTE', 'EM_TRANSITO'];
export function semInvencao(p: ProjecaoLiberacao): void {
  const json = JSON.stringify(p.avaliacao);
  for (const termo of INVENTADOS) assert.ok(!json.includes(termo), `nada inventado: ${termo}`);
}

/** Pool cujo cliente falha ao gravar a linha atual (DEPOIS do evento): simula queda no meio da transação. */
export function poolQueFalhaNaLinhaAtual(pool: Pool): Pool {
  return {
    connect: async () => {
      const c = await pool.connect();
      return new Proxy(c, {
        get(alvo, prop) {
          if (prop === 'query') {
            return (sql: string, params?: unknown[]) => {
              if (typeof sql === 'string' && sql.includes('INSERT INTO liberacao_avaliacoes')) throw new Error('queda simulada');
              return alvo.query(sql, params as any[]);
            };
          }
          const v = (alvo as any)[prop];
          return typeof v === 'function' ? v.bind(alvo) : v;
        },
      });
    },
  } as unknown as Pool;
}

export function poolQuebrado(): Pool {
  const falha = async () => { throw new Error('banco fora (simulado)'); };
  return { connect: falha, query: falha } as unknown as Pool;
}

/* --------------------------------------- rotas --------------------------------------- */

export const usuarioDe = async (pool: Pool, home: string) =>
  (await pool.query(`SELECT id, nome FROM usuarios WHERE home_account_id = $1`, [home])).rows[0] as { id: string; nome: string };

export async function sessaoDePessoa(pool: Pool, home: string) {
  const u = await usuarioDe(pool, home);
  return { pessoa: { usuarioId: u.id, homeAccountId: home, nome: u.nome, autenticadaEm: new Date().toISOString() } };
}

export async function routerLiberacao(pool: Pool, c: Cenario, sessao: () => Record<string, unknown>, ligado = true) {
  const router = criarLiberacaoRouter({
    habilitado: () => ligado,
    pool: () => pool,
    // O requireAuth REAL (S4): a organização sai da caixa monitorada → membership da pessoa.
    auth: criarRequireAuth({
      contaAtiva: () => ({ homeAccountId: c.homeCaixa, username: 'operacao', connectedAt: new Date().toISOString() }),
      pool: () => pool,
      tokenDaCaixa: async () => 'token-da-caixa',
    }),
  });
  const { Router } = await import('express');
  const raiz = Router();
  raiz.use('/liberacao', router);
  return servir(raiz, sessao as any);
}

export function fatosDeps(pool: Pool, c: Cenario): FatosDuraveisDeps {
  return {
    habilitado: () => true,
    pool: () => pool,
    contexto: (req) => resolverContextoOperacional(pool, {
      caixaHomeAccountId: c.homeCaixa,
      pessoa: req.session?.homeAccountId ? { homeAccountId: req.session.homeAccountId } : null,
    }),
  };
}

export function msg(id: string, subject: string, body: string): LogisticsSummary {
  return {
    id, conversationId: `c-${id}`, subject, bodyPreview: body.slice(0, 40), body: { contentType: 'text', content: body },
    from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: '2026-10-01T10:00:00Z',
    isRead: true, hasAttachments: false, webLink: `https://outlook/${id}`,
  };
}
