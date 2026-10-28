import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'crypto';
import { AddressInfo } from 'node:net';
import http, { Server } from 'node:http';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { criarApp } from '../../app';
import { ArmazenamentoObjetos } from '../documentos/armazenamento';
import { ConfiguracaoArquivos } from '../documentos/configuracao';
import { GanchosTesteDocumentos } from '../documentos/servico';
import { MicrosoftFalsa, Navegador, pessoa, Pessoa, SEGREDO_TESTE } from './tarifasAdminTestHelper';

/**
 * Produção P1 (arquivos de minuta) — harness dos testes HTTP de documentos.
 * TUDO passa pelo app REAL (`criarApp`): sessão humana no store PostgreSQL,
 * cookie de verdade, `/auth/login` → `/auth/callback`, CSRF por origem,
 * `requireSessao`, `autorizarInterno` e os routers reais. Só a Microsoft é
 * simulada, e o armazenamento é injetado (memória com falhas, ou o provedor S3
 * real contra o servidor S3 falso local) — nenhuma rede externa.
 */

export const T = '2026-08-20T00:00:00Z';
export const HOJE = '2026-10-01';
export const DOCS = '/api/demurrage/v2/documentos';
export const ACOES = '/api/demurrage/v2/acoes';

export const PNG_2X2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM8ISfHwMDAxMDAwMDAAAANBAEIfXHKZgAAAABJRU5ErkJggg==', 'base64');
export const JPEG_2X2 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z', 'base64');

