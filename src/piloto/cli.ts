import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { lerManifesto } from './manifesto';
import { ErroDoProvisionamento, RelatorioDoProvisionamento, provisionar } from './provisionamento';

/**
 * I4 — linha de comando do provisionamento do piloto.
 *
 *   PRIORA_PILOTO_DATABASE_URL='postgresql://USUARIO@HOST:PORTA/BANCO' PGPASSWORD=… \
 *     npm run piloto:provisionar -- --manifesto piloto.json [--aplicar --alvo BANCO] [--relatorio saida.json]
 *
 * Proteções (falha fechada, código 2, nada é lido nem gravado):
 *  - o banco vem SÓ de `PRIORA_PILOTO_DATABASE_URL` (sem `DATABASE_URL` nem `DEMURRAGE_DATABASE_URL` de reserva);
 *  - URL com senha é recusada (a senha vai em `PGPASSWORD`, nunca na linha de comando nem no histórico);
 *  - `--aplicar` exige `--alvo` igual ao `current_database()` do servidor conectado;
 *  - migrações pendentes (ou ausentes) recusam: o provisionamento nunca migra;
 *  - sem `--aplicar`, é SIMULAÇÃO em transação somente leitura.
 * A saída não mostra a URL, nomes, contas nem e-mails completos (só a inicial e o domínio).
 * Códigos de saída: 0 ok; 1 manifesto inválido ou conflito (nada gravado); 2 ambiente recusado ou erro.
 */

export const VARIAVEL_DO_BANCO = 'PRIORA_PILOTO_DATABASE_URL';
const MIGRACOES = path.join(__dirname, '..', 'demurrage-engine', 'db', 'migrations');
const MAX_BYTES_DO_MANIFESTO = 1024 * 1024;

export interface Saida { linha(texto: string): void }

interface Argumentos { manifesto: string | null; aplicar: boolean; alvo: string | null; relatorio: string | null; erro: string | null }

function argumentos(argv: ReadonlyArray<string>): Argumentos {
  const a: Argumentos = { manifesto: null, aplicar: false, alvo: null, relatorio: null, erro: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const valor = () => { const x = argv[++i]; if (!x || x.startsWith('--')) a.erro = `valor ausente para ${v}`; return x ?? null; };
    if (v === '--manifesto') a.manifesto = valor();
    else if (v === '--alvo') a.alvo = valor();
    else if (v === '--relatorio') a.relatorio = valor();
    else if (v === '--aplicar') a.aplicar = true;
    else a.erro = `argumento desconhecido: ${v}`;
  }
  if (!a.erro && !a.manifesto) a.erro = 'informe --manifesto';
  if (!a.erro && a.aplicar && !a.alvo) a.erro = '--aplicar exige --alvo (o nome do banco do piloto)';
  return a;
}

/** Recusa motivos de ambiente antes de conectar. */
export function conferirUrl(url: string | undefined): { ok: true; url: string } | { ok: false; motivo: string } {
  if (!url || !url.trim()) return { ok: false, motivo: `ALVO_NAO_DEFINIDO: defina ${VARIAVEL_DO_BANCO} (não há banco de reserva)` };
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { ok: false, motivo: 'URL_INVALIDA' }; }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return { ok: false, motivo: 'URL_INVALIDA' };
  if (u.password) return { ok: false, motivo: 'SENHA_NA_URL: use PGPASSWORD; a senha nunca vai na URL' };
  if (u.searchParams.has('password')) return { ok: false, motivo: 'SENHA_NA_URL: use PGPASSWORD; a senha nunca vai na URL' };
  return { ok: true, url: url.trim() };
}

