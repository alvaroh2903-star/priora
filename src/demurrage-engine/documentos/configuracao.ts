import { ArmazenamentoObjetos } from './armazenamento';
import { ArmazenamentoS3, ConfiguracaoS3 } from './armazenamentoS3';
import { ArmazenamentoFilesystemDev } from './armazenamentoFilesystemDev';

/**
 * Produção P1 (arquivos de minuta) — configuração do armazenamento de objetos.
 *
 *  - `DEMURRAGE_ARQUIVOS_PROVEDOR`: `s3` (produção) | `filesystem-dev` (só
 *    desenvolvimento, explícito) | vazio (fora de produção: não configurado —
 *    as rotas de documento respondem 503 e nenhuma minuta nova é registrada,
 *    porque o registro exige documento disponível). Nunca há fallback para
 *    disco.
 *  - Em produção: o provedor é OBRIGATÓRIO e só `s3` é aceito, com endpoint
 *    HTTPS — configuração ausente ou inválida derruba o boot (o deploy
 *    anterior continua no ar), em vez de subir um app que não guarda minuta.
 *  - Mensagens de erro citam só o NOME da variável, nunca o valor (o valor
 *    pode ser o segredo ou um endpoint com credencial).
 */

export const TETO_TAMANHO_BYTES = 52428800; // = CHECK `documentos_minuta_coerente` (50 MiB)

export interface ConfiguracaoArquivos {
  provedor: 's3' | 'filesystem-dev' | null;
  tamanhoMaximoBytes: number;
  /** Prazo de um upload PENDENTE nunca concluído (depois disso expira e o objeto é apagado). */
  uploadExpiraMs: number;
  /** Posse do envio do conteúdo (PUT): um envio por vez; também é o TETO de duração de uma tentativa. */
  posseEnvioMs: number;
  /** Documento DISPONIVEL nunca vinculado a minuta expira depois deste prazo (abandonado). */
  naoVinculadoExpiraMs: number;
  /** Etapa do tick que expira uploads abandonados e remove objetos nunca vinculados (desligável após restauração de backup). */
  limpezaAutomatica: boolean;
  /** Carência da remoção AUTOMÁTICA de objeto completo nunca vinculado (proteção contra banco restaurado). */
  carenciaRemocaoMs: number;
  /** Ociosidade máxima de uma requisição ao provedor. */
  timeoutMs: number;
  s3: ConfiguracaoS3 | null;
  diretorioDev: string | null;
}

export class ErroConfiguracaoArquivos extends Error {
  constructor(public readonly variavel: string, motivo: string) {
    super(`[documentos] configuração inválida: ${variavel} (${motivo})`);
    this.name = 'ErroConfiguracaoArquivos';
  }
}

function inteiro(env: NodeJS.ProcessEnv, nome: string, padrao: number, min: number, max: number): number {
  const bruto = env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  if (!/^\d{1,12}$/.test(bruto.trim())) throw new ErroConfiguracaoArquivos(nome, 'inteiro esperado');
  const n = Number(bruto.trim());
  if (n < min || n > max) throw new ErroConfiguracaoArquivos(nome, `fora do intervalo ${min}..${max}`);
  return n;
}

function booleano(env: NodeJS.ProcessEnv, nome: string, padrao: boolean): boolean {
  const bruto = (env[nome] ?? '').trim();
  if (bruto === '') return padrao;
  if (bruto !== 'true' && bruto !== 'false') throw new ErroConfiguracaoArquivos(nome, 'true ou false');
  return bruto === 'true';
}

function obrigatorio(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome];
  if (!v || !v.trim()) throw new ErroConfiguracaoArquivos(nome, 'obrigatória');
  return v.trim();
}