export function pdf(tag: string = randomUUID(), preenchimento = 0): Buffer {
  return Buffer.from(
    `%PDF-1.4\n% minuta ${tag}\n${'x'.repeat(preenchimento)}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1',
  );
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export const CFG_TESTE: ConfiguracaoArquivos = {
  provedor: null, tamanhoMaximoBytes: 1024 * 1024, uploadExpiraMs: 24 * 3600_000, posseEnvioMs: 15 * 60_000,
  naoVinculadoExpiraMs: 30 * 86_400_000, limpezaAutomatica: true, carenciaRemocaoMs: 30 * 86_400_000, timeoutMs: 5000,
  s3: null, diretorioDev: null,
};

export interface AppArquivos { base: string; fechar: () => Promise<void> }

export async function subirAppArquivos(
  pool: Pool, ms: MicrosoftFalsa, armazenamento: ArmazenamentoObjetos | null,
  opts: { cfg?: Partial<ConfiguracaoArquivos>; ganchos?: GanchosTesteDocumentos } = {},
): Promise<AppArquivos> {
  const app = criarApp({
    pool: () => pool, segredo: SEGREDO_TESTE, cookieSeguro: false, purgarSessoesACada: null,
    auth: {
      identidade: ms.identidade, integracao: ms.integracao, estadoIntegracao: ms.estado,
      desconectarIntegracao: ms.desconectar, integracaoUtilizavel: async () => true,
      redirectUri: 'http://127.0.0.1/auth/callback',
    },
    arquivos: { armazenamento, cfg: { ...CFG_TESTE, ...(opts.cfg ?? {}) } },
    ganchosDocumentos: opts.ganchos,
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const porta = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${porta}`,
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/* ------------------------------------------------------------------ *
 * Operações HTTP (pelo navegador com sessão real).
 * ------------------------------------------------------------------ */

export async function iniciar(
  nav: Navegador, corpo: { containerId: string; nomeOriginal?: unknown; tipoDeclarado?: unknown; tamanhoBytes?: unknown; sha256?: unknown },
  chave: string = randomUUID(),
): Promise<{ status: number; body: any }> {
  return nav.json(`${DOCS}/uploads`, { method: 'POST', body: corpo, headers: { 'idempotency-key': chave } });
}

/**
 * PUT binário do conteúdo por `http.request` cru (corpo, `Content-Length` e
 * aborto sob controle do teste); cookie e Origin do navegador. `abortarApos`:
 * envia só esses bytes e derruba a conexão (navegador que caiu no meio).
 */
export async function enviar(
  nav: Navegador, documentoId: string, conteudo: Buffer,
  opts: { tipo?: string; chave?: string; headers?: Record<string, string>; abortarApos?: number; semContentLength?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    origin: nav.base, 'idempotency-key': opts.chave ?? randomUUID(), 'content-type': opts.tipo ?? 'application/pdf', ...(opts.headers ?? {}),
  };
  if (!opts.semContentLength) headers['content-length'] = String(conteudo.length);
  else headers['transfer-encoding'] = 'chunked';
  if (nav.cookies.size) headers.cookie = [...nav.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const u = new URL(`${nav.base}${DOCS}/uploads/${documentoId}/conteudo`);
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      const pedacos: Buffer[] = [];
      res.on('data', (p) => pedacos.push(p));
      res.on('end', () => {
        const texto = Buffer.concat(pedacos).toString('utf8');
        let body: any = texto;
        try { body = JSON.parse(texto); } catch { /* não-JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('error', (err) => (opts.abortarApos !== undefined ? resolve({ status: 0, body: { abortado: true } }) : reject(err)));
    if (opts.abortarApos !== undefined) {
      req.write(conteudo.subarray(0, opts.abortarApos), () => setTimeout(() => req.destroy(), 50));
      return;
    }
    req.end(conteudo);
  });
}

export async function concluir(nav: Navegador, documentoId: string, chave: string = randomUUID()): Promise<{ status: number; body: any }> {
  return nav.json(`${DOCS}/uploads/${documentoId}/concluir`, { method: 'POST', body: {}, headers: { 'idempotency-key': chave } });
}

/** Download pelo navegador (mesma origem): devolve status, cabeçalhos e bytes. */
export async function baixar(
  nav: Navegador, documentoId: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
): Promise<{ status: number; headers: Headers; bytes: Buffer; body: any }> {
  const h: Record<string, string> = { ...headers };
  if (nav.cookies.size) h.cookie = [...nav.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${nav.base}${DOCS}/${documentoId}/conteudo`, { headers: h, redirect: 'manual' });
  nav.absorver(res);
  const bytes = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { /* binário */ }
  return { status: res.status, headers: res.headers, bytes, body };
}

/** Upload completo (iniciar → enviar → concluir); devolve o documentoId DISPONIVEL. */
export async function uploadCompleto(
  nav: Navegador, containerId: string, conteudo: Buffer = pdf(), tipo = 'application/pdf', nome = 'minuta.pdf',
): Promise<string> {
  const i = await iniciar(nav, { containerId, nomeOriginal: nome, tipoDeclarado: tipo, tamanhoBytes: conteudo.length });
  assert.equal(i.status, 201, `iniciar: ${JSON.stringify(i.body)}`);
  const e = await enviar(nav, i.body.documento.documentoId, conteudo, { tipo });
  assert.equal(e.status, 201, `enviar: ${JSON.stringify(e.body)}`);
  const c = await concluir(nav, i.body.documento.documentoId);
  assert.equal(c.status, 200, `concluir: ${JSON.stringify(c.body)}`);
  assert.equal(c.body.documento.estado, 'DISPONIVEL');
  return i.body.documento.documentoId;
}

export async function registrarMinutaHttp(
  nav: Navegador, containerId: string, corpo: Record<string, unknown>, chave: string = randomUUID(),
): Promise<{ status: number; body: any }> {
  return nav.json(`${ACOES}/containers/${containerId}/minutas`, { method: 'POST', body: corpo, headers: { 'idempotency-key': chave } });
}

/* ------------------------------------------------------------------ *
 * Cenários de domínio (contrato real de registro + tracking real).
 * ------------------------------------------------------------------ */

let seqContainer = 1;
export interface Cenario { orgId: string; processoId: string; containers: Array<{ id: string; numero: string }> }

async function seedArmadorTabelaNormalizada(pool: Pool) {
  const { rows: arm } = await pool.query(`SELECT id FROM armadores WHERE codigo_interno='MAERSK'`);
  const { rows: tab } = await pool.query(
    `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES (NULL, 'armador', $1, 2, '2026-01-01', 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'Referência de teste arquivos (40HC)', '2026-08-01T00:00:00Z')
     RETURNING id`,
    [arm[0].id],
  );
  await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, 80, 'USD')`, [tab[0].id]);
  await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [tab[0].id]);
}

/** Mesmo cenário de `minutaEncerramentoP1.test.ts`: com demurrage (FT 3/5 + tabelas) ou sem (FT 20/20). */
export async function cenario(pool: Pool, opts: { orgId: string; numeroProcesso: string; n?: number; comDemurrage: boolean }): Promise<Cenario> {
  let condicaoComercial: any = null;
  if (opts.comDemurrage) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tariff_tables WHERE fonte = 'Referência de teste arquivos (40HC)'`);
    if (rows[0].n === 0) await seedArmadorTabelaNormalizada(pool);
    const { rows: existente } = await pool.query(`SELECT id FROM tariff_tables WHERE organization_id = $1 AND tipo = 'rocket_cliente' LIMIT 1`, [opts.orgId]);
    const tabelaEmbarque = existente[0]?.id ?? await seedRocketTermoPorEmbarque(pool, { organizationId: opts.orgId });
    condicaoComercial = o({ termoTipo: 'embarque', tabelaId: tabelaEmbarque }, 'shipping_instructions', T);
  }
  const numeros = Array.from({ length: opts.n ?? 1 }, () => numeroContainer('ARQM', seqContainer++));
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: opts.orgId, numeroProcesso: opts.numeroProcesso,
    containers: numeros.map((n) => containerContrato(n, { tipoOriginal: o('40HC', 'house_document', T) })),
    mbl: o(`MBL${opts.numeroProcesso.replace(/[^A-Z0-9]/gi, '')}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    condicaoComercial,
    houseFreeTimeDays: o(opts.comDemurrage ? 3 : 20, 'house_document', T), masterFreeTimeDays: o(opts.comDemurrage ? 5 : 20, 'master_bl', T),
  }), { pool, hojeReferencia: '2026-08-25' });
  const containers = r.containers.map((c: any, i: number) => ({ id: c.containerId, numero: numeros[i] }));
  await ingerirTrackingDoContainer(pool, containers[0].id, resultadoTracking({
    containers: containers.map((c) => ({ numero: c.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any)),
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: containers[0].numero }],
  }), '2026-09-02');
  return { orgId: opts.orgId, processoId: r.processoId, containers };
}

/** Devolução OFICIAL pelo tracking (ingestão real — dispara o gatilho de encerramento automático). */
export async function devolverPeloTracking(pool: Pool, c: Cenario, devolucoes: Record<string, string | null>, hoje = HOJE): Promise<void> {
  await ingerirTrackingDoContainer(pool, c.containers[0].id, resultadoTracking({
    containers: c.containers.map((x) => ({
      numero: x.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: devolucoes[x.numero] ?? null,
    } as any)),
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: c.containers[0].numero }],
  }), hoje);
}

