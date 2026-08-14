import { Router } from 'express';
import { getSupabase, isSupabaseConfigured } from '../db/supabase';
import { getPlan } from '../billing/plans';

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

/** Normaliza o tipo de empresa vindo do formulário. Padrão: operador. */
function normTipo(v: string): 'operador' | 'cliente' {
  const t = (v || '').trim().toLowerCase();
  return t === 'cli' || t === 'cliente' ? 'cliente' : 'operador';
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

/** Contexto da empresa (organização) do usuário, lido da tabela memberships. */
interface OrgContext {
  orgId: string;
  role: 'admin' | 'analyst';
  status: 'invited' | 'active' | 'disabled';
  orgName: string | null;
}

/**
 * Carrega a empresa + papel do usuário. Null se ele ainda não pertence a
 * nenhuma (ex.: contas antigas criadas antes do multi-empresa).
 */
async function loadOrgContext(userId: string): Promise<OrgContext | null> {
  const { data, error } = await getSupabase()
    .from('memberships')
    .select('org_id, role, status, organizations(name)')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const org = (data as { organizations?: { name?: string } | null }).organizations;
  return {
    orgId: data.org_id as string,
    role: data.role as OrgContext['role'],
    status: data.status as OrgContext['status'],
    orgName: org?.name ?? null,
  };
}

/**
 * Cadastro: cria SÓ a conta (aberto a qualquer um). A EMPRESA ainda NÃO nasce
 * aqui — ela é criada quando o usuário ASSINA um plano (POST /assinar), que é o
 * ponto onde o pagamento entra. Guardamos o nome da empresa/tipo como intenção
 * (metadados do usuário) para pré-preencher a tela de planos. Ver
 * docs/ARQUITETURA_MULTIEMPRESA.md (fluxo 1: conta → plano/pagamento → admin).
 */
prioraAuthRouter.post('/signup', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const creds = parseCreds(req.body);
    if ('error' in creds) return res.status(400).json({ error: creds.error });

    const b = (req.body || {}) as Record<string, unknown>;
    const fullName = String(b.nome ?? b.full_name ?? '').trim();
    const empresa = String(b.empresa ?? b.org ?? '').trim();
    const tipo = normTipo(String(b.tipo ?? b.role ?? ''));
    if (fullName.length < 2) return res.status(400).json({ error: 'Informe seu nome completo.' });

    const sb = getSupabase();
    const { data, error } = await sb.auth.admin.createUser({
      email: creds.email,
      password: creds.password,
      email_confirm: true, // MVP: sem etapa de confirmação por e-mail
      // Intenção guardada de forma durável (sobrevive a novo login antes de assinar).
      user_metadata: { full_name: fullName, empresa, tipo },
    });
    if (error || !data.user) {
      const exists = /registered|already|exists|duplicate/i.test(error?.message || '');
      return res.status(exists ? 409 : 400).json({
        error: exists
          ? 'Já existe uma conta Priora com esse e-mail.'
          : error?.message || 'Não foi possível criar a conta.',
      });
    }
    const userId = data.user.id;

    // Completa o profile (o trigger on_auth_user_created já criou a linha).
    await sb.from('profiles').upsert({
      id: userId,
      email: data.user.email || creds.email,
      full_name: fullName,
    });

    req.session.prioraUserId = userId;
    req.session.prioraEmail = data.user.email || creds.email;
    req.session.prioraEmpresaIntent = empresa || undefined;
    req.session.prioraTipoIntent = tipo;
    // org: null → a UI leva para a tela de planos (a empresa nasce ao assinar).
    return res.json({
      ok: true,
      user: { id: userId, email: data.user.email },
      org: null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Assinar um plano → CRIA A EMPRESA e torna o usuário ADMIN dela. É AQUI que o
 * pagamento entra no fluxo: hoje aprova em MODO TESTE (sem cobrança real);
 * quando o Stripe entrar, este passo passa a ser disparado pelo webhook de
 * "pagamento aprovado". O plano define o limite de assentos (analistas).
 */
prioraAuthRouter.post('/assinar', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const userId = req.session.prioraUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Faça login na Priora primeiro.' });
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const plano = getPlan(String(b.plano ?? b.plan ?? ''));
    if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

    const empresa = String(b.empresa ?? req.session.prioraEmpresaIntent ?? '').trim();
    const tipo = normTipo(String(b.tipo ?? req.session.prioraTipoIntent ?? ''));
    if (empresa.length < 2) return res.status(400).json({ error: 'Informe o nome da empresa.' });

    const sb = getSupabase();

    // Uma empresa por conta: se já pertence a uma, não cria outra.
    const existing = await loadOrgContext(userId);
    if (existing) {
      return res.status(409).json({ error: 'Sua conta já pertence a uma empresa.' });
    }

    // Cria a empresa com o limite de assentos do plano.
    const { data: org, error: orgErr } = await sb
      .from('organizations')
      .insert({
        name: empresa,
        type: tipo,
        plan: plano.id,
        seat_limit: plano.seats,
        created_by: userId,
      })
      .select('id, name')
      .single();
    if (orgErr || !org) throw orgErr || new Error('Falha ao criar a empresa.');

    // Vincula como ADMIN. Se falhar, desfaz a empresa órfã para permitir retry.
    const { error: memErr } = await sb.from('memberships').insert({
      user_id: userId,
      org_id: org.id,
      role: 'admin',
      status: 'active',
    });
    if (memErr) {
      await sb.from('organizations').delete().eq('id', org.id);
      throw memErr;
    }

    await sb.from('profiles').update({ org_id: org.id }).eq('id', userId);

    req.session.prioraOrgId = org.id as string;
    req.session.prioraOrgName = org.name as string;
    req.session.prioraRole = 'admin';
    return res.json({
      ok: true,
      org: {
        id: org.id,
        name: org.name,
        role: 'admin',
        plan: plano.id,
        seats: plano.seats,
      },
    });
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

    // Carrega a empresa/papel. Contas desativadas pelo admin não entram.
    const ctx = await loadOrgContext(data.user.id);
    if (ctx?.status === 'disabled') {
      return res.status(403).json({
        error: 'Seu acesso foi desativado pelo administrador da empresa.',
      });
    }

    req.session.prioraUserId = data.user.id;
    req.session.prioraEmail = data.user.email || creds.email;
    if (ctx) {
      req.session.prioraOrgId = ctx.orgId;
      req.session.prioraOrgName = ctx.orgName || undefined;
      req.session.prioraRole = ctx.role;
    } else {
      // Ainda sem empresa: recupera a intenção dos metadados p/ a tela de planos.
      const meta = (data.user.user_metadata || {}) as Record<string, unknown>;
      req.session.prioraEmpresaIntent = String(meta.empresa || '') || undefined;
      req.session.prioraTipoIntent = normTipo(String(meta.tipo || ''));
    }
    res.json({
      ok: true,
      user: { id: data.user.id, email: data.user.email },
      org: ctx ? { id: ctx.orgId, name: ctx.orgName, role: ctx.role } : null,
    });
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
  const hasOrg = !!req.session.prioraOrgId;
  res.json({
    authenticated: true,
    user: { id: req.session.prioraUserId, email: req.session.prioraEmail },
    org: hasOrg
      ? {
          id: req.session.prioraOrgId,
          name: req.session.prioraOrgName || null,
          role: req.session.prioraRole || null,
        }
      : null,
    // Sem empresa ainda: intenção do cadastro p/ pré-preencher a tela de planos.
    intent: hasOrg
      ? null
      : {
          empresa: req.session.prioraEmpresaIntent || '',
          tipo: req.session.prioraTipoIntent || 'operador',
        },
  });
});