export function lerConfiguracaoArquivos(env: NodeJS.ProcessEnv = process.env, producao = env.NODE_ENV === 'production'): ConfiguracaoArquivos {
  const bruto = (env.DEMURRAGE_ARQUIVOS_PROVEDOR ?? '').trim();
  const comum = {
    tamanhoMaximoBytes: inteiro(env, 'DEMURRAGE_ARQUIVOS_TAMANHO_MAXIMO_BYTES', 26214400, 1024, TETO_TAMANHO_BYTES),
    uploadExpiraMs: inteiro(env, 'DEMURRAGE_ARQUIVOS_UPLOAD_EXPIRA_MIN', 1440, 5, 10080) * 60_000,
    posseEnvioMs: inteiro(env, 'DEMURRAGE_ARQUIVOS_ENVIO_POSSE_MIN', 15, 1, 120) * 60_000,
    naoVinculadoExpiraMs: inteiro(env, 'DEMURRAGE_ARQUIVOS_NAO_VINCULADO_EXPIRA_DIAS', 30, 1, 3650) * 86_400_000,
    limpezaAutomatica: booleano(env, 'DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA', true),
    carenciaRemocaoMs: inteiro(env, 'DEMURRAGE_ARQUIVOS_REMOCAO_CARENCIA_DIAS', 30, 0, 3650) * 86_400_000,
    timeoutMs: inteiro(env, 'DEMURRAGE_ARQUIVOS_TIMEOUT_MS', 30000, 1000, 600000),
  };
  if (bruto === '') {
    if (producao) throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_PROVEDOR', 'obrigatória em produção (s3)');
    return { provedor: null, ...comum, s3: null, diretorioDev: null };
  }
  if (bruto === 'filesystem-dev') {
    if (producao) throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_PROVEDOR', 'filesystem-dev é proibido em produção');
    return { provedor: 'filesystem-dev', ...comum, s3: null, diretorioDev: obrigatorio(env, 'DEMURRAGE_ARQUIVOS_DIR') };
  }
  if (bruto !== 's3') throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_PROVEDOR', 's3 ou filesystem-dev');
  const endpoint = obrigatorio(env, 'DEMURRAGE_ARQUIVOS_S3_ENDPOINT');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_ENDPOINT', 'URL inválida'); }
  if (url.protocol !== 'https:' && (producao || url.protocol !== 'http:')) {
    throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_ENDPOINT', producao ? 'HTTPS obrigatório em produção' : 'http ou https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_ENDPOINT', 'sem credencial, query ou fragmento na URL');
  }
  const bucket = obrigatorio(env, 'DEMURRAGE_ARQUIVOS_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_BUCKET', 'nome de bucket inválido');
  const pathStyleBruto = (env.DEMURRAGE_ARQUIVOS_S3_PATH_STYLE ?? 'true').trim();
  if (pathStyleBruto !== 'true' && pathStyleBruto !== 'false') throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_PATH_STYLE', 'true ou false');
  // Virtual-hosted com ponto no bucket quebra o TLS (*.s3.amazonaws.com).
  if (pathStyleBruto === 'false' && bucket.includes('.')) {
    throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_BUCKET', 'bucket com ponto exige PATH_STYLE=true');
  }
  // Região explícita: `auto` é específica do Cloudflare R2; AWS/B2/MinIO exigem a região real.
  const regiao = obrigatorio(env, 'DEMURRAGE_ARQUIVOS_S3_REGIAO');
  if (!/^[a-z0-9-]{2,32}$/.test(regiao)) throw new ErroConfiguracaoArquivos('DEMURRAGE_ARQUIVOS_S3_REGIAO', 'região inválida');
  return {
    provedor: 's3', ...comum, diretorioDev: null,
    s3: {
      endpoint: url.toString(),
      regiao,
      bucket,
      accessKeyId: obrigatorio(env, 'DEMURRAGE_ARQUIVOS_S3_ACCESS_KEY_ID'),
      secretAccessKey: obrigatorio(env, 'DEMURRAGE_ARQUIVOS_S3_SECRET_ACCESS_KEY'),
      pathStyle: pathStyleBruto === 'true',
      timeoutMs: comum.timeoutMs,
    },
  };
}

export function criarArmazenamento(cfg: ConfiguracaoArquivos): ArmazenamentoObjetos | null {
  if (cfg.provedor === 's3' && cfg.s3) return new ArmazenamentoS3(cfg.s3);
  if (cfg.provedor === 'filesystem-dev' && cfg.diretorioDev) return new ArmazenamentoFilesystemDev(cfg.diretorioDev);
  return null;
}

let cache: { cfg: ConfiguracaoArquivos; armazenamento: ArmazenamentoObjetos | null } | null = null;

/** Configuração do ambiente (memorizada). Lança `ErroConfiguracaoArquivos` em configuração inválida. */
export function arquivosDoAmbiente(): { cfg: ConfiguracaoArquivos; armazenamento: ArmazenamentoObjetos | null } {
  if (!cache) {
    const cfg = lerConfiguracaoArquivos();
    cache = { cfg, armazenamento: criarArmazenamento(cfg) };
  }
  return cache;
}
