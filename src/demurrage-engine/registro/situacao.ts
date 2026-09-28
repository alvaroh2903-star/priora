import { Pool } from 'pg';
import { normalizarNumeroProcesso } from './contrato';

/**
 * Fase D10 — situação APRESENTÁVEL da Demurrage (somente leitura).
 *
 * Não cria enum novo no lifecycle congelado: sem descarga oficial, o lifecycle
 * continua em `PENDENCIA_DE_DADOS` e os dois relógios em `PENDING` com a
 * pendência estruturada `DESCARGA_AUSENTE`. Esta camada apenas TRADUZ esse
 * motivo estruturado para `AGUARDANDO_DESCARGA` / "Aguardando descarga".
 * ETA, chegada, atracação ou Gate Out não mudam isso: só `discharge_date`.
 */

export type CodigoSituacao =
  | 'AGUARDANDO_DESCARGA'
  | 'MONITORAMENTO_SILENCIOSO' | 'PRAZO_PROXIMO' | 'EM_DEMURRAGE_ATENCAO' | 'EM_DEMURRAGE_CRITICO'
  | 'PENDENCIA_DE_DADOS' | 'TRACKING_DESATUALIZADO' | 'DEVOLVIDO_AGUARDANDO_TRATAMENTO' | 'CONCLUIDO_PARA_ROCKET'
  | 'NAO_DERIVADO';

const ROTULO: Record<CodigoSituacao, string> = {
  AGUARDANDO_DESCARGA: 'Aguardando descarga',
  MONITORAMENTO_SILENCIOSO: 'Monitoramento silencioso',
  PRAZO_PROXIMO: 'Prazo próximo',
  EM_DEMURRAGE_ATENCAO: 'Em demurrage — atenção',
  EM_DEMURRAGE_CRITICO: 'Em demurrage — crítico',
  PENDENCIA_DE_DADOS: 'Pendência de dados',
  TRACKING_DESATUALIZADO: 'Tracking desatualizado',
  DEVOLVIDO_AGUARDANDO_TRATAMENTO: 'Devolvido — aguardando tratamento',
  CONCLUIDO_PARA_ROCKET: 'Concluído para a Rocket',
  NAO_DERIVADO: 'Ainda não derivado',
};

export interface RelogioSituacao { estado: string | null; diasDemurrage: number | null; ultimoDiaLivre: string | null; primeiroDiaDemurrage: string | null; pendencias: string[] }

export interface SituacaoContainer {
  containerId: string;
  numero: string;
  dischargeDate: string | null;
  situacao: { codigo: CodigoSituacao; rotulo: string; motivo: string | null };
  lifecycleEstado: string | null;
  custoAtivo: boolean;
  relogios: { cliente: RelogioSituacao | null; rocket: RelogioSituacao | null };
  valoresAtivos: Array<{ relogio: string; motor: string; status: string; total: number | null; moeda: string | null }>;
}

export interface SituacaoProcesso {
  processoId: string;
  numeroProcesso: string;
  apuracaoStatus: string;
  situacao: { codigo: CodigoSituacao; rotulo: string };
  containers: SituacaoContainer[];
  pendenciasAbertas: Array<{ tipo: string; containerNumero: string | null }>;
}

/** Tradução PURA do estado congelado + motivo estruturado dos relógios. */
export function situacaoDoContainer(i: {
  dischargeDate: string | null; emptyReturn: boolean; lifecycleEstado: string | null; pendenciasRelogios: string[];
}): { codigo: CodigoSituacao; rotulo: string; motivo: string | null } {
  if (!i.dischargeDate && !i.emptyReturn) {
    return { codigo: 'AGUARDANDO_DESCARGA', rotulo: ROTULO.AGUARDANDO_DESCARGA, motivo: i.pendenciasRelogios.includes('DESCARGA_AUSENTE') ? 'DESCARGA_AUSENTE' : null };
  }
  const codigo = (i.lifecycleEstado ?? 'NAO_DERIVADO') as CodigoSituacao;
  return { codigo, rotulo: ROTULO[codigo] ?? codigo, motivo: null };
}