export const statusProcesso = (pool: Pool, id: string) =>
  pool.query(`SELECT apuracao_status, encerramento_bloqueio, encerramento_bloqueio_container_id FROM processos WHERE id = $1`, [id]).then((r) => r.rows[0]);

export interface Base {
  orgX: string; orgY: string;
  ana: Pessoa; bia: Pessoa; gil: Pessoa; adm: Pessoa; cli: Pessoa; yadm: Pessoa;
}

/** Banco limpo + duas organizações e pessoas reais (ANALYST responsável, outra ANALYST, MANAGER, ADMIN, CLIENT; ADMIN da org Y). */
export async function base(pool: Pool): Promise<Base> {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const orgX = (await new OrganizationRepository(pool).create('Org X', `org-x-${randomUUID().slice(0, 6)}`)).id;
  const orgY = (await new OrganizationRepository(pool).create('Org Y', `org-y-${randomUUID().slice(0, 6)}`)).id;
  return {
    orgX, orgY,
    ana: await pessoa(pool, orgX, 'ANALYST', 'Ana'), bia: await pessoa(pool, orgX, 'ANALYST', 'Bia'),
    gil: await pessoa(pool, orgX, 'MANAGER', 'Gil'), adm: await pessoa(pool, orgX, 'ADMIN', 'Adm'),
    cli: await pessoa(pool, orgX, 'CLIENT', 'Cli'), yadm: await pessoa(pool, orgY, 'ADMIN', 'Yadm'),
  };
}

