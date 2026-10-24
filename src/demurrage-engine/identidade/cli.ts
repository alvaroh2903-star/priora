import crypto from 'crypto';
import { getPool } from '../db/pool';
import { atribuirResponsavel } from '../responsavel/atribuirResponsavel';
import {
  AtorProvisionamento, ErroProvisionamento, adicionarMembership, definirAdministradorPlataforma, definirAtivo, definirPapel,
  desvincularIdentidade, listarMembros, revogarSessoes, usuarioPorEmail, vincularIdentidadeMicrosoft,
} from './provisionamento';

/**
 * Produção P1 (autenticação) — CLI do OPERADOR DE PLATAFORMA (só backend; não
 * existe administração visual). Toda ação exige `--operador "<nome>"` e
 * `--motivo "<texto>"`, gravados na trilha de auditoria. Nunca imprime token,
 * cookie ou identificador de sessão.
 *
 *   npm run demurrage:provisionar -- vincular-usuario --nome "Ana" --email ana@empresa.com \
 *       --oid <objectId> --tid <tenantId> --operador "Equipe Priora" --motivo "admissão"
 *   npm run demurrage:provisionar -- adicionar-membro --org <organizationId> --email ana@empresa.com \
 *       --papel ANALYST --operador ... --motivo ...
 *   ... definir-papel --org <id> --membership <id> --papel MANAGER --operador ... --motivo ...
 *   ... desativar-membro | reativar-membro --org <id> --membership <id> --operador ... --motivo ...
 *   ... admin-plataforma --email ... --ativar|--desativar --operador ... --motivo ...
 *   ... desvincular-usuario | revogar-sessoes --email ... --operador ... --motivo ...
 *   ... listar-membros --org <id>
 *
 * Implantação (ver o relatório da entrega, seção "Implantação"):
 *   ... conta-integracao
 *       mostra a conta Microsoft conectada hoje como integração e a quem ela
 *       está vinculada (para o operador CONFIRMAR que é a conta certa);
 *   ... vincular-conta-integracao --nome "..." --email ... --operador ... --motivo ...
 *       vincula a conta de integração já conectada a um usuário e o torna
 *       administrador de plataforma (sem precisar descobrir oid/tid);
 *   ... processos-sem-responsavel --org <id> [--limite 50]
 *       processos ABERTOS sem responsável (nulo ou desativado);
 *   ... atribuir-responsavel --org <id> --processo <id> --para <membershipId|nenhum>
 *       --responsavel-atual <membershipId|nenhum> --operador ... --motivo ...
 *   ... atribuir-sem-responsavel --org <id> --para <membershipId> [--limite 500] [--lote <id>] --operador ... --motivo ...
 *       atribuição inicial em lote (mesmo serviço, mesma trilha, autor =
 *       operador de plataforma). Cada execução é um lote novo; repetir com o
 *       MESMO `--lote` (ex.: depois de uma queda no meio) não duplica nada.
 *
 * O `oid` (Object ID) e o `tid` (Tenant ID) vêm do Microsoft Entra; a página
 * "Conta não provisionada" do login mostra o identificador `oid.tid` da
 * própria pessoa.
 */

const SEM_RESPONSAVEL_SQL = `
  SELECT p.id, p.responsavel_operacional_membership_id AS atual
    FROM processos p
   WHERE p.organization_id = $1 AND p.apuracao_status <> 'FINAL'
     AND (p.responsavel_operacional_membership_id IS NULL
          OR EXISTS (SELECT 1 FROM organization_memberships m
                      WHERE m.id = p.responsavel_operacional_membership_id AND m.desativado_em IS NOT NULL))
   ORDER BY p.id
   LIMIT $2`;

function idOuNenhum(v: string): string | null {
  return v === 'nenhum' ? null : v;
}

function opcoes(argv: string[]): Record<string, string | true> {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const prox = argv[i + 1];
    if (prox === undefined || prox.startsWith('--')) o[a.slice(2)] = true;
    else { o[a.slice(2)] = prox; i++; }
  }
  return o;
}

