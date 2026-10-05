import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { PapelRbac } from '../scheduler/failurePolicy';
import { validarMinuta as validarCoerencia } from './minutaValidation';
import { registrarFatoMaterialPosFinal, lockProcesso } from './materialChangeGuard';
import { MinutaRepository, Minuta } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ReaberturaRepository } from '../persistence/reaberturaRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import {
  recalcularApuracaoContainerComClient, recalcularApuracaoProcessoComClient,
} from '../apuracao/recalcularApuracao';

/**
 * Fase 8 v1.1 — orquestração do fechamento: minuta (upload → validação/rejeição),
 * effective_return_date (só de minuta VALIDADA), recálculo (pipeline ÚNICO
 * transacional fatos→relógios→valores→lifecycle, via recalcularApuracao),
 * fechamento FINAL (gate de comprovação/responsabilidade/confirmação) e
 * reabertura. tracking_return_date nunca é apagado. Upload nunca recalcula.
 * Multi-contêiner: cada minuta é de um contêiner; o recálculo atinge só o
 * contêiner afetado.
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

type Falha = { ok: false; motivo: string };

interface Ator {
  usuarioId: string;
  papel: PapelRbac;
}

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
   * chamador. Devolve `null` quando o membership não existe ou pertence a
   * outra organização — o chamador trata isso com o MESMO código de falha de
   * "não autorizado" (nunca vaza se o problema era o membership ou o papel).
   */
  private async resolverAtor(db: Pool | PoolClient, organizationId: string, membershipId: string): Promise<Ator | null> {
    const { rows } = await db.query(
      `SELECT usuario_id, papel FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
      [membershipId, organizationId],
    );
    return rows.length ? { usuarioId: rows[0].usuario_id, papel: rows[0].papel as PapelRbac } : null;
  }

  private async containerInfo(containerId: string) {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.numero, c.discharge_date, c.gate_out_date, c.tracking_return_date,
              c.effective_return_date, c.processo_id, c.effective_return_minuta_id, p.apuracao_status
         FROM containers c JOIN processos p ON p.id = c.processo_id
        WHERE c.id = $1`,
      [containerId],
    );
    return rows[0] ?? null;
  }

  /** Upload/anexo de minuta (Cliente/Analista). Nasce RECEBIDA; NÃO altera datas/valores. Sem RBAC de Gestor (ação de captura, não de decisão). */
  async registrarMinuta(input: {
    containerId: string; numeroInformado: string | null; dataInformada: CivilDate | null;
    evidenciaRef?: string | null; recebidaPor?: string | null;
  }): Promise<Minuta> {
    const m = await this.minutas.criarRecebida(input);
    const ci = await this.containerInfo(input.containerId);
    await this.eventos.registrar({
      processoId: ci?.processo_id ?? null, containerId: input.containerId,
      tipoEvento: 'MINUTA_RECEBIDA', origem: 'humano', atorUsuarioId: input.recebidaPor ?? null,
      evidenciaRef: input.evidenciaRef ?? null, payload: { minutaId: m.id },
    });
    return m;
  }

  /**
   * Validação (MANAGER/ADMIN, resolvido por membership real — Fase D15-A).
   * Transação ÚNICA: lê minuta+contêiner com lock, trava o processo
   * (lock consultivo), resolve o ator, revalida coerência (regra 1) e, só
   * então, grava. Qualquer falha no meio desfaz tudo (nenhum estado parcial).
   *
   * Divergência documental (ADENDO): a comparação usa a DATA INFORMADA no
   * conteúdo da minuta (nunca a data de recebimento/upload). Quando
   * data_informada != tracking_return_date, a minuta NÃO é aceita
   * automaticamente só por ser cronologicamente possível: a divergência é
   * registrada, as duas fontes são preservadas e o effective_return_date só é
   * alterado após revisão EXPLÍCITA do MANAGER/ADMIN (`aceitarDivergencia: true`).
   *
   * FINAL + minuta diverge da data congelada (31.14): as DUAS evidências
   * (tracking e minuta) são registradas num evento `FATO_MATERIAL_POS_FINAL`
   * ANTES de devolver `exige_reabertura` — nunca mais um retorno mudo. A
   * projeção FINAL nunca é mutada aqui; só a reabertura autorizada reabilita.
   */
  async validarMinuta(input: {
    minutaId: string; membershipId: string; config: ClosingConfig;
    /** Revisão explícita do MANAGER/ADMIN aceitando a divergência tracking × minuta. */
    aceitarDivergencia?: boolean;
    /** SÓ TESTE — ver nota de cabeçalho do arquivo. */
    _testeFalhaEntreValidacaoERecalculo?: () => void | Promise<void>;
  }): Promise<{ ok: true; resultado: 'validada'; dataValidada: CivilDate; divergente: boolean } | { ok: true; resultado: 'rejeitada'; motivo: string } | { ok: true; resultado: 'divergencia_pendente'; dataInformada: CivilDate; trackingReturnDate: CivilDate | null } | Falha> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Passo 1 — identidade do processo pela minuta, SEM lock de linha
      // mutável (só para descobrir em qual processo adquirir o lock).
      const { rows: idRows } = await client.query(
        `SELECT m.container_id, c.processo_id FROM minutas m JOIN containers c ON c.id = m.container_id WHERE m.id = $1`,
        [input.minutaId],
      );
      if (!idRows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'minuta_nao_encontrada' }; }
      const processoIdEsperado: string = idRows[0].processo_id;
      const containerIdEsperado: string = idRows[0].container_id;

      // Passo 2 — lock consultivo do processo, ANTES de qualquer linha mutável.
      await lockProcesso(client, processoIdEsperado);

      // Passo 3 — relê e trava o PROCESSO.
      const { rows: procRows } = await client.query(`SELECT id FROM processos WHERE id = $1 FOR UPDATE`, [processoIdEsperado]);
      if (!procRows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'container_nao_encontrado' }; }

      // Passo 4 — relê e trava o CONTÊINER.
      const { rows: cirows } = await client.query(
        `SELECT c.id, c.organization_id, c.numero, c.discharge_date, c.gate_out_date, c.tracking_return_date,
                c.effective_return_date, c.processo_id, c.effective_return_minuta_id, p.apuracao_status
           FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.id = $1 FOR UPDATE OF c`,
        [containerIdEsperado],
      );
      if (!cirows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'container_nao_encontrado' }; }
      const ci = cirows[0];

      // Passo 4b — relê e trava a MINUTA; confirma que ainda pertence ao
      // contêiner/processo esperado (defesa — ver achado #2).
      const { rows: mrows } = await client.query(`SELECT * FROM minutas WHERE id = $1 FOR UPDATE`, [input.minutaId]);
      if (!mrows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'minuta_nao_encontrada' }; }
      const mRow = mrows[0];
      if (mRow.container_id !== containerIdEsperado || ci.processo_id !== processoIdEsperado) {
        await client.query('ROLLBACK');
        return { ok: false, motivo: 'minuta_nao_encontrada' };
      }
      const m = {
        id: mRow.id, containerId: mRow.container_id, estado: mRow.estado_minuta,
        numeroInformado: mRow.numero_informado, dataInformada: mRow.data_informada,
        divergenteDoTracking: mRow.divergente_do_tracking,
      };

      const ator = await this.resolverAtor(client, ci.organization_id, input.membershipId);
      if (!ator || !ehGestor(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'apenas_manager_admin' }; }

      const minutas = new MinutaRepository(client as unknown as Pool);
      const eventos = new ClosingEventRepository(client as unknown as Pool);

      const r = validarCoerencia({
        numeroInformado: m.numeroInformado, numeroContainer: ci.numero,
        dataInformada: m.dataInformada, dischargeDate: ci.discharge_date,
        gateOutDate: ci.gate_out_date, hoje: input.config.hoje,
      });

      if (!r.valida) {
        await minutas.marcarRejeitada(m.id, r.motivo, ator.usuarioId);
        await eventos.registrar({
          processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_REJEITADA',
          origem: 'humano', atorUsuarioId: ator.usuarioId, payload: { minutaId: m.id, motivo: r.motivo },
        });
        await client.query('COMMIT');
        return { ok: true, resultado: 'rejeitada', motivo: r.motivo };
      }

      const divergente = ci.tracking_return_date != null && r.dataValidada !== ci.tracking_return_date;

      // Apuração FINAL (Cap. 20.1 / 31.14): uma minuta que NÃO altera a data de
      // devolução em força apenas encerra a pendência DOCUMENTAL (sem recálculo,
      // sem reabertura). Uma que ALTERARIA o resultado exige reabertura autorizada
      // — e, a partir de D15-A, registra as DUAS evidências antes de devolver.
      if (ci.apuracao_status === 'FINAL') {
        // A prova de "apenas confirma" é a DATA FINAL CONGELADA (relógios), não
        // o tracking_return_date atual (que um tracking posterior pode ter movido).
        const congelada: CivilDate | null = (
          await client.query(`SELECT data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [m.containerId])
        ).rows[0]?.data_final_apuracao ?? ci.effective_return_date ?? ci.tracking_return_date ?? null;
        if (r.dataValidada !== congelada) {
          await registrarFatoMaterialPosFinal(client, {
            processoId: ci.processo_id, containerId: m.containerId, campo: 'minutaDivergente',
            valorAnterior: congelada, valorNovo: r.dataValidada, origem: 'humano', atorUsuarioId: ator.usuarioId,
            extra: { minutaId: m.id, trackingReturnDate: ci.tracking_return_date, dataCongelada: congelada },
          });
          await client.query('COMMIT');
          return { ok: false, motivo: 'exige_reabertura' };
        }
        await minutas.marcarValidada(m.id, r.dataValidada, divergente, ator.usuarioId);
        if (input._testeFalhaEntreValidacaoERecalculo) await input._testeFalhaEntreValidacaoERecalculo();
        await client.query(
          `UPDATE containers SET effective_return_date = $2, effective_return_minuta_id = $3 WHERE id = $1`,
          [m.containerId, r.dataValidada, m.id],
        );
        await eventos.registrar({
          processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_VALIDADA',
          origem: 'humano', atorUsuarioId: ator.usuarioId,
          payload: { minutaId: m.id, dataValidada: r.dataValidada, documentalApenas: true },
        });
        // Só re-deriva o documentaryStatus do contêiner (cache-only: relógios/valores
        // da apuração FINAL permanecem congelados; nada é recalculado).
        await new LifecycleRepository(client as unknown as Pool).derivarContainerEConsolidar(m.containerId, ci.processo_id, input.config);
        await client.query('COMMIT');
        return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
      }

      // ADENDO: divergência (data_informada != tracking) NÃO é aceita automaticamente.
      // Registra a divergência, PRESERVA as duas fontes (não altera effective_return_date)
      // e exige revisão explícita do MANAGER/ADMIN (`aceitarDivergencia: true`) antes de alterar.
      if (divergente && input.aceitarDivergencia !== true) {
        if (!m.divergenteDoTracking) {
          await client.query(`UPDATE minutas SET divergente_do_tracking = true, atualizado_em = now() WHERE id = $1`, [m.id]);
          await eventos.registrar({
            processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'DIVERGENCIA_TRACKING_MINUTA',
            origem: 'automatico', payload: { tracking: ci.tracking_return_date, minuta: r.dataValidada },
          });
        }
        await client.query('COMMIT');
        return { ok: true, resultado: 'divergencia_pendente', dataInformada: r.dataValidada, trackingReturnDate: ci.tracking_return_date };
      }
      // Divergência já registrada num passo anterior? Se não, e estamos aceitando agora, registra.
      if (divergente && !m.divergenteDoTracking) {
        await eventos.registrar({
          processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'DIVERGENCIA_TRACKING_MINUTA',
          origem: 'automatico', payload: { tracking: ci.tracking_return_date, minuta: r.dataValidada },
        });
      }

      // Encadeia lineage se já havia uma minuta efetiva diferente (nova supersede a anterior).
      if (ci.effective_return_minuta_id && ci.effective_return_minuta_id !== m.id) {
        await client.query(`UPDATE minutas SET supersedes_id = $2 WHERE id = $1`, [m.id, ci.effective_return_minuta_id]);
      }
      await minutas.marcarValidada(m.id, r.dataValidada, divergente, ator.usuarioId);
      if (input._testeFalhaEntreValidacaoERecalculo) await input._testeFalhaEntreValidacaoERecalculo();
      // effective_return_date derivado da minuta validada; tracking_return_date preservado.
      await client.query(
        `UPDATE containers SET effective_return_date = $2, effective_return_minuta_id = $3 WHERE id = $1`,
        [m.containerId, r.dataValidada, m.id],
      );
      await eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_VALIDADA',
        origem: 'humano', atorUsuarioId: ator.usuarioId, payload: { minutaId: m.id, dataValidada: r.dataValidada },
      });
      // Pipeline ÚNICO e transacional (fatos → relógios → valores → lifecycle), NA
      // MESMA transação da validação (Fase D15-A — atomicidade ponta a ponta).
      await recalcularApuracaoContainerComClient(client, m.containerId, { dataReferencia: input.config.hoje });
      await eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'RECALCULO', origem: 'automatico', payload: {},
      });
      await client.query('COMMIT');
      return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Fechamento FINAL (MANAGER/ADMIN, resolvido por membership real). Gate
   * (Blueprint 20.1/21.9 + decisão 8 + clarificações A e item 6), por contêiner:
   *  - devolvido (effective/tracking return date) senão bloqueia;
   *  - INDETERMINADA bloqueia (não dá para afirmar zero com segurança);
   *  - ZERO_CONFIRMADO fecha SEM tarifa e SEM minuta (sem demurrage, sem comprovação);
   *  - DEMURRAGE_CONFIRMADA exige: responsabilidade != EM_ANALISE; minuta VALIDADA
   *    do contêiner (comprovação, clarificação A); e cada relógio em demurrage com
   *    valor ATIVO confirmado ESTIMATED|CONFIRMED (UNAVAILABLE/ESTIMATED_PROVISIONAL
   *    bloqueiam — item 6).
   *
   * Fase D15-A: TUDO — recálculo de projeção, releitura dos gates, transição
   * de valores OPEN→FINAL e UPDATE do processo — roda numa ÚNICA transação,
   * sob lock consultivo do processo. `apuracao_status` é relido com `FOR
   * UPDATE` DEPOIS do lock (nunca confia em leitura anterior ao lock); a
   * transição só ocorre `WHERE apuracao_status = 'OPEN'` — defesa em
   * profundidade mesmo com o lock já serializando. Duas chamadas concorrentes
   * nunca produzem dois `fechamentos`: a segunda, depois de esperar o lock,
   * relê `apuracao_status = 'FINAL'` e devolve `ja_final` sem escrever nada.
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

      const ator = await this.resolverAtor(client, proc.organization_id, input.membershipId);
      if (!ator || !ehGestor(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'apenas_manager_admin' }; }

      if (proc.apuracao_status === 'FINAL') { await client.query('ROLLBACK'); return { ok: false, motivo: 'ja_final' }; }

      const { rows: conts } = await client.query(
        `SELECT id, effective_return_date, tracking_return_date,
                (effective_return_date IS NOT NULL OR tracking_return_date IS NOT NULL) AS devolvido
           FROM containers WHERE processo_id = $1 ORDER BY id FOR UPDATE`,
        [input.processoId],
      );
      if (conts.length === 0) { await client.query('ROLLBACK'); return { ok: false, motivo: 'sem_conteineres' }; }
      if (conts.some((c) => !c.devolvido)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'conteiner_nao_devolvido' }; }

      // Projeta a apuração corrente de cada contêiner (relógios + valores + lifecycle)
      // ANTES do gate, NA MESMA transação: o gate consome os relógios/valores
      // persistidos (v1.2), então o que for congelado no FINAL é exatamente o
      // estado atual — sem janela entre a projeção e a decisão de fechar.
      for (const c of conts) {
        await recalcularApuracaoContainerComClient(client, c.id, { dataReferencia: input.config.hoje });
      }

      const lifecycle = new LifecycleRepository(client as unknown as Pool);
      const minutas = new MinutaRepository(client as unknown as Pool);
      const valores = new ValorApuradoRepository(client as unknown as Pool);

      for (const c of conts) {
        const { facts, responsabilidade } = await lifecycle.gateFechamento(c.id, input.config);
        if (facts.apuracaoDemurrageStatus === 'INDETERMINADA') { await client.query('ROLLBACK'); return { ok: false, motivo: 'apuracao_indeterminada' }; }
        const dataFinalEvidencia: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
        const comprov = await minutas.comprovacao(c.id, dataFinalEvidencia);
        if (facts.apuracaoDemurrageStatus === 'ZERO_CONFIRMADO') {
          // Zero confirmado fecha SEM minuta; mas uma divergência documental JÁ
          // CONHECIDA (minuta RECEBIDA divergente aguardando decisão do Gestor) bloqueia
          // até ser resolvida/rejeitada (v1.4). Ausência de minuta NUNCA bloqueia.
          if (comprov.divergenciaPendente) { await client.query('ROLLBACK'); return { ok: false, motivo: 'divergencia_pendente' }; }
          continue;
        }
        // DEMURRAGE_CONFIRMADA a partir daqui.
        if (responsabilidade === 'EM_ANALISE') { await client.query('ROLLBACK'); return { ok: false, motivo: 'responsabilidade_em_analise' }; }
        // Comprovação (v1.3): minuta VALIDADA correspondente à evidência efetiva do
        // fechamento E sem divergência de data ainda pendente de revisão.
        if (comprov.divergenciaPendente) { await client.query('ROLLBACK'); return { ok: false, motivo: 'divergencia_pendente' }; }
        if (!comprov.validadaCorrespondente) { await client.query('ROLLBACK'); return { ok: false, motivo: 'comprovacao_pendente' }; }
        const ativos = await valores.ativosDoContainer(c.id);
        const confirmado = (tipo: 'cliente' | 'rocket'): boolean =>
          ativos.some((v) => v.relogioTipo === tipo && (v.confirmationStatus === 'ESTIMATED' || v.confirmationStatus === 'CONFIRMED'));
        const relogioEmDemurrage = (clock: { status: string; diasDemurrage: number }) => clock.status === 'OK' && clock.diasDemurrage >= 1;
        if (relogioEmDemurrage(facts.clienteClock) && !confirmado('cliente')) { await client.query('ROLLBACK'); return { ok: false, motivo: 'valor_cliente_nao_confirmado' }; }
        if (relogioEmDemurrage(facts.rocketClock) && !confirmado('rocket')) { await client.query('ROLLBACK'); return { ok: false, motivo: 'valor_rocket_nao_confirmado' }; }
      }

      if (input._testeFalhaDuranteFinalizacao) await input._testeFalhaDuranteFinalizacao();

      // Transição atômica: valores ATIVOS OPEN → FINAL (processo ainda OPEN, guard
      // permite) e SÓ ENTÃO processo FINAL, na MESMA transação de todo o gate acima.
      for (const c of conts) await valores.finalizarAtivos(client, c.id);
      const upd = await client.query(
        `UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now(), fechado_por = $2 WHERE id = $1 AND apuracao_status = 'OPEN'`,
        [input.processoId, ator.usuarioId],
      );
      if (upd.rowCount === 0) {
        // O lock consultivo já deveria ter impedido isto — defesa em profundidade
        // contra qualquer caminho que mude apuracao_status fora deste lock.
        throw new Error('finalizarProcesso: apuracao_status mudou sob o lock consultivo (corrida inesperada)');
      }
      await client.query(
        `INSERT INTO fechamentos (processo_id, realizado_por, justificativa) VALUES ($1, $2, $3)`,
        [input.processoId, ator.usuarioId, input.justificativa ?? null],
      );
      const reab = await new ReaberturaRepository(client as unknown as Pool).abertaDoProcesso(input.processoId);
      await new ClosingEventRepository(client as unknown as Pool).registrar({
        processoId: input.processoId, tipoEvento: reab ? 'REFECHAMENTO' : 'FECHAMENTO_FINAL',
        origem: 'humano', atorUsuarioId: ator.usuarioId, payload: { justificativa: input.justificativa ?? null },
      });
      if (reab) await new ReaberturaRepository(client as unknown as Pool).marcarEstado(reab.id, 'REFECHADA');

      if (input._testeAguardarAntesDoCommit) await input._testeAguardarAntesDoCommit();

      await client.query('COMMIT');
      return { ok: true };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
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
   */
  async solicitarReabertura(input: { processoId: string; membershipId: string; justificativa: string }): Promise<{ ok: true; reaberturaId: string } | Falha> {
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

      const ator = await this.resolverAtor(client, proc.organization_id, input.membershipId);
      if (!ator || !ehPapelInterno(ator.papel)) { await client.query('ROLLBACK'); return { ok: false, motivo: 'ator_nao_autorizado' }; }

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

      await client.query(
        `UPDATE processos SET apuracao_status = 'OPEN', fechado_em = NULL, fechado_por = NULL WHERE id = $1`,
        [processoId],
      );
      const eventos = new ClosingEventRepository(client as unknown as Pool);
      await eventos.registrar({
        processoId, tipoEvento: 'REABERTURA_AUTORIZADA', origem: 'humano', atorUsuarioId: ator.usuarioId,
        payload: { reaberturaId: input.reaberturaId },
      });
      await eventos.registrar({ processoId, tipoEvento: 'REABERTURA', origem: 'humano', atorUsuarioId: ator.usuarioId, payload: {} });
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
