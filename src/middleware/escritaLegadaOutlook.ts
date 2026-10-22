import { RequestHandler } from 'express';

/**
 * Escritas LEGADAS no Outlook da caixa monitorada, fora da Liberação documental:
 *  - `POST /api/emails/send` — envia e-mail;
 *  - `POST /api/couriers/reply-draft` — cria o rascunho de resposta do Courier;
 *  - `POST /api/demurrage/solicitar-minuta` — cria o rascunho do pedido de minuta.
 *
 * `PRIORA_ESCRITA_LEGADA_OUTLOOK` ausente, vazia ou `on` → comportamento de sempre.
 * Qualquer outro valor (o piloto usa `off`) desliga as três: a rota responde 403
 * ANTES da autenticação, de qualquer chamada ao Graph e de qualquer gravação.
 * Um valor não reconhecido desliga (falha segura).
 *
 * Independente de `PRIORA_LIBERACAO_OUTLOOK_ESCRITA`, que continua governando só a
 * escrita da Liberação documental.
 */
export const VARIAVEL_ESCRITA_LEGADA_OUTLOOK = 'PRIORA_ESCRITA_LEGADA_OUTLOOK';

/** Código estável da recusa (campo `motivo` da resposta 403). */
export const MOTIVO_ESCRITA_LEGADA_DESLIGADA = 'ESCRITA_LEGADA_OUTLOOK_DESLIGADA';

export function escritaLegadaNoOutlookHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = String(env[VARIAVEL_ESCRITA_LEGADA_OUTLOOK] ?? '').trim().toLowerCase();
  return valor === '' || valor === 'on';
}

/**
 * Guarda da rota de escrita legada. Registrar ANTES do `requireAuth` do router:
 * desligada, a requisição termina aqui (nenhum token, Graph ou gravação).
 */
export function exigirEscritaLegadaNoOutlook(habilitada: () => boolean = () => escritaLegadaNoOutlookHabilitada()): RequestHandler {
  return (_req, res, next) => {
    if (habilitada()) return next();
    res.status(403).json({
      error: 'O envio de e-mail e a criação de rascunhos pela caixa monitorada estão desligados neste ambiente.',
      motivo: MOTIVO_ESCRITA_LEGADA_DESLIGADA,
    });
  };
}
