import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { hashEstavel } from '../registro/contrato';
import { atualizarFotografia } from '../registro/fotografia';
import { repararPosCommitOutbox } from '../registro/registrarProcessoDemurrage';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import { RelogioRepository } from '../persistence/relogioRepository';
import { ClosingEventRepository, TipoEventoFechamento } from '../persistence/closingEventRepository';
import { ReaberturaRepository } from '../persistence/reaberturaRepository';
import {
  DecidirResponsabilidadeInput, DiaAtribuido, ErroResponsabilidade, StatusResponsabilidade, validarEntrada,
} from './contrato';
import { atribuirValoresPorDia, DiaValorado, expandirFaixasAplicadas, somarPorLado } from './valoracaoPorDia';

/**
 * Fase D11 (Gates G1-G7) — serviço de aplicação que grava a decisão de
 * Responsabilidade Rocket × Cliente. NÃO existe rota nem tela: só código de
 * aplicação (uma futura UI de Gestor chamaria isto) e os testes da engine.
 *
 * Fonte de verdade: `responsabilidade_decisoes` (append-only, versionada —
 * migration 0031). `containers.responsabilidade`/`responsabilidade_decisao_id`
 * são só a PROJEÇÃO da decisão vigente, sob guarda de banco (migration 0032)
 * — este é o ÚNICO caminho de escrita de produção; qualquer outra tentativa
 * de gravar a projeção sem a decisão correspondente é rejeitada pelo banco.
 *
 * Em UMA transação:
 *  1. lock consultivo por contêiner (serializa correções concorrentes);
 *  2. carrega processo/contêiner/relógios/autor, valida timing e autoridade;
 *  3. valida a base × dias × período contra os relógios REAIS;
 *  4. apura o valor por dia (só em RELOGIO_CLIENTE — ajuste 3: a distribuição
 *     financeira incide só sobre o valor comercial do cliente; a exposição da
 *     Rocket ao armador nunca é copiada nem dividida aqui);
 *  5. INSERT decisão + períodos + dias (o banco valida cobertura/cronologia);
 *  6. projeta no contêiner + evento de timeline + upsert do outbox pós-commit.
 * Qualquer erro → ROLLBACK de tudo.
 *
 * Depois do COMMIT (fora da transação, mesmo padrão do D10): o reparo do
 * outbox (recálculo idempotente + fotografia) roda sempre — uma falha aqui
 * nunca perde a decisão já commitada; o tick existente (`processarPosCommit-
 * OutboxPendentes`) repara sem intervenção.
 */

export interface DecidirResponsabilidadeResultado {
  ok: true;
  decisaoId: string;
  versao: number;
  status: StatusResponsabilidade;
}

export type FalhaResponsabilidade = { ok: false; codigo: string; detalhe?: Record<string, unknown> };

const lock = (pool: Pool, containerId: string) => pool.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [containerId]);

function tipoEvento(versao: number): TipoEventoFechamento {
  return versao === 1 ? 'RESPONSABILIDADE_CONFIRMADA' : 'RESPONSABILIDADE_CORRIGIDA';
}

