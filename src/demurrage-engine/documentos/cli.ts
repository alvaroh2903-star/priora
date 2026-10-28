import { getPool } from '../db/pool';
import { ArmazenamentoObjetos, codigoDeFalhaArmazenamento } from './armazenamento';
import { arquivosDoAmbiente, ErroConfiguracaoArquivos } from './configuracao';
import { corrigir, diagnosticar } from './reconciliacao';

/**
 * Produção P1 (arquivos de minuta) — CLI de RECONCILIAÇÃO banco ×
 * armazenamento (só backend). Usa a MESMA configuração do app
 * (`DEMURRAGE_ARQUIVOS_*`, `DEMURRAGE_DATABASE_URL`) — rode no próprio
 * ambiente (Render Shell), nunca com outro `.env`.
 *
 *   npm run demurrage:arquivos -- diagnosticar [--verificar-hash] [--sem-orfaos]
 *       somente leitura: uploads abandonados, posses vencidas, tentativas
 *       abandonadas, remoções pendentes, registros confirmados sem objeto (ou
 *       com tamanho/hash divergente), objetos órfãos (por impressão — nunca a
 *       chave), leitura anônima do bucket (precisa ser recusada) e o legado
 *       que bloqueia o encerramento;
 *   npm run demurrage:arquivos -- corrigir --operador "<nome>" --motivo "<texto>"
 *       [--verificar-hash] [--limite-ausentes 0.2] [--limite 500]
 *       correção CONTROLADA e auditada: expira uploads abandonados, remove
 *       objetos de chaves descartáveis (nunca vinculadas), marca "objeto
 *       ausente" (abortado se a proporção passar do limite — sinal de bucket
 *       errado) e desmarca o que reapareceu íntegro. NUNCA apaga órfão nem
 *       documento confirmado.
 *
 * Saída: JSON. Nunca imprime chave de objeto, endpoint, bucket ou credencial.
 */

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

export interface DepsCli {
  pool?: ReturnType<typeof getPool>;
  armazenamento?: ArmazenamentoObjetos | null;
  naoVinculadoExpiraMs?: number;
}

export async function executarCliArquivos(argv: string[], saida: (linha: string) => void = (l) => console.log(l), deps: DepsCli = {}): Promise<number> {
  const [comando, ...resto] = argv;
  const o = opcoes(resto);
  try {
    const amb = deps.armazenamento !== undefined ? null : arquivosDoAmbiente();
    const armazenamento = deps.armazenamento !== undefined ? deps.armazenamento : amb!.armazenamento;
    if (!armazenamento) { saida(JSON.stringify({ erro: 'armazenamento_nao_configurado' })); return 1; }
    const base = {
      pool: deps.pool ?? getPool(), armazenamento,
      naoVinculadoExpiraMs: deps.naoVinculadoExpiraMs ?? amb?.cfg.naoVinculadoExpiraMs ?? 30 * 86_400_000,
    };
    switch (comando) {
      case 'diagnosticar': {
        const d = await diagnosticar(base, { verificarHash: o['verificar-hash'] === true, listarOrfaos: o['sem-orfaos'] !== true });
        saida(JSON.stringify(d));
        const grave = d.leituraAnonima === 'PERMITIDA' || d.problemas.some((p) => p.problema !== 'objeto_reapareceu')
          || d.arquivoIndisponivelBloqueante.length > 0;
        return grave ? 3 : 0;
      }
      case 'corrigir': {
        const limiteAusentes = typeof o['limite-ausentes'] === 'string' ? Number(o['limite-ausentes']) : undefined;
        if (limiteAusentes !== undefined && !(limiteAusentes >= 0 && limiteAusentes <= 1)) throw new Error('--limite-ausentes entre 0 e 1');
        const limite = typeof o.limite === 'string' ? Math.min(Math.max(Number(o.limite) || 500, 1), 5000) : undefined;
        const r = await corrigir(base, {
          operador: texto(o, 'operador'), motivo: texto(o, 'motivo'), verificarHash: o['verificar-hash'] === true, limiteAusentes, limite,
        });
        saida(JSON.stringify(r));
        return r.abortado || r.marcacaoAbortada ? 3 : 0;
      }
      default:
        saida('comandos: diagnosticar [--verificar-hash] [--sem-orfaos] | corrigir --operador "<nome>" --motivo "<texto>" [--verificar-hash] [--limite-ausentes 0.2] [--limite 500]');
        return 2;
    }
  } catch (err) {
    if (err instanceof ErroConfiguracaoArquivos) { saida(JSON.stringify({ erro: 'configuracao_invalida', variavel: err.variavel })); return 1; }
    const codigo = codigoDeFalhaArmazenamento(err);
    // Nunca a mensagem crua de um erro de provedor/banco (pode carregar valores).
    saida(JSON.stringify({ erro: codigo === 'ERRO_INTERNO' && err instanceof Error && /obrigatório|entre 0 e 1/.test(err.message) ? err.message : codigo }));
    return 1;
  }
}

if (require.main === module) {
  executarCliArquivos(process.argv.slice(2))
    .then(async (codigo) => { await getPool().end().catch(() => undefined); process.exit(codigo); })
    .catch(() => process.exit(1));
}
