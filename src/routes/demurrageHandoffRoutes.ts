import express, { NextFunction, Response, Router } from 'express';
import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { AutenticacaoHandoffDeps, HandoffAuthedRequest, criarAutenticarHandoffHttp } from '../demurrage-engine/handoff/autenticacaoHttp';
import { RespostaHandoff, processarEventoHandoff } from '../demurrage-engine/handoff/handoffService';
import { classificarFalhaHandoff } from '../demurrage-engine/handoff/erros';
import {
  ConfigCapacidadeHandoff, carregarConfigCapacidadeHandoff, criarControleCapacidadeHandoff, descreverConfigCapacidadeHandoff,
} from '../demurrage-engine/handoff/capacidade';

/**
 * Produção P1 (Entrega 1) — adaptador HTTP FINO do handoff.
 *
 * Nenhuma regra de negócio aqui: autentica (HMAC, `autenticarHandoffHttp`),
 * faz o parse do corpo (já verificado) e DELEGA inteiramente a
 * `processarEventoHandoff` (`handoffService.ts`, o mesmo serviço chamável
 * in-process). Esta função só traduz o resultado discriminado em status
 * HTTP — tradução de protocolo, não decisão de negócio.
 *
 * `express.raw()` é PRÓPRIO deste router (não o `express.json()` global do
 * app): a assinatura HMAC precisa dos bytes EXATOS do corpo, e o parser
 * global já consumiria/alteraria esse buffer antes de chegar aqui. Por isso
 * este router é montado em `index.ts` ANTES do `express.json()` global.
 *
 * Controle de capacidade (adição estreita autorizada à Entrega 1 —
 * `handoff/capacidade.ts`, migration 0047): logo DEPOIS da autenticação e
 * ANTES do parse do corpo e do serviço. Acima do limite (por credencial ou
 * por organização) a rota responde `429 {"error":"limite_temporario"}` com
 * `Retry-After`, sem tocar a idempotência nem o serviço do handoff.
 */

export interface DemurrageHandoffRoutesDeps extends AutenticacaoHandoffDeps {
  pool?: () => Pool;
  /** Limites de capacidade; ausente = lidos (e validados) das variáveis de ambiente. */
  capacidade?: ConfigCapacidadeHandoff;
}

function statusHttpDoResultado(r: RespostaHandoff['resultado']): number {
  switch (r) {
    case 'APLICADO': return 200;
    case 'REPLAY_IDEMPOTENTE': return 200;
    case 'ACEITO_COM_PENDENCIA': return 200;
    case 'EXIGE_REABERTURA': return 409;
    case 'CONFLITO_EVENTO': return 409;
    case 'CONTRATO_INVALIDO': return 400;
    case 'FALHA': return 500;
    default: return 500;
  }
}

export function criarDemurrageHandoffRouter(deps: DemurrageHandoffRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();
  const configCapacidade = deps.capacidade ?? carregarConfigCapacidadeHandoff();

  // Corpo cru (bytes exatos) — a assinatura HMAC cobre o corpo exato, não uma
  // reserialização do JSON parseado (que poderia divergir em espaços/ordem).
  router.use(express.raw({ type: '*/*', limit: '1mb' }));
  router.use((req: HandoffAuthedRequest, _res: Response, next: NextFunction) => {
    req.corpoBruto = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  });
  router.use(criarAutenticarHandoffHttp(deps));

  // Capacidade só na rota que ENTRA no processamento (não em `router.use`):
  // requisição autenticada que não casa com ela não consome tentativa.
  router.post('/', criarControleCapacidadeHandoff({ pool, config: configCapacidade }), async (req: HandoffAuthedRequest, res: Response) => {
    let entradaJson: unknown;
    try {
      entradaJson = req.corpoBruto && req.corpoBruto.length ? JSON.parse(req.corpoBruto.toString('utf8')) : {};
    } catch {
      res.status(400).json({ resultado: 'CONTRATO_INVALIDO', detalhe: { codigo: 'JSON_INVALIDO' } });
      return;
    }
    try {
      const resposta = await processarEventoHandoff(entradaJson, req.contextoHandoff!, { pool: pool() });
      res.status(statusHttpDoResultado(resposta.resultado)).json(resposta);
    } catch (erro) {
      // Achado #3 (v1.1): nunca loga o objeto de erro bruto (poderia incluir
      // `.stack`/dados capturados em closure) — só a classificação FECHADA.
      const codigo = classificarFalhaHandoff(erro);
      // eslint-disable-next-line no-console
      console.error(`[demurrage-handoff] erro inesperado ao processar evento: ${codigo}`);
      res.status(500).json({ resultado: 'FALHA', detalhe: { motivo: codigo } });
    }
  });

  return router;
}

// Configuração lida (e validada) na IMPORTAÇÃO deste módulo pelo `index.ts`:
// valor inválido lança `ErroConfigCapacidadeHandoff` e derruba a
// inicialização antes do `listen` — nunca sobe com o limite desligado.
const configCapacidadePadrao = carregarConfigCapacidadeHandoff();
export const demurrageHandoffRouter = criarDemurrageHandoffRouter({ capacidade: configCapacidadePadrao });
// eslint-disable-next-line no-console
console.log(descreverConfigCapacidadeHandoff(configCapacidadePadrao));