function texto(o: Record<string, string | true>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`--${k} é obrigatório`);
  return v.trim();
}

export async function executarCli(argv: string[], saida: (linha: string) => void = (l) => console.log(l)): Promise<number> {
  const [comando, ...resto] = argv;
  const o = opcoes(resto);
  const pool = getPool();
  const ator = (): AtorProvisionamento => ({ tipo: 'operador_plataforma', descricao: texto(o, 'operador') });
  const usuario = async () => (typeof o.usuario === 'string' ? o.usuario : usuarioPorEmail(pool, texto(o, 'email')));
  try {
    switch (comando) {
      case 'vincular-usuario': {
        const r = await vincularIdentidadeMicrosoft(pool, {
          nome: texto(o, 'nome'), email: texto(o, 'email'), oid: texto(o, 'oid'), tid: texto(o, 'tid'), ator: ator(), motivo: texto(o, 'motivo'),
        });
        saida(JSON.stringify(r));
        return 0;
      }
      case 'adicionar-membro': {
        const r = await adicionarMembership(pool, {
          organizationId: texto(o, 'org'), usuarioId: await usuario(), papel: texto(o, 'papel'), ator: ator(), motivo: texto(o, 'motivo'),
        });
        saida(JSON.stringify(r));
        return 0;
      }
      case 'definir-papel': {
        const r = await definirPapel(pool, {
          organizationId: texto(o, 'org'), membershipId: texto(o, 'membership'), papel: texto(o, 'papel'), ator: ator(), motivo: texto(o, 'motivo'),
        });
        saida(JSON.stringify(r));
        return 0;
      }
      case 'desativar-membro':
      case 'reativar-membro': {
        const r = await definirAtivo(pool, {
          organizationId: texto(o, 'org'), membershipId: texto(o, 'membership'), ativo: comando === 'reativar-membro', ator: ator(), motivo: texto(o, 'motivo'),
        });
        saida(JSON.stringify(r));
        return 0;
      }
      case 'admin-plataforma': {
        if (!o.ativar === !o.desativar) throw new Error('use exatamente um de --ativar ou --desativar');
        const r = await definirAdministradorPlataforma(pool, { usuarioId: await usuario(), ativo: o.ativar === true, ator: ator(), motivo: texto(o, 'motivo') });
        saida(JSON.stringify(r));
        return 0;
      }
      case 'desvincular-usuario': {
        saida(JSON.stringify(await desvincularIdentidade(pool, { usuarioId: await usuario(), ator: ator(), motivo: texto(o, 'motivo') })));
        return 0;
      }
      case 'revogar-sessoes': {
        saida(JSON.stringify(await revogarSessoes(pool, { usuarioId: await usuario(), ator: ator(), motivo: texto(o, 'motivo') })));
        return 0;
      }
      case 'listar-membros': {
        saida(JSON.stringify(await listarMembros(pool, texto(o, 'org'))));
        return 0;
      }
      case 'conta-integracao': {
        const { rows } = await pool.query(
          `SELECT c.home_account_id, c.username, c.conectada_em, u.id AS usuario_id, u.nome, u.email, u.administrador_plataforma
             FROM msal_conta_ativa c LEFT JOIN usuarios u ON u.home_account_id = c.home_account_id
            WHERE c.id = 'default'`,
        );
        const c = rows[0];
        saida(JSON.stringify(!c?.home_account_id ? { conectada: false } : {
          conectada: true, username: c.username, homeAccountId: c.home_account_id, conectadaEm: c.conectada_em,
          usuarioVinculado: c.usuario_id ? { id: c.usuario_id, nome: c.nome, email: c.email, administradorPlataforma: c.administrador_plataforma } : null,
        }));
        return 0;
      }
      case 'vincular-conta-integracao': {
        const { rows } = await pool.query(`SELECT home_account_id FROM msal_conta_ativa WHERE id = 'default'`);
        const home: string | null = rows[0]?.home_account_id ?? null;
        const partes = home ? home.split('.') : [];
        if (partes.length !== 2) throw new Error('nenhuma conta de integração conectada (ou identificador fora do formato oid.tid)');
        const v = await vincularIdentidadeMicrosoft(pool, {
          nome: texto(o, 'nome'), email: texto(o, 'email'), oid: partes[0], tid: partes[1], ator: ator(), motivo: texto(o, 'motivo'),
        });
        const adm = await definirAdministradorPlataforma(pool, { usuarioId: v.usuarioId, ativo: true, ator: ator(), motivo: texto(o, 'motivo') });
        saida(JSON.stringify({ ...v, administradorPlataforma: true, alterado: adm.alterado }));
        return 0;
      }
      case 'processos-sem-responsavel': {
        const limite = Math.min(Math.max(Number(o.limite ?? 50) || 50, 1), 1000);
        const { rows } = await pool.query(SEM_RESPONSAVEL_SQL, [texto(o, 'org'), limite]);
        saida(JSON.stringify({ total: rows.length, limite, processos: rows.map((r) => ({ id: r.id, responsavelAtual: r.atual })) }));
        return 0;
      }
      case 'atribuir-responsavel': {
        const r = await atribuirResponsavel(pool, {
          organizationId: texto(o, 'org'), processoId: texto(o, 'processo'),
          autor: { tipo: 'operador_plataforma', descricao: texto(o, 'operador') },
          novoMembershipId: idOuNenhum(texto(o, 'para')), responsavelAtual: idOuNenhum(texto(o, 'responsavel-atual')),
          motivo: texto(o, 'motivo'),
          idempotenciaChave: typeof o.chave === 'string' ? o.chave : `cli:${crypto.randomUUID()}`,
        });
        saida(JSON.stringify(r));
        return r.ok ? 0 : 1;
      }
      case 'atribuir-sem-responsavel': {
        const org = texto(o, 'org');
        const para = texto(o, 'para');
        const limite = Math.min(Math.max(Number(o.limite ?? 500) || 500, 1), 5000);
        const { rows } = await pool.query(SEM_RESPONSAVEL_SQL, [org, limite]);
        // A chave carrega o LOTE: uma execução nova nunca reaproveita a
        // resposta de um lote antigo (o processo pode ter sido desatribuído
        // depois); repetir o mesmo lote é idempotente.
        const lote = typeof o.lote === 'string' && o.lote.trim() ? o.lote.trim() : crypto.randomUUID();
        const resumo = { lote, avaliados: rows.length, atribuidos: 0, jaAtribuidosNesteLote: 0, falhas: [] as Array<{ processoId: string; motivo: string }> };
        for (const p of rows) {
          const r = await atribuirResponsavel(pool, {
            organizationId: org, processoId: p.id, autor: { tipo: 'operador_plataforma', descricao: texto(o, 'operador') },
            novoMembershipId: para, responsavelAtual: p.atual ?? null, motivo: texto(o, 'motivo'),
            idempotenciaChave: `cli-lote:${lote}:${p.id}`,
          });
          if (!r.ok) resumo.falhas.push({ processoId: p.id, motivo: r.motivo });
          else if (r.replay) resumo.jaAtribuidosNesteLote += 1;
          else if (r.resultado === 'ATRIBUIDO') resumo.atribuidos += 1;
        }
        saida(JSON.stringify(resumo));
        return resumo.falhas.length ? 1 : 0;
      }
      default:
        saida('comandos: vincular-usuario | adicionar-membro | definir-papel | desativar-membro | reativar-membro | admin-plataforma | desvincular-usuario | revogar-sessoes | listar-membros | conta-integracao | vincular-conta-integracao | processos-sem-responsavel | atribuir-responsavel | atribuir-sem-responsavel');
        return 2;
    }
  } catch (err) {
    if (err instanceof ErroProvisionamento) { saida(JSON.stringify({ erro: err.codigo, ...err.detalhe })); return 1; }
    saida(JSON.stringify({ erro: (err as Error).message }));
    return 1;
  }
}

if (require.main === module) {
  executarCli(process.argv.slice(2))
    .then(async (codigo) => { await getPool().end().catch(() => undefined); process.exit(codigo); })
    .catch(() => process.exit(1));
}
