import { randomUUID } from 'crypto';
import {
  CadastroInstitucional, DEFINICOES_EM_VIGOR, EventoDoSignatario, PendenciaInstitucional, ProblemaDoCadastro, SignatarioLegal, TipoDocumento, cadastroVigente,
  modeloVigente, pendenciasInstitucionais, signatariosVigentes, validarDadosInstitucionais, validarPoderes, validarSignatario,
} from '../dominio';
import { AtorDocumental, DepsDocumentos, RepositorioInstitucional } from './portas';
import { dataNoFuso } from './servico';

/**
 * Cadastro institucional da organização (decisão O1.8, 14.19): os dados fixos usados pelos quatro documentos e o
 * signatário legal (DOC-23). Só a ADMINISTRAÇÃO da organização consulta e altera (papel conferido aqui e no banco);
 * a organização e o autor vêm do servidor, nunca do corpo. Append-only: cada alteração é um registro novo, com autor
 * e instante, e o histórico fica. Nada é inventado: o que não for cadastrado fica faltando nos documentos que o pedem.
 */

export type ResultadoDoCadastro =
  | { tipo: 'REGISTRADO'; id: string }
  | { tipo: 'RECUSADO'; motivo: string; problemas?: ProblemaDoCadastro[] };

const TIPOS: TipoDocumento[] = ['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR', 'TERMO_EVERGREEN'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As recusas do banco que a aplicação já conhece (proteção em profundidade): viram recusa, não erro. */
const RECUSAS_DO_BANCO = [
  'CADASTRO_INSTITUCIONAL_EXIGE_ADMIN', 'SIGNATARIO_INEXISTENTE', 'SIGNATARIO_REVOGADO', 'PODERES_DE_OUTRO_CADASTRO', 'CADASTRO_INSTITUCIONAL_FORA_DE_ORDEM',
];

async function comoAdmin(
  deps: DepsDocumentos, ator: AtorDocumental, fn: (repo: RepositorioInstitucional) => Promise<ResultadoDoCadastro>,
): Promise<ResultadoDoCadastro> {
  if (!deps.institucional) return { tipo: 'RECUSADO', motivo: 'CADASTRO_INDISPONIVEL' };
  if ((await deps.fontes.papelDaPessoa(ator.organizationId, ator.membershipId)) !== 'ADMIN') return { tipo: 'RECUSADO', motivo: 'EXIGE_ADMIN' };
  try {
    return await fn(deps.institucional);
  } catch (e) {
    const motivo = RECUSAS_DO_BANCO.find((m) => e instanceof Error && e.message.includes(m));
    if (motivo) return { tipo: 'RECUSADO', motivo: motivo === 'CADASTRO_INSTITUCIONAL_EXIGE_ADMIN' ? 'EXIGE_ADMIN' : motivo };
    throw e;
  }
}

/** Motivo opcional da alteração: uma linha de texto (nenhum controle C0/C1 nem separador de linha ou parágrafo). */
function motivoDe(v: unknown): { ok: true; motivo: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, motivo: null };
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || !v.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return { ok: false };
  return { ok: true, motivo: v.trim() };
}

/** Registra o cadastro institucional COMPLETO da organização (o anterior fica no histórico). */
export async function registrarCadastroInstitucional(deps: DepsDocumentos, ator: AtorDocumental, entrada: Readonly<Record<string, unknown>>): Promise<ResultadoDoCadastro> {
  return comoAdmin(deps, ator, async (repo) => {
    const v = validarDadosInstitucionais(entrada);
    const m = motivoDe(entrada.motivo);
    if (v.tipo === 'INVALIDO' || !m.ok) {
      return { tipo: 'RECUSADO', motivo: 'DADOS_INVALIDOS', problemas: [...(v.tipo === 'INVALIDO' ? v.problemas : []), ...(m.ok ? [] : [{ campo: 'motivo', motivo: 'CARACTERE_DE_CONTROLE_OU_QUEBRA' as const }])] };
    }
    const r = await repo.gravarCadastro(ator.organizationId, { ...v.dados, motivo: m.motivo, por: ator.membershipId, em: deps.relogio.agora() });
    return { tipo: 'REGISTRADO', id: r.cadastroId };
  });
}

/** Cadastra um signatário legal novo (sem `signatarioId`) ou corrige os dados de um existente (com ele). */
export async function registrarSignatarioLegal(
  deps: DepsDocumentos, ator: AtorDocumental, entrada: Readonly<Record<string, unknown>>, signatarioId: string | null = null,
): Promise<ResultadoDoCadastro> {
  return comoAdmin(deps, ator, async (repo) => {
    if (signatarioId !== null) {
      const r = await existente(repo, ator.organizationId, signatarioId);
      if (r) return r;
    }
    const v = validarSignatario(entrada);
    if (v.tipo === 'INVALIDO') return { tipo: 'RECUSADO', motivo: 'DADOS_INVALIDOS', problemas: v.problemas };
    const r = await repo.gravarEventoDoSignatario(ator.organizationId, {
      signatarioId: signatarioId ?? randomUUID(), evento: 'CADASTRADO', ...v.dados, poderesValidoAte: null, motivo: null, refereCadastroId: null,
      por: ator.membershipId, em: deps.relogio.agora(),
    });
    return { tipo: 'REGISTRADO', id: r.eventoId };
  });
}

/**
 * Registra a comprovação dos poderes de representação do signatário, com a evidência (nunca presumida), para o cadastro
 * ATUAL dele (nome, CPF, qualificação). Uma correção posterior do cadastro exige nova comprovação.
 */
