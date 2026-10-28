import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { PapelRbac } from '../scheduler/failurePolicy';
import { lockProcesso } from './materialChangeGuard';
import { registrarMinutaTecnica, reavaliarMinutasComClient, RegistrarMinutaTecnicaInput, ResultadoRegistroMinutaTecnica } from './minutaTecnica';
import { MinutaRepository } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ReaberturaRepository } from '../persistence/reaberturaRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import {
  recalcularApuracaoContainerComClient, recalcularApuracaoProcessoComClient,
} from '../apuracao/recalcularApuracao';

/**
 * Fase 8 v1.1 — orquestração do fechamento: minuta, recálculo (pipeline ÚNICO
 * transacional fatos→relógios→valores→lifecycle, via recalcularApuracao),
 * fechamento FINAL (gate de comprovação/responsabilidade/confirmação) e
 * reabertura. tracking_return_date nunca é apagado.
 *
 * Produção P1 (reabertura controlada — correção de minuta e encerramento):
 *  - a minuta é registrada pelo analista e ACEITA/DIVERGENTE/INCONSISTENTE
 *    por verificação técnica AUTOMÁTICA (`minutaTecnica.ts`); não existe mais
 *    validação por MANAGER/ADMIN (`validarMinuta` removido) nem minuta
 *    gravando data em `effective_return_date` — a devolução oficial é a do
 *    tracking (a efetiva legada só é limpa quando sua minuta é substituída);
 *  - o encerramento é AUTOMÁTICO (`avaliarEncerramentoAutomatico`): quando
 *    todas as condições reais estão satisfeitas o processo vira FINAL sem
 *    ação humana. `finalizarProcesso` fica como acionamento administrativo
 *    (MANAGER/ADMIN, idempotente) da MESMA avaliação — nunca etapa
 *    obrigatória, nunca um atalho para contornar gate;
 *  - os gates de FINAL vivem num único lugar (`gateEncerramentoComClient`).
 *
 * Produção P1 (identidade operacional e filas pessoais): todo ator é um
 * membership ATIVO (`desativado_em IS NULL`, `resolverAtor`). Ações
 * ORGANIZACIONAIS por natureza — `finalizarProcesso` (acionamento
 * administrativo) e `autorizarReabertura` — seguem só MANAGER/ADMIN, em
 * qualquer processo da organização. `solicitarReabertura` é PESSOAL: ANALYST
 * só no processo atribuído a ele (conferido sob o lock — ver o método).
 *
 * FINAL protegido em profundidade (item 4): guard de aplicação (o orquestrador é
 * NO-OP em processo FINAL) + guard de banco (migration 0017). No fechamento os
 * valores ATIVOS transitam OPEN → FINAL (congelados) ANTES de o processo virar
 * FINAL; a reabertura volta o processo a OPEN e o pipeline recomputa.
 *
 * Fase D15-A (integridade de estado final e reabertura — R11/31.7b, R16/31.12,
 * R19/31.14, R51-R54 do diagnóstico f22d153):
 *  - RBAC NUNCA confia em `papel` informado pelo chamador: todo ator é um
 *    `membershipId` real, resolvido contra `organization_memberships` DENTRO
 *    da mesma transação (mesmo padrão de `decidirResponsabilidade.ts`);
 *  - `validarMinuta`, `finalizarProcesso`, `solicitarReabertura` e
 *    `autorizarReabertura` são operações ATÔMICAS: uma única transação, lock
 *    consultivo por processo (`demurrage:closing:<processoId>`), todos os
 *    gates relidos DEPOIS do lock, e qualquer falha intermediária desfaz tudo;
 *  - minuta divergente em processo FINAL (31.14) registra as DUAS evidências
 *    (tracking e minuta) num evento `FATO_MATERIAL_POS_FINAL` ANTES de devolver
 *    `exige_reabertura` — nunca mais um retorno "mudo";
 *  - `autorizarReabertura` só avança a partir do estado `SOLICITADA`; duas
 *    autorizações concorrentes produzem exatamente uma autorização efetiva
 *    (a segunda falha com `reabertura_ja_autorizada` depois de perder a
 *    corrida pelo lock); `solicitarReabertura` só é aceita em processo FINAL
 *    e nunca duplica uma reabertura já aberta (checagem + índice único
 *    parcial da migration 0035, defesa em profundidade).
 *
 * Fase D15-A v1.1 (corretiva, achado #2 — ordem universal de lock): as
 * QUATRO operações seguem, sem exceção, a MESMA sequência — identifica o
 * recurso/processo SEM lock de linha mutável → `lockProcesso` (consultivo,
 * de `materialChangeGuard.ts`, MESMA implementação usada por todo escritor
 * material de D15-A) → relê/trava processo → relê/trava contêiner(es)/
 * minuta/reabertura → gates/autorização relidos → escreve → comita. Como o
 * lock consultivo é sempre o PRIMEIRO lock de qualquer operação D15-A
 * (nunca um lock de linha antes dele), duas operações no mesmo processo
 * nunca disputam uma linha em ordens opostas — elimina o deadlock entre
 * `validarMinuta`/`finalizarProcesso`/`solicitarReabertura`/
 * `autorizarReabertura` (ver docs/demurrage-fase-d15-a-v1-1.md §2).
 * `validarMinuta` relê a minuta SOB lock depois do lock consultivo e
 * confirma que ainda pertence ao contêiner/processo esperado antes de
 * decidir. `autorizarReabertura` lê `processo_id` da reabertura SEM lock
 * primeiro, só então adquire o lock consultivo, e só então relê e trava a
 * reabertura e o processo.
 *
 * Parâmetros `_teste*`: SÓ TESTE (mesmo padrão de
 * `registrarProcessoDemurrage.ts`/`decidirResponsabilidade.ts`) — nunca
 * usados em produção, nenhuma rota os expõe.
 */

