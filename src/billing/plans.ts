/**
 * Priora — Catálogo de planos (assinaturas).
 *
 * O plano define o LIMITE DE ASSENTOS (analistas) da empresa. A empresa só é
 * criada quando um plano é ASSINADO (pagamento aprovado) — ver
 * docs/ARQUITETURA_MULTIEMPRESA.md e prioraAuthRoutes (POST /assinar).
 *
 * `preco` fica `null` de propósito enquanto a precificação real não é definida:
 * a regra do projeto é NUNCA inventar dados. Preencha os valores quando o
 * pagamento (Stripe) entrar — o `seats` é o que importa para o limite agora.
 */
export interface Plan {
  /** Identificador estável (usado no banco em organizations.plan). */
  id: string;
  /** Nome comercial exibido. */
  nome: string;
  /** Limite de analistas (assentos) que a empresa pode ter neste plano. */
  seats: number;
  /** Rótulo de preço, ou null enquanto não definido (não inventar). */
  preco: string | null;
}

export const PLANS: readonly Plan[] = [
  { id: 'time_3', nome: 'Time', seats: 3, preco: null },
  { id: 'time_5', nome: 'Equipe', seats: 5, preco: null },
  { id: 'time_10', nome: 'Operação', seats: 10, preco: null },
];

/** Retorna o plano pelo id, ou undefined se não existir. */
export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}
