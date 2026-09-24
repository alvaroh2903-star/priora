import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailHeuristicSource, fieldsFromAiContainer, EmailThreadInput } from '../sources/emailHeuristicSource';

/**
 * Testes puros (sem Postgres, sem chave de IA) — exercitam o caminho
 * determinístico (filtro) e o mapeamento crítico dataRetirada -> gateOutDate.
 * Neste ambiente GEMINI_API_KEY não está definida, então `isAiConfigured()`
 * é false e emailHeuristicSource.extract() usa só o filtro determinístico.
 */

test('emailHeuristicSource: mapeamento dataRetirada -> gateOutDate, NUNCA dischargeDate (achado D1 do diagnóstico)', () => {
  const fields = fieldsFromAiContainer(
    {
      numero: 'MSKU1234567',
      dataRetirada: '2026-01-10',
      freeTimeDias: 14,
      diaria: 150,
      moeda: 'USD',
      dataDevolucao: '2026-01-20',
      minutaRecebida: false,
    },
    new Date('2026-01-15T00:00:00Z'),
  );

  const campos = fields.map((f) => f.campo);
  assert.ok(campos.includes('gateOutDate'), 'dataRetirada deve virar gateOutDate');
  assert.ok(!campos.includes('dischargeDate'), 'e-mail NUNCA deve popular dischargeDate — não é fonte aprovada para descarga');
  assert.ok(campos.includes('houseFreeTimeDays'), 'freeTimeDias deve virar houseFreeTimeDays (lado cliente)');
  assert.ok(!campos.includes('masterFreeTimeDays'), 'e-mail nunca popula masterFreeTimeDays — fica pendente');
  assert.ok(campos.includes('trackingReturnDate'), 'dataDevolucao deve virar trackingReturnDate');

  const gateOut = fields.find((f) => f.campo === 'gateOutDate');
  assert.equal(gateOut?.valor, '2026-01-10');
});

test('emailHeuristicSource: campo ausente no e-mail não gera field — vira pendência (nada inventado)', () => {
  const fields = fieldsFromAiContainer(
    {
      numero: 'MSKU1234567',
      dataRetirada: null,
      freeTimeDias: null,
      diaria: null,
      moeda: null,
      dataDevolucao: null,
      minutaRecebida: null,
    },
    new Date(),
  );
  assert.deepEqual(fields, [], 'nenhum campo observado quando o e-mail não traz nenhum dado');
});

test('emailHeuristicSource.extract: thread sem sinal de demurrage não produz nenhum contêiner', async () => {
  const thread: EmailThreadInput = {
    subject: 'Reunião de equipe amanhã',
    messages: [
      {
        id: 'msg-1',
        subject: 'Reunião de equipe amanhã',
        bodyText: 'Pessoal, vamos alinhar o cronograma do projeto na sexta.',
        receivedDateTime: '2026-01-05T10:00:00Z',
      },
    ],
  };
  const result = await emailHeuristicSource.extract(thread);
  assert.deepEqual(result.processes, []);
});

test('emailHeuristicSource.extract: thread com sinal forte extrai processo e contêiner via filtro determinístico', async () => {
  const thread: EmailThreadInput = {
    subject: 'IM2151 — Sobreestadia MSKU1234567',
    messages: [
      {
        id: 'msg-1',
        subject: 'IM2151 — Sobreestadia MSKU1234567',
        bodyText:
          'Prezados, o contêiner MSKU1234567 do processo IM2151 está em demurrage. ' +
          'O free time já venceu e a diária está sendo cobrada. Favor confirmar a devolução.',
        senderAddress: 'agente@armador.example',
        receivedDateTime: '2026-01-15T10:00:00Z',
      },
    ],
  };

  const result = await emailHeuristicSource.extract(thread);
  assert.equal(result.processes.length, 1);
  const [proc] = result.processes;
  assert.equal(proc.numeroProcesso, 'IM2151');
  assert.equal(proc.containers.length, 1);
  assert.equal(proc.containers[0].numero, 'MSKU1234567');
  // Sem GEMINI_API_KEY neste ambiente: só o filtro determinístico roda, que
  // não extrai datas/free time — os campos ficam vazios (pendentes), nunca
  // inventados a partir de um número de contêiner sozinho.
  assert.deepEqual(proc.containers[0].fields, []);
});
