import { NextFunction, Response } from 'express';
import { Pool } from 'pg';
import { classificarFalhaHandoff } from './erros';
import type { HandoffAuthedRequest } from './autenticacaoHttp';

/**
 * Controle de capacidade da rota HTTP do handoff (adição estreita à Entrega
 * 1, autorizada explicitamente pelo usuário).
 *
 * Limita quantas requisições AUTENTICADAS a rota aceita, em duas dimensões
 * independentes — por credencial e por organização (somando todas as
 * credenciais dela). A decisão é tomada INTEIRAMENTE no PostgreSQL, por
 * `demurrage_handoff_capacidade_admitir` (migration 0047): estado durável e
 * compartilhado por todas as instâncias da aplicação, relógio do próprio
 * banco, uma única chamada = uma transação curta, sem chamada externa. Nada
 * em memória do processo participa da decisão (os contadores abaixo são só
 * observabilidade da instância).
 *
 * Posição no fluxo (`demurrageHandoffRoutes.ts`): DEPOIS da autenticação
 * HMAC (credencial, assinatura, timestamp, nonce) e ANTES do parse do corpo,
 * da reivindicação de idempotência (`demurrage_handoff_eventos`) e de
 * qualquer regra de negócio. Requisição recusada aqui nunca chega ao serviço
 * do handoff. Requisição que falhou na autenticação nunca chega aqui (não
 * cria estado de capacidade).
 */

/* ========================================================================= *
 * Configuração (variáveis de ambiente, validação estrita na inicialização).
 * ========================================================================= */

export interface LimiteDimensao {
  /** Tentativas aceitas por minuto (taxa de reposição contínua: limite/60 por segundo). */
  porMinuto: number;
  /** Rajada: capacidade do balde (tentativas imediatas a partir de um balde cheio). */
  rajada: number;
}

export interface ConfigCapacidadeHandoff {
  credencial: LimiteDimensao;
  organizacao: LimiteDimensao;
}

export const CAPACIDADE_HANDOFF_PADRAO: Readonly<ConfigCapacidadeHandoff> = Object.freeze({
  credencial: Object.freeze({ porMinuto: 60, rajada: 10 }),
  organizacao: Object.freeze({ porMinuto: 120, rajada: 20 }),
});

export const VARIAVEIS_CAPACIDADE_HANDOFF = Object.freeze({
  credencialPorMinuto: 'PRIORA_HANDOFF_CAPACIDADE_CREDENCIAL_POR_MINUTO',
  credencialRajada: 'PRIORA_HANDOFF_CAPACIDADE_CREDENCIAL_RAJADA',
  organizacaoPorMinuto: 'PRIORA_HANDOFF_CAPACIDADE_ORGANIZACAO_POR_MINUTO',
  organizacaoRajada: 'PRIORA_HANDOFF_CAPACIDADE_ORGANIZACAO_RAJADA',
});

/** Maior valor aceito (cabe com folga nos tipos `INTEGER`/`NUMERIC(14,6)` da migration 0047). */
export const LIMITE_CAPACIDADE_MAXIMO = 1_000_000;

export class ErroConfigCapacidadeHandoff extends Error {
  constructor(public readonly variavel: string, public readonly valor: string) {
    super(
      `Configuração inválida do controle de capacidade do handoff: ${variavel}=${JSON.stringify(valor)} ` +
      `— esperado um número inteiro positivo entre 1 e ${LIMITE_CAPACIDADE_MAXIMO} (ou a variável ausente, para usar o padrão).`,
    );
    this.name = 'ErroConfigCapacidadeHandoff';
  }
}

function lerInteiroPositivo(env: NodeJS.ProcessEnv, variavel: string, padrao: number): number {
  const bruto = env[variavel];
  // Só a AUSÊNCIA da variável usa o padrão. Qualquer valor presente — inclusive
  // vazio — precisa ser um inteiro positivo; nunca há "desligar o limite".
  if (bruto === undefined) return padrao;
  const texto = bruto.trim();
  if (!/^[1-9][0-9]*$/.test(texto)) throw new ErroConfigCapacidadeHandoff(variavel, bruto);
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n > LIMITE_CAPACIDADE_MAXIMO) throw new ErroConfigCapacidadeHandoff(variavel, bruto);
  return n;
}

/**
 * Lê a configuração do ambiente. Lança `ErroConfigCapacidadeHandoff` (com o
 * nome da variável e o valor recebido — nenhum deles é segredo) para
 * qualquer valor inválido. Chamada na criação do router padrão, ou seja, na
 * IMPORTAÇÃO de `demurrageHandoffRoutes.ts` pelo `index.ts`: configuração
 * inválida derruba a inicialização antes do `listen`.
 */
export function carregarConfigCapacidadeHandoff(env: NodeJS.ProcessEnv = process.env): ConfigCapacidadeHandoff {
  const v = VARIAVEIS_CAPACIDADE_HANDOFF;
  const p = CAPACIDADE_HANDOFF_PADRAO;
  return {
    credencial: {
      porMinuto: lerInteiroPositivo(env, v.credencialPorMinuto, p.credencial.porMinuto),
      rajada: lerInteiroPositivo(env, v.credencialRajada, p.credencial.rajada),
    },
    organizacao: {
      porMinuto: lerInteiroPositivo(env, v.organizacaoPorMinuto, p.organizacao.porMinuto),
      rajada: lerInteiroPositivo(env, v.organizacaoRajada, p.organizacao.rajada),
    },
  };
}