export function ehGestor(papel: PapelRbac): boolean {
  return papel === 'MANAGER' || papel === 'ADMIN';
}

/** Qualquer papel interno (nunca CLIENT) — usado por ações que não exigem especificamente Gestor. */
function ehPapelInterno(papel: PapelRbac): boolean {
  return papel === 'ANALYST' || papel === 'MANAGER' || papel === 'ADMIN';
}

export interface ClosingConfig {
  hoje: CivilDate;
}

/** Resultado da avaliação automática de encerramento (nunca lança para domínio previsível). */
export type ResultadoEncerramentoAutomatico =
  | { resultado: 'finalizado' }
  | { resultado: 'ja_final' }
  | { resultado: 'bloqueado'; motivo: string; containerId: string | null }
  | { resultado: 'processo_nao_encontrado' }
  | { resultado: 'avaliacao_adiada' };

type Falha = { ok: false; motivo: string };

interface Ator {
  usuarioId: string;
  papel: PapelRbac;
}

/**
 * Pendências que bloqueiam o encerramento (automático e administrativo) do
 * contêiner enquanto abertas — Produção P1, "sem pendência bloqueante": sem
 * gestor no caminho, o gate precisa recusar o que o próprio sistema marcou
 * como fato do relógio ainda em dúvida (achado da revisão adversarial):
 *  - `retorno_vazio_antes_descarga` (D15-B R08/31.5): devolução reportada
 *    antes da descarga;
 *  - `cronologia_retorno_antes_gate_out` (R40): uma devolução do tracking foi
 *    rejeitada por cronologia — a devolução vigente está em dúvida;
 *  - `conflito_mesma_fonte` (R37): a mesma fonte, no mesmo instante, deu dois
 *    valores — o selecionado é o primeiro, nunca revisado;
 *  - `fallback_manual_superado` (R07): uma fonte real contradiz o Free Time
 *    manual, mantido "até decisão humana".
 * Todas estão no catálogo de resolução do analista (`pendenciaCatalogo.ts`:
 * ANALYST/MANAGER/ADMIN, motivo obrigatório) e a resolução dispara a
 * reavaliação do encerramento — nenhuma trava o processo sem saída. Fora da
 * lista, deliberadamente: Gate Out rejeitado por cronologia (não é devolução
 * nem entra no relógio), `free_time_ausente` (Free Time ausente já deixa a
 * apuração INDETERMINADA, que bloqueia) e `ft_divergencias` (informativo, sem
 * rota de resolução nesta entrega — bloquear seria travar sem saída).
 */
export const TIPOS_PENDENCIA_BLOQUEIAM_ENCERRAMENTO: readonly string[] = [
  'retorno_vazio_antes_descarga', 'cronologia_retorno_antes_gate_out', 'conflito_mesma_fonte', 'fallback_manual_superado',
];

export class ClosingService {
  private minutas: MinutaRepository;
  private eventos: ClosingEventRepository;
  private reaberturas: ReaberturaRepository;
  private lifecycle: LifecycleRepository;
  private valores: ValorApuradoRepository;

  constructor(private pool: Pool = getPool()) {
    this.minutas = new MinutaRepository(pool);
    this.eventos = new ClosingEventRepository(pool);
    this.reaberturas = new ReaberturaRepository(pool);
    this.lifecycle = new LifecycleRepository(pool);
    this.valores = new ValorApuradoRepository(pool);
  }

  /**
   * Fase D15-A — resolve o ator (usuário + papel) a partir do `membershipId`
   * REAL, dentro da organização do recurso. Nunca aceita papel informado pelo
   * chamador. Devolve `null` quando o membership não existe, pertence a
   * outra organização ou está DESATIVADO (Produção P1, migration 0049 — o
   * `FOR SHARE` impede que a desativação comite enquanto esta transação usa o
   * membership) — o chamador trata isso com o MESMO código de falha de
   * "não autorizado" (nunca vaza se o problema era o membership ou o papel).
   */
  private async resolverAtor(db: Pool | PoolClient, organizationId: string, membershipId: string): Promise<Ator | null> {
    const { rows } = await db.query(
      `SELECT usuario_id, papel FROM organization_memberships
        WHERE id = $1 AND organization_id = $2 AND desativado_em IS NULL FOR SHARE`,
      [membershipId, organizationId],
    );
    return rows.length ? { usuarioId: rows[0].usuario_id, papel: rows[0].papel as PapelRbac } : null;
  }

