import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

let client: Anthropic | null = null;

/** Indica se a IA está configurada (chave da Anthropic presente). */
export function isAiConfigured(): boolean {
  return Boolean(config.ai.apiKey);
}

/**
 * Retorna um cliente Anthropic (Claude) singleton.
 * Lança erro claro se a chave não estiver configurada.
 */
export function getClaudeClient(): Anthropic {
  if (!config.ai.apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY não configurada. Defina-a no .env para usar os recursos de IA.',
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.ai.apiKey });
  }
  return client;
}
