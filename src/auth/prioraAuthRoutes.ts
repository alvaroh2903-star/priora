import { Router } from 'express';
import { getSupabase, isSupabaseConfigured } from '../db/supabase';

/**
 * Priora — Auth da CONTA PRIORA (Supabase Auth, e-mail + senha).
 *
 * É o login do SaaS: o usuário cria/entra na sua conta Priora ANTES de conectar
 * a Microsoft. Cada conta Priora terá seu ambiente isolado (RLS por auth.uid()).
 *
 *   POST /api/priora/signup  { email, password }
 *   POST /api/priora/login   { email, password }
 *   POST /api/priora/logout
 *   GET  /api/priora/me
 *
 * Backend-driven: o servidor fala com o Supabase Auth (service role) e guarda o
 * user_id na sessão do Express. A service role NUNCA vai para o navegador.
 */
export const prioraAuthRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Creds {
  email: string;
  password: string;
}

/** Valida e normaliza e-mail + senha do corpo. Null se inválido. */
function parseCreds(body: unknown): Creds | { error: string } {
  const b = (body || {}) as Record<string, unknown>;
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!EMAIL_RE.test(email)) return { error: 'Informe um e-mail válido.' };
  if (password.length < 8) return { error: 'A senha precisa de ao menos 8 caracteres.' };
  return { email, password };
}

function ensureSupabase(res: import('express').Response): boolean {
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: 'Contas Priora indisponíveis: Supabase ainda não configurado.',
    });
    return false;
  }
  return true;
}

/** Cadastro: cria a conta no Supabase Auth (já confirmada) e faz login. */
prioraAuthRouter.post('/signup', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const creds = parseCreds(req.body);
    if ('error' in creds) return res.status(400).json({ error: creds.error });

    const { data, error } = await getSupabase().auth.admin.createUser({
      email: creds.email,
      password: creds.password,
      email_confirm: true, // MVP: sem etapa de confirmação por e-mail
    });
    if (error || !data.user) {
      const exists = /registered|already|exists|duplicate/i.test(error?.message || '');
      return res.status(exists ? 409 : 400).json({
        error: exists
          ? 'Já existe uma conta Priora com esse e-mail.'
          : error?.message || 'Não foi possível criar a conta.',
      });
    }

    req.session.prioraUserId = data.user.id;
    req.session.prioraEmail = data.user.email || creds.email;
    res.json({ ok: true, user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    next(err);
  }
});

/** Login: valida a senha no Supabase Auth e guarda o user_id na sessão. */
prioraAuthRouter.post('/login', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const creds = parseCreds(req.body);
    if ('error' in creds) return res.status(400).json({ error: creds.error });

    const { data, error } = await getSupabase().auth.signInWithPassword({
      email: creds.email,
      password: creds.password,
    });
    if (error || !data.user) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    req.session.prioraUserId = data.user.id;
    req.session.prioraEmail = data.user.email || creds.email;
    res.json({ ok: true, user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    next(err);
  }
});

/** Logout da conta Priora: encerra a sessão inteira. */
prioraAuthRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/** Estado da conta Priora logada (para a UI). */
prioraAuthRouter.get('/me', (req, res) => {
  if (!req.session.prioraUserId) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: { id: req.session.prioraUserId, email: req.session.prioraEmail },
  });
});