  /**
   * Registro de minuta (Produção P1 — correção de minuta). Delega ao fluxo
   * ÚNICO `registrarMinutaTecnica`: o analista (qualquer papel interno, por
   * membership REAL) registra a minuta com o documento; a verificação técnica
   * automática decide o estado na mesma transação. Não existe validação por
   * MANAGER/ADMIN — o antigo `validarMinuta` foi removido (ver
   * docs/demurrage-producao-p1-correcao-minuta-encerramento.md §3).
   *
   * Depois do COMMIT do registro, avalia o encerramento automático do
   * processo (transação própria). Uma falha inesperada nessa segunda etapa
   * nunca desfaz o registro já persistido: o resultado diz
   * `avaliacao_adiada` e a varredura periódica reavalia.
   */
  async registrarMinuta(input: Omit<RegistrarMinutaTecnicaInput, 'hoje'> & { config: ClosingConfig }): Promise<
    | (Extract<ResultadoRegistroMinutaTecnica, { ok: true }> & { encerramento: ResultadoEncerramentoAutomatico })
    | Extract<ResultadoRegistroMinutaTecnica, { ok: false }>
  > {
    const { config, ...resto } = input;
    const r = await registrarMinutaTecnica(this.pool, { ...resto, hoje: config.hoje });
    if (!r.ok) return r;
    const encerramento = await this.avaliarEncerramentoAutomaticoSeguro({ processoId: r.processoId, config });
    return { ...r, encerramento };
  }

  /**
   * Gate de encerramento, por contêiner (Blueprint 20.1/21.9 + decisão 8 +
   * clarificações A e item 6; Produção P1 — aceite técnico da minuta).
   * Precondição: lock consultivo do processo detido e contêineres travados.
   *  - devolvido (tracking — ou devolução efetiva LEGADA) senão bloqueia;
   *  - pendência aberta que põe em dúvida um fato do relógio bloqueia
   *    (`TIPOS_PENDENCIA_BLOQUEIAM_ENCERRAMENTO`; todas resolvíveis pelo
   *    analista, com motivo — nunca exigem gestor);
   *  - INDETERMINADA bloqueia (não dá para afirmar zero com segurança);
   *  - minuta vigente do fluxo técnico DIVERGENTE/INCONSISTENTE/aguardando
   *    bloqueia o contêiner (com ou sem demurrage — há pendência aberta);
   *  - ZERO_CONFIRMADO conclui SEM minuta, tarifa, responsabilidade ou gestor;
   *  - DEMURRAGE_CONFIRMADA exige: responsabilidade decidida (≠ EM_ANALISE);
   *    minuta ACEITA tecnicamente contra a devolução ATUAL do tracking (ou,
   *    em contêiner só com minutas LEGADAS, a comprovação legada v1.3); e cada
   *    relógio em demurrage com valor ATIVO ESTIMATED|CONFIRMED;
   *  - Produção P1 (arquivos de minuta): DEMURRAGE_CONFIRMADA exige também o
   *    ARQUIVO REAL da minuta usada como evidência guardado pela Priora e
   *    disponível (documento armazenado DISPONIVEL, objeto não marcado
   *    ausente, inspeção não reprovada) — senão `minuta_sem_arquivo_
   *    disponivel`. Minuta LEGADA (só referência externa, ou aprovação humana
   *    sem arquivo) não libera o encerramento: o analista envia o arquivo e
   *    registra nova versão. Processo FINAL não é tocado (fechamentos
   *    históricos preservados); ZERO_CONFIRMADO continua sem exigir minuta.
   */
  private async gateEncerramentoComClient(
    client: PoolClient, conts: Array<{ id: string; effective_return_date: CivilDate | null; tracking_return_date: CivilDate | null }>, config: ClosingConfig,
  ): Promise<{ ok: true } | { ok: false; motivo: string; containerId: string }> {
    const lifecycle = new LifecycleRepository(client as unknown as Pool);
    const minutas = new MinutaRepository(client as unknown as Pool);
    const valores = new ValorApuradoRepository(client as unknown as Pool);
    const bloqueio = (motivo: string, containerId: string) => ({ ok: false as const, motivo, containerId });

    for (const c of conts) {
      // Pendência que ainda espera revisão humana de um fato do relógio:
      // bloqueio EXPLÍCITO e nomeado (`<tipo>_pendente`), na ordem de gravidade
      // da lista (D15-B R08/31.5 — Empty Return antes da descarga — primeiro).
      const { rows: pendBloqueantes } = await client.query(
        `SELECT DISTINCT tipo FROM demurrage_pendencias WHERE container_id = $1 AND tipo = ANY($2::text[]) AND estado = 'aberta'`,
        [c.id, TIPOS_PENDENCIA_BLOQUEIAM_ENCERRAMENTO],
      );
      const pendBloqueante = TIPOS_PENDENCIA_BLOQUEIAM_ENCERRAMENTO.find((t) => pendBloqueantes.some((p) => p.tipo === t));
      if (pendBloqueante) return bloqueio(`${pendBloqueante}_pendente`, c.id);

      const { facts, responsabilidade } = await lifecycle.gateFechamento(c.id, config);
      if (facts.apuracaoDemurrageStatus === 'INDETERMINADA') return bloqueio('apuracao_indeterminada', c.id);

      const vigente = await minutas.vigenteTecnica(c.id);
      let comprovado = false;
      let arquivoDisponivel = false;
      if (vigente) {
        if (vigente.estado === 'DIVERGENTE') return bloqueio('divergencia_pendente', c.id);
        if (vigente.estado === 'INCONSISTENTE') return bloqueio('minuta_inconsistente', c.id);
        if (vigente.estado !== 'ACEITA' || vigente.dataTrackingComparada !== c.tracking_return_date) {
          // RECEBIDA (aguardando) ou ACEITA contra uma devolução que mudou depois.
          // A reavaliação roda antes, na mesma transação e sob o mesmo lock; isto
          // é defesa em profundidade — nunca se fecha sobre avaliação velha.
          return bloqueio('minuta_aguardando_avaliacao', c.id);
        }
        comprovado = true;
        const { rows: arq } = await client.query(
          `SELECT 1 FROM documentos d JOIN documentos_armazenados a ON a.id = d.armazenado_id AND a.minuta_id = d.minuta_id
            WHERE d.minuta_id = $1 AND a.estado = 'DISPONIVEL' AND a.objeto_ausente_em IS NULL
              AND a.inspecao IN ('NAO_REALIZADA', 'APROVADA')`,
          [vigente.id],
        );
        arquivoDisponivel = arq.length > 0;
      } else {
        // Só minutas LEGADAS (ou nenhuma): semântica de comprovação v1.3 preservada.
        const dataFinalEvidencia: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
        const legado = await minutas.comprovacaoLegada(c.id, dataFinalEvidencia);
        if (legado.divergenciaPendente) return bloqueio('divergencia_pendente', c.id);
        comprovado = legado.validadaCorrespondente;
      }

      if (facts.apuracaoDemurrageStatus === 'ZERO_CONFIRMADO') continue; // sem demurrage: nada mais é exigido.

      // DEMURRAGE_CONFIRMADA a partir daqui.
      if (responsabilidade === 'EM_ANALISE') return bloqueio('responsabilidade_em_analise', c.id);
      if (!comprovado) return bloqueio('comprovacao_pendente', c.id);
      const ativos = await valores.ativosDoContainer(c.id);
      const confirmado = (tipo: 'cliente' | 'rocket'): boolean =>
        ativos.some((v) => v.relogioTipo === tipo && (v.confirmationStatus === 'ESTIMATED' || v.confirmationStatus === 'CONFIRMED'));
      const relogioEmDemurrage = (clock: { status: string; diasDemurrage: number }) => clock.status === 'OK' && clock.diasDemurrage >= 1;
      if (relogioEmDemurrage(facts.clienteClock) && !confirmado('cliente')) return bloqueio('valor_cliente_nao_confirmado', c.id);
      if (relogioEmDemurrage(facts.rocketClock) && !confirmado('rocket')) return bloqueio('valor_rocket_nao_confirmado', c.id);
      // Produção P1 (arquivos de minuta) — ÚLTIMO requisito: o arquivo real da
      // minuta usada como evidência, guardado e disponível.
      if (!arquivoDisponivel) return bloqueio('minuta_sem_arquivo_disponivel', c.id);
    }
    return { ok: true };
  }

