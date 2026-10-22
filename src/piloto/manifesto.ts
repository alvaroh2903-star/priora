/**
 * I4 — manifesto do provisionamento do ambiente piloto (validação PURA: nenhum I/O, nenhum banco).
 *
 * O manifesto declara o que deve existir para UMA organização: a organização (slug + nome), os membros (pessoa,
 * papel e, quando já conhecido, o identificador da conta Microsoft) e, opcionalmente, a caixa monitorada, que o
 * provisionamento só CONFERE (o vínculo da caixa continua sendo feito pela rota existente, pela própria conta da
 * caixa). Regras:
 *  - nenhum segredo: não há campo de senha, token ou chave; campo desconhecido é recusado (lista fechada);
 *  - nenhum papel padrão: cada membro declara o papel; ADMIN só existe se declarado;
 *  - só papéis internos (ANALYST, MANAGER, ADMIN): CLIENT exige o cadastro de clientes e fica fora do piloto;
 *  - o identificador da conta Microsoft é o vínculo EXPLÍCITO do S4 (`usuarios.home_account_id`); sem ele, a
 *    pessoa existe mas ainda não entra (a tela de login informa o identificador a ser cadastrado).
 */

export const FORMATO_DO_MANIFESTO = 'priora-piloto/v1' as const;

export const PAPEIS_DO_PILOTO = ['ANALYST', 'MANAGER', 'ADMIN'] as const;
export type PapelDoPiloto = (typeof PAPEIS_DO_PILOTO)[number];

export interface MembroDoManifesto {
  nome: string;
  /** Normalizado: sem espaços nas pontas, minúsculo. */
  email: string;
  /** Identificador da conta Microsoft (MSAL `homeAccountId`); null = ainda não informado. */
  homeAccountId: string | null;
  papel: PapelDoPiloto;
}

export interface CaixaDoManifesto {
  /** Conta Microsoft da caixa monitorada (deve ser a de um membro ADMIN: é quem a vincula pela rota existente). */
  homeAccountId: string;
  /** Endereço da caixa, normalizado. */
  username: string;
}

export interface ManifestoDoPiloto {
  formato: typeof FORMATO_DO_MANIFESTO;
  organizacao: { slug: string; nome: string };
  membros: MembroDoManifesto[];
  caixa: CaixaDoManifesto | null;
}

export type CodigoDeErroDoManifesto =
  | 'NAO_E_OBJETO' | 'CAMPO_DESCONHECIDO' | 'CAMPO_OBRIGATORIO' | 'FORMATO_DESCONHECIDO' | 'SLUG_INVALIDO' | 'NOME_INVALIDO'
  | 'EMAIL_INVALIDO' | 'CONTA_INVALIDA' | 'PAPEL_AUSENTE' | 'PAPEL_INVALIDO' | 'PAPEL_FORA_DO_PILOTO' | 'SEM_MEMBROS'
  | 'MEMBROS_DEMAIS' | 'EMAIL_REPETIDO' | 'CONTA_REPETIDA' | 'CAIXA_SEM_MEMBRO' | 'CONTA_DA_CAIXA_NAO_E_ADMIN';

export interface ErroDoManifesto {
  caminho: string;
  codigo: CodigoDeErroDoManifesto;
}

export type LeituraDoManifesto = { ok: true; manifesto: ManifestoDoPiloto } | { ok: false; erros: ErroDoManifesto[] };

