import type { Db } from '../../identidade';
import { vinculoDoProcesso } from '../../auditoria/fatos/vinculos';
import type { ArmadorDoMaster, EstadoOficial, Integrado } from '../dominio';
import type { FatosPosteriores } from './entrada';

/**
 * I2 — produtor documental do armador do Master (campo `armador` das fontes posteriores da L1b). PREPARADO e NÃO
 * LIGADO: nenhum caminho de produção o compõe; a composição com as leituras da I1, o contrato documental e a regra de
 * uso da O2.1-C e o combinador existe só nos testes. Por isso o produtor recebe essas peças por injeção e não as
 * importa (as guardas de "nada ligado" da O2.1-C — P1A-10 e L04 — e da I1 — LD-08 — continuam valendo sem alteração).
 *
 * Caminho: processo → vínculo publicado com o Master (S2) → leituras documentais do Master (evidências JÁ existentes,
 * identidade conferida na I1) → localizador (PORTA; nenhuma regra aprovada ainda) → regra injetada (contrato
 * documental `transportadorDoMbl` + regra de uso, O2.1-C) → `armador`.
 *
 * Garantias:
 *  - nenhum OCR, IA, busca por nome ou listagem: só o que as portas entregam;
 *  - nada por prefixo de BL, remetente, tracking, agência ou NVOCC: só declarações do localizador, julgadas pela regra
 *    (que recusa agência, NVOCC e papel não declarado no próprio trecho); o produtor não lê as declarações, só repassa;
 *  - sem localizador (ausente), o produtor não fornece nada: a L1b segue com NAO_INTEGRADA, como hoje;
 *  - leitura sem resultado confiável do localizador não declara nada (não vira escolha provável);
 *  - armazenamento ou localizador sem resposta, captura além do limite ou evidência recusada → fonte INDISPONÍVEL
 *    ("não determinável", nem positivo nem negativo); nunca um armador;
 *  - exceções (de qualquer porta) não são tratadas aqui: sobem e o combinador recusa a combinação inteira.
 */

export const NOME_DO_PRODUTOR_DO_ARMADOR = 'documental-armador' as const;
/** Fonte registrada na evidência do fato do armador (o `ref` é a evidência OCR: `ocr-source:v1:<assinatura>`). */
export const FONTE_DOCUMENTAL_DO_ARMADOR = 'auditoria_ocr' as const;

/** A evidência conferida que o localizador recebe (forma estrutural de `EvidenciaConferida`, I1). */
export interface EvidenciaParaArmador {
  ref: string;
  contentHash: string;
  capturaVersao: number;
  capturadaEm: string;
  paginas: ReadonlyArray<{ pageIndex: number | null; markdown: string }>;
}

/** O que o produtor consome das leituras do Master (forma estrutural de `LeiturasDocumentaisDoMaster`, I1). */
export interface LeiturasDoMasterParaArmador {
  masterId: string;
  arquivos: ReadonlyArray<{
    arquivoSha256: string | null;
    origens: ReadonlyArray<{ extracaoId: string; recebidaEm: Date | null }>;
    situacao:
      | { tipo: 'COM_LEITURAS'; leituras: ReadonlyArray<{ evidencia: EvidenciaParaArmador; extracaoIds: ReadonlyArray<string> }> }
      | { tipo: 'SEM_EVIDENCIA' | 'INDISPONIVEL' | 'CAPTURAS_ALEM_DO_LIMITE' | 'SEM_IDENTIDADE_DE_ARQUIVO' }
      | { tipo: 'EVIDENCIA_RECUSADA'; motivos: ReadonlyArray<string> };
  }>;
}

/**
 * Resultado do localizador para UMA evidência (`D` e `A` são a declaração e a assinatura do contrato documental,
 * ligados pela composição; o produtor não os interpreta):
 *  - LOCALIZADO: declarações candidatas (nome + trecho literal) e, se houver, a assinatura — quem aceita é a regra;
 *  - SEM_RESULTADO_CONFIAVEL: o localizador não tem o que afirmar sobre esta evidência (ela não declara nada);
 *  - INDISPONIVEL: o localizador não respondeu (nada se conclui).
 */
export type ResultadoDoLocalizador<D, A> =
  | { tipo: 'LOCALIZADO'; declaracoes: ReadonlyArray<D>; assinatura: A | null }
  | { tipo: 'SEM_RESULTADO_CONFIAVEL' }
  | { tipo: 'INDISPONIVEL' };

