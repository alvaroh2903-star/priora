import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { PapelRbac } from '../scheduler/failurePolicy';
import { validarMinuta as validarCoerencia } from './minutaValidation';
import { MinutaRepository, Minuta } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ReaberturaRepository } from '../persistence/reaberturaRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import { recalcularApuracaoContainer, recalcularApuracaoProcesso } from '../apuracao/recalcularApuracao';

/**
 * Fase 8 v1.1 — orquestração do fechamento: minuta (upload → validação/rejeição),
 * effective_return_date (só de minuta VALIDADA), recálculo (pipeline ÚNICO
 * transacional fatos→relógios→valores→lifecycle, via recalcularApuracao),
 * fechamento FINAL (gate de comprovação/responsabilidade/confirmação) e
 * reabertura. RBAC: validar/rejeitar/FINAL/reabrir exigem MANAGER/ADMIN.
 * tracking_return_date nunca é apagado. Upload nunca recalcula. Multi-contêiner:
 * cada minuta é de um contêiner; o recálculo atinge só o contêiner afetado.
 *
 * FINAL protegido em profundidade (item 4): guard de aplicação (o orquestrador é
 * NO-OP em processo FINAL) + guard de banco (migration 0017). No fechamento os
 * valores ATIVOS transitam OPEN → FINAL (congelados) ANTES de o processo virar
 * FINAL; a reabertura volta o processo a OPEN e o pipeline recomputa.
 */

export function ehGestor(papel: PapelRbac): boolean {
  return papel === 'MANAGER' || papel === 'ADMIN';
}

export interface ClosingConfig {
  hoje: CivilDate;
}

