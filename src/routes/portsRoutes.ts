import { Router } from 'express';
import { requirePrioraUser, PrioraRequest } from '../middleware/requirePrioraUser';
import { PORTS, getLineup, findVessel, getPort } from '../ports';
import type { PortCall } from '../ports';

/**
 * Priora — Rotas do LINE-UP DOS PORTOS (/api/ports). Dados públicos dos portos,
 * mas a rota exige conta Priora logada: não somos um proxy aberto para os
 * sites dos terminais.
 *
 *   GET /api/ports                         → portos disponíveis
 *   GET /api/ports/:id/lineup              → escalas (?status=atracado,esperado
 *                                            &conteiner=1&refresh=1)
 *   GET /api/ports/navio?nome=&viagem=     → onde/quando um navio escala
 */
export const portsRouter = Router();
portsRouter.use(requirePrioraUser);

portsRouter.get('/', (_req: PrioraRequest, res) => {
  res.json({ ports: PORTS.map((p) => ({ id: p.id, name: p.name, uf: p.uf, cobre: p.cobre })) });
});

portsRouter.get('/navio', async (req: PrioraRequest, res, next) => {
  try {
    const nome = String(req.query.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe ?nome=<navio> (e opcionalmente &viagem=).' });
    const viagem = String(req.query.viagem || '').trim() || null;
    res.json({ navio: nome, viagem, ...(await findVessel(nome, viagem)) });
  } catch (err) {
    next(err);
  }
});

/** Contêiner: os terminais de contêiner (Itapoá, Rio Brasil) não preenchem mercadoria. */
function isContainer(c: PortCall): boolean {
  return !c.mercadoria || /CONT[EÊ]INER/i.test(c.mercadoria);
}

portsRouter.get('/:id/lineup', async (req: PrioraRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (!getPort(id)) return res.status(404).json({ error: `Porto desconhecido: ${id}. Veja GET /api/ports.` });
    const l = await getLineup(id, { refresh: req.query.refresh === '1' });
    const statuses = String(req.query.status || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let calls = l.calls;
    if (statuses.length) calls = calls.filter((c) => statuses.includes(c.status));
    if (req.query.conteiner === '1') calls = calls.filter(isContainer);
    res.json({ ...l, count: calls.length, calls });
  } catch (err) {
    next(err);
  }
});
