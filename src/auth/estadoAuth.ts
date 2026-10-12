import crypto from 'crypto';

/**
 * `state` do OAuth ASSINADO (HMAC com o SESSION_SECRET), sem depender da
 * sessão (a instância pode reciclar entre /login e /callback). Carrega um
 * timestamp (validade) e, desde o S4, o MODO do fluxo:
 *  - 'caixa': conectar a caixa Microsoft monitorada (o fluxo legado `/auth/login`);
 *  - 'pessoa': identificar a pessoa (`/auth/entrar`), sem tocar na caixa.
 * Formato: `nonce.ts.modo.assinatura` (a assinatura cobre o modo). O formato
 * legado `nonce.ts.assinatura` continua válido e é sempre 'caixa'.
 */
export type ModoAuth = 'caixa' | 'pessoa';

export const VALIDADE_ESTADO_MS = 15 * 60 * 1000; // 15 min para concluir o login

const assinar = (segredo: string, texto: string) => crypto.createHmac('sha256', segredo).update(texto).digest('hex');

function igual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function criarEstadoAuth(segredo: string, modo: ModoAuth, agora: number = Date.now()): string {
  const carga = `${crypto.randomBytes(16).toString('hex')}.${agora}.${modo}`;
  return `${carga}.${assinar(segredo, carga)}`;
}

/** Modo do fluxo se o `state` for nosso e estiver no prazo; senão null. */
export function lerEstadoAuth(segredo: string, estado: string | undefined, agora: number = Date.now()): ModoAuth | null {
  if (!estado) return null;
  const partes = estado.split('.');
  let modo: ModoAuth;
  let ts: string;
  if (partes.length === 3) {
    const [nonce, t, sig] = partes;
    if (!igual(sig, assinar(segredo, `${nonce}.${t}`))) return null;
    modo = 'caixa';
    ts = t;
  } else if (partes.length === 4) {
    const [nonce, t, m, sig] = partes;
    if (m !== 'caixa' && m !== 'pessoa') return null;
    if (!igual(sig, assinar(segredo, `${nonce}.${t}.${m}`))) return null;
    modo = m;
    ts = t;
  } else {
    return null;
  }
  const idade = agora - Number(ts);
  return Number.isFinite(idade) && idade >= 0 && idade < VALIDADE_ESTADO_MS ? modo : null;
}
