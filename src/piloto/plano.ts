import type { ManifestoDoPiloto, PapelDoPiloto } from './manifesto';

/**
 * I4 — plano do provisionamento (PURO): compara o manifesto com o estado atual do banco e devolve as ações que
 * faltam, os conflitos e a situação de cada item. Garantias:
 *  - só ACRESCENTA: cria a organização, usuários e memberships que faltam e grava o vínculo explícito da conta
 *    Microsoft quando ele ainda não existe; nunca remove, renomeia nem muda papel;
 *  - qualquer divergência é CONFLITO e recusa a execução inteira (nada é gravado): nome diferente, conta diferente,
 *    conta de outro usuário, papel diferente, caixa vinculada a outra organização;
 *  - isolamento: nada de outra organização é alterado. Uma pessoa que já é membro de outra organização pode ganhar
 *    membership nesta (é decisão desta organização), mas o vínculo da conta dela nunca é gravado por aqui (ele
 *    valeria também na outra organização);
 *  - a caixa monitorada nunca é vinculada aqui: o vínculo é da rota existente, pela própria conta da caixa (prova de
 *    posse da conta); o plano só informa a situação.
 */

export interface UsuarioAtual { id: string; nome: string; email: string; homeAccountId: string | null }
export interface MembershipAtual { id: string; organizationId: string; usuarioId: string; papel: string }
export interface CaixaAtual { id: string; organizationId: string; homeAccountId: string; estado: 'ativa' | 'pausada'; vinculadaPorMembershipId: string }

export interface EstadoAtual {
  organizacao: { id: string; nome: string } | null;
  /** Usuários que casam com algum e-mail (sem diferenciar maiúsculas) ou conta do manifesto. */
  usuarios: UsuarioAtual[];
  /** Todas as memberships desses usuários, em qualquer organização. */
  memberships: MembershipAtual[];
  /** Vínculos não removidos da conta da caixa declarada (em qualquer organização). */
  caixas: CaixaAtual[];
  /** Memberships da organização cujo usuário não está no manifesto (nunca removidas; só informadas). */
  membrosForaDoManifesto: number;
}

export type CodigoDeConflito =
  | 'ORGANIZACAO_COM_OUTRO_NOME' | 'EMAIL_AMBIGUO' | 'USUARIO_COM_OUTRO_NOME' | 'USUARIO_COM_OUTRA_CONTA'
  | 'CONTA_DE_OUTRO_USUARIO' | 'VINCULO_DE_CONTA_DE_MEMBRO_DE_OUTRA_ORGANIZACAO' | 'PAPEL_DIVERGENTE'
  | 'CAIXA_DE_OUTRA_ORGANIZACAO';

export interface Conflito { item: string; codigo: CodigoDeConflito }

export type Acao =
  | { tipo: 'CRIAR_ORGANIZACAO'; slug: string; nome: string }
  | { tipo: 'CRIAR_USUARIO'; membro: number; nome: string; email: string; homeAccountId: string | null }
  | { tipo: 'VINCULAR_CONTA'; membro: number; usuarioId: string; homeAccountId: string }
  | { tipo: 'CRIAR_MEMBERSHIP'; membro: number; usuarioId: string | null; papel: PapelDoPiloto };

export interface SituacaoDoMembro {
  membro: number;
  papel: PapelDoPiloto;
  usuario: 'CRIAR' | 'EXISTENTE';
  conta: 'VINCULAR' | 'VINCULADA' | 'PENDENTE';
  membership: 'CRIAR' | 'EXISTENTE';
  /** O usuário também é membro de outra organização (nada dela muda). */
  tambemEmOutraOrganizacao: boolean;
}

export type SituacaoDaCaixa = 'NAO_DECLARADA' | 'PENDENTE_DE_VINCULO' | 'VINCULADA' | 'PAUSADA' | 'DE_OUTRA_ORGANIZACAO';

export interface Plano {
  organizacao: 'CRIAR' | 'EXISTENTE';
  acoes: Acao[];
  conflitos: Conflito[];
  membros: SituacaoDoMembro[];
  caixa: SituacaoDaCaixa;
  admins: number;
  membrosForaDoManifesto: number;
}

