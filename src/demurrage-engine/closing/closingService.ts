import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { PapelRbac } from '../scheduler/failurePolicy';
import { validarMinuta as validarCoerencia } from './minutaValidation';
import { MinutaRepository, Minuta } from '../persistence/minutaRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ReaberturaRepository } from '../persistence/reaberturaRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';

/**
 * Fase 8 — orquestração do fechamento: minuta (upload → validação/rejeição),
 * effective_return_date (só de minuta VALIDADA), recálculo (relógios + Fase 7),
 * fechamento FINAL (gate de responsabilidade) e reabertura. RBAC: validar/
 * rejeitar/FINAL/reabrir exigem MANAGER/ADMIN. tracking_return_date nunca é
 * apagado. Upload nunca recalcula. Multi-contêiner: cada minuta é de um contêiner.
 *
 * NOTA de escopo (assunção técnica): "recálculo" aqui re-deriva os RELÓGIOS e o
 * ciclo da Fase 7 com a nova data final (via LifecycleRepository). O recálculo
 * MONETÁRIO de `valores_apurados` depende do orquestrador tarifário (Fase 4/9),
 * inexistente como caminho de produção; a existência de custo (que dirige o gate
 * e a responsabilidade) vem dos relógios (v4.1), não de valores_apurados.
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

  constructor(private pool: Pool = getPool()) {
    this.minutas = new MinutaRepository(pool);
    this.eventos = new ClosingEventRepository(pool);
    this.reaberturas = new ReaberturaRepository(pool);
    this.lifecycle = new LifecycleRepository(pool);
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

  /** Validação (MANAGER/ADMIN). Coerência (regra 1) → VALIDADA define effective_return_date + recalcula; senão REJEITADA. */
  async validarMinuta(input: {
    minutaId: string; papel: PapelRbac; validadaPor?: string | null; config: ClosingConfig;
  }): Promise<{ ok: true; resultado: 'validada'; dataValidada: CivilDate; divergente: boolean } | { ok: true; resultado: 'rejeitada'; motivo: string } | Falha> {
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
      const emForca: CivilDate | null = ci.effective_return_date ?? ci.tracking_return_date ?? null;
      if (r.dataValidada !== emForca) return { ok: false, motivo: 'exige_reabertura' };
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
      // Só re-deriva o documentaryStatus (sem mudar datas/valores da apuração fechada).
      await this.lifecycle.derivarEPersistirProcesso(ci.processo_id, input.config);
      return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
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
    if (divergente) {
      await this.eventos.registrar({
        processoId: ci.processo_id, containerId: m.containerId, tipoEvento: 'DIVERGENCIA_TRACKING_MINUTA',
        origem: 'automatico', payload: { tracking: ci.tracking_return_date, minuta: r.dataValidada },
      });
    }
    await this.recalcular(ci.processo_id, m.containerId, input.config);
    return { ok: true, resultado: 'validada', dataValidada: r.dataValidada, divergente };
  }

  private async recalcular(processoId: string, containerId: string, config: ClosingConfig): Promise<void> {
    await this.lifecycle.derivarEPersistirProcesso(processoId, config);
    await this.eventos.registrar({
      processoId, containerId, tipoEvento: 'RECALCULO', origem: 'automatico', payload: {},
    });
  }

  /**
   * Fechamento FINAL (MANAGER/ADMIN). Gate (Blueprint 20.1/21.9 + decisão 8):
   * todos os contêineres devolvidos e nenhum com responsabilidade EM_ANALISE.
   * Zero demurrage → FINAL; com demurrage → bloqueado enquanto EM_ANALISE.
   */
  async finalizarProcesso(input: {
    processoId: string; papel: PapelRbac; realizadoPor?: string | null; justificativa?: string | null; config: ClosingConfig;
  }): Promise<{ ok: true } | Falha> {
    if (!ehGestor(input.papel)) return { ok: false, motivo: 'apenas_manager_admin' };
    const proc = (await this.pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [input.processoId])).rows[0];
    if (!proc) return { ok: false, motivo: 'processo_nao_encontrado' };
    if (proc.apuracao_status === 'FINAL') return { ok: false, motivo: 'ja_final' };

    const { rows: conts } = await this.pool.query(
      `SELECT id, (effective_return_date IS NOT NULL OR tracking_return_date IS NOT NULL) AS devolvido
         FROM containers WHERE processo_id = $1`,
      [input.processoId],
    );
    if (conts.length === 0) return { ok: false, motivo: 'sem_conteineres' };
    if (conts.some((c) => !c.devolvido)) return { ok: false, motivo: 'conteiner_nao_devolvido' };
    for (const c of conts) {
      const resp = await this.lifecycle.responsabilidadeDoContainer(c.id, input.config);
      if (resp === 'EM_ANALISE') return { ok: false, motivo: 'responsabilidade_em_analise' };
    }

    await this.pool.query(
      `UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now(), fechado_por = $2 WHERE id = $1`,
      [input.processoId, input.realizadoPor ?? null],
    );
    await this.pool.query(
      `INSERT INTO fechamentos (processo_id, realizado_por, justificativa) VALUES ($1, $2, $3)`,
      [input.processoId, input.realizadoPor ?? null, input.justificativa ?? null],
    );
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
    await this.lifecycle.derivarEPersistirProcesso(processoId, input.config);
    await this.reaberturas.marcarEstado(input.reaberturaId, 'RECALCULADA');
    return { ok: true };
  }
}