export async function logar(app: AppArquivos, ms: MicrosoftFalsa, p: Pessoa): Promise<Navegador> {
  const n = new Navegador(app.base);
  await n.login(ms, p);
  return n;
}

export { MicrosoftFalsa, Navegador, pessoa };
export type { Pessoa };

/**
 * Minuta LEGADA da 0048 (fluxo técnico com documento só por referência
 * externa + hash informado), como existia antes da 0053 — gravada por SQL
 * porque o serviço não aceita mais essa forma. `estado` ACEITA exige a data do
 * tracking igual à informada (CHECK `minutas_aceita_coerente`).
 */
export async function inserirMinutaLegadaReferencia(
  pool: Pool, p: { containerId: string; numero: string; data: string; membershipId: string; usuarioId: string; estado?: 'ACEITA' | 'RECEBIDA' },
): Promise<{ minutaId: string; documentoId: string }> {
  const { rows: c } = await pool.query(`SELECT processo_id, organization_id FROM containers WHERE id = $1`, [p.containerId]);
  const minutaId = randomUUID();
  const documentoId = randomUUID();
  const estado = p.estado ?? 'ACEITA';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: n } = await client.query(`SELECT count(*)::int AS n FROM minutas WHERE container_id = $1`, [p.containerId]);
    await client.query(
      `INSERT INTO minutas (id, container_id, estado_minuta, numero_informado, data_informada, recebida_por, regra_avaliacao, versao,
                            data_tracking_comparada, aguardando, avaliada_em)
       VALUES ($1, $2, $3, $4, $5, $6, 'minuta.tecnica.v1', $7, $8, $9, now())`,
      [minutaId, p.containerId, estado, p.numero, p.data, p.usuarioId, n[0].n + 1, estado === 'ACEITA' ? p.data : null,
        estado === 'RECEBIDA' ? 'DEVOLUCAO_TRACKING' : null],
    );
    await client.query(
      `INSERT INTO documentos (id, processo_id, container_id, organization_id, minuta_id, versao_minuta, tipo, origem, referencia_armazenamento,
                               nome_arquivo, tipo_conteudo, tamanho_bytes, hash_conteudo, incluido_por, incluido_por_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'minuta_devolucao', 'referencia_externa', $7, 'minuta-legada.pdf', 'application/pdf', 4096, $8, $9, $10)`,
      [documentoId, c[0].processo_id, p.containerId, c[0].organization_id, minutaId, n[0].n + 1, `graph:message/${minutaId}/attachment/1`,
        createHash('sha256').update(minutaId).digest('hex'), p.usuarioId, p.membershipId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { minutaId, documentoId };
}

/** Captura `console.*` durante `fn` (o texto de cada chamada, com objetos serializados). */
export async function capturarLogs<T>(fn: () => Promise<T>): Promise<{ resultado: T; logs: string }> {
  const linhas: string[] = [];
  const originais = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const cap = (...a: unknown[]) => { linhas.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? `${x.name}: ${x.message} ${x.stack ?? ''}` : JSON.stringify(x))).join(' ')); };
  console.log = cap; console.warn = cap; console.error = cap; console.info = cap;
  try {
    const resultado = await fn();
    return { resultado, logs: linhas.join('\n') };
  } finally {
    Object.assign(console, originais);
  }
}