/** Situação do processo e de seus contêineres (somente SELECT). */
export async function consultarSituacaoProcesso(pool: Pool, organizationId: string, numeroProcesso: string): Promise<SituacaoProcesso | null> {
  const { rows: pr } = await pool.query(
    `SELECT id, numero_processo, apuracao_status, estado_mais_relevante FROM processos WHERE organization_id = $1 AND numero_processo = $2`,
    [organizationId, normalizarNumeroProcesso(numeroProcesso)],
  );
  const p = pr[0];
  if (!p) return null;
  const { rows: cs } = await pool.query(
    `SELECT id, numero, discharge_date, tracking_return_date, effective_return_date, estado FROM containers WHERE processo_id = $1 ORDER BY numero`,
    [p.id],
  );
  const containers: SituacaoContainer[] = [];
  for (const c of cs) {
    const { rows: rel } = await pool.query(
      `SELECT tipo, estado, dias_demurrage, ultimo_dia_livre, primeiro_dia_demurrage, pendencias FROM relogios WHERE container_id = $1`, [c.id],
    );
    const { rows: val } = await pool.query(
      `SELECT relogio_tipo, motor_comercial, confirmation_status, total, moeda FROM valores_apurados
        WHERE container_id = $1 AND calculation_status IN ('OPEN', 'FINAL') ORDER BY relogio_tipo`, [c.id],
    );
    const rel1 = (t: string): RelogioSituacao | null => {
      const r = rel.find((x) => x.tipo === t);
      return r ? { estado: r.estado, diasDemurrage: r.dias_demurrage, ultimoDiaLivre: r.ultimo_dia_livre, primeiroDiaDemurrage: r.primeiro_dia_demurrage, pendencias: r.pendencias } : null;
    };
    const pendencias = rel.flatMap((r) => r.pendencias as string[]);
    const emptyReturn = !!(c.effective_return_date ?? c.tracking_return_date);
    const valoresAtivos = val.map((v) => ({ relogio: v.relogio_tipo, motor: v.motor_comercial, status: v.confirmation_status, total: v.total === null ? null : Number(v.total), moeda: v.moeda }));
    containers.push({
      containerId: c.id, numero: c.numero, dischargeDate: c.discharge_date,
      situacao: situacaoDoContainer({ dischargeDate: c.discharge_date, emptyReturn, lifecycleEstado: c.estado, pendenciasRelogios: pendencias }),
      lifecycleEstado: c.estado,
      custoAtivo: !emptyReturn && rel.some((r) => r.estado === 'OK' && (r.dias_demurrage ?? 0) >= 1),
      relogios: { cliente: rel1('cliente'), rocket: rel1('rocket') },
      valoresAtivos,
    });
  }
  const { rows: pend } = await pool.query(
    `SELECT dp.tipo, c.numero FROM demurrage_pendencias dp LEFT JOIN containers c ON c.id = dp.container_id
      WHERE dp.processo_id = $1 AND dp.estado = 'aberta' ORDER BY dp.tipo, c.numero`,
    [p.id],
  );
  const todosAguardando = containers.length > 0 && containers.every((c) => c.situacao.codigo === 'AGUARDANDO_DESCARGA');
  const codigo: CodigoSituacao = containers.length === 0 || todosAguardando ? 'AGUARDANDO_DESCARGA' : ((p.estado_mais_relevante ?? 'NAO_DERIVADO') as CodigoSituacao);
  return {
    processoId: p.id, numeroProcesso: p.numero_processo, apuracaoStatus: p.apuracao_status,
    situacao: { codigo, rotulo: ROTULO[codigo] ?? codigo }, containers,
    pendenciasAbertas: pend.map((x) => ({ tipo: x.tipo, containerNumero: x.numero ?? null })),
  };
}