export async function decidirResponsabilidade(
  poolArg: Pool,
  input: DecidirResponsabilidadeInput & { hojeReferencia: CivilDate },
): Promise<DecidirResponsabilidadeResultado | FalhaResponsabilidade> {
  const pool = poolArg ?? getPool();

  // 1) Validação PURA (forma, coerência, expansão dos períodos) — antes de
  // qualquer consulta ao banco.
  let dias: DiaAtribuido[];
  let diasRocket: number;
  let diasCliente: number;
  try {
    const r = validarEntrada(input);
    dias = r.dias;
    diasRocket = r.diasRocket;
    diasCliente = r.diasCliente;
  } catch (erro) {
    if (erro instanceof ErroResponsabilidade) return { ok: false, codigo: erro.codigo, detalhe: erro.detalhe };
    throw erro;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lock(client as unknown as Pool, input.containerId);

    const { rows: cr } = await client.query(
      `SELECT c.id, c.organization_id, c.processo_id, c.effective_return_date, c.tracking_return_date,
              c.house_free_time_days, c.master_free_time_days,
              p.apuracao_status, cc.termo_tipo
         FROM containers c
         JOIN processos p ON p.id = c.processo_id
         LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
        WHERE c.id = $1 AND c.organization_id = $2
        FOR UPDATE OF c`,
      [input.containerId, input.organizationId],
    );
    if (!cr.length) throw new ErroResponsabilidade('CONTAINER_NAO_ENCONTRADO', { containerId: input.containerId });
    const c = cr[0];

    if (c.apuracao_status === 'FINAL') throw new ErroResponsabilidade('EXIGE_REABERTURA', { processoId: c.processo_id });

    const { rows: mr } = await client.query(
      `SELECT id, usuario_id, papel FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
      [input.autorMembershipId, input.organizationId],
    );
    if (!mr.length || (mr[0].papel !== 'MANAGER' && mr[0].papel !== 'ADMIN')) {
      throw new ErroResponsabilidade('AUTOR_NAO_AUTORIZADO', { autorMembershipId: input.autorMembershipId });
    }
    const autorPapel: 'MANAGER' | 'ADMIN' = mr[0].papel;
    const autorUsuarioId: string = mr[0].usuario_id;

    const devolucao: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
    if (!devolucao) throw new ErroResponsabilidade('ANTES_DA_DEVOLUCAO', { containerId: input.containerId });

    // v1.2 (corretiva 3): nunca decidir sobre um relógio obsoleto. Reutiliza a
    // validação de cache do RelogioRepository (mesma fórmula de input_hash do
    // recalculador — nada é duplicado aqui) para os fatos ATUAIS do contêiner
    // e a data final da devolução. Não recalcula: o pipeline recalcula
    // primeiro, o Gestor decide depois.
    //  - RELOGIO_CLIENTE: o relógio do cliente;
    //  - RELOGIO_ROCKET: o Rocket e o do cliente (que prova o zero do cliente);
    //  - NAO_APLICAVEL: os dois.
    //
    // Precedência (validada): VERSAO_DESATUALIZADA vem ANTES de
    // RELOGIO_OBSOLETO. Com relógio válido nada muda em relação à v1.1 — as
    // validações de relógio seguem antes de VERSAO_DESATUALIZADA. Por isso a
    // MESMA verificação de versão (`verificarVersao`) só é antecipada quando o
    // relógio está obsoleto.
    const verificarVersao = async (): Promise<{ vigente: { id: string; versao: number } | null; versaoEsperada: number }> => {
      // Sequência de versão (o gatilho de INSERT valida de novo — defesa em
      // profundidade; aqui erramos com um código de negócio legível).
      const { rows: vig } = await client.query(
        `SELECT id, versao FROM responsabilidade_decisoes WHERE container_id = $1 ORDER BY versao DESC LIMIT 1`,
        [input.containerId],
      );
      const vigente = vig[0] ?? null;
      if (input.substituiDecisaoId) {
        if (!vigente || vigente.id !== input.substituiDecisaoId) {
          throw new ErroResponsabilidade('VERSAO_DESATUALIZADA', { esperado: vigente?.id ?? null, recebido: input.substituiDecisaoId });
        }
      } else if (vigente) {
        throw new ErroResponsabilidade('VERSAO_DESATUALIZADA', { esperado: vigente.id, recebido: null });
      }
      return { vigente, versaoEsperada: vigente ? vigente.versao + 1 : 1 };
    };

    const relogiosExigidos: Array<'cliente' | 'rocket'> = input.baseRelogio === 'RELOGIO_CLIENTE' ? ['cliente'] : ['cliente', 'rocket'];
    const relogioRepo = new RelogioRepository(client as unknown as Pool);
    for (const tipo of relogiosExigidos) {
      const { validade } = await relogioRepo.buscarValido(input.containerId, tipo, devolucao);
      if (validade !== 'VALIDO') {
        await verificarVersao();
        throw new ErroResponsabilidade('RELOGIO_OBSOLETO', { relogio: tipo, validade });
      }
    }

    const { rows: relRows } = await client.query(
      `SELECT tipo, estado, dias_demurrage, primeiro_dia_demurrage, data_final_apuracao, input_hash
         FROM relogios WHERE container_id = $1`,
      [input.containerId],
    );
    const relCliente = relRows.find((r) => r.tipo === 'cliente') ?? null;
    const relRocket = relRows.find((r) => r.tipo === 'rocket') ?? null;
    const clienteTemDias = relCliente?.estado === 'OK' && (relCliente.dias_demurrage ?? 0) >= 1;
    const rocketTemDias = relRocket?.estado === 'OK' && (relRocket.dias_demurrage ?? 0) >= 1;

    if (input.baseRelogio === 'RELOGIO_CLIENTE') {
      if (!clienteTemDias) throw new ErroResponsabilidade('SEM_APURACAO_DETERMINAVEL', { motivo: 'relogio_cliente_sem_dias_ok' });
      if (relCliente.data_final_apuracao !== devolucao) throw new ErroResponsabilidade('INTERVALO_ABERTO', { relogio: 'cliente' });
    } else if (input.baseRelogio === 'RELOGIO_ROCKET') {
      if (clienteTemDias) throw new ErroResponsabilidade('BASE_RELOGIO_INVALIDA', { motivo: 'cliente_tem_dias_use_RELOGIO_CLIENTE' });
      if (!rocketTemDias) throw new ErroResponsabilidade('SEM_APURACAO_DETERMINAVEL', { motivo: 'relogio_rocket_sem_dias_ok' });
      if (relRocket.data_final_apuracao !== devolucao) throw new ErroResponsabilidade('INTERVALO_ABERTO', { relogio: 'rocket' });
    } else {
      // NAO_APLICAVEL (v1.1 — ajuste corretivo 1): universo estritamente
      // restrito. Nunca aceito só porque o cliente está com zero dias — exige
      // a Rocket com exposição real, os dois relógios fechados na devolução e
      // uma diferença comercial de Free Time DETERMINÁVEL e efetiva.
      if (!relCliente || relCliente.estado !== 'OK') {
        throw new ErroResponsabilidade('SEM_APURACAO_DETERMINAVEL', { motivo: 'relogio_cliente_nao_ok_nao_aplicavel' });
      }
      if (clienteTemDias) throw new ErroResponsabilidade('BASE_RELOGIO_INVALIDA', { motivo: 'cliente_tem_dias_nao_aplicavel_invalido' });
      if (relCliente.data_final_apuracao !== devolucao) throw new ErroResponsabilidade('INTERVALO_ABERTO', { relogio: 'cliente' });
      if (!relRocket || relRocket.estado !== 'OK') {
        throw new ErroResponsabilidade('NAO_APLICAVEL_INVALIDO', { motivo: 'relogio_rocket_nao_ok' });
      }
      if ((relRocket.dias_demurrage ?? 0) < 1) {
        throw new ErroResponsabilidade('NAO_APLICAVEL_INVALIDO', { motivo: 'ambos_relogios_zero_dias' });
      }
      if (relRocket.data_final_apuracao !== devolucao) throw new ErroResponsabilidade('INTERVALO_ABERTO', { relogio: 'rocket' });
      const houseFt: number | null = c.house_free_time_days ?? null;
      const masterFt: number | null = c.master_free_time_days ?? null;
      if (houseFt === null || masterFt === null) {
        throw new ErroResponsabilidade('NAO_APLICAVEL_INVALIDO', { motivo: 'free_time_indeterminavel' });
      }
      if (!(houseFt > masterFt)) {
        throw new ErroResponsabilidade('NAO_APLICAVEL_INVALIDO', { motivo: 'house_free_time_nao_maior_que_master', houseFt, masterFt });
      }
    }

    const { versaoEsperada } = await verificarVersao();

    // Dias fora do intervalo real do relógio-base (G9) — erro de negócio
    // legível antes de ir ao banco (o trigger de INSERT também barra).
    const baseRel = input.baseRelogio === 'RELOGIO_CLIENTE' ? relCliente : input.baseRelogio === 'RELOGIO_ROCKET' ? relRocket : null;
    if (baseRel) {
      for (const d of dias) {
        if (d.dia < baseRel.primeiro_dia_demurrage || d.dia > baseRel.data_final_apuracao) {
          throw new ErroResponsabilidade('DIA_FORA_DA_BASE', { dia: d.dia, base: input.baseRelogio });
        }
      }
    }

    // Cobertura completa exigida em RELOGIO_CLIENTE (o trigger de banco
    // também valida — ver 0031).
    if (input.baseRelogio === 'RELOGIO_CLIENTE' && dias.length !== relCliente.dias_demurrage) {
      throw new ErroResponsabilidade('LACUNA', { esperado: relCliente.dias_demurrage, recebido: dias.length });
    }

    // 4) Valoração por dia — só existe valor comercial a distribuir na base
    // RELOGIO_CLIENTE (ajuste 3).
    let diasValorados: DiaValorado[] = dias.map((d) => ({ ...d, posicao: 0, faixaInicio: null, faixaFim: null, valorDiaCents: null }));
    let valorStatus: 'CALCULADO' | 'INDISPONIVEL' | 'NAO_APLICAVEL' = 'NAO_APLICAVEL';
    let valorRocket: number | null = null;
    let valorCliente: number | null = null;
    let moeda: string | null = null;
    // v1.1 (corretiva #3): retrato do valorApurado do cliente ESPECÍFICO que
    // sustentou esta divisão — a base financeira fica versionada junto com a
    // temporal (`clienteInputHash`/`rocketInputHash`). Uma mudança posterior no
    // valor ativo (nova versão de tabela, tarifa que passa a existir) é
    // detectável mesmo que o relógio não tenha mudado (trigger em 0033).
    let valorClienteBase: Record<string, unknown> | null = null;

    if (input.baseRelogio === 'RELOGIO_CLIENTE') {
      const motor = c.termo_tipo === 'embarque' ? 'termo_embarque' : c.termo_tipo === 'unico' ? 'termo_unico' : null;
      const ativo = motor ? await new ValorApuradoRepository(client as unknown as Pool).buscarAtivo(input.containerId, 'cliente', motor) : null;
      valorClienteBase = {
        id: ativo?.id ?? null,
        inputHash: ativo?.inputHash ?? null,
        motorComercial: ativo?.motorComercial ?? motor,
        tabelaId: ativo?.tabelaId ?? null,
        versaoTabela: ativo?.versaoTabela ?? null,
        total: ativo?.total ?? null,
        moeda: ativo?.moeda ?? null,
        faixasAplicadasHash: ativo ? hashEstavel(ativo.faixasAplicadas) : null,
      };
      let diaria = null;
      if (ativo && ativo.total !== null && ativo.confirmationStatus !== 'UNAVAILABLE') {
        diaria = expandirFaixasAplicadas(ativo.faixasAplicadas as any, relCliente.dias_demurrage);
        moeda = ativo.moeda;
      }
      diasValorados = atribuirValoresPorDia(dias, relCliente.primeiro_dia_demurrage, diaria);
      const soma = somarPorLado(diasValorados);
      if (soma.completo && ativo) {
        const totalCents = Math.round(ativo.total! * 100);
        if (soma.rocketCents! + soma.clienteCents! === totalCents) {
          valorStatus = 'CALCULADO';
          valorRocket = soma.rocketCents! / 100;
          valorCliente = soma.clienteCents! / 100;
        } else {
          valorStatus = 'INDISPONIVEL';
          moeda = null;
        }
      } else {
        valorStatus = 'INDISPONIVEL';
        moeda = null;
      }
    } else if (input.baseRelogio === 'RELOGIO_ROCKET') {
      // Sem valor comercial do cliente a apurar aqui (ajuste 3) — mas a
      // posição cronológica (1-based) do dia ainda precisa existir, relativa
      // ao próprio relógio Rocket (CHECK de banco exige posicao >= 1).
      diasValorados = atribuirValoresPorDia(dias, relRocket.primeiro_dia_demurrage, null);
    }

    const base = {
      clienteInputHash: relCliente?.input_hash ?? null,
      rocketInputHash: relRocket?.input_hash ?? null,
      clienteDiasDemurrage: relCliente?.dias_demurrage ?? null,
      rocketDiasDemurrage: relRocket?.dias_demurrage ?? null,
      devolucao,
      // v1.1: só preenchido em RELOGIO_CLIENTE — a base financeira específica
      // (ver corretiva #3); a exposição da Rocket ao armador nunca entra aqui.
      valorCliente: valorClienteBase,
    };
    const baseHash = hashEstavel(base);

    const { rows: insDecisao } = await client.query(
      `INSERT INTO responsabilidade_decisoes
         (organization_id, processo_id, container_id, versao, status, motivo_estruturado, base_relogio,
          dias_rocket, dias_cliente, valor_status, valor_rocket, valor_cliente, moeda, base, base_hash,
          justificativa, evidencia_ref, autor_membership_id, autor_papel, substitui_decisao_id, motivo_correcao, reabertura_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id, versao`,
      [
        input.organizationId, c.processo_id, input.containerId, versaoEsperada, input.status,
        input.motivoEstruturado ?? null, input.baseRelogio, diasRocket, diasCliente, valorStatus,
        valorRocket, valorCliente, moeda, JSON.stringify(base), baseHash,
        input.justificativa.trim(), input.evidenciaRef.trim(), input.autorMembershipId, autorPapel,
        input.substituiDecisaoId ?? null, input.motivoCorrecao ?? null,
        (await new ReaberturaRepository(client as unknown as Pool).abertaDoProcesso(c.processo_id))?.id ?? null,
      ],
    );
    const decisaoId: string = insDecisao[0].id;
    const versao: number = insDecisao[0].versao;

    for (const p of input.periodos ?? []) {
      await client.query(
        `INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.organizationId, decisaoId, p.lado, p.inicio, p.fim],
      );
    }
    // v1.2: diária e moeda por dia só quando a divisão financeira está
    // CALCULADA (o banco exige, no COMMIT, que soma e moeda dos dias batam com
    // a decisão; sem valor calculado, nenhum dia carrega diária).
    const valorado = valorStatus === 'CALCULADO';
    for (const d of diasValorados) {
      await client.query(
        `INSERT INTO responsabilidade_decisao_dias
           (organization_id, decisao_id, dia, lado, posicao, faixa_inicio, faixa_fim, valor_dia, moeda)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.organizationId, decisaoId, d.dia, d.lado, d.posicao, d.faixaInicio, d.faixaFim,
          valorado && d.valorDiaCents !== null ? d.valorDiaCents / 100 : null, valorado ? moeda : null,
        ],
      );
    }

    await client.query(
      `UPDATE containers SET responsabilidade = $2, responsabilidade_decisao_id = $3 WHERE id = $1`,
      [input.containerId, input.status, decisaoId],
    );

    await new ClosingEventRepository(client as unknown as Pool).registrar({
      processoId: c.processo_id, containerId: input.containerId, tipoEvento: tipoEvento(versao),
      origem: 'humano', atorUsuarioId: autorUsuarioId,
      evidenciaRef: input.evidenciaRef.trim(),
      payload: { decisaoId, versao, status: input.status, motivoCorrecao: input.motivoCorrecao ?? null },
    });

    await client.query(
      `INSERT INTO demurrage_pos_commit_outbox (organization_id, processo_id, container_id, estado)
       VALUES ($1, $2, $3, 'pendente')
       ON CONFLICT (processo_id, container_id) DO UPDATE SET
         geracao = demurrage_pos_commit_outbox.geracao + 1,
         estado = CASE WHEN demurrage_pos_commit_outbox.estado = 'processando' THEN 'processando' ELSE 'pendente' END,
         atualizado_em = now()`,
      [input.organizationId, c.processo_id, input.containerId],
    );

    await client.query('COMMIT');

    // Fora da transação (D10, padrão já congelado): recálculo idempotente +
    // fotografia. Uma falha aqui não perde a decisão; o tick existente repara.
    await repararPosCommitOutbox(pool, c.processo_id, { hojeReferencia: input.hojeReferencia });

    return { ok: true, decisaoId, versao, status: input.status };
  } catch (erro) {
    await client.query('ROLLBACK');
    if (erro instanceof ErroResponsabilidade) return { ok: false, codigo: erro.codigo, detalhe: erro.detalhe };
    throw erro;
  } finally {
    client.release();
  }
}
