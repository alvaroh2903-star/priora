import { ConfidentialClientApplication, ICachePlugin, InteractionRequiredAuthError, TokenCacheContext } from '@azure/msal-node';
import { Pool } from 'pg';
import { ChavesCache, ErroChaveCache, cifrarCache, decifrarCache } from './cacheCrypto';
import { opcoesMsalIdentidade } from './msalClient';
import { AcessoDaPessoa } from './pessoa';

/**
 * S4 — Outlook do PRÓPRIO Analista (autenticação delegada, decisão 4.3).
 *
 *  - Consentimento explícito e separado do login de identidade: quem só entra
 *    na Priora não concede acesso a e-mail (`/auth/entrar` continua só com
 *    openid/profile).
 *  - Permissões mínimas: `Mail.ReadWrite` (rascunho, leitura do estado e dos
 *    anexos da mensagem para conciliar, descarte do rascunho que a Priora
 *    criou) + `offline_access` (conciliar depois, sem nova interação).
 *    `Mail.Send` só quando a pessoa opta por enviar PELA Priora; sem ele o
 *    Analista envia no próprio Outlook e a Priora concilia.
 *  - A conta é a vinculada à pessoa (`usuarios.home_account_id`) e nunca a da
 *    caixa monitorada; o banco garante as duas coisas de novo.
 *  - Tokens só no cache serializado do MSAL desta pessoa, cifrado (AES-256-GCM,
 *    chave versionada) e amarrado à organização, à membership e à conta.
 *    Nunca em log, sessão, resposta HTTP ou tabela legível.
 *  - DOC-21: a conexão NÃO é sessão. Sobrevive ao logout da Priora e termina por
 *    desconexão da pessoa, revogação pela administração ou invalidação pela
 *    Microsoft (token revogado/expirado → o cache é apagado na hora). Usar a
 *    conexão exige uma sessão autenticada DESSA pessoa (reautenticação depois
 *    do logout): ela só é lida pela membership resolvida da sessão, nunca por
 *    parâmetro — logout não abre a conta para outro usuário.
 */

export const ESCOPOS_OUTLOOK_RASCUNHO = ['offline_access', 'Mail.ReadWrite'];
export const ESCOPO_ENVIO_PELA_PRIORA = 'Mail.Send';
/** Escopos pedidos no consentimento (o OIDC entra junto: o MSAL acrescenta openid/profile). */
export const escoposDoConsentimento = (envioPelaPriora: boolean) =>
  envioPelaPriora ? [...ESCOPOS_OUTLOOK_RASCUNHO, ESCOPO_ENVIO_PELA_PRIORA] : [...ESCOPOS_OUTLOOK_RASCUNHO];

/** Escopo como o Azure devolve (às vezes com o recurso na frente) → nome curto. */
export const escopoCurto = (s: string) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').trim();

/** Dado adicional autenticado do cifrado: um registro não decifra como de outra pessoa, organização ou conta. */
export const idDoCacheDaPessoa = (organizationId: string, membershipId: string, homeAccountId: string) =>
  `outlook-pessoa:${organizationId}:${membershipId}:${homeAccountId}`;

export type MotivoDaDesconexao = 'PELA_PESSOA' | 'REVOGADA_PELA_ADMINISTRACAO' | 'INVALIDADA_PELA_MICROSOFT';