  /**
   * Núcleo ÚNICO da transição para FINAL — usado pelo encerramento
   * AUTOMÁTICO (`ator` null) e pelo acionamento administrativo
   * (`finalizarProcesso`). Uma única transação, sob lock consultivo do
   * processo; `apuracao_status` relido com `FOR UPDATE` DEPOIS do lock; a
   * transição só ocorre `WHERE apuracao_status = 'OPEN'`. Duas avaliações
   * concorrentes nunca produzem dois `fechamentos`: a segunda, depois de
   * esperar o lock, relê FINAL e devolve `ja_final` sem escrever nada.
   *
   * Antes do gate, NA MESMA transação e sob o mesmo lock, as minutas
   * vigentes são reavaliadas contra os fatos atuais (e a devolução efetiva
   * legada de minuta substituída é limpa) — `reavaliarMinutasComClient`. O
   * gate nunca decide sobre uma avaliação feita antes de um fato novo.
   *
   * Bloqueado: tudo o que a avaliação de ENCERRAMENTO projetou (recálculo) é
   * desfeito (savepoint); a reavaliação técnica das minutas, que é anterior
   * ao savepoint, persiste. No caminho automático o resultado (motivo +
   * contêiner) é registrado em `processos.encerramento_*` (informativo;
   * rotação justa da varredura); no administrativo nada do encerramento é
   * escrito (semântica congelada).
   *
   * `respeitarReabertura` (varredura): processo com reabertura aberta não é
   * re-encerrado — conferido AQUI, sob o lock, e não só na seleção de
   * candidatos (um processo reaberto entre a seleção e a avaliação nunca é
   * re-encerrado pela varredura).
   */
  private async encerrarSeElegivel(input: {
    processoId: string;
    /** null = encerramento automático (sistema). */
    membershipId: string | null;
    justificativa: string | null;
    config: ClosingConfig;
    respeitarReabertura?: boolean;
    _testeFalhaDuranteFinalizacao?: () => void | Promise<void>;
    _testeAguardarAntesDoCommit?: () => void | Promise<void>;
  }): Promise<{ ok: true } | { ok: false; motivo: string; containerId?: string }> {
    const automatico = input.membershipId === null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockProcesso(client, input.processoId);

      const { rows: prows } = await client.query(
        `SELECT organization_id, apuracao_status FROM processos WHERE id = $1 FOR UPDATE`,
        [input.processoId],
      );
      if (!prows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'processo_nao_encontrado' }; }
      const proc = prows[0];

