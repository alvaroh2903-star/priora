import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { Container, ContainerObservableField, FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { FieldObservationRepository, InsertFieldObservationInput, assertFonteAutorizada } from './fieldObservationRepository';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { fatoMaterialBloqueadoPorFinal, lockProcesso } from '../closing/materialChangeGuard';

function mapRow(row: any): Container {
  return {
    id: row.id,
    organizationId: row.organization_id,
    processoId: row.processo_id,
    numero: row.numero,
    containerTypeId: row.container_type_id,
    containerTypeSourceObservationId: row.container_type_source_observation_id,
    dischargeDate: row.discharge_date,
    dischargeDateObservationId: row.discharge_date_observation_id,
    houseFreeTimeDays: row.house_free_time_days,
    houseFreeTimeObservationId: row.house_free_time_observation_id,
    masterFreeTimeDays: row.master_free_time_days,
    masterFreeTimeObservationId: row.master_free_time_observation_id,
    gateOutDate: row.gate_out_date,
    gateOutObservationId: row.gate_out_observation_id,
    trackingReturnDate: row.tracking_return_date,
    trackingReturnObservationId: row.tracking_return_observation_id,
    effectiveReturnDate: row.effective_return_date,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

/** Nome do campo observável -> colunas físicas de valor e de ponteiro de proveniência. */
const FIELD_COLUMNS: Record<ContainerObservableField, { valueColumn: string; obsColumn: string }> = {
  containerType: { valueColumn: 'container_type_id', obsColumn: 'container_type_source_observation_id' },
  dischargeDate: { valueColumn: 'discharge_date', obsColumn: 'discharge_date_observation_id' },
  houseFreeTimeDays: { valueColumn: 'house_free_time_days', obsColumn: 'house_free_time_observation_id' },
  masterFreeTimeDays: { valueColumn: 'master_free_time_days', obsColumn: 'master_free_time_observation_id' },
  gateOutDate: { valueColumn: 'gate_out_date', obsColumn: 'gate_out_observation_id' },
  trackingReturnDate: { valueColumn: 'tracking_return_date', obsColumn: 'tracking_return_observation_id' },
};

/**
 * Fase D15-A (31.7b) — `bloqueada_final`: a observação VENCERIA a promoção
 * pela hierarquia de fontes, mas o processo do contêiner está FINAL e o
 * valor é MATERIALMENTE diferente do selecionado. A observação bruta já foi
 * preservada no ledger (sempre, acima); só a promoção foi recusada. Um
 * evento `FATO_MATERIAL_POS_FINAL` fica registrado e `exigeReabertura: true`
 * é devolvido (contrato canônico — D15-A v1.1, ver `materialChangeGuard.ts`).
 */
export type ApplyObservationOutcome = 'promovida' | 'registrada_sem_promover' | 'bloqueada_final';

export interface ApplyObservationInput {
  containerId: string;
  organizationId: string;
  campo: ContainerObservableField;
  valor: unknown;
  fonte: FieldObservationSource;
  observadoEm: Date;
  evidenciaRef?: string | null;
  criadoPor?: string | null;
  /**
   * SÓ TESTE (D15-A v1.1) — dispara logo depois de a observação bruta ser
   * persistida (ledger) e ANTES de qualquer decisão de prioridade/promoção.
   * Lançar aqui simula uma falha no meio da operação: a transação inteira
   * (observação + decisão + evento + projeção) desfaz. Nunca usado em
   * produção; nenhuma rota o expõe.
   */
  _testeFalhaAposObservacao?: () => void | Promise<void>;
  /**
   * SÓ TESTE (D15-A v1.1) — propagado para `fatoMaterialBloqueadoPorFinal`;
   * pausa exatamente antes da decisão promover×bloquear, já com o lock
   * consultivo do processo adquirido. Usado pelos testes de corrida.
   */
  _testeAntesDaDecisaoFinal?: () => void | Promise<void>;
}

export interface ApplyObservationResultado {
  outcome: ApplyObservationOutcome;
  observationId: string;
  /** Campo canônico (D15-A v1.1): true somente quando `outcome === 'bloqueada_final'`. */
  exigeReabertura: boolean;
}

export interface ApplyObservationComClientResultado extends ApplyObservationResultado {
  criada: boolean;
  valorAnterior: unknown;
  valorSelecionado: unknown;
  conflitoMesmaFonte: boolean;
}

export class ContainerRepository {
  private fieldObservations: FieldObservationRepository;

  constructor(private pool: Pool = getPool()) {
    this.fieldObservations = new FieldObservationRepository(pool);
  }

  async create(organizationId: string, processoId: string, numero: string): Promise<Container> {
    const { rows } = await this.pool.query(
      `INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, $3) RETURNING *`,
      [organizationId, processoId, numero],
    );
    return mapRow(rows[0]);
  }

  async findById(id: string): Promise<Container | null> {
    const { rows } = await this.pool.query(`SELECT * FROM containers WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByProcessoAndNumero(processoId: string, numero: string): Promise<Container | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM containers WHERE processo_id = $1 AND numero = $2`,
      [processoId, numero],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Busca em QUALQUER processo da organização — usado pelo backfill para reaproveitar um contêiner já conhecido quando a thread não traz o número do processo (ver runBackfill). */
  async findByOrganizationAndNumero(organizationId: string, numero: string): Promise<Container | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM containers WHERE organization_id = $1 AND numero = $2 LIMIT 1`,
      [organizationId, numero],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Fase D15-A v1.1 (achado #1) — WRAPPER TRANSACIONAL fino. Antes da
   * correção, cada etapa (observação, leitura do valor atual, checagem de
   * FINAL, UPDATE) era uma transação `autocommit` separada: entre a checagem
   * de FINAL e o UPDATE, `finalizarProcesso` podia correr por completo e
   * comitar, e o UPDATE ainda assim escrevia por cima de um contêiner já
   * FINAL (corrida real — ver docs/demurrage-fase-d15-a-v1-1.md §1). Agora
   * TODA a operação roda numa única transação, delegada a
   * `applyObservationComClient` (mesmo protocolo universal de lock —
   * identidade sem lock → lock consultivo do processo → relê/trava
   * processo+contêiner → persiste → decide → promove ou bloqueia+registra
   * → comita tudo junto).
   */
  async applyObservation(input: ApplyObservationInput): Promise<ApplyObservationResultado> {
    assertFonteAutorizada(input.campo, input.fonte);

    // Master Free Time passa SEMPRE pelo serviço central (mesma regra de
    // promoção, + divergência SI × Master, eventos, avisos e outbox de
    // recálculo numa única transação) — qualquer que seja a entrada. O
    // serviço central já implementa o MESMO protocolo universal de lock.
    if (input.campo === 'masterFreeTimeDays') {
      const r = await promoverMasterFreeTime(this.pool, {
        organizationId: input.organizationId, containerId: input.containerId, valor: input.valor as number,
        fonte: input.fonte, observadoEm: input.observadoEm, evidenciaRef: input.evidenciaRef, criadoPor: input.criadoPor,
        autor: `applyObservation:${input.fonte}`,
        _testeFalhaAposObservacao: input._testeFalhaAposObservacao,
        _testeAntesDaDecisaoFinal: input._testeAntesDaDecisaoFinal,
      });
      return { outcome: r.outcome, observationId: r.observationId, exigeReabertura: r.exigeReabertura };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await ContainerRepository.applyObservationComClient(client, input);
      await client.query('COMMIT');
      return { outcome: r.outcome, observationId: r.observationId, exigeReabertura: r.exigeReabertura };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Fase D15-A v1.1 (achado #1) — protocolo universal de lock, nesta ordem
   * exata (ver `materialChangeGuard.ts`, cabeçalho, e
   * docs/demurrage-fase-d15-a-v1-1.md §2):
   *   1. identifica o processo pelo contêiner, SEM lock de linha mutável;
   *   2. lock consultivo do processo (`lockProcesso`) — ANTES de qualquer
   *      linha mutável;
   *   3. relê e trava (`FOR UPDATE`) a linha do PROCESSO;
   *   4. relê e trava (`FOR UPDATE`) a linha do CONTÊINER;
   *   5. persiste a observação bruta (ledger, sempre — preservada mesmo
   *      quando bloqueada abaixo);
   *   6. decide prioridade de fonte contra a seleção relida no passo 4;
   *   7. verifica o status relido no passo 3 (nunca uma leitura anterior ao
   *      lock) e promove OU bloqueia+registra `FATO_MATERIAL_POS_FINAL`;
   *   8. devolve — o chamador comita.
   * Só um fato NOVO altera a seleção — reprocessar uma observação JÁ
   * selecionada é NO-OP estrito (D15-A v1.2, achado #2): nenhum `UPDATE`,
   * `atualizado_em` intocado, nenhum evento/outbox/recálculo — ver passo 6
   * abaixo. `conflitoMesmaFonte` = a mesma fonte já registrou o campo no
   * mesmo instante com OUTRO valor (nada muda, nunca promove). Master Free
   * Time tem serviço próprio (divergência/recálculo) e é recusado aqui.
   *
   * PRECONDIÇÃO (D15-A v1.2, achado #1) — este método estabelece o protocolo
   * universal de lock INTEIRO (passos 1-4) sozinho, sempre, nesta ordem; não
   * assume nem depende de o chamador já ter feito nada disso. O que ele NÃO
   * PODE detectar nem corrigir é o chamador ter adquirido, ANTES desta
   * chamada, um `FOR UPDATE` em `processos`/`containers`/`minutas`/
   * `reaberturas` deste MESMO processo sem primeiro ter chamado `lockProcesso`
   * — isso inverteria a ordem (linha antes do consultivo) e reabriria o
   * deadlock do achado #1 contra `finalizarProcesso`/`autorizarReabertura`/
   * etc. Se o seu chamador PRECISA orquestrar múltiplas operações sob UMA
   * transação (como `registrarProcessoDemurrage.aplicar`), descubra o
   * `processoId` sem lock, chame `lockProcesso` você mesmo PRIMEIRO, e só
   * então tome qualquer `FOR UPDATE` (inclusive o seu) — a chamada a este
   * método depois disso é segura (o lock consultivo já detido torna o passo 2
   * daqui um no-op; o `FOR UPDATE` dos passos 3-4 é idempotente dentro da
   * MESMA transação). Todos os chamadores de produção estão auditados em
   * `materialChangeGuard.ts` (`CHAMADORES_AUDITADOS_COM_CLIENT`).
   */
  static async applyObservationComClient(
    client: PoolClient,
    input: ApplyObservationInput,
  ): Promise<ApplyObservationComClientResultado> {
    assertFonteAutorizada(input.campo, input.fonte);
    if (input.campo === 'masterFreeTimeDays') {
      throw new Error('masterFreeTimeDays deve ser promovido pelo serviço central (promoverMasterFreeTimeComClient).');
    }
    const columns = FIELD_COLUMNS[input.campo];

    // Passo 1 — identidade do processo, SEM lock de linha mutável (a FK
    // `processo_id` é estável, nunca reatribuída — ler sem lock é seguro).
    const { rows: idRows } = await client.query(`SELECT processo_id FROM containers WHERE id = $1`, [input.containerId]);
    if (!idRows.length) throw new Error(`Contêiner ${input.containerId} não encontrado.`);
    const processoId: string = idRows[0].processo_id;

    // Passo 2 — lock consultivo do processo, ANTES de qualquer linha mutável.
    await lockProcesso(client, processoId);

    // Passo 3 — relê e trava a linha do PROCESSO (status fresco, pós-lock).
    const { rows: pr } = await client.query(`SELECT apuracao_status FROM processos WHERE id = $1 FOR UPDATE`, [processoId]);
    const apuracaoStatus: string | undefined = pr[0]?.apuracao_status;

    // Passo 4 — relê e trava a linha do CONTÊINER.
    const { rows: cr } = await client.query(
      `SELECT organization_id, ${columns.valueColumn} AS valor, ${columns.obsColumn} AS obs_id FROM containers WHERE id = $1 FOR UPDATE`,
      [input.containerId],
    );
    const c = cr[0];
    if (!c) throw new Error(`Contêiner ${input.containerId} não encontrado.`);
    if (c.organization_id !== input.organizationId) {
      throw new Error(`Contêiner ${input.containerId} não pertence à organização ${input.organizationId}.`);
    }

    // Passo 5 — observação bruta (ledger append-only), sempre preservada.
    const { observacao, criada } = await FieldObservationRepository.insertComClient(client, {
      organizationId: input.organizationId, entidadeTipo: 'container', entidadeId: input.containerId, campo: input.campo,
      valor: input.valor, fonte: input.fonte, observadoEm: input.observadoEm, evidenciaRef: input.evidenciaRef, criadoPor: input.criadoPor,
    });
    const conflito = !criada && JSON.stringify(observacao.valor) !== JSON.stringify(input.valor);

    // SÓ TESTE: injeta falha depois da observação persistida, antes de
    // qualquer decisão — prova que a transação inteira desfaz (nenhuma
    // observação/evento/projeção parcial sobrevive).
    if (input._testeFalhaAposObservacao) await input._testeFalhaAposObservacao();

    // D15-A v1.2 (achado #2) — replay de uma observação JÁ selecionada
    // (criada=false, não é conflito, e é EXATAMENTE a observação apontada
    // pela coluna de proveniência hoje) é um NO-OP ESTRITO: nada mudou, então
    // nada escreve — sem `UPDATE`, sem tocar `atualizado_em`, sem decisão de
    // prioridade/FINAL, sem outbox, sem evento, sem recálculo. Antes desta
    // correção, `promover = !conflito` (v1.1) entrava no passo 7 mesmo aqui e
    // reescrevia a linha com o MESMO valor (só por reprocessar). Isto é
    // disjunto do caminho "bloqueada por FINAL, reprocessada" (achado #1 da
    // v1.1): aquele é identificado por `c.obs_id !== observacao.id` (nunca
    // foi promovida) — este exige `c.obs_id === observacao.id`.
    if (!criada && !conflito && c.obs_id === observacao.id) {
      return {
        outcome: 'promovida', exigeReabertura: false, observationId: observacao.id, criada,
        valorAnterior: c.valor, valorSelecionado: c.valor, conflitoMesmaFonte: false,
      };
    }

    // Passo 6 — prioridade de fonte contra a seleção relida no passo 4.
    // Reprocessar um fato IDÊNTICO ao já registrado mas NÃO selecionado
    // (bloqueado por FINAL anteriormente, ou perdedor de prioridade) precisa
    // refazer a mesma decisão, não pulá-la — senão um reenvio idempotente de
    // um fato já bloqueado por FINAL relataria 'registrada_sem_promover' em
    // vez de 'bloqueada_final' (v1.1, achado #1).
    let promover = !conflito;
    if (promover && c.obs_id) {
      const { rows: atual } = await client.query(`SELECT fonte FROM field_observations WHERE id = $1`, [c.obs_id]);
      const fonteAtual = atual[0]?.fonte as FieldObservationSource | undefined;
      if (fonteAtual) promover = FIELD_OBSERVATION_SOURCE_PRIORITY[input.fonte] >= FIELD_OBSERVATION_SOURCE_PRIORITY[fonteAtual];
    }

    // Passo 7 — status já relido sob lock (passo 3): promove OU bloqueia+registra.
    let bloqueadoPorFinal = false;
    if (promover) {
      bloqueadoPorFinal = await fatoMaterialBloqueadoPorFinal(client, {
        containerId: input.containerId, campo: input.campo, valorAnterior: c.valor, valorNovo: input.valor,
        origem: 'automatico', extra: { fonte: input.fonte, observationId: observacao.id },
        processoIdConhecido: processoId, apuracaoStatusConhecido: apuracaoStatus,
        _testeAntesDaDecisaoFinal: input._testeAntesDaDecisaoFinal,
      });
      if (bloqueadoPorFinal) {
        promover = false;
      } else {
        await client.query(
          `UPDATE containers SET ${columns.valueColumn} = $2, ${columns.obsColumn} = $3, atualizado_em = now() WHERE id = $1`,
          [input.containerId, input.valor, observacao.id],
        );
      }
    }
    // Chegar aqui com `!criada` só acontece quando NÃO é o caso "já
    // selecionada" (tratado acima, retorna antes) — ou é um fato novo
    // (`criada`), ou é um conflito de mesma fonte (nunca promove
    // silenciosamente — `promover` já é `false` desde o passo 6).
    return {
      outcome: bloqueadoPorFinal ? 'bloqueada_final' : promover ? 'promovida' : 'registrada_sem_promover',
      exigeReabertura: bloqueadoPorFinal,
      observationId: observacao.id, criada,
      valorAnterior: c.valor, valorSelecionado: promover ? input.valor : c.valor, conflitoMesmaFonte: conflito,
    };
  }
}
