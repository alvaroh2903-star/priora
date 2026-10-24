import { NextFunction, Request, Response } from 'express';
import { lerCookie } from './transacaoOAuth';

/**
 * Defesa contra CSRF nas escritas humanas (`/api/*` e `/auth/*`), além do
 * cookie de sessão `SameSite=Lax` (que já não viaja em POST de outro site):
 * um POST/PUT/PATCH/DELETE só passa quando
 *  - `Origin` (ou, sem ele, `Referer`) é a PRÓPRIA origem da requisição
 *    (`protocolo://Host` — ambos postos pelo navegador da vítima, que um site
 *    terceiro não controla) ou uma das origens configuradas em
 *    `PRIORA_ORIGENS_PERMITIDAS`; ou
 *  - não há `Origin` nem `Referer` E a requisição não carrega o cookie de
 *    sessão (cliente não-navegador, testes — nada de sessão para abusar).
 * `Origin: null` (iframe sandbox, redirecionamento opaco) e escrita com
 * cookie de sessão sem nenhum dos dois cabeçalhos são recusados: navegadores
 * atuais sempre enviam `Origin` em POST.
 * O handoff M2M (HMAC) é montado antes e não passa por aqui.
 */
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

function origemDe(valor: string): string | null {
  try {
    const u = new URL(valor);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export interface OpcoesVerificarOrigem {
  /** Nome do cookie da sessão humana (para reconhecer escrita autenticada sem `Origin`). */
  nomeCookieSessao: string;
  /** Origens extras aceitas (ex.: domínio próprio atrás de outro proxy). */
  origensPermitidas?: string[];
}

export function origensPermitidasDoAmbiente(): string[] {
  return (process.env.PRIORA_ORIGENS_PERMITIDAS ?? '')
    .split(',')
    .map((o) => origemDe(o.trim()))
    .filter((o): o is string => o !== null);
}

export function criarVerificarOrigem(opts: OpcoesVerificarOrigem) {
  const extras = new Set(opts.origensPermitidas ?? []);
  return function verificarOrigem(req: Request, res: Response, next: NextFunction): void {
    if (METODOS_SEGUROS.has(req.method)) { next(); return; }
    const esperada = `${req.protocol}://${req.get('host')}`;
    const origin = req.get('origin');
    const referer = req.get('referer');
    let recebida: string | null;
    if (origin !== undefined) recebida = origin === 'null' ? null : origemDe(origin);
    else if (referer !== undefined) recebida = origemDe(referer);
    else if (lerCookie(req, opts.nomeCookieSessao) === null) { next(); return; }
    else recebida = null;
    if (recebida === null || (recebida !== esperada && !extras.has(recebida))) {
      res.status(403).json({ error: 'origem_nao_permitida' });
      return;
    }
    next();
  };
}
