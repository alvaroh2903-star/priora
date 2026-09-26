import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivarFaseTracking, FatosFaseTracking, TrackingPhase } from '../tracking/vesselCallPhase';

/** Fase 9 — Bloco 1: derivação PURA da fase de tracking (sem banco). */

const base: FatosFaseTracking = {
  associacaoVesselCallAtiva: false,
  chegadaConfirmada: false,
  atracacaoConfirmada: false,
  dischargeDate: null,
  effectiveReturnDate: null,
  trackingReturnDate: null,
};
const fase = (over: Partial<FatosFaseTracking>): TrackingPhase => derivarFaseTracking({ ...base, ...over });

test('SEM_VESSELCALL: sem associação e sem qualquer fato posterior', () => {
  assert.equal(fase({}), 'SEM_VESSELCALL');
});

test('PRE_CHEGADA: associação ativa, sem chegada/atracação/descarga/devolução', () => {
  assert.equal(fase({ associacaoVesselCallAtiva: true }), 'PRE_CHEGADA');
});

test('EM_PORTO: só quando chegada OU atracação CONFIRMADA (não por ETA/tempo)', () => {
  assert.equal(fase({ associacaoVesselCallAtiva: true, chegadaConfirmada: true }), 'EM_PORTO');
  assert.equal(fase({ associacaoVesselCallAtiva: true, atracacaoConfirmada: true }), 'EM_PORTO');
  // Sem associação, mas com chegada confirmada, ainda é EM_PORTO (fato prevalece sobre associação).
  assert.equal(fase({ chegadaConfirmada: true }), 'EM_PORTO');
});

test('POS_DESCARGA: descarga confirmada, sem devolução', () => {
  assert.equal(fase({ associacaoVesselCallAtiva: true, dischargeDate: '2026-09-15' }), 'POS_DESCARGA');
});

test('DEVOLVIDO: effective OU tracking return date presente', () => {
  assert.equal(fase({ effectiveReturnDate: '2026-09-20' }), 'DEVOLVIDO');
  assert.equal(fase({ trackingReturnDate: '2026-09-20' }), 'DEVOLVIDO');
});

test('precedência: fato posterior prevalece sobre anterior', () => {
  // Descarga + chegada → POS_DESCARGA (descarga é mais conclusiva).
  assert.equal(fase({ chegadaConfirmada: true, dischargeDate: '2026-09-15' }), 'POS_DESCARGA');
  // Devolução domina tudo, mesmo com descarga/chegada/associação.
  assert.equal(fase({ associacaoVesselCallAtiva: true, chegadaConfirmada: true, dischargeDate: '2026-09-15', effectiveReturnDate: '2026-09-20' }), 'DEVOLVIDO');
});

test('saltos válidos: não é obrigatório passar por EM_PORTO', () => {
  // PRE_CHEGADA → POS_DESCARGA direto (chegada nunca confirmada).
  assert.equal(fase({ associacaoVesselCallAtiva: true, dischargeDate: '2026-09-15' }), 'POS_DESCARGA');
  // SEM_VESSELCALL → POS_DESCARGA direto (sem associação, com descarga).
  assert.equal(fase({ dischargeDate: '2026-09-15' }), 'POS_DESCARGA');
  // SEM_VESSELCALL → DEVOLVIDO direto.
  assert.equal(fase({ trackingReturnDate: '2026-09-20' }), 'DEVOLVIDO');
});

test('devolução prevalece mesmo sem descarga registrada (não depende de transições intermediárias)', () => {
  assert.equal(fase({ associacaoVesselCallAtiva: true, effectiveReturnDate: '2026-09-20' }), 'DEVOLVIDO');
});
