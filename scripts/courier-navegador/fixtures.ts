/**
 * Fixtures SINTÉTICAS da validação no navegador do Courier Module (ASS-010 /
 * HIS-004). Nenhum dado real: trackings, IMs, agentes, e-mails e referências são
 * inventados. Usadas por validar.ts.
 */

/** Trackings sintéticos, um por cenário. */
export const T = {
  ASSOC: '770012345701', // IM2401 com OMBL, IM2402 com OHBL
  REVISAR: '770012345702', // OHBL ambíguo entre dois IMs + OMBL sem IM
  TELEX: '770012345703', // telex no envelope + "Não recebido" e follow-up no IM2405
  GENERICO: '770012345704', // BL ligado a 9 processos nos pré-alertas
  NORMAL: '770012345705', // fluxo comum (OMBL e OHBL no e-mail)
  SEM_MENCAO: '770012345706', // e-mail sem menção a documento
  ASSOC_CONFLITO: '770012345707', // "Recebido" no OHBL do IM2410, mas o OHBL é do IM2411
};

export type Email = Record<string, any>;

function email(i: number, tracking: string, processos: string, linhas: string[]): Email {
  const corpo = [
    `Segue o tracking FedEx ${tracking} com os documentos originais (OBL) do processo ${processos} enviados por courier.`,
    ...linhas,
  ].join('\n');
  return {
    id: `msg-n${i}`,
    conversationId: `conv-n${i}`,
    subject: `Courier FedEx - documentos originais ${processos}`,
    from: { emailAddress: { name: `Agente sintético ${i}`, address: `agente${i}@exemplo.test` } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 3600_000).toISOString(),
    bodyPreview: corpo.slice(0, 80),
    body: { contentType: 'text', content: corpo },
    isRead: true,
    hasAttachments: false,
    attachments: [],
    webLink: '',
  };
}

/** Caixa de e-mails sintética (o que o Graph falso devolve). */
export function caixaSintetica(): Email[] {
  const caixa = [
    email(1, T.ASSOC, 'IM2401 e IM2402', ['IM2401 - OMBL', 'IM2402 - OHBL']),
    email(2, T.REVISAR, 'IM2403 e IM2404', ['IM2403 / IM2404 - OHBL', 'OMBL SHYA26049999 enclosed']),
    email(3, T.TELEX, 'IM2405 e IM2406', ['IM2405 - OMBL / OHBL', 'IM2406 - OMBL / OHBL', 'HBL released via telex release.']),
    email(4, T.GENERICO, 'IM2407', ['IM2407 - OMBL', 'OHBL SHGEN00000001 enclosed']),
    email(5, T.NORMAL, 'IM2408', ['Documentos: OMBL e OHBL.']),
    email(6, T.SEM_MENCAO, 'IM2409', ['Favor confirmar o recebimento.']),
    email(7, T.ASSOC_CONFLITO, 'IM2410 e IM2411', ['IM2410 - OMBL', 'IM2411 - OHBL']),
  ];
  // Pré-alertas sintéticos: o mesmo BL em 9 processos (acima do limite de 8).
  for (let k = 0; k < 9; k++) {
    caixa.push({
      id: `pre-${k}`, conversationId: `conv-pre-${k}`, subject: `Pre-alert IM${2431 + k}`,
      from: { emailAddress: { name: 'Origem sintética', address: 'origem@exemplo.test' } }, toRecipients: [], ccRecipients: [],
      receivedDateTime: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + k * 60_000).toISOString(),
      bodyPreview: 'Pre-alert', body: { contentType: 'text', content: `Pre-alert IM${2431 + k}\nHBL SHGEN00000001` },
      isRead: true, hasAttachments: false, attachments: [], webLink: '',
    });
  }
  return caixa;
}

/** Registros humanos já existentes (estado, conferência, follow-up). */
export const semente = {
  estados: {
    [T.ASSOC]: { estado: 'Em Conferência', updatedAt: '2026-10-20T10:00:00.000Z' },
    [T.REVISAR]: { estado: 'Recebido', updatedAt: '2026-10-20T10:00:00.000Z' },
    [T.TELEX]: { estado: 'Divergência', updatedAt: '2026-10-20T10:00:00.000Z' },
    [T.GENERICO]: { estado: 'Recebido', updatedAt: '2026-10-20T10:00:00.000Z' },
    [T.SEM_MENCAO]: { estado: 'Recebido', updatedAt: '2026-10-20T10:00:00.000Z' },
    [T.ASSOC_CONFLITO]: { estado: 'Em Conferência', updatedAt: '2026-10-20T10:00:00.000Z' },
  } as Record<string, unknown>,
  conferencia: {
    [T.TELEX]: { IM2405: { mbl: 'recebido', hbl: 'nao_recebido' } },
    [T.ASSOC_CONFLITO]: { IM2410: { mbl: 'recebido', hbl: 'recebido' } },
  } as Record<string, unknown>,
  followups: {
    [T.TELEX]: { IM2405: { hbl: { via: 'manual', at: '2026-10-20T11:00:00.000Z' } } },
  } as Record<string, unknown>,
};

/** O que a Clara falsa "afirma" em cada courier: 1ª análise e a recarregada. */
export const CLARA: Record<string, [string | null, string | null]> = {
  [T.ASSOC]: ['Telex release to consignee', 'Wave BL — emitido no destino'],
  [T.REVISAR]: ['Original HBL sent to consignee', null],
  [T.TELEX]: ['Telex release confirmed', 'Destination Release'],
  [T.GENERICO]: [null, 'HBL sent to client'],
  [T.NORMAL]: [null, null],
  [T.SEM_MENCAO]: [null, null],
  [T.ASSOC_CONFLITO]: [null, null],
};
/** IMs que só a Clara falsa cita (nenhum texto os contém). */
export const SO_DA_CLARA: Record<string, string[]> = { [T.ASSOC]: ['IM9999'] };
