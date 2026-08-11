import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, isSupabaseConfigured } from '../config';

/**
 * Priora — Cliente Supabase (server-side).
 *
 * Usa a SERVICE ROLE KEY: tem acesso total e IGNORA as políticas de RLS. Por
 * isso todo acesso a dados no backend DEVE ser escopado por `user_id` da conta
 * Priora logada — a RLS é a segunda linha de defesa (contra acesso direto com a
 * anon key), o escopo no código é a primeira.
 *
 * Lazy: o servidor sobe sem Supabase (modo MVP de conta única); só quem usa os
 * recursos multiusuário exige a configuração.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

export { isSupabaseConfigured };