type Falha = { ok: false; motivo: string };

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

  /** Upload/anexo de minuta (Cliente/Analista). Nasce RECEBIDA; NÃO altera datas/valores. */
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
   * Validação (MANAGER/ADMIN). Coerência (regra 1) → VALIDADA define
   * effective_return_date + recalcula; senão REJEITADA.
   *
   * Divergência documental (ADENDO): a comparação usa a DATA INFORMADA no
   * conteúdo da minuta (nunca a data de recebimento/upload). Quando
   * data_informada != tracking_return_date, a minuta NÃO é aceita
   * automaticamente só por ser cronologicamente possível: a divergência é
   * registrada, as duas fontes são preservadas e o effective_return_date só é
   * alterado após revisão EXPLÍCITA do MANAGER/ADMIN (`aceitarDivergencia: true`).
   */
  async validarMinuta(input: {
    minutaId: string; papel: PapelRbac; validadaPor?: string | null; config: ClosingConfig;
    /** Revisão explícita do MANAGER/ADMIN aceitando a divergência tracking × minuta. */
    aceitarDivergencia?: boolean;
  }): Promise<{ ok: true; resultado: 'validada'; dataValidada: CivilDate; divergente: boolean } | { ok: true; resultado: 'rejeitada'; motivo: string } | { ok: true; resultado: 'divergencia_pendente'; dataInformada: CivilDate; trackingReturnDate: CivilDate | null } | Falha> {
    if (!ehGestor(input.papel)) return { ok: false, motivo: 'apenas_manager_admin' };
    const m = await this.minutas.findById(input.minutaId);
    if (!m) return { ok: false, motivo: 'minuta_nao_encontrada' };
    const ci = await this.containerInfo(m.containerId);
    if (!ci) return { ok: false, motivo: 'container_nao_encontrado' };

    const r = validarCoerencia({
      numeroInformado: m.numeroInformado, numeroContainer: ci.numero,
      dataInformada: m.dataInformada, dischargeDate: ci.discharge_date,
      gateOutDate: ci.gate_out_date, hoje: input.config.hoje,
    });

    if (!r.valida) {
      await this.minutas.marcarRejeitada(m.id, r.motivo, input.validadaPor ?? null);
      await this.eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_REJEITADA',
        origem: 'humano', atorUsuarioId: input.validadaPor ?? null, payload: { minutaId: m.id, motivo: r.motivo },
      });
      return { ok: true, resultado: 'rejeitada', motivo: r.motivo };
    }

    const divergente = ci.tracking_return_date != null && r.dataValidada !== ci.tracking_return_date;

    // Apuração FINAL (Cap. 20.1 / 31.14): uma minuta que NÃO altera a data de
    // devolução em força apenas encerra a pendência DOCUMENTAL (sem recálculo,
    // sem reabertura). Uma que ALTERARIA o resultado exige reabertura autorizada.
    if (ci.apuracao_status === 'FINAL') {
      // v1.3: a prova de "apenas confirma" é a DATA FINAL CONGELADA (relógios),
      // não o tracking_return_date atual (que um tracking posterior pode ter movido).
      const congelada: CivilDate | null = (
        await this.pool.query(`SELECT data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [m.containerId])
      ).rows[0]?.data_final_apuracao ?? ci.effective_return_date ?? ci.tracking_return_date ?? null;
      if (r.dataValidada !== congelada) return { ok: false, motivo: 'exige_reabertura' };
      await this.minutas.marcarValidada(m.id, r.dataValidada, divergente, input.validadaPor ?? null);
      await this.pool.query(
        `UPDATE containers SET effective_return_date = $2, effective_return_minuta_id = $3 WHERE id = $1`,
        [m.containerId, r.dataValidada, m.id],
      );
      await this.eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_VALIDADA',
        origem: 'humano', atorUsuarioId: input.validadaPor ?? null,
        payload: { minutaId: m.id, dataValidada: r.dataValidada, documentalApenas: true },
      });
      // Só re-deriva o documentaryStatus do contêiner (cache-only: relógios/valores
      // da apuração FINAL permanecem congelados; nada é recalculado).
      await this.lifecycle.derivarContainerEConsolidar(m.containerId, ci.processo_id, input.config);
      return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
    }

    // ADENDO: divergência (data_informada != tracking) NÃO é aceita automaticamente.
    // Registra a divergência, PRESERVA as duas fontes (não altera effective_return_date)
    // e exige revisão explícita do MANAGER/ADMIN (`aceitarDivergencia: true`) antes de alterar.
    if (divergente && input.aceitarDivergencia !== true) {
      if (!m.divergenteDoTracking) {
        await this.pool.query(`UPDATE minutas SET divergente_do_tracking = true, atualizado_em = now() WHERE id = $1`, [m.id]);
        await this.eventos.registrar({
          processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'DIVERGENCIA_TRACKING_MINUTA',
          origem: 'automatico', payload: { tracking: ci.tracking_return_date, minuta: r.dataValidada },
        });
      }
      return { ok: true, resultado: 'divergencia_pendente', dataInformada: r.dataValidada, trackingReturnDate: ci.tracking_return_date };
    }
    // Divergência já registrada num passo anterior? Se não, e estamos aceitando agora, registra.
    if (divergente && !m.divergenteDoTracking) {
      await this.eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'DIVERGENCIA_TRACKING_MINUTA',
        origem: 'automatico', payload: { tracking: ci.tracking_return_date, minuta: r.dataValidada },
      });
    }

    // Encadeia lineage se já havia uma minuta efetiva diferente (nova supersede a anterior).
    if (ci.effective_return_minuta_id && ci.effective_return_minuta_id !== m.id) {
      await this.pool.query(`UPDATE minutas SET supersedes_id = $2 WHERE id = $1`, [m.id, ci.effective_return_minuta_id]);
    }
    await this.minutas.marcarValidada(m.id, r.dataValidada, divergente, input.validadaPor ?? null);
    // effective_return_date derivado da minuta validada; tracking_return_date preservado.
    await this.pool.query(
      `UPDATE containers SET effective_return_date = $2, effective_return_minuta_id = $3 WHERE id = $1`,
      [m.containerId, r.dataValidada, m.id],
    );
    await this.eventos.registrar({
      processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'MINUTA_VALIDADA',
      origem: 'humano', atorUsuarioId: input.validadaPor ?? null, payload: { minutaId: m.id, dataValidada: r.dataValidada },
    });
    await this.recalcular(ci.processo_id, m.containerId, input.config);
    return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
  }

  private async recalcular(processoId: string, containerId: string, config: ClosingConfig): Promise<void> {
    // Pipeline ÚNICO e transacional: fatos → relógios → valores → lifecycle, com a
    // MESMA data final. Atinge só o contêiner afetado (a consolidação do processo
    // é re-derivada dentro do orquestrador).
    await recalcularApuracaoContainer(this.pool, containerId, { dataReferencia: config.hoje });
    await this.eventos.registrar({
      processoId, containerId, tipoEvento: 'RECALCULO', origem: 'automatico', payload: {},
    });
  }

  /**
   * Fechamento FINAL (MANAGER/ADMIN). Gate (Blueprint 20.1/21.9 + decisão 8 +
   * clarificações A e item 6), por contêiner:
   *  - devolvido (effective/tracking return date) senão bloqueia;
   *  - INDETERMINADA bloqueia (não dá para afirmar zero com segurança);
   *  - ZERO_CONFIRMADO fecha SEM tarifa e SEM minuta (sem demurrage, sem comprovação);
   *  - DEMURRAGE_CONFIRMADA exige: responsabilidade != EM_ANALISE; minuta VALIDADA
   *    do contêiner (comprovação, clarificação A); e cada relógio em demurrage com
   *    valor ATIVO confirmado ESTIMATED|CONFIRMED (UNAVAILABLE/ESTIMATED_PROVISIONAL
   *    bloqueiam — item 6).
   * Os valores ATIVOS transitam OPEN → FINAL ANTES de o processo virar FINAL,
   * numa transação (atomicidade); depois o guard de banco congela tudo.
   */
  async finalizarProcesso(input: {
    processoId: string; papel: PapelRbac; realizadoPor?: string | null; justificativa?: string | null; config: ClosingConfig;
  }): Promise<{ ok: true } | Falha> {
    if (!ehGestor(input.papel)) return { ok: false, motivo: 'apenas_manager_admin' };
    const proc = (await this.pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [input.processoId])).rows[0];
    if (!proc) return { ok: false, motivo: 'processo_nao_encontrado' };
    if (proc.apuracao_status === 'FINAL') return { ok: false, motivo: 'ja_final' };

    const { rows: conts } = await this.pool.query(
      `SELECT id, effective_return_date, tracking_return_date,
              (effective_return_date IS NOT NULL OR tracking_return_date IS NOT NULL) AS devolvido
         FROM containers WHERE processo_id = $1 ORDER BY id`,
      [input.processoId],
    );
    if (conts.length === 0) return { ok: false, motivo: 'sem_conteineres' };
    if (conts.some((c) => !c.devolvido)) return { ok: false, motivo: 'conteiner_nao_devolvido' };

    // Projeta a apuração corrente de cada contêiner (relógios + valores + lifecycle)
    // ANTES do gate: o gate consome os relógios/valores persistidos (v1.2), então o
    // que for congelado no FINAL é exatamente o estado atual. Processo OPEN → não é
    // no-op; idempotente por input_hash.
    for (const c of conts) {
      await recalcularApuracaoContainer(this.pool, c.id, { dataReferencia: input.config.hoje });
    }

    for (const c of conts) {
      const { facts, responsabilidade } = await this.lifecycle.gateFechamento(c.id, input.config);
      if (facts.apuracaoDemurrageStatus === 'INDETERMINADA') return { ok: false, motivo: 'apuracao_indeterminada' };
      const dataFinalEvidencia: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
      const comprov = await this.minutas.comprovacao(c.id, dataFinalEvidencia);
      if (facts.apuracaoDemurrageStatus === 'ZERO_CONFIRMADO') {
        // Zero confirmado fecha SEM minuta; mas uma divergência documental JÁ
        // CONHECIDA (minuta RECEBIDA divergente aguardando decisão do Gestor) bloqueia
        // até ser resolvida/rejeitada (v1.4). Ausência de minuta NUNCA bloqueia.
        if (comprov.divergenciaPendente) return { ok: false, motivo: 'divergencia_pendente' };
        continue;
      }
      // DEMURRAGE_CONFIRMADA a partir daqui.
      if (responsabilidade === 'EM_ANALISE') return { ok: false, motivo: 'responsabilidade_em_analise' };
      // Comprovação (v1.3): minuta VALIDADA correspondente à evidência efetiva do
      // fechamento E sem divergência de data ainda pendente de revisão.
      if (comprov.divergenciaPendente) return { ok: false, motivo: 'divergencia_pendente' };
      if (!comprov.validadaCorrespondente) return { ok: false, motivo: 'comprovacao_pendente' };
      const ativos = await this.valores.ativosDoContainer(c.id);
      const confirmado = (tipo: 'cliente' | 'rocket'): boolean =>
        ativos.some((v) => v.relogioTipo === tipo && (v.confirmationStatus === 'ESTIMATED' || v.confirmationStatus === 'CONFIRMED'));
      const relogioEmDemurrage = (clock: { status: string; diasDemurrage: number }) => clock.status === 'OK' && clock.diasDemurrage >= 1;
      if (relogioEmDemurrage(facts.clienteClock) && !confirmado('cliente')) return { ok: false, motivo: 'valor_cliente_nao_confirmado' };
      if (relogioEmDemurrage(facts.rocketClock) && !confirmado('rocket')) return { ok: false, motivo: 'valor_rocket_nao_confirmado' };
    }

    // Transição atômica: valores ATIVOS OPEN → FINAL (processo ainda OPEN, guard
    // permite) e SÓ ENTÃO processo FINAL. Se algo falhar, rollback total.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of conts) await this.valores.finalizarAtivos(client, c.id);
      await client.query(
        `UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now(), fechado_por = $2 WHERE id = $1`,
        [input.processoId, input.realizadoPor ?? null],
      );
      await client.query(
        `INSERT INTO fechamentos (processo_id, realizado_por, justificativa) VALUES ($1, $2, $3)`,
        [input.processoId, input.realizadoPor ?? null, input.justificativa ?? null],
      );
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
    const reab = await this.reaberturas.abertaDoProcesso(input.processoId);
    await this.eventos.registrar({
      processoId: input.processoId, tipoEvento: reab ? 'REFECHAMENTO' : 'FECHAMENTO_FINAL',
      origem: 'humano', atorUsuarioId: input.realizadoPor ?? null, payload: { justificativa: input.justificativa ?? null },
    });
    if (reab) await this.reaberturas.marcarEstado(reab.id, 'REFECHADA');
    return { ok: true };
  }

  /** Solicitação de reabertura (registro; a autorização é do Gestor). */
  async solicitarReabertura(input: { processoId: string; solicitadaPor?: string | null; justificativa: string }): Promise<{ ok: true; reaberturaId: string } | Falha> {
    const proc = (await this.pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [input.processoId])).rows[0];
    if (!proc) return { ok: false, motivo: 'processo_nao_encontrado' };
    const reab = await this.reaberturas.criarSolicitada(input.processoId, input.solicitadaPor ?? null, input.justificativa);
    await this.eventos.registrar({
      processoId: input.processoId, tipoEvento: 'REABERTURA_SOLICITADA', origem: 'humano',
      atorUsuarioId: input.solicitadaPor ?? null, payload: { reaberturaId: reab.id, justificativa: input.justificativa },
    });
    return { ok: true, reaberturaId: reab.id };
  }

  /** Autorização da reabertura (MANAGER/ADMIN): preserva valores anteriores, reabre (OPEN) e recalcula. */
  async autorizarReabertura(input: { reaberturaId: string; papel: PapelRbac; autorizadaPor?: string | null; config: ClosingConfig }): Promise<{ ok: true } | Falha> {
    if (!ehGestor(input.papel)) return { ok: false, motivo: 'apenas_manager_admin' };
    const { rows } = await this.pool.query(`SELECT * FROM reaberturas WHERE id = $1`, [input.reaberturaId]);
    if (!rows.length) return { ok: false, motivo: 'reabertura_nao_encontrada' };
    const processoId = rows[0].processo_id;

    // Snapshot dos valores/estado anteriores (nunca sobrescrito).
    const proc = (await this.pool.query(`SELECT apuracao_status, fechado_em, fechado_por FROM processos WHERE id = $1`, [processoId])).rows[0];
    const { rows: conts } = await this.pool.query(
      `SELECT id, effective_return_date, estado, prioridade_balde FROM containers WHERE processo_id = $1 ORDER BY id`,
      [processoId],
    );
    const snapshot = { processo: proc, containers: conts };
    await this.reaberturas.autorizar(input.reaberturaId, input.autorizadaPor ?? null, snapshot);

    await this.pool.query(
      `UPDATE processos SET apuracao_status = 'OPEN', fechado_em = NULL, fechado_por = NULL WHERE id = $1`,
      [processoId],
    );
    await this.eventos.registrar({
      processoId, tipoEvento: 'REABERTURA_AUTORIZADA', origem: 'humano', atorUsuarioId: input.autorizadaPor ?? null,
      payload: { reaberturaId: input.reaberturaId },
    });
    await this.eventos.registrar({ processoId, tipoEvento: 'REABERTURA', origem: 'humano', atorUsuarioId: input.autorizadaPor ?? null, payload: {} });
    // Processo agora OPEN: o pipeline recomputa relógios + valores + lifecycle. Se
    // o input não mudou (mesmo input_hash), a idempotência preserva a versão
    // anterior (clarificação C); se mudou, nasce nova versão OPEN e a anterior fica
    // SUPERSEDED no histórico.
    await recalcularApuracaoProcesso(this.pool, processoId, { dataReferencia: input.config.hoje });
    await this.reaberturas.marcarEstado(input.reaberturaId, 'RECALCULADA');
    return { ok: true };
  }
}