/** PORTA do localizador documental. Nenhuma implementação aprovada existe (as regras dependem da F0). */
export interface LocalizadorDeDeclaracoes<D, A> {
  localizar(evidencia: EvidenciaParaArmador): Promise<ResultadoDoLocalizador<D, A>>;
}

/** Uma leitura entregue à regra (forma estrutural de `LeituraParaTransportador`, O2.1-C). */
export interface LeituraDoArmador<D, A> {
  evidenciaRef: string;
  arquivoSha256: string;
  /** Chegada do documento (o e-mail do MBL); sem ela, a captura. */
  observadaEm: Date;
  /** Captura OCR. */
  extraidaEm: Date;
  /** Ausente = sem resultado confiável do localizador (a leitura não declara nada). */
  declaracoes?: ReadonlyArray<D>;
  assinatura?: A | null;
}

export interface ConfiguracaoDoProdutorDoArmador<D, A> {
  /** Leituras documentais do Master (I1), ligadas pela raiz de composição. */
  leiturasDoMaster(db: Db, organizationId: string, masterId: string): Promise<LeiturasDoMasterParaArmador>;
  /** Localizador aprovado; null = nenhum (o produtor não fornece nada e nem lê as evidências). */
  localizador: LocalizadorDeDeclaracoes<D, A> | null;
  /** Contrato documental e regra de USO (O2.1-C: `transportadorDoMbl` → `armadorAutomatico` → `armadorParaL1b`), ligados pela composição. */
  regra(masterId: string, leituras: ReadonlyArray<LeituraDoArmador<D, A>>): FatosPosteriores;
  /** Relógio da indisponibilidade (desde quando a fonte não respondeu). */
  agora(): Date;
}

/** Forma estrutural de `ProdutorDeFatos<'armador'>` (I1). */
export interface ProdutorDoArmador {
  nome: typeof NOME_DO_PRODUTOR_DO_ARMADOR;
  campos: ReadonlyArray<'armador'>;
  produzir(db: Db, organizationId: string, processoId: string): Promise<Pick<FatosPosteriores, 'armador'>>;
}

const SITUACOES_SEM_CONCLUSAO = new Set(['INDISPONIVEL', 'CAPTURAS_ALEM_DO_LIMITE', 'EVIDENCIA_RECUSADA']);

export function produtorDoArmador<D, A>(cfg: ConfiguracaoDoProdutorDoArmador<D, A>): ProdutorDoArmador {
  const indisponivel = (): Pick<FatosPosteriores, 'armador'> => {
    const armador: Integrado<EstadoOficial<ArmadorDoMaster>> = {
      tipo: 'INTEGRADA', fonte: { disponivel: false, desde: cfg.agora().toISOString() }, valor: { oficial: null, historico: [] },
    };
    return { armador };
  };
  return {
    nome: NOME_DO_PRODUTOR_DO_ARMADOR,
    campos: ['armador'],
    async produzir(db, organizationId, processoId) {
      const localizador = cfg.localizador;
      if (!localizador) return {};
      const vinculo = await vinculoDoProcesso(db, organizationId, processoId);
      if (vinculo.tipo !== 'VINCULADO') return {}; // sem Master publicado (ou em conflito): não há de quem ser o armador
      const leituras = await cfg.leiturasDoMaster(db, organizationId, vinculo.masterId);
      if (leituras.arquivos.some((a) => SITUACOES_SEM_CONCLUSAO.has(a.situacao.tipo))) return indisponivel();

      const paraARegra: LeituraDoArmador<D, A>[] = [];
      for (const arquivo of leituras.arquivos) {
        if (arquivo.situacao.tipo !== 'COM_LEITURAS') continue; // sem evidência OCR: o arquivo não declara nada
        for (const { evidencia, extracaoIds } of arquivo.situacao.leituras) {
          const r = await localizador.localizar(evidencia);
          if (r.tipo === 'INDISPONIVEL') return indisponivel();
          const recebidas = arquivo.origens.filter((o) => extracaoIds.includes(o.extracaoId) && o.recebidaEm).map((o) => o.recebidaEm!.getTime());
          const extraidaEm = new Date(evidencia.capturadaEm);
          paraARegra.push({
            evidenciaRef: evidencia.ref, arquivoSha256: evidencia.contentHash,
            observadaEm: recebidas.length ? new Date(Math.min(...recebidas)) : extraidaEm, extraidaEm,
            ...(r.tipo === 'LOCALIZADO' ? { declaracoes: r.declaracoes, assinatura: r.assinatura } : {}),
          });
        }
      }
      const fatos = cfg.regra(leituras.masterId, paraARegra);
      return fatos.armador === undefined ? {} : { armador: fatos.armador };
    },
  };
}