/** Linha de log de inicialização: só os limites efetivos (nenhum segredo existe nesta configuração). */
export function descreverConfigCapacidadeHandoff(cfg: ConfigCapacidadeHandoff): string {
  return (
    `[demurrage-handoff] controle de capacidade ativo: ` +
    `credencial=${cfg.credencial.porMinuto}/min rajada=${cfg.credencial.rajada}; ` +
    `organizacao=${cfg.organizacao.porMinuto}/min rajada=${cfg.organizacao.rajada}`
  );
}

/* ========================================================================= *
 * Decisão (uma chamada atômica ao PostgreSQL).
 * ========================================================================= */

export type DimensaoCapacidade = 'credencial' | 'organizacao';

export type DecisaoCapacidade =
  | { admitida: true }
  | { admitida: false; dimensao: DimensaoCapacidade; retryAfterSegundos: number; proximoPermitidoEm: Date };

/**
 * Avalia e atualiza os DOIS baldes numa única chamada (uma transação curta).
 * Admite só se os dois têm ficha; recusa sem consumir nenhum dos dois.
 */
export async function admitirTentativaHandoff(
  pool: Pool, ids: { credencialId: string; organizationId: string }, cfg: ConfigCapacidadeHandoff,
): Promise<DecisaoCapacidade> {
  const { rows } = await pool.query<{
    admitida: boolean; dimensao: DimensaoCapacidade | null; retry_after_segundos: number | null; proximo_permitido_em: Date | null;
  }>(
    `SELECT admitida, dimensao, retry_after_segundos, proximo_permitido_em
       FROM demurrage_handoff_capacidade_admitir($1, $2, $3, $4, $5, $6)`,
    [
      ids.credencialId, ids.organizationId,
      cfg.credencial.porMinuto, cfg.credencial.rajada, cfg.organizacao.porMinuto, cfg.organizacao.rajada,
    ],
  );
  const r = rows[0];
  if (!r) throw new Error('demurrage_handoff_capacidade_admitir não devolveu decisão');
  if (r.admitida) return { admitida: true };
  return { admitida: false, dimensao: r.dimensao!, retryAfterSegundos: r.retry_after_segundos!, proximoPermitidoEm: r.proximo_permitido_em! };
}

/* ========================================================================= *
 * Observabilidade (mesma convenção do scheduler: contadores simples + linha
 * de log `[prefixo] chave=valor`). Contadores POR INSTÂNCIA; os totais
 * duráveis e compartilhados ficam nas colunas `admitidas_total`/
 * `rejeitadas_total`/`ultima_rejeicao_em` dos baldes (migration 0047).
 * ========================================================================= */

export interface ContadoresCapacidadeHandoff {
  admitidas: number;
  rejeitadasCredencial: number;
  rejeitadasOrganizacao: number;
  falhasInternas: number;
}

const contadores: ContadoresCapacidadeHandoff = { admitidas: 0, rejeitadasCredencial: 0, rejeitadasOrganizacao: 0, falhasInternas: 0 };

/** Cópia dos contadores desta instância desde a inicialização. */
export function contadoresCapacidadeHandoff(): ContadoresCapacidadeHandoff {
  return { ...contadores };
}

function resumoContadores(): string {
  return `admitidas=${contadores.admitidas} rejeitadas_credencial=${contadores.rejeitadasCredencial} ` +
    `rejeitadas_organizacao=${contadores.rejeitadasOrganizacao} falhas=${contadores.falhasInternas}`;
}

/* ========================================================================= *
 * Middleware da rota.
 * ========================================================================= */

/** Corpo ÚNICO e estável da recusa por capacidade — nunca contadores, credencial ou detalhe do banco. */
export const CORPO_LIMITE_TEMPORARIO = Object.freeze({ error: 'limite_temporario' as const });

export interface ControleCapacidadeDeps {
  pool: () => Pool;
  config: ConfigCapacidadeHandoff;
}

export function criarControleCapacidadeHandoff(deps: ControleCapacidadeDeps) {
  return async function controleCapacidadeHandoff(req: HandoffAuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const ctx = req.contextoHandoff;
    let decisao: DecisaoCapacidade;
    try {
      // Só alcançável depois da autenticação, que sempre preenche o contexto;
      // a checagem existe para nunca seguir sem identidade.
      if (!ctx) throw new Error('contexto de autenticação ausente');
      decisao = await admitirTentativaHandoff(deps.pool(), { credencialId: ctx.credencialIdentidade, organizationId: ctx.organizationId }, deps.config);
    } catch (erro) {
      contadores.falhasInternas += 1;
      // Mesma resposta genérica de falha inesperada da rota (nunca `.message`/`.stack`).
      const codigo = classificarFalhaHandoff(erro);
      // eslint-disable-next-line no-console
      console.error(`[demurrage-handoff] capacidade: falha interna ${codigo} — requisição não processada (${resumoContadores()})`);
      res.status(500).json({ resultado: 'FALHA', detalhe: { motivo: codigo } });
      return;
    }

    if (decisao.admitida) {
      contadores.admitidas += 1;
      next();
      return;
    }

    if (decisao.dimensao === 'credencial') contadores.rejeitadasCredencial += 1;
    else contadores.rejeitadasOrganizacao += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[demurrage-handoff] capacidade: 429 dimensao=${decisao.dimensao} organizationId=${ctx!.organizationId} ` +
      `credencialId=${ctx!.credencialIdentidade} retryAfter=${decisao.retryAfterSegundos}s (${resumoContadores()})`,
    );
    res.set('Retry-After', String(decisao.retryAfterSegundos));
    res.status(429).json(CORPO_LIMITE_TEMPORARIO);
  };
}
