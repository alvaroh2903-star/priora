/**
 * Leitura dos BYTES do arquivo que o Analista entregou como ASSINADO (decisões
 * 4.2 e DOC-20). A Priora não assina, não valida certificado e NUNCA declara uma
 * assinatura criptograficamente válida: só registra o INDÍCIO estrutural que os
 * bytes mostram. Quem decide se o arquivo serve é a CONFERÊNCIA HUMANA, sempre
 * obrigatória antes do encaminhamento. Puro: sem I/O.
 *  - INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO: o arquivo começa com os bytes exatos do PDF preparado e a
 *    parte acrescentada tem a estrutura de uma assinatura PDF (/ByteRange + /Sig). Indício de vínculo, não validade;
 *  - INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO: há estrutura de assinatura, mas o arquivo foi regravado (não dá
 *    para provar que é este documento);
 *  - SEM_INDICIO_DE_ASSINATURA_DIGITAL: ex.: impresso, assinado à mão e digitalizado.
 * Arquivo diferente do preparado NÃO é assinatura válida: só a conferência humana registrada decide.
 * A validade do certificado (ICP-Brasil, cadeia, revogação) não é verificada. A Priora nunca recebe nem usa o
 * certificado, a chave privada ou a senha (DOC-23): só os bytes do PDF já assinado.
 */
export type VerificacaoDoArquivoAssinado =
  | 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO'
  | 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO'
  | 'SEM_INDICIO_DE_ASSINATURA_DIGITAL';

/** Nenhuma verificação desta camada valida certificado: é o que a Priora informa junto de toda leitura. */
export const CERTIFICADO_NAO_VERIFICADO = 'CERTIFICADO_NAO_VERIFICADO' as const;

export const VERIFICACOES_DO_ARQUIVO_ASSINADO: ReadonlyArray<VerificacaoDoArquivoAssinado> = [
  'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO', 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO', 'SEM_INDICIO_DE_ASSINATURA_DIGITAL',
];

const texto = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const temAssinaturaDigital = (b: Uint8Array) => {
  const t = texto(b);
  return /\/ByteRange\s*\[/.test(t) && /\/(Type|FT)\s*\/Sig\b/.test(t);
};

const comecaCom = (b: Uint8Array, prefixo: Uint8Array) => {
  if (b.length <= prefixo.length) return false;
  for (let i = 0; i < prefixo.length; i++) if (b[i] !== prefixo[i]) return false;
  return true;
};

export function verificarArquivoAssinado(preparado: Uint8Array, assinado: Uint8Array): VerificacaoDoArquivoAssinado {
  if (comecaCom(assinado, preparado) && temAssinaturaDigital(assinado.subarray(preparado.length))) return 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO';
  return temAssinaturaDigital(assinado) ? 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO' : 'SEM_INDICIO_DE_ASSINATURA_DIGITAL';
}

/**
 * DOC-25 — indício de ALTERAÇÃO POSTERIOR: o novo arquivo começa com os bytes exatos de um arquivo assinado já
 * registrado para o mesmo documento e acrescenta conteúdo (atualização incremental depois da assinatura). Indício
 * estrutural, não juízo: só o leitor de PDF mostra se a mudança compromete a assinatura. Devolve o registro estendido.
 */
export function alteracaoPosteriorA(anteriores: ReadonlyArray<{ assinaturaId: string; bytes: Uint8Array }>, novo: Uint8Array): string | null {
  return anteriores.find((a) => comecaCom(novo, a.bytes))?.assinaturaId ?? null;
}