export const MAX_MEMBROS = 200;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const CONTA = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001f\u007f\u2028\u2029]/;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function lerManifesto(bruto: unknown): LeituraDoManifesto {
  const erros: ErroDoManifesto[] = [];
  const erro = (caminho: string, codigo: CodigoDeErroDoManifesto) => { erros.push({ caminho, codigo }); };
  const soCampos = (v: Record<string, unknown>, caminho: string, permitidos: ReadonlyArray<string>) => {
    for (const k of Object.keys(v)) if (!permitidos.includes(k)) erro(`${caminho}.${k}`, 'CAMPO_DESCONHECIDO');
  };
  const nome = (v: unknown, caminho: string): string => {
    if (typeof v !== 'string') { erro(caminho, v === undefined ? 'CAMPO_OBRIGATORIO' : 'NOME_INVALIDO'); return ''; }
    const t = v.trim();
    if (!t || t.length > 200 || CONTROLE.test(t)) erro(caminho, 'NOME_INVALIDO');
    return t;
  };
  const email = (v: unknown, caminho: string): string => {
    if (typeof v !== 'string') { erro(caminho, v === undefined ? 'CAMPO_OBRIGATORIO' : 'EMAIL_INVALIDO'); return ''; }
    const t = v.trim().toLowerCase();
    if (t.length > 254 || !EMAIL.test(t)) erro(caminho, 'EMAIL_INVALIDO');
    return t;
  };
  const conta = (v: unknown, caminho: string, obrigatoria: boolean): string | null => {
    if (v === null || v === undefined) { if (obrigatoria) erro(caminho, 'CAMPO_OBRIGATORIO'); return null; }
    if (typeof v !== 'string' || !CONTA.test(v)) { erro(caminho, 'CONTA_INVALIDA'); return null; }
    return v;
  };

  if (!obj(bruto)) return { ok: false, erros: [{ caminho: '$', codigo: 'NAO_E_OBJETO' }] };
  soCampos(bruto, '$', ['formato', 'organizacao', 'membros', 'caixa']);
  if (bruto.formato !== FORMATO_DO_MANIFESTO) erro('$.formato', bruto.formato === undefined ? 'CAMPO_OBRIGATORIO' : 'FORMATO_DESCONHECIDO');

  let organizacao = { slug: '', nome: '' };
  if (!obj(bruto.organizacao)) erro('$.organizacao', bruto.organizacao === undefined ? 'CAMPO_OBRIGATORIO' : 'NAO_E_OBJETO');
  else {
    soCampos(bruto.organizacao, '$.organizacao', ['slug', 'nome']);
    const slug = bruto.organizacao.slug;
    if (typeof slug !== 'string' || !SLUG.test(slug)) erro('$.organizacao.slug', slug === undefined ? 'CAMPO_OBRIGATORIO' : 'SLUG_INVALIDO');
    organizacao = { slug: typeof slug === 'string' ? slug : '', nome: nome(bruto.organizacao.nome, '$.organizacao.nome') };
  }

  const membros: MembroDoManifesto[] = [];
  if (!Array.isArray(bruto.membros)) erro('$.membros', bruto.membros === undefined ? 'CAMPO_OBRIGATORIO' : 'NAO_E_OBJETO');
  else if (!bruto.membros.length) erro('$.membros', 'SEM_MEMBROS');
  else if (bruto.membros.length > MAX_MEMBROS) erro('$.membros', 'MEMBROS_DEMAIS');
  else {
    bruto.membros.forEach((m, i) => {
      const c = `$.membros[${i}]`;
      if (!obj(m)) { erro(c, 'NAO_E_OBJETO'); return; }
      soCampos(m, c, ['nome', 'email', 'homeAccountId', 'papel']);
      let papel: PapelDoPiloto = 'ANALYST';
      if (m.papel === undefined || m.papel === null) erro(`${c}.papel`, 'PAPEL_AUSENTE');
      else if (m.papel === 'CLIENT') erro(`${c}.papel`, 'PAPEL_FORA_DO_PILOTO');
      else if (!(PAPEIS_DO_PILOTO as ReadonlyArray<unknown>).includes(m.papel)) erro(`${c}.papel`, 'PAPEL_INVALIDO');
      else papel = m.papel as PapelDoPiloto;
      membros.push({ nome: nome(m.nome, `${c}.nome`), email: email(m.email, `${c}.email`), homeAccountId: conta(m.homeAccountId, `${c}.homeAccountId`, false), papel });
    });
    const repetidos = (chave: (m: MembroDoManifesto) => string | null, codigo: CodigoDeErroDoManifesto, campo: string) => {
      const vistos = new Map<string, number>();
      membros.forEach((m, i) => {
        const k = chave(m);
        if (!k) return;
        if (vistos.has(k)) erro(`$.membros[${i}].${campo}`, codigo);
        else vistos.set(k, i);
      });
    };
    repetidos((m) => m.email, 'EMAIL_REPETIDO', 'email');
    repetidos((m) => m.homeAccountId, 'CONTA_REPETIDA', 'homeAccountId');
  }

  let caixa: CaixaDoManifesto | null = null;
  if (bruto.caixa !== undefined && bruto.caixa !== null) {
    if (!obj(bruto.caixa)) erro('$.caixa', 'NAO_E_OBJETO');
    else {
      soCampos(bruto.caixa, '$.caixa', ['homeAccountId', 'username']);
      const homeAccountId = conta(bruto.caixa.homeAccountId, '$.caixa.homeAccountId', true);
      const username = email(bruto.caixa.username, '$.caixa.username');
      if (homeAccountId) {
        // O vínculo da caixa é feito pela rota existente, pela própria conta da caixa, que precisa ser ADMIN
        // da organização (`vincularCaixa`). O manifesto só é coerente se declarar essa conta assim.
        const contaDaCaixa = membros.find((m) => m.homeAccountId === homeAccountId);
        if (!contaDaCaixa) erro('$.caixa.homeAccountId', 'CAIXA_SEM_MEMBRO');
        else if (contaDaCaixa.papel !== 'ADMIN') erro('$.caixa.homeAccountId', 'CONTA_DA_CAIXA_NAO_E_ADMIN');
        caixa = { homeAccountId, username };
      }
    }
  }

  if (erros.length) return { ok: false, erros };
  return { ok: true, manifesto: { formato: FORMATO_DO_MANIFESTO, organizacao, membros, caixa } };
}

/** E-mail para relatório e console: só a inicial e o domínio (nada pessoal em log). */
export function emailMascarado(email: string): string {
  const [local, dominio] = email.split('@');
  return `${(local ?? '').slice(0, 1)}***@${dominio ?? ''}`;
}