      let ator: Ator | null = null;
      if (!automatico) {
        ator = await this.resolverAtor(client, proc.organization_id, input.membershipId!);
        if (!ator || !ehGestor(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'apenas_manager_admin' }; }
      }

      if (proc.apuracao_status === 'FINAL') { await client.query('ROLLBACK'); return { ok: false, motivo: 'ja_final' }; }

      if (input.respeitarReabertura) {
        const { rows: reab } = await client.query(
          `SELECT 1 FROM reaberturas WHERE processo_id = $1 AND estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA') LIMIT 1`,
          [input.processoId],
        );
        if (reab.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'reabertura_em_andamento' }; }
      }

      // Reavaliação técnica das minutas sob o lock (persiste mesmo bloqueado).
      await reavaliarMinutasComClient(
        client, { processoId: input.processoId, organizationId: proc.organization_id, apuracaoStatus: 'OPEN' }, input.config.hoje,
      );

      const { rows: conts } = await client.query(
        `SELECT id, effective_return_date, tracking_return_date,
                (effective_return_date IS NOT NULL OR tracking_return_date IS NOT NULL) AS devolvido
           FROM containers WHERE processo_id = $1 ORDER BY id FOR UPDATE`,
        [input.processoId],
      );

      // Tudo o que a avaliação projeta fica depois deste ponto — um bloqueio
      // volta aqui, preservando os locks já adquiridos.
      await client.query('SAVEPOINT avaliacao_encerramento');
      const bloquear = async (motivo: string, containerId?: string) => {
        await client.query('ROLLBACK TO SAVEPOINT avaliacao_encerramento');
        if (!automatico) { await client.query('COMMIT'); return { ok: false as const, motivo }; }
        await client.query(
          `UPDATE processos SET encerramento_avaliado_em = now(), encerramento_bloqueio = $2, encerramento_bloqueio_container_id = $3 WHERE id = $1`,
          [input.processoId, motivo, containerId ?? null],
        );
        await client.query('COMMIT');
        return { ok: false as const, motivo, ...(containerId ? { containerId } : {}) };
      };

      if (conts.length === 0) return bloquear('sem_conteineres');
      const naoDevolvido = conts.find((c) => !c.devolvido);
      if (naoDevolvido) return bloquear('conteiner_nao_devolvido', naoDevolvido.id);
      // O encerramento AUTOMÁTICO só conclui sobre a devolução OFICIAL (tracking).
      // Uma devolução efetiva LEGADA (data de minuta aprovada no fluxo antigo)
      // ausente do tracking ou diferente dele mantém a semântica legada: só o
      // acionamento administrativo (humano, como antes) a encerra. Achado da
      // revisão adversarial — o sistema nunca congela sozinho uma data que veio
      // de minuta.
      if (automatico) {
        const legada = conts.find((c) => c.effective_return_date !== null && c.effective_return_date !== c.tracking_return_date);
        if (legada) return bloquear('devolucao_efetiva_legada', legada.id);
      }

      // Projeta a apuração corrente de cada contêiner (relógios + valores + lifecycle)
      // ANTES do gate, NA MESMA transação: o que for congelado no FINAL é
      // exatamente o estado atual — sem janela entre a projeção e a decisão.
      for (const c of conts) {
        await recalcularApuracaoContainerComClient(client, c.id, { dataReferencia: input.config.hoje });
      }

      const gate = await this.gateEncerramentoComClient(client, conts, input.config);
      if (!gate.ok) return bloquear(gate.motivo, gate.containerId);

      if (input._testeFalhaDuranteFinalizacao) await input._testeFalhaDuranteFinalizacao();

      // Transição atômica: valores ATIVOS OPEN → FINAL (processo ainda OPEN, guard
      // permite) e SÓ ENTÃO processo FINAL, na MESMA transação de todo o gate acima.
      const valores = new ValorApuradoRepository(client as unknown as Pool);
      for (const c of conts) await valores.finalizarAtivos(client, c.id);
      const upd = await client.query(
        `UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now(), fechado_por = $2,
                encerramento_avaliado_em = now(), encerramento_bloqueio = NULL, encerramento_bloqueio_container_id = NULL
          WHERE id = $1 AND apuracao_status = 'OPEN'`,
        [input.processoId, ator?.usuarioId ?? null],
      );
      if (upd.rowCount === 0) {
        // O lock consultivo já deveria ter impedido isto — defesa em profundidade
        // contra qualquer caminho que mude apuracao_status fora deste lock.
        throw new Error('encerrarSeElegivel: apuracao_status mudou sob o lock consultivo (corrida inesperada)');
      }
      const justificativa = automatico ? (input.justificativa ?? 'encerramento_automatico') : (input.justificativa ?? null);
      await client.query(
        `INSERT INTO fechamentos (processo_id, realizado_por, justificativa, origem) VALUES ($1, $2, $3, $4)`,
        [input.processoId, ator?.usuarioId ?? null, justificativa, automatico ? 'automatico' : 'humano'],
      );
      const reab = await new ReaberturaRepository(client as unknown as Pool).abertaDoProcesso(input.processoId);
      await new ClosingEventRepository(client as unknown as Pool).registrar({
        processoId: input.processoId, tipoEvento: reab ? 'REFECHAMENTO' : 'FECHAMENTO_FINAL',
        origem: automatico ? 'automatico' : 'humano', atorUsuarioId: ator?.usuarioId ?? null,
        payload: { justificativa, modo: automatico ? 'automatico' : 'administrativo' },
      });
      if (reab) await new ReaberturaRepository(client as unknown as Pool).marcarEstado(reab.id, 'REFECHADA');

      if (input._testeAguardarAntesDoCommit) await input._testeAguardarAntesDoCommit();

      await client.query('COMMIT');
      return { ok: true };
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Encerramento AUTOMÁTICO (Produção P1). Reavalia as minutas vigentes
   * contra os fatos atuais e tenta a transição para FINAL pelo MESMO gate do
   * acionamento administrativo — tudo numa transação, sob o lock do processo
   * (o resultado da verificação técnica persiste mesmo que o encerramento
   * siga bloqueado). Ninguém precisa "finalizar": quando todas as condições
   * reais estão satisfeitas, o processo vira FINAL sozinho. Idempotente.
   */
  async avaliarEncerramentoAutomatico(input: {
    processoId: string; config: ClosingConfig;
    /** Varredura: não re-encerra processo com reabertura aberta (conferido sob o lock). */
    respeitarReabertura?: boolean;
    _testeAguardarAntesDoCommit?: () => void | Promise<void>;
  }): Promise<ResultadoEncerramentoAutomatico> {
    const r = await this.encerrarSeElegivel({
      processoId: input.processoId, membershipId: null, justificativa: null, config: input.config,
      respeitarReabertura: input.respeitarReabertura,
      _testeAguardarAntesDoCommit: input._testeAguardarAntesDoCommit,
    });
    if (r.ok) return { resultado: 'finalizado' };
    if (r.motivo === 'ja_final') return { resultado: 'ja_final' };
    if (r.motivo === 'processo_nao_encontrado') return { resultado: 'processo_nao_encontrado' };
    return { resultado: 'bloqueado', motivo: r.motivo, containerId: r.containerId ?? null };
  }

  /**
   * Igual a `avaliarEncerramentoAutomatico`, mas uma falha inesperada vira
   * `avaliacao_adiada` (a varredura reavalia) — para chamadores cuja escrita
   * principal já comitou. A falha é registrada no processo
   * (`encerramento_bloqueio = 'falha_avaliacao'`, `encerramento_avaliado_em`
   * atualizado): sem isso, um processo que falha sempre ficaria eternamente
   * no topo da ordem da varredura e, com falhas suficientes, monopolizaria o
   * limite do tick (achado da revisão adversarial).
   */
  async avaliarEncerramentoAutomaticoSeguro(input: { processoId: string; config: ClosingConfig; respeitarReabertura?: boolean }): Promise<ResultadoEncerramentoAutomatico> {
    try {
      return await this.avaliarEncerramentoAutomatico(input);
    } catch (erro) {
      // eslint-disable-next-line no-console
      console.error('[demurrage-encerramento] avaliação adiada (a varredura reavalia):', String((erro as any)?.code ?? 'erro'));
      await this.registrarFalhaDeAvaliacao(input.processoId).catch(() => undefined);
      return { resultado: 'avaliacao_adiada' };
    }
  }

  /** Registra (informativo) que a última avaliação automática falhou — mesmo protocolo de lock; só em processo OPEN. */
  private async registrarFalhaDeAvaliacao(processoId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockProcesso(client, processoId);
      await client.query(
        `UPDATE processos SET encerramento_avaliado_em = now(), encerramento_bloqueio = 'falha_avaliacao', encerramento_bloqueio_container_id = NULL
          WHERE id = $1 AND apuracao_status = 'OPEN'`,
        [processoId],
      );
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Acionamento ADMINISTRATIVO do encerramento (MANAGER/ADMIN, membership
   * real). Não é mais etapa operacional obrigatória — o encerramento é
   * automático; esta operação só antecipa a MESMA avaliação (mesmos gates,
   * nenhum contornado), é idempotente (`ja_final`) e fica restrita a
   * gestor. Mantida por compatibilidade do contrato da Entrega 2 e para
   * antecipar a varredura quando necessário (ver relatório, §5).
   * RBAC é conferido antes de abrir a transação e de novo, sob lock, ANTES
   * da reavaliação das minutas (um ANALYST não dispara escrita nenhuma por
   * aqui).
   */
  async finalizarProcesso(input: {
    processoId: string; membershipId: string; justificativa?: string | null; config: ClosingConfig;
    /** SÓ TESTE — ver nota de cabeçalho do arquivo. */
    _testeFalhaDuranteFinalizacao?: () => void | Promise<void>;
    /**
     * SÓ TESTE (D15-A v1.1) — dispara imediatamente ANTES do `COMMIT`, com
     * todos os gates já passados e a transição para FINAL já escrita (ainda
     * não visível a outras transações). Usado pelos testes de corrida
     * "fechamento vence": enquanto pausado aqui, o lock consultivo do
     * processo permanece retido, bloqueando qualquer escritor material
     * concorrente — a liberação do gancho comita e libera o lock de uma vez.
     */
    _testeAguardarAntesDoCommit?: () => void | Promise<void>;
  }): Promise<{ ok: true } | Falha> {
    const { rows } = await this.pool.query(`SELECT organization_id FROM processos WHERE id = $1`, [input.processoId]);
    if (!rows.length) return { ok: false, motivo: 'processo_nao_encontrado' };
    const atorPrevio = await this.resolverAtor(this.pool, rows[0].organization_id, input.membershipId);
    if (!atorPrevio || !ehGestor(atorPrevio.papel)) return { ok: false, motivo: 'apenas_manager_admin' };

    const r = await this.encerrarSeElegivel({
      processoId: input.processoId, membershipId: input.membershipId, justificativa: input.justificativa ?? null, config: input.config,
      _testeFalhaDuranteFinalizacao: input._testeFalhaDuranteFinalizacao,
      _testeAguardarAntesDoCommit: input._testeAguardarAntesDoCommit,
    });
    return r.ok ? r : { ok: false, motivo: r.motivo };
  }

  /**
   * Solicitação de reabertura (Fase D15-A). Exige membership REAL na
   * organização do processo (qualquer papel interno — ANALYST/MANAGER/ADMIN;
   * CLIENT é recusado com o MESMO código de "não autorizado", sem vazar a
   * existência do processo), justificativa não vazia, e o processo FINAL
   * (reabrir um processo que já está OPEN não tem sentido — 31.12 é sobre
   * processo CONCLUÍDO). No máximo UMA reabertura aberta por processo: a
   * checagem aqui é defesa de aplicação; o índice único parcial da migration
   * 0035 é a garantia de banco contra a mesma corrida.
   *
   * Produção P1 (filas pessoais) — ação PESSOAL: ANALYST só solicita em
   * processo ATRIBUÍDO a ele (`processos.responsavel_operacional_membership_id`
   * — sem responsável = nenhum ANALYST) → senão `ator_nao_responsavel`;
   * MANAGER/ADMIN em qualquer processo da organização. Conferido sob o lock
   * consultivo e o `FOR UPDATE` do processo — a atribuição
   * (`responsavel/atribuirResponsavel.ts`) toma o MESMO lock, então uma
   * reatribuição concorrente nunca passa entre a checagem e a escrita — e
   * ANTES de `reabertura_ja_aberta` (que devolve a reabertura existente).
   */
  async solicitarReabertura(input: { processoId: string; membershipId: string; justificativa: string }): Promise<{ ok: true; reaberturaId: string } | Falha> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockProcesso(client, input.processoId);

      const { rows: prows } = await client.query(
        `SELECT organization_id, apuracao_status, responsavel_operacional_membership_id FROM processos WHERE id = $1 FOR UPDATE`,
        [input.processoId],
      );
      if (!prows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'processo_nao_encontrado' }; }
      const proc = prows[0];

      const ator = await this.resolverAtor(client, proc.organization_id, input.membershipId);
      if (!ator || !ehPapelInterno(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'ator_nao_autorizado' }; }
      if (ator.papel === 'ANALYST' && proc.responsavel_operacional_membership_id !== input.membershipId) {
        await client.query('ROLLBACK');
        return { ok: false, motivo: 'ator_nao_responsavel' };
      }

      if (!input.justificativa || !input.justificativa.trim()) { await client.query('ROLLBACK'); return { ok: false, motivo: 'justificativa_obrigatoria' }; }

      if (proc.apuracao_status !== 'FINAL') { await client.query('ROLLBACK'); return { ok: false, motivo: 'processo_nao_final' }; }

      const { rows: existentes } = await client.query(
        `SELECT id FROM reaberturas WHERE processo_id = $1 AND estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA') FOR UPDATE`,
        [input.processoId],
      );
      if (existentes.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'reabertura_ja_aberta' }; }

      const reab = await new ReaberturaRepository(client as unknown as Pool).criarSolicitada(input.processoId, ator.usuarioId, input.justificativa.trim());
      await new ClosingEventRepository(client as unknown as Pool).registrar({
        processoId: input.processoId, tipoEvento: 'REABERTURA_SOLICITADA', origem: 'humano',
        atorUsuarioId: ator.usuarioId, payload: { reaberturaId: reab.id, justificativa: input.justificativa.trim() },
      });
      await client.query('COMMIT');
      return { ok: true, reaberturaId: reab.id };
    } catch (erro) {
      await client.query('ROLLBACK');
      // Defesa em profundidade: se a checagem acima perdesse uma corrida que o
      // lock consultivo já deveria ter impedido, o índice único parcial (0035)
      // ainda rejeitaria uma segunda reabertura aberta — nunca silenciosamente.
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Autorização da reabertura (MANAGER/ADMIN, membership real — Fase D15-A):
   * preserva valores anteriores (snapshot, nunca sobrescrito), reabre (OPEN) e
   * recalcula — tudo em UMA transação. Só avança a partir do estado
   * `SOLICITADA`: duas autorizações concorrentes produzem exatamente UMA
   * autorização efetiva (a segunda, depois de esperar o lock, relê o estado
   * já `RECALCULADA` e devolve `reabertura_ja_autorizada` sem escrever nada).
   */
  async autorizarReabertura(input: {
    reaberturaId: string; membershipId: string; config: ClosingConfig;
    /** SÓ TESTE — ver nota de cabeçalho do arquivo. */
    _testeFalhaDuranteReabertura?: () => void | Promise<void>;
  }): Promise<{ ok: true } | Falha> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Passo 1 — identidade do processo pela reabertura, SEM lock de linha
      // mutável (só para descobrir em qual processo adquirir o lock —
      // achado #2: o lock consultivo precisa vir ANTES de qualquer lock de
      // linha, nunca depois).
      const { rows: idRows } = await client.query(`SELECT processo_id FROM reaberturas WHERE id = $1`, [input.reaberturaId]);
      if (!idRows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'reabertura_nao_encontrada' }; }
      const processoId: string = idRows[0].processo_id;

      // Passo 2 — lock consultivo do processo, ANTES de qualquer linha mutável.
      await lockProcesso(client, processoId);

      // Passo 3 — relê e trava a REABERTURA.
      const { rows } = await client.query(`SELECT * FROM reaberturas WHERE id = $1 FOR UPDATE`, [input.reaberturaId]);
      if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'reabertura_nao_encontrada' }; }
      const reabRow = rows[0];

      // Passo 4 — relê e trava o PROCESSO.
      const { rows: prows } = await client.query(
        `SELECT organization_id, apuracao_status, fechado_em, fechado_por FROM processos WHERE id = $1 FOR UPDATE`,
        [processoId],
      );
      const proc = prows[0];
      const ator = await this.resolverAtor(client, proc.organization_id, input.membershipId);
      if (!ator || !ehGestor(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'apenas_manager_admin' }; }

      if (reabRow.estado !== 'SOLICITADA') { await client.query('ROLLBACK'); return { ok: false, motivo: 'reabertura_ja_autorizada' }; }

      // Snapshot dos valores/estado anteriores (nunca sobrescrito).
      const { rows: conts } = await client.query(
        `SELECT id, effective_return_date, estado, prioridade_balde FROM containers WHERE processo_id = $1 ORDER BY id`,
        [processoId],
      );
      const snapshot = { processo: proc, containers: conts };
      await new ReaberturaRepository(client as unknown as Pool).autorizar(input.reaberturaId, ator.usuarioId, snapshot);

      if (input._testeFalhaDuranteReabertura) await input._testeFalhaDuranteReabertura();

      // Produção P1: a leitura do encerramento automático (`processos.encerramento_*`)
      // passa a dizer por que o processo reaberto não fecha sozinho pela varredura —
      // nunca "avaliado, sem bloqueio" com a data do fechamento anterior.
      await client.query(
        `UPDATE processos SET apuracao_status = 'OPEN', fechado_em = NULL, fechado_por = NULL,
                encerramento_avaliado_em = now(), encerramento_bloqueio = 'reabertura_em_andamento', encerramento_bloqueio_container_id = NULL
          WHERE id = $1`,
        [processoId],
      );
      const eventos = new ClosingEventRepository(client as unknown as Pool);
      await eventos.registrar({
        processoId, tipoEvento: 'REABERTURA_AUTORIZADA', origem: 'humano', atorUsuarioId: ator.usuarioId,
        payload: { reaberturaId: input.reaberturaId },
      });
      await eventos.registrar({ processoId, tipoEvento: 'REABERTURA', origem: 'humano', atorUsuarioId: ator.usuarioId, payload: {} });
      // Produção P1: processo agora OPEN — a devolução efetiva LEGADA cuja minuta
      // foi substituída enquanto ele estava FINAL perde a base AQUI (e as minutas
      // vigentes são reavaliadas), para que o recálculo da reabertura já use a
      // devolução oficial do tracking. Mesmo lock, mesma transação.
      await reavaliarMinutasComClient(client, { processoId, organizationId: proc.organization_id, apuracaoStatus: 'OPEN' }, input.config.hoje);
      // Processo agora OPEN: o pipeline recomputa relógios + valores + lifecycle,
      // NA MESMA transação. Se o input não mudou (mesmo input_hash), a
      // idempotência preserva a versão anterior (clarificação C); se mudou, nasce
      // nova versão OPEN e a anterior fica SUPERSEDED no histórico.
      await recalcularApuracaoProcessoComClient(client, processoId, { dataReferencia: input.config.hoje });
      await new ReaberturaRepository(client as unknown as Pool).marcarEstado(input.reaberturaId, 'RECALCULADA');

      await client.query('COMMIT');
      return { ok: true };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }
}