export async function registrarPoderesDoSignatario(
  deps: DepsDocumentos, ator: AtorDocumental, signatarioId: string, entrada: Readonly<Record<string, unknown>>,
): Promise<ResultadoDoCadastro> {
  return comoAdmin(deps, ator, async (repo) => {
    const r = await existente(repo, ator.organizationId, signatarioId);
    if (r) return r;
    const v = validarPoderes(entrada);
    if (v.tipo === 'INVALIDO') return { tipo: 'RECUSADO', motivo: 'DADOS_INVALIDOS', problemas: v.problemas };
    const atual = (await repo.eventosDosSignatarios(ator.organizationId)).filter((e) => e.signatarioId === signatarioId && e.evento === 'CADASTRADO')
      .sort((a, b) => a.sequencia - b.sequencia).at(-1)!;
    const g = await repo.gravarEventoDoSignatario(ator.organizationId, {
      signatarioId, evento: 'PODERES_COMPROVADOS', nome: null, cpf: null, qualificacao: null, evidencia: v.dados.evidencia, poderesValidoAte: v.dados.validoAte,
      motivo: null, refereCadastroId: atual.eventoId, por: ator.membershipId, em: deps.relogio.agora(),
    });
    return { tipo: 'REGISTRADO', id: g.eventoId };
  });
}

/** Revoga o signatário (definitivo): os campos de quem assina deixam de usá-lo. */
export async function revogarSignatarioLegal(
  deps: DepsDocumentos, ator: AtorDocumental, signatarioId: string, entrada: Readonly<Record<string, unknown>>,
): Promise<ResultadoDoCadastro> {
  return comoAdmin(deps, ator, async (repo) => {
    const r = await existente(repo, ator.organizationId, signatarioId);
    if (r) return r;
    const m = motivoDe(entrada.motivo);
    if (!m.ok || m.motivo === null) return { tipo: 'RECUSADO', motivo: 'DADOS_INVALIDOS', problemas: [{ campo: 'motivo', motivo: 'OBRIGATORIO' }] };
    const g = await repo.gravarEventoDoSignatario(ator.organizationId, {
      signatarioId, evento: 'REVOGADO', nome: null, cpf: null, qualificacao: null, evidencia: null, poderesValidoAte: null, motivo: m.motivo, refereCadastroId: null,
      por: ator.membershipId, em: deps.relogio.agora(),
    });
    return { tipo: 'REGISTRADO', id: g.eventoId };
  });
}

/** O signatário existe NESTA organização e não foi revogado; senão, a recusa. */
async function existente(repo: RepositorioInstitucional, organizationId: string, signatarioId: string): Promise<ResultadoDoCadastro | null> {
  if (!UUID.test(signatarioId)) return { tipo: 'RECUSADO', motivo: 'SIGNATARIO_INEXISTENTE' };
  const eventos = (await repo.eventosDosSignatarios(organizationId)).filter((e) => e.signatarioId === signatarioId);
  if (!eventos.some((e) => e.evento === 'CADASTRADO')) return { tipo: 'RECUSADO', motivo: 'SIGNATARIO_INEXISTENTE' };
  if (eventos.some((e) => e.evento === 'REVOGADO')) return { tipo: 'RECUSADO', motivo: 'SIGNATARIO_REVOGADO' };
  return null;
}

export type ConsultaDoCadastro =
  | {
    tipo: 'OK';
    vigente: CadastroInstitucional | null;
    historico: CadastroInstitucional[];
    signatarios: { vigentes: SignatarioLegal[]; eventos: EventoDoSignatario[] };
    /** Por modelo, o que o cadastro ainda não fornece; `definicao` diz se é a da versão VALIDADA em uso ou a proposta oficial. */
    pendencias: Array<PendenciaInstitucional & { definicao: 'VERSAO_EM_USO' | 'PROPOSTA_OFICIAL' }>;
  }
  | { tipo: 'RECUSADO'; motivo: string };

/** O cadastro vigente, o histórico, os signatários e o que ainda falta cadastrar, por modelo. Só a administração. */
export async function consultarCadastroInstitucional(deps: DepsDocumentos, ator: AtorDocumental): Promise<ConsultaDoCadastro> {
  if (!deps.institucional) return { tipo: 'RECUSADO', motivo: 'CADASTRO_INDISPONIVEL' };
  if ((await deps.fontes.papelDaPessoa(ator.organizationId, ator.membershipId)) !== 'ADMIN') return { tipo: 'RECUSADO', motivo: 'EXIGE_ADMIN' };
  const agora = deps.relogio.agora();
  const historico = await deps.institucional.cadastros(ator.organizationId);
  const eventos = await deps.institucional.eventosDosSignatarios(ator.organizationId);
  const vigentes = signatariosVigentes(eventos, agora.toISOString());
  const vigente = cadastroVigente(historico);
  const definicoes = await Promise.all(TIPOS.map(async (tipo) => {
    const emUso = modeloVigente(tipo, await deps.repo.versoes(ator.organizationId, tipo));
    return emUso?.definicao ? { definicao: emUso.definicao, origem: 'VERSAO_EM_USO' as const } : { definicao: DEFINICOES_EM_VIGOR[tipo], origem: 'PROPOSTA_OFICIAL' as const };
  }));
  const pendencias = pendenciasInstitucionais(definicoes.map((d) => d.definicao), vigente, vigentes, dataNoFuso(agora))
    .map((p, i) => ({ ...p, definicao: definicoes[i].origem }));
  return { tipo: 'OK', vigente, historico, signatarios: { vigentes, eventos }, pendencias };
}
