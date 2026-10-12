import { Db, resolverMaster, resolverProcesso } from '../../identidade';

/**
 * Contrato de saída do vínculo documental Processo ↔ Master (S2-mín; H-7,
 * N-15, N-18). Só leitura; a Liberação consome por referência, sem cópia.
 *
 * Uma linha de vínculo vale enquanto as identidades que a sustentaram ainda
 * resolvem igual no S6 (alias ou referência de Master invalidados deixam de
 * valer). Com um único Master válido, o vínculo é publicado; com mais de um,
 * é CONFLITO e nenhum vínculo é publicado até a evidência resolver.
 *
 * `vinculadoEm` é quando a Priora ESTABELECEU o vínculo (a primeira linha
 * válida para aquele Master) — nunca a data antiga do e-mail. A data da fonte
 * fica separada em `observadoEm`. Isso é o que o N-15 (vínculo tardio) exige.
 */
export interface EvidenciaVinculo {
  vinculoId: string;
  extracaoId: string;
  vinculadoEm: Date;
  observadoEm: Date | null;
  evidencia: { fonte: 'auditoria'; ref: string };
}

export type SituacaoVinculo =
  | { tipo: 'SEM_VINCULO'; processoId: string }
  | ({ tipo: 'VINCULADO'; processoId: string; masterId: string; evidencias: EvidenciaVinculo[] } & Omit<EvidenciaVinculo, 'vinculoId' | 'extracaoId'>)
  | { tipo: 'CONFLITO'; processoId: string; masters: Array<{ masterId: string; evidencias: EvidenciaVinculo[] }> };

export async function vinculoDoProcesso(db: Db, organizationId: string, processoId: string): Promise<SituacaoVinculo> {
  const { rows } = await db.query(
    `SELECT id, master_id, extracao_id, processo_ref_bruta, mbl_bruto, observado_em, vinculado_em
       FROM processo_master_vinculos
      WHERE organization_id = $1 AND processo_id = $2
      ORDER BY vinculado_em, id`,
    [organizationId, processoId],
  );
  const porMaster = new Map<string, EvidenciaVinculo[]>();
  for (const r of rows) {
    const p = await resolverProcesso(db, organizationId, r.processo_ref_bruta);
    if (p.status !== 'RESOLVIDO' || p.processoId !== processoId) continue;
    const m = await resolverMaster(db, organizationId, { mbl: r.mbl_bruto });
    if (m.status !== 'RESOLVIDO' || m.masterId !== r.master_id) continue;
    const lista = porMaster.get(r.master_id) ?? [];
    lista.push({
      vinculoId: r.id, extracaoId: r.extracao_id, vinculadoEm: new Date(r.vinculado_em),
      observadoEm: r.observado_em ? new Date(r.observado_em) : null,
      evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${r.extracao_id}` },
    });
    porMaster.set(r.master_id, lista);
  }
  if (porMaster.size === 0) return { tipo: 'SEM_VINCULO', processoId };
  if (porMaster.size > 1) {
    return { tipo: 'CONFLITO', processoId, masters: [...porMaster].map(([masterId, evidencias]) => ({ masterId, evidencias })) };
  }
  const [[masterId, evidencias]] = [...porMaster];
  const primeira = evidencias[0];
  return {
    tipo: 'VINCULADO', processoId, masterId, vinculadoEm: primeira.vinculadoEm, observadoEm: primeira.observadoEm,
    evidencia: primeira.evidencia, evidencias,
  };
}