export function planejar(m: ManifestoDoPiloto, e: EstadoAtual): Plano {
  const conflitos: Conflito[] = [];
  const acoes: Acao[] = [];
  const conflito = (item: string, codigo: CodigoDeConflito) => { conflitos.push({ item, codigo }); };

  const org = e.organizacao;
  if (!org) acoes.push({ tipo: 'CRIAR_ORGANIZACAO', slug: m.organizacao.slug, nome: m.organizacao.nome });
  else if (org.nome !== m.organizacao.nome) conflito('organizacao', 'ORGANIZACAO_COM_OUTRO_NOME');

  const membros: SituacaoDoMembro[] = m.membros.map((pm, i) => {
    const item = `membros[${i}]`;
    const porEmail = e.usuarios.filter((u) => u.email.trim().toLowerCase() === pm.email);
    const porConta = pm.homeAccountId ? e.usuarios.filter((u) => u.homeAccountId === pm.homeAccountId) : [];
    const situacao: SituacaoDoMembro = {
      membro: i, papel: pm.papel, usuario: 'CRIAR', conta: pm.homeAccountId ? 'VINCULAR' : 'PENDENTE', membership: 'CRIAR', tambemEmOutraOrganizacao: false,
    };
    if (porEmail.length > 1) { conflito(item, 'EMAIL_AMBIGUO'); return situacao; }
    const u = porEmail[0];
    if (!u) {
      if (porConta.length) { conflito(item, 'CONTA_DE_OUTRO_USUARIO'); return situacao; }
      acoes.push({ tipo: 'CRIAR_USUARIO', membro: i, nome: pm.nome, email: pm.email, homeAccountId: pm.homeAccountId });
      acoes.push({ tipo: 'CRIAR_MEMBERSHIP', membro: i, usuarioId: null, papel: pm.papel });
      return situacao;
    }
    situacao.usuario = 'EXISTENTE';
    const outras = e.memberships.filter((x) => x.usuarioId === u.id && x.organizationId !== org?.id);
    situacao.tambemEmOutraOrganizacao = outras.length > 0;
    if (u.nome !== pm.nome) conflito(item, 'USUARIO_COM_OUTRO_NOME');
    if (porConta.some((x) => x.id !== u.id)) conflito(item, 'CONTA_DE_OUTRO_USUARIO');
    if (u.homeAccountId) {
      if (pm.homeAccountId && pm.homeAccountId !== u.homeAccountId) conflito(item, 'USUARIO_COM_OUTRA_CONTA');
      situacao.conta = 'VINCULADA';
    } else if (pm.homeAccountId) {
      // O vínculo da conta é da identidade GLOBAL: gravado aqui, valeria também na outra organização.
      if (outras.length) conflito(item, 'VINCULO_DE_CONTA_DE_MEMBRO_DE_OUTRA_ORGANIZACAO');
      else acoes.push({ tipo: 'VINCULAR_CONTA', membro: i, usuarioId: u.id, homeAccountId: pm.homeAccountId });
    }
    const atual = org ? e.memberships.find((x) => x.usuarioId === u.id && x.organizationId === org.id) : undefined;
    if (!atual) acoes.push({ tipo: 'CRIAR_MEMBERSHIP', membro: i, usuarioId: u.id, papel: pm.papel });
    else {
      situacao.membership = 'EXISTENTE';
      if (atual.papel !== pm.papel) conflito(item, 'PAPEL_DIVERGENTE');
    }
    return situacao;
  });

  let caixa: SituacaoDaCaixa = 'NAO_DECLARADA';
  if (m.caixa) {
    const vinculo = e.caixas[0];
    if (!vinculo) caixa = 'PENDENTE_DE_VINCULO';
    else if (!org || vinculo.organizationId !== org.id) { caixa = 'DE_OUTRA_ORGANIZACAO'; conflito('caixa', 'CAIXA_DE_OUTRA_ORGANIZACAO'); }
    else caixa = vinculo.estado === 'ativa' ? 'VINCULADA' : 'PAUSADA';
  }

  return {
    organizacao: org ? 'EXISTENTE' : 'CRIAR', acoes: conflitos.length ? [] : acoes, conflitos, membros, caixa,
    admins: m.membros.filter((x) => x.papel === 'ADMIN').length, membrosForaDoManifesto: e.membrosForaDoManifesto,
  };
}