export interface ConexaoOutlook {
  organizationId: string;
  membershipId: string;
  homeAccountId: string;
  username: string;
  escopos: string[];
  estado: 'CONECTADA' | 'DESCONECTADA';
  conectadaEm: string;
  desconectadaEm: string | null;
  motivoDesconexao: MotivoDaDesconexao | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** A conexão da pessoa, sem o cache (nada de token sai daqui). */
export async function conexaoDaPessoa(pool: Pool, organizationId: string, membershipId: string): Promise<ConexaoOutlook | null> {
  const { rows: [r] } = await pool.query(
    `SELECT organization_id, membership_id, home_account_id, username, escopos, estado, conectada_em, desconectada_em, motivo_desconexao
       FROM outlook_conexoes_pessoa WHERE organization_id = $1 AND membership_id = $2`, [organizationId, membershipId]);
  return r ? {
    organizationId: r.organization_id, membershipId: r.membership_id, homeAccountId: r.home_account_id, username: r.username,
    escopos: r.escopos, estado: r.estado, conectadaEm: iso(r.conectada_em)!, desconectadaEm: iso(r.desconectada_em), motivoDesconexao: r.motivo_desconexao,
  } : null;
}

/** A conta é de alguma caixa monitorada ativa? (o Outlook do Analista nunca é a Clara) */
export async function contaEhCaixaMonitorada(pool: Pool, homeAccountId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM email_caixas WHERE home_account_id = $1 AND estado <> 'removida' LIMIT 1`, [homeAccountId]);
  return rows.length > 0;
}

/** Conecta (ou reconecta) o Outlook da pessoa com o cache serializado do MSAL, cifrado. Nova geração a cada conexão. */
export async function gravarConexao(
  pool: Pool, chaves: ChavesCache, acesso: AcessoDaPessoa, conta: { homeAccountId: string; username: string }, escopos: string[],
  cacheSerializado: string, agora: Date,
): Promise<void> {
  const c = cifrarCache(chaves, idDoCacheDaPessoa(acesso.organizationId, acesso.membershipId, conta.homeAccountId), cacheSerializado);
  await pool.query(
    `INSERT INTO outlook_conexoes_pessoa
       (organization_id, membership_id, usuario_id, home_account_id, username, escopos, estado, chave_versao, iv, auth_tag, dados, conectada_em, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, 'CONECTADA', $7, $8, $9, $10, $11, $11)
     ON CONFLICT ON CONSTRAINT outlook_conexoes_pessoa_uma_por_pessoa DO UPDATE SET
       home_account_id = EXCLUDED.home_account_id, username = EXCLUDED.username, escopos = EXCLUDED.escopos, estado = 'CONECTADA',
       chave_versao = EXCLUDED.chave_versao, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, dados = EXCLUDED.dados,
       conectada_em = EXCLUDED.conectada_em, desconectada_em = NULL, motivo_desconexao = NULL, desconectada_por_membership_id = NULL,
       geracao = outlook_conexoes_pessoa.geracao + 1,
       revisao = outlook_conexoes_pessoa.revisao + 1, atualizado_em = EXCLUDED.atualizado_em`,
    [acesso.organizationId, acesso.membershipId, acesso.usuarioId, conta.homeAccountId, conta.username, escopos, c.chaveVersao, c.iv, c.authTag, c.dados, agora],
  );
}

/**
 * Desconecta: apaga o cache cifrado e avança a geração (uma renovação em trânsito não ressuscita os tokens).
 * Registra o motivo e quem desconectou (a própria pessoa ou a administração; ninguém na invalidação pela Microsoft).
 */
export async function desconectarOutlook(
  pool: Pool, organizationId: string, membershipId: string, agora: Date,
  motivo: MotivoDaDesconexao = 'PELA_PESSOA', por: string | null = membershipId,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE outlook_conexoes_pessoa SET estado = 'DESCONECTADA', chave_versao = NULL, iv = NULL, auth_tag = NULL, dados = NULL,
        desconectada_em = $3, motivo_desconexao = $4, desconectada_por_membership_id = $5, geracao = geracao + 1, revisao = revisao + 1, atualizado_em = $3
      WHERE organization_id = $1 AND membership_id = $2 AND estado = 'CONECTADA'`,
    [organizationId, membershipId, agora, motivo, motivo === 'INVALIDADA_PELA_MICROSOFT' ? null : por]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Revogação pela ADMINISTRAÇÃO (DOC-21): um ADMIN da MESMA organização apaga os tokens de uma pessoa (ex.: saída
 * da empresa, conta comprometida). Funciona mesmo se a pessoa já perdeu o acesso. Outra organização: nada muda.
 */
export async function revogarOutlookDaPessoa(pool: Pool, organizationId: string, alvoMembershipId: string, porAdmin: string, agora: Date): Promise<boolean> {
  return desconectarOutlook(pool, organizationId, alvoMembershipId, agora, 'REVOGADA_PELA_ADMINISTRACAO', porAdmin);
}

/**
 * Plugin de cache do MSAL restrito à linha DESTA pessoa e DESTA conta. Lê e
 * decifra antes do acesso; grava (cifrado) só se mudou, só se a conexão ainda
 * é a mesma (geração) e com escrita otimista (revisão). Nunca lança para o MSAL.
 */
export function pluginDoCacheDaPessoa(pool: Pool, chaves: ChavesCache, organizationId: string, membershipId: string, homeAccountId: string): ICachePlugin {
  const id = idDoCacheDaPessoa(organizationId, membershipId, homeAccountId);
  const lidas = new WeakMap<object, { geracao: number; revisao: number } | null>();
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      lidas.set(ctx, null);
      try {
        const { rows: [r] } = await pool.query(
          `SELECT geracao, revisao, chave_versao, iv, auth_tag, dados FROM outlook_conexoes_pessoa
            WHERE organization_id = $1 AND membership_id = $2 AND home_account_id = $3 AND estado = 'CONECTADA'`,
          [organizationId, membershipId, homeAccountId]);
        if (!r) return;
        ctx.tokenCache.deserialize(decifrarCache(chaves, id, { chaveVersao: r.chave_versao, iv: r.iv, authTag: r.auth_tag, dados: r.dados }));
        lidas.set(ctx, { geracao: r.geracao, revisao: r.revisao });
      } catch {
        lidas.set(ctx, null); // chave errada, adulteração ou banco fora: segue sem cache e não grava
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      const l = lidas.get(ctx);
      if (!ctx.cacheHasChanged || !l) return;
      try {
        const c = cifrarCache(chaves, id, ctx.tokenCache.serialize());
        await pool.query(
          `UPDATE outlook_conexoes_pessoa SET chave_versao = $6, iv = $7, auth_tag = $8, dados = $9, revisao = revisao + 1, atualizado_em = now()
            WHERE organization_id = $1 AND membership_id = $2 AND home_account_id = $3 AND estado = 'CONECTADA' AND geracao = $4 AND revisao = $5`,
          [organizationId, membershipId, homeAccountId, l.geracao, l.revisao, c.chaveVersao, c.iv, c.authTag, c.dados]);
      } catch {
        // Falha ao gravar a renovação: o próximo acesso renova de novo a partir do cache gravado.
      }
    },
  };
}

type ClienteSilencioso = Pick<ConfidentialClientApplication, 'getTokenCache' | 'acquireTokenSilent'>;

export interface DepsOutlookDaPessoa {
  pool: Pool;
  /** null = chave do cache ausente/inválida: nada de token de pessoa (falha segura). */
  chaves: ChavesCache | null;
  /** Fábrica do cliente MSAL com o plugin da pessoa (injetável nos testes). */
  msal?: (plugin: ICachePlugin) => ClienteSilencioso;
}

export type DisponibilidadeDoOutlook =
  | { tipo: 'DISPONIVEL'; accessToken: string; contaMicrosoft: string; envioPelaPrioraPermitido: boolean }
  | { tipo: 'INDISPONIVEL'; motivo: 'NAO_CONECTADO' | 'CONTA_DIFERENTE_DA_PESSOA' | 'ARMAZENAMENTO_SEGURO_INDISPONIVEL' | 'RECONEXAO_NECESSARIA' | 'CONTA_E_CAIXA_MONITORADA' };

const clientePadrao = (plugin: ICachePlugin): ClienteSilencioso =>
  new ConfidentialClientApplication({ ...opcoesMsalIdentidade(), cache: { cachePlugin: plugin } });

/** Token delegado da PRÓPRIA pessoa para o Outlook dela, renovado a partir do cache cifrado. */
export async function tokenDoOutlookDaPessoa(deps: DepsOutlookDaPessoa, acesso: AcessoDaPessoa): Promise<DisponibilidadeDoOutlook> {
  if (!deps.chaves) return { tipo: 'INDISPONIVEL', motivo: 'ARMAZENAMENTO_SEGURO_INDISPONIVEL' };
  const conexao = await conexaoDaPessoa(deps.pool, acesso.organizationId, acesso.membershipId);
  if (!conexao || conexao.estado !== 'CONECTADA') return { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' };
  if (conexao.homeAccountId !== acesso.homeAccountId) return { tipo: 'INDISPONIVEL', motivo: 'CONTA_DIFERENTE_DA_PESSOA' };
  if (await contaEhCaixaMonitorada(deps.pool, conexao.homeAccountId)) return { tipo: 'INDISPONIVEL', motivo: 'CONTA_E_CAIXA_MONITORADA' };
  const cliente = (deps.msal ?? clientePadrao)(pluginDoCacheDaPessoa(deps.pool, deps.chaves, acesso.organizationId, acesso.membershipId, conexao.homeAccountId));
  try {
    const account = await cliente.getTokenCache().getAccountByHomeId(conexao.homeAccountId);
    if (!account) return { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' };
    const r = await cliente.acquireTokenSilent({ account, scopes: ['Mail.ReadWrite'] });
    if (!r?.accessToken) return { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' };
    return {
      tipo: 'DISPONIVEL', accessToken: r.accessToken, contaMicrosoft: conexao.homeAccountId,
      envioPelaPrioraPermitido: conexao.escopos.map(escopoCurto).includes(ESCOPO_ENVIO_PELA_PRIORA),
    };
  } catch (e) {
    if (e instanceof ErroChaveCache) return { tipo: 'INDISPONIVEL', motivo: 'ARMAZENAMENTO_SEGURO_INDISPONIVEL' };
    // DOC-21: a Microsoft não renova mais (consentimento revogado, senha trocada, token expirado): os tokens guardados não
    // servem e saem na hora. Falha transitória (rede) não desconecta: só não há token agora.
    if (e instanceof InteractionRequiredAuthError) {
      await desconectarOutlook(deps.pool, acesso.organizationId, acesso.membershipId, new Date(), 'INVALIDADA_PELA_MICROSOFT', null).catch(() => undefined);
    }
    return { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' };
  }
}
