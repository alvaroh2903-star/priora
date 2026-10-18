import { Instante } from '../../dominio';
import {
  AssinaturaRegistrada, ConferenciaDaAssinatura, ConstatacaoDaConferencia, DocumentoPreparado, EstadoDoEnvio, SubstituicaoDoArquivoAssinado, TentativaDeEnvio,
  assinaturaDoDocumento,
} from './ciclo';
import { VerificacaoDoArquivoAssinado } from './assinatura';
import { IdentidadeDoSignatario } from './signatario';

/**
 * Rastreabilidade de UMA versão do documento (DOC-22, DOC-30): cada ato com o seu autor, instante e arquivo, sem
 * misturar papéis. Nada é sobrescrito: os arquivos assinados anteriores, as conferências e os envios (inclusive
 * reenvios) continuam listados, na ordem de registro. Puro: só organiza o que o repositório guardou.
 */
export interface PapeisDoDocumento {
  documentoId: string;
  masterId: string;
  /** Versão do documento: o conteúdo (hash) e a versão do modelo. */
  versao: { conteudoSha256: string; arquivoSha256: string; modelo: { modeloId: string; versao: string } };
  preparacao: { por: string; em: Instante };
  /** Identidade do signatário legal representada no documento (não é quem preparou, anexou, conferiu ou encaminhou). */
  signatario: IdentidadeDoSignatario | null;
  arquivosAssinados: Array<{
    assinaturaId: string; arquivoSha256: string; operador: string; em: Instante; signatarioEsperado: IdentidadeDoSignatario | null;
    verificacao: VerificacaoDoArquivoAssinado; substituicao: SubstituicaoDoArquivoAssinado | null; vigente: boolean;
  }>;
  conferencias: Array<{
    conferenciaId: string; assinaturaId: string; arquivoSha256: string; conferente: string; em: Instante; resultado: 'CONFORME' | 'NAO_CONFORME';
    constatacao: ConstatacaoDaConferencia | null; observacao: string | null; signatarioEsperado: IdentidadeDoSignatario | null;
  }>;
  encaminhamentos: Array<{
    envioId: string; encaminhador: string; contaMicrosoft: string; assinaturaId: string; estado: EstadoDoEnvio; abertoEm: Instante; concluidoEm: Instante | null;
    reenvio: TentativaDeEnvio['reenvio'];
  }>;
}

export function papeisDoDocumento(
  doc: DocumentoPreparado, assinaturas: ReadonlyArray<AssinaturaRegistrada>, conferencias: ReadonlyArray<ConferenciaDaAssinatura>,
  tentativas: ReadonlyArray<TentativaDeEnvio>,
): PapeisDoDocumento {
  const vigente = assinaturaDoDocumento(doc.documentoId, assinaturas);
  return {
    documentoId: doc.documentoId, masterId: doc.masterId,
    versao: { conteudoSha256: doc.conteudoSha256, arquivoSha256: doc.arquivoSha256, modelo: doc.modelo },
    preparacao: { por: doc.preparadoPor, em: doc.preparadoEm },
    signatario: doc.signatario,
    arquivosAssinados: assinaturas.filter((a) => a.documentoId === doc.documentoId).map((a) => ({
      assinaturaId: a.assinaturaId, arquivoSha256: a.arquivoSha256, operador: a.registradoPor, em: a.registradoEm, signatarioEsperado: a.signatarioEsperado,
      verificacao: a.verificacao, substituicao: a.substituicao, vigente: vigente?.assinaturaId === a.assinaturaId,
    })),
    conferencias: conferencias.filter((c) => c.documentoId === doc.documentoId).map((c) => ({
      conferenciaId: c.conferenciaId, assinaturaId: c.assinaturaId, arquivoSha256: c.arquivoSha256, conferente: c.conferidoPor, em: c.conferidoEm,
      resultado: c.resultado, constatacao: c.constatacao, observacao: c.observacao, signatarioEsperado: c.signatarioEsperado,
    })),
    encaminhamentos: tentativas.filter((t) => t.documentoId === doc.documentoId).map((t) => ({
      envioId: t.envioId, encaminhador: t.analista.membershipId, contaMicrosoft: t.analista.contaMicrosoft, assinaturaId: t.assinaturaId, estado: t.estado,
      abertoEm: t.abertoEm, concluidoEm: t.concluidoEm, reenvio: t.reenvio,
    })),
  };
}
