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
 * Garante que o usuário tenha uma EMPRESA (cria + o torna ADMIN se ainda não
 * tiver). O nome vem do que foi informado, senão dos metadados do cadastro,
 * senão um padrão. Usado no cadastro e no login (repara contas sem empresa).
 * Plano free por padrão (3 assentos) — a assinatura paga entra como upgrade.
 */
async function ensureOrgForUser(
  userId: string,
  empresaHint?: string,
  tipoHint?: string,
): Promise<OrgContext> {
  const existing = await loadOrgContext(userId);
  if (existing) return existing;

  const sb = getSupabase();
  let empresa = (empresaHint || '').trim();
  let tipo = normTipo(tipoHint || '');
  if (!empresa) {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    const meta = (u?.user?.user_metadata || {}) as Record<string, unknown>;
    empresa = String(meta.empresa || '').trim();
    tipo = normTipo(String(meta.tipo || ''));
  }
  if (empresa.length < 2) empresa = 'Minha empresa';

  const { data: org, error: orgErr } = await sb
    .from('organizations')
    .insert({ name: empresa, type: tipo, plan: 'free', seat_limit: 3, created_by: userId })
    .select('id, name')
    .single();
  if (orgErr || !org) throw orgErr || new Error('Falha ao criar a empresa.');

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
  return { orgId: org.id as string, role: 'admin', status: 'active', orgName: org.name as string };
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

    // Cria a EMPRESA e torna este usuário ADMIN dela (dono do workspace).
    const ctx = await ensureOrgForUser(userId, empresa, tipo);
    req.session.prioraOrgId = ctx.orgId;
    req.session.prioraOrgName = ctx.orgName || undefined;
    req.session.prioraRole = ctx.role;
    return res.json({
      ok: true,
      user: { id: userId, email: data.user.email },
      org: { id: ctx.orgId, name: ctx.orgName, role: ctx.role },
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
    let ctx = await loadOrgContext(data.user.id);
    if (ctx?.status === 'disabled') {
      return res.status(403).json({
        error: 'Seu acesso foi desativado pelo administrador da empresa.',
      });
    }
    // Conta sem empresa (ex.: criada antes deste fluxo) → cria e vira admin.
    if (!ctx) {
      ctx = await ensureOrgForUser(data.user.id);
    }

    req.session.prioraUserId = data.user.id;
    req.session.prioraEmail = data.user.email || creds.email;
    req.session.prioraOrgId = ctx.orgId;
    req.session.prioraOrgName = ctx.orgName || undefined;
    req.session.prioraRole = ctx.role;
    res.json({
      ok: true,
      user: { id: data.user.id, email: data.user.email },
      org: { id: ctx.orgId, name: ctx.orgName, role: ctx.role },
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

/* ============================ Portal do ADMIN ============================ *
 * Gestão da empresa e da equipe (analistas). Só o admin da empresa acessa.
 * Ver docs/ARQUITETURA_MULTIEMPRESA.md (Etapa 3: convidar/listar/desativar).
 * ======================================================================== */

/** Exige um ADMIN logado; devolve o contexto da empresa (ou responde e null). */
async function requireAdmin(
  req: import('express').Request,
  res: import('express').Response,
): Promise<OrgContext | null> {
  const userId = req.session.prioraUserId;
  if (!userId) {
    res.status(401).json({ error: 'Faça login na Priora primeiro.' });
    return null;
  }
  const ctx = await loadOrgContext(userId);
  if (!ctx || ctx.role !== 'admin' || ctx.status !== 'active') {
    res.status(403).json({ error: 'Apenas o administrador da empresa acessa isto.' });
    return null;
  }
  return ctx;
}

/** Dados da empresa + uso de assentos (cabeçalho do portal). */
prioraAuthRouter.get('/org', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const userId = req.session.prioraUserId;
    if (!userId) return res.status(401).json({ error: 'Faça login primeiro.' });
    const ctx = await loadOrgContext(userId);
    if (!ctx) return res.json({ org: null });
    const sb = getSupabase();
    const { data: org } = await sb
      .from('organizations')
      .select('id, name, plan, seat_limit, type')
      .eq('id', ctx.orgId)
      .single();
    const { count } = await sb
      .from('memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', ctx.orgId);
    res.json({ org: org ? { ...org, seatsUsed: count ?? 0, myRole: ctx.role } : null });
  } catch (err) {
    next(err);
  }
});

/** Lista a equipe (membros) da empresa. Admin. */
prioraAuthRouter.get('/analysts', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const sb = getSupabase();
    const { data: members } = await sb
      .from('memberships')
      .select('user_id, role, status, created_at')
      .eq('org_id', ctx.orgId)
      .order('created_at', { ascending: true });
    const ids = (members || []).map((m) => m.user_id as string);
    const { data: profs } = await sb
      .from('profiles')
      .select('id, email, full_name')
      .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    const byId = Object.fromEntries((profs || []).map((p) => [p.id as string, p]));
    const list = (members || []).map((m) => {
      const p = byId[m.user_id as string];
      return {
        userId: m.user_id,
        role: m.role,
        status: m.status,
        email: p?.email || null,
        fullName: p?.full_name || null,
      };
    });
    res.json({ analysts: list });
  } catch (err) {
    next(err);
  }
});

/** Cria um analista na empresa (respeita o limite de assentos). Admin. */
prioraAuthRouter.post('/analysts', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const fullName = String(b.nome ?? b.full_name ?? '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (password.length < 8) {
      return res.status(400).json({ error: 'A senha precisa de ao menos 8 caracteres.' });
    }

    const sb = getSupabase();
    const { data: org } = await sb
      .from('organizations')
      .select('seat_limit')
      .eq('id', ctx.orgId)
      .single();
    const { count } = await sb
      .from('memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', ctx.orgId);
    if (org && (count ?? 0) >= org.seat_limit) {
      return res.status(409).json({
        error: `Limite do plano atingido (${org.seat_limit} assentos). Faça upgrade para adicionar mais.`,
      });
    }

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) {
      const exists = /registered|already|exists|duplicate/i.test(error?.message || '');
      return res.status(exists ? 409 : 400).json({
        error: exists ? 'Já existe uma conta com esse e-mail.' : error?.message || 'Falha ao criar o analista.',
      });
    }
    const analystId = data.user.id;
    const { error: memErr } = await sb.from('memberships').insert({
      user_id: analystId,
      org_id: ctx.orgId,
      role: 'analyst',
      status: 'active',
    });
    if (memErr) {
      await sb.auth.admin.deleteUser(analystId).catch(() => {});
      throw memErr;
    }
    await sb.from('profiles').upsert({ id: analystId, email, full_name: fullName, org_id: ctx.orgId });
    res.json({
      ok: true,
      analyst: { userId: analystId, email, fullName, role: 'analyst', status: 'active' },
    });
  } catch (err) {
    next(err);
  }
});

/** Ativa/desativa um analista da empresa. Admin. */
prioraAuthRouter.post('/analysts/status', async (req, res, next) => {
  try {
    if (!ensureSupabase(res)) return;
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const targetId = String(b.userId || '');
    const status = String(b.status || '');
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'status inválido (use active|disabled).' });
    }
    const sb = getSupabase();
    const { data: m } = await sb
      .from('memberships')
      .select('role, org_id')
      .eq('user_id', targetId)
      .maybeSingle();
    if (!m || m.org_id !== ctx.orgId) {
      return res.status(404).json({ error: 'Analista não encontrado nesta empresa.' });
    }
    if (m.role === 'admin') {
      return res.status(400).json({ error: 'Não é possível desativar um administrador.' });
    }
    await sb.from('memberships').update({ status }).eq('user_id', targetId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