export async function executar(argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>, saida: Saida): Promise<number> {
  const a = argumentos(argv);
  if (a.erro) { saida.linha(`RECUSADO: ${a.erro}`); return 2; }
  const url = conferirUrl(env[VARIAVEL_DO_BANCO]);
  if (!url.ok) { saida.linha(`RECUSADO: ${url.motivo}`); return 2; }

  let bruto: unknown;
  try {
    const st = fs.statSync(a.manifesto!);
    if (!st.isFile() || st.size > MAX_BYTES_DO_MANIFESTO) { saida.linha('RECUSADO: manifesto não é um arquivo ou passa de 1 MB'); return 1; }
    bruto = JSON.parse(fs.readFileSync(a.manifesto!, 'utf8'));
  } catch {
    saida.linha('RECUSADO: manifesto ilegível ou não é JSON');
    return 1;
  }
  const lido = lerManifesto(bruto);
  if (!lido.ok) {
    saida.linha(`MANIFESTO INVÁLIDO (${lido.erros.length} erro(s)); nada foi lido no banco:`);
    for (const e of lido.erros) saida.linha(`  ${e.caminho}: ${e.codigo}`);
    return 1;
  }

  const pool = new Pool({ connectionString: url.url, max: 1, application_name: 'priora-piloto-provisionamento' });
  try {
    const { rows: [alvo] } = await pool.query(
      `SELECT current_database() AS banco, coalesce(host(inet_server_addr()), 'socket') AS host, inet_server_port() AS porta`,
    );
    saida.linha(`Banco conectado: ${alvo.banco} em ${alvo.host}:${alvo.porta ?? '-'}`);
    if (a.aplicar && a.alvo !== alvo.banco) { saida.linha(`RECUSADO: ALVO_DIVERGENTE (--alvo ${a.alvo} ≠ banco conectado)`); return 2; }
    const pendentes = await migracoesPendentes(pool);
    if (pendentes === null) { saida.linha('RECUSADO: MIGRACOES_AUSENTES (rode db:migrate:demurrage antes; o provisionamento nunca migra)'); return 2; }
    if (pendentes.length) { saida.linha(`RECUSADO: MIGRACOES_PENDENTES (${pendentes.length}; a primeira: ${pendentes[0]})`); return 2; }

    const r = await provisionar(pool, lido.manifesto, { aplicar: a.aplicar });
    for (const l of resumo(r)) saida.linha(l);
    if (a.relatorio) fs.writeFileSync(a.relatorio, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    return r.conflitos.length ? 1 : 0;
  } catch (e) {
    saida.linha(e instanceof ErroDoProvisionamento ? `ERRO: ${e.codigo} (transação desfeita, nada gravado)` : `ERRO: ${(e as { code?: string }).code ?? 'INESPERADO'} (transação desfeita, nada gravado)`);
    return 2;
  } finally {
    await pool.end();
  }
}

/** null = tabela de controle ausente (banco sem migrações). */
async function migracoesPendentes(pool: Pool): Promise<string[] | null> {
  const { rows: [t] } = await pool.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existe`);
  if (!t.existe) return null;
  const aplicadas = new Set((await pool.query(`SELECT filename FROM schema_migrations`)).rows.map((x) => x.filename));
  return fs.readdirSync(MIGRACOES).filter((f) => f.endsWith('.sql')).sort().filter((f) => !aplicadas.has(f));
}

export function resumo(r: RelatorioDoProvisionamento): string[] {
  const l: string[] = [];
  const titulo = { SIMULACAO: 'SIMULAÇÃO (nada gravado)', APLICADO: 'APLICADO', RECUSADO: 'RECUSADO por conflito (nada gravado)' }[r.modo];
  l.push(`${titulo} — organização ${r.organizacao.slug} (${r.organizacao.situacao === 'CRIAR' ? 'nova' : 'existente'}), manifesto ${r.manifestoSha256.slice(0, 12)}`);
  for (const c of r.conflitos) l.push(`  CONFLITO ${c.item}: ${c.codigo}`);
  for (const m of r.membros) {
    l.push(`  membro ${m.membro} ${m.email} ${m.papel}: usuário ${m.usuario}, conta ${m.conta}, membership ${m.membership}${m.tambemEmOutraOrganizacao ? ' (também em outra organização)' : ''}`);
  }
  const p = r.modo === 'APLICADO' ? r.gravado : r.previsto;
  l.push(`  ${r.modo === 'APLICADO' ? 'gravado' : 'previsto'}: ${p.organizacoes} organização, ${p.usuarios} usuário(s), ${p.contasVinculadas} conta(s) vinculada(s), ${p.memberships} membership(s)`);
  l.push(`  caixa monitorada: ${r.caixa}; ADMIN declarados: ${r.admins}; membros fora do manifesto (não alterados): ${r.membrosForaDoManifesto}`);
  for (const x of r.pendencias) l.push(`  PENDÊNCIA ${x.codigo}${'membros' in x ? `: membros ${x.membros.join(', ')}` : ''}`);
  return l;
}

/* istanbul ignore next -- entrada de linha de comando; a lógica é `executar`, testada diretamente */
if (require.main === module) {
  executar(process.argv.slice(2), process.env, { linha: (t) => process.stdout.write(`${t}\n`) })
    .then((codigo) => { process.exitCode = codigo; })
    .catch(() => { process.stdout.write('ERRO: INESPERADO\n'); process.exitCode = 2; });
}
