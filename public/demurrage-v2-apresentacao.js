/**
 * D13 — camada de apresentação PURA da Demurrage Operacional (V2).
 *
 * Módulo UMD, sem DOM, sem React, carregável no navegador (`window.DemurrageV2`)
 * e via `require()` em Node (testes `node:test`, sem CDN nem navegador real).
 *
 * REGRA DE OURO (D13, seção "Autoridade dos dados"): este arquivo só TRADUZ e
 * FORMATA o que o backend `/api/demurrage/v2` já decidiu. Nenhuma função aqui:
 *   - decide estado ou prioridade;
 *   - escolhe o contêiner líder;
 *   - reordena a fila;
 *   - soma valores monetários (de contêineres, de moedas ou de lados);
 *   - converte `subtotalConhecido` (string decimal exata) para `Number`;
 *   - recalcula relógio, Free Time, dias de demurrage ou faixa tarifária;
 *   - infere um dado que o backend não mandou;
 *   - funde o relógio do cliente com o da Rocket num "status geral".
 *
 * Guarda estática (verificada por teste, `demurrageV2Apresentacao.test.ts`):
 * este arquivo nunca usa `sort`, `reduce`, `Number` ou `parseFloat`/`parseInt`
 * como OPERAÇÃO (nem no array da fila, nem em texto monetário), nem o nome de
 * nenhuma função de cálculo do motor (faixas,
 * relógios, moeda exata) — ver a lista completa no teste.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // Idempotente (mesmo padrão de `priora-bus.js`): carregado só pelo
    // `<helmet>` de `DemurrageOperacional.dc.html`; se algum dia for incluído
    // de novo, a primeira instância é mantida — nunca duas cópias concorrentes.
    root.DemurrageV2 = root.DemurrageV2 || factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================== *
   * 1) Tabela HTTP status/código → texto fixo (seção 5 do diagnóstico).
   *    Nenhum texto do servidor é exibido — nem em erro inesperado (5xx).
   * ================================================================== */

  var TEXTO_GENERICO_ERRO = 'Não foi possível carregar. Tentar novamente.';

  /**
   * Classifica uma resposta HTTP de erro em uma ação de UI fixa. `corpo` é o
   * JSON (se houver) — só o campo `error` é usado, e só para ESCOLHER a
   * mensagem fixa (nunca exibido literalmente).
   */
  function classificarErro(status, corpo) {
    var codigo = corpo && typeof corpo.error === 'string' ? corpo.error : null;

    if (status === 401) {
      return { acao: 'sessao_encerrada', mensagem: 'Sua sessão encerrou. Entre novamente para continuar.', codigo: codigo };
    }
    if (status === 403) {
      return { acao: 'acesso_restrito', mensagem: 'Acesso restrito à equipe interna.', codigo: codigo };
    }
    if (status === 409 && codigo === 'organizacao_ambigua') {
      return {
        acao: 'organizacao_ambigua',
        mensagem: 'Seu usuário pertence a mais de uma organização; a seleção de organização ainda não está disponível. Fale com o administrador.',
        codigo: codigo,
      };
    }
    if (status === 409 && codigo === 'ordem_alterada') {
      return { acao: 'reiniciar_fila', mensagem: 'A fila mudou desde a última página. Recarregamos a partir do início.', codigo: codigo };
    }
    if (status === 400 && codigo === 'cursor_invalido') {
      return { acao: 'reiniciar_fila', mensagem: 'Não foi possível continuar de onde você estava. Recarregamos a partir do início.', codigo: codigo };
    }
    if (status === 400 && (codigo === 'valor_invalido' || codigo === 'parametro_nao_aceito')) {
      return { acao: 'filtro_invalido', mensagem: 'Filtro inválido. Voltamos ao padrão.', codigo: codigo };
    }
    if (status === 404) {
      return { acao: 'nao_encontrado', mensagem: 'Não encontrado ou sem acesso.', codigo: codigo };
    }
    // 5xx, rede, tempo excedido, ou qualquer outra coisa — NUNCA o texto do servidor
    // (mesmo que `corpo.error` contenha uma stack trace: só a mensagem genérica).
    return { acao: 'retry', mensagem: TEXTO_GENERICO_ERRO, codigo: codigo };
  }

  /* ================================================================== *
   * 2) Envelope financeiro (seção 9 do diagnóstico).
   * ================================================================== */

  var ROTULO_SITUACAO = {
    CONFIRMADO: 'Confirmado',
    ESTIMADO: 'Estimado',
    ESTIMADO_PROVISORIO: 'Estimativa provisória — sujeita à confirmação',
    PENDENTE: 'Pendente de cálculo',
    NAO_APLICAVEL: 'Sem demurrage',
    // INDISPONIVEL depende do lado — ver rotuloSituacaoValor.
  };

  /**
   * Rótulo textual da situação de um envelope de valor (`ValorEnvelope.situacao`).
   * `lado` é `'cliente'` ou `'rocket'` — só muda o texto de INDISPONIVEL
   * (Cap. 24.3: "exposição ao armador", nunca "valor", do lado Rocket).
   */
  function rotuloSituacaoValor(situacao, lado) {
    if (situacao === 'INDISPONIVEL') {
      return lado === 'rocket' ? 'Exposição ao armador ainda não disponível' : 'Valor ainda não disponível';
    }
    return ROTULO_SITUACAO[situacao] || String(situacao);
  }

  /**
   * Formata um número JÁ NUMÉRICO (vindo do JSON da API — nunca uma string
   * decimal) com separador de milhar brasileiro, SEM `Number()`/`parseFloat()`
   * (o valor já é `typeof 'number'`; aqui só agrupamos os dígitos).
   */
  function formatarNumeroBr(n) {
    var negativo = n < 0;
    var abs = negativo ? -n : n;
    var partes = abs.toFixed(2).split('.');
    var inteiro = partes[0];
    var centavos = partes[1];
    var comPontos = '';
    var contador = 0;
    for (var i = inteiro.length - 1; i >= 0; i--) {
      comPontos = inteiro.charAt(i) + comPontos;
      contador++;
      if (contador % 3 === 0 && i > 0) comPontos = '.' + comPontos;
    }
    return (negativo ? '-' : '') + comPontos + ',' + centavos;
  }

  /**
   * Envelope → view-model de exibição: `{ situacao, rotulo, textoValor }`.
   * `textoValor` é `null` sempre que `total === null` — NUNCA "0", "—" como
   * valor numérico fabricado, nem conversão de moeda. `total` já chega como
   * `number` do JSON (não é convertido aqui; só formatado).
   */
  function formatarEnvelope(envelope, lado) {
    if (!envelope) return { situacao: 'PENDENTE', rotulo: rotuloSituacaoValor('PENDENTE', lado), textoValor: null };
    var textoValor = null;
    if (envelope.total !== null && envelope.total !== undefined && envelope.moeda) {
      textoValor = envelope.moeda + ' ' + formatarNumeroBr(envelope.total);
    }
    return { situacao: envelope.situacao, rotulo: rotuloSituacaoValor(envelope.situacao, lado), textoValor: textoValor };
  }

  var SIMBOLO_MOEDA = { BRL: 'R$', USD: 'US$', EUR: '€' };

  /** Código ISO da moeda → símbolo de exibição (o mesmo do módulo V1); moeda desconhecida sai como o código. */
  function simboloMoeda(codigo) {
    return SIMBOLO_MOEDA[codigo] || String(codigo);
  }

  var RE_DECIMAL_EXATO = /^(-?)(\d+)(?:\.(\d+))?$/;

  /**
   * String decimal EXATA do backend ("2400.00", "60.06") → formato brasileiro
   * ("2.400,00", "60,06") SÓ por manipulação de texto: os dígitos de entrada
   * são exatamente os dígitos de saída — nenhum `Number()`, nenhum
   * arredondamento, nenhuma perda de casa. Formato inesperado sai como veio
   * (nunca inventa um número).
   */
  function formatarDecimalExatoBr(texto) {
    var s = String(texto);
    var m = RE_DECIMAL_EXATO.exec(s);
    if (!m) return s;
    var inteiro = m[2];
    var comPontos = '';
    var contador = 0;
    for (var i = inteiro.length - 1; i >= 0; i--) {
      comPontos = inteiro.charAt(i) + comPontos;
      contador++;
      if (contador % 3 === 0 && i > 0) comPontos = '.' + comPontos;
    }
    return m[1] + comPontos + (m[3] !== undefined ? ',' + m[3] : '');
  }

  /** Composição de status de UM grupo de moeda, com as contagens que o próprio grupo trouxe (nunca somadas entre grupos). */
  function statusDoGrupo(grupo) {
    var partes = [];
    if (grupo.confirmados) partes.push(grupo.confirmados + (grupo.confirmados === 1 ? ' confirmado' : ' confirmados'));
    if (grupo.estimados) partes.push(grupo.estimados + (grupo.estimados === 1 ? ' estimado' : ' estimados'));
    if (grupo.estimativasProvisorias) partes.push(grupo.estimativasProvisorias + (grupo.estimativasProvisorias === 1 ? ' estimativa provisória' : ' estimativas provisórias'));
    return partes.join(' · ');
  }

  /**
   * Grupo financeiro por moeda (`GrupoFinanceiroPorMoeda`) → texto de exibição.
   * `subtotalConhecido` é a STRING DECIMAL EXATA do backend ("60.06") — nunca
   * passa por `Number()`/`parseFloat()` aqui: `subtotalExato` é a própria
   * string, e `texto` é ela reformatada só como texto ("US$ 60,06").
   */
  function formatarGrupoFinanceiro(grupo) {
    return {
      moeda: grupo.moeda,
      subtotalExato: grupo.subtotalConhecido,
      texto: simboloMoeda(grupo.moeda) + ' ' + formatarDecimalExatoBr(grupo.subtotalConhecido),
      statusTexto: statusDoGrupo(grupo),
      confirmados: grupo.confirmados,
      estimados: grupo.estimados,
      estimativasProvisorias: grupo.estimativasProvisorias,
    };
  }

  /**
   * Linhas de situação de um lado — o que NÃO entrou em nenhum subtotal
   * (pendente/indisponível/sem demurrage), cada categoria com a contagem que
   * o backend mandou. Nunca vira "0" nem um valor.
   */
  function linhasStatusLado(lado, ladoNome) {
    var linhas = [];
    if (lado.pendentes) linhas.push(lado.pendentes + (lado.pendentes === 1 ? ' contêiner pendente de cálculo' : ' contêineres pendentes de cálculo'));
    if (lado.indisponiveis) {
      var txt = ladoNome === 'rocket' ? ' sem exposição disponível' : ' sem valor disponível';
      linhas.push(lado.indisponiveis + (lado.indisponiveis === 1 ? ' contêiner' : ' contêineres') + txt);
    }
    return linhas;
  }

  /**
   * `AgregadoFinanceiroLado` → view-model. Cada moeda sai como uma linha
   * SEPARADA (nunca somadas entre si); `completo` é repassado como veio —
   * esta função não recalcula completude. `situacaoSemValor` só é preenchido
   * quando não há NENHUM grupo de moeda (para o cartão nunca mostrar um
   * número que não existe).
   */
  function formatarAgregadoLado(lado, ladoNome) {
    if (!lado) return { grupos: [], pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true, linhasStatus: [], situacaoSemValor: null };
    var grupos = [];
    for (var i = 0; i < lado.gruposPorMoeda.length; i++) grupos.push(formatarGrupoFinanceiro(lado.gruposPorMoeda[i]));
    var situacaoSemValor = null;
    if (!grupos.length) {
      if (lado.pendentes) situacaoSemValor = 'Pendente de cálculo';
      else if (lado.indisponiveis) situacaoSemValor = ladoNome === 'rocket' ? 'Exposição ao armador ainda não disponível' : 'Valor ainda não disponível';
      else if (lado.semAplicacao) situacaoSemValor = 'Sem demurrage';
      else situacaoSemValor = 'Sem valor apurado';
    }
    return {
      grupos: grupos,
      pendentes: lado.pendentes,
      indisponiveis: lado.indisponiveis,
      semAplicacao: lado.semAplicacao,
      completo: lado.completo,
      linhasStatus: linhasStatusLado(lado, ladoNome),
      situacaoSemValor: situacaoSemValor,
    };
  }

  function formatarAgregadoFinanceiro(agregado) {
    if (!agregado) return { cliente: formatarAgregadoLado(null, 'cliente'), rocket: formatarAgregadoLado(null, 'rocket') };
    return { cliente: formatarAgregadoLado(agregado.cliente, 'cliente'), rocket: formatarAgregadoLado(agregado.rocket, 'rocket') };
  }

  /* ================================================================== *
   * 3) Datas e instantes (seção 9 do diagnóstico).
   *
   *    `CivilDate` ("AAAA-MM-DD") NUNCA passa por `Date` nem por conversão de
   *    fuso — só corte de string (ela já representa um dia civil, sem hora).
   *    Instantes ISO (TIMESTAMPTZ) usam `Date` só para apresentação em
   *    horário local e tempo relativo — nunca para calcular Free Time, dias
   *    de demurrage ou qualquer prazo do Blueprint (isso é feito só pelo
   *    motor temporal, no backend).
   * ================================================================== */

  var RE_DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

  /** "AAAA-MM-DD" → "DD/MM/AAAA". Corte de string pura; `null`/formato inválido → null. */
  function formatarDataCivil(civilDate) {
    if (!civilDate) return null;
    var m = RE_DATA_CIVIL.exec(String(civilDate));
    if (!m) return null;
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  /** Instante ISO → "DD/MM/AAAA HH:mm" em horário LOCAL do navegador. */
  function formatarInstante(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var dia = String(d.getDate()).padStart(2, '0');
    var mes = String(d.getMonth() + 1).padStart(2, '0');
    var ano = d.getFullYear();
    var hora = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return dia + '/' + mes + '/' + ano + ' ' + hora + ':' + min;
  }

  /**
   * Tempo relativo ("há 3 h") de um instante ISO até `agoraMs` (ms epoch;
   * default `Date.now()`, injetável para teste determinístico). Não é um
   * prazo do Blueprint — é só o "quando a tela buscou este dado da última
   * vez", igual ao `fmtAgo` que já existe no módulo V1 (Demurrage.dc.html).
   */
  function tempoRelativo(iso, agoraMs) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    var agora = typeof agoraMs === 'number' ? agoraMs : Date.now();
    var diffMs = agora - t;
    if (diffMs < 0) diffMs = 0;
    var minutos = Math.floor(diffMs / 60000);
    if (minutos < 1) return 'agora mesmo';
    if (minutos < 60) return 'há ' + minutos + ' min';
    var horas = Math.floor(minutos / 60);
    if (horas < 24) return 'há ' + horas + ' h';
    var dias = Math.floor(horas / 24);
    return 'há ' + dias + (dias === 1 ? ' dia' : ' dias');
  }

  /* ================================================================== *
   * 4) Relógio (seção 3/9) — cliente e Rocket SEMPRE em blocos separados;
   *    esta função nunca funde os dois nem produz um "status geral".
   * ================================================================== */

  var ROTULO_PENDENCIA_RELOGIO = {
    DESCARGA_AUSENTE: 'Aguardando descarga',
    FREE_TIME_AUSENTE: 'Free Time ausente',
  };

  function rotuloMotivoPendente(pendencias) {
    if (!pendencias || !pendencias.length) return 'Dado pendente';
    var textos = [];
    for (var i = 0; i < pendencias.length; i++) {
      textos.push(ROTULO_PENDENCIA_RELOGIO[pendencias[i]] || 'Dado pendente');
    }
    // Sem duplicar texto repetido.
    var vistos = {};
    var unicos = [];
    for (var j = 0; j < textos.length; j++) {
      if (!vistos[textos[j]]) { vistos[textos[j]] = true; unicos.push(textos[j]); }
    }
    return unicos.join(' · ');
  }

  var TITULO_RELOGIO = { cliente: 'Relógio do cliente', rocket: 'Relógio da Rocket' };

  /**
   * Mesmo vocabulário de rótulos de `EstadoOperacional` que o backend usa em
   * `leitura/contrato.ts` (`ROTULOS_ESTADO`) — duplicado aqui de propósito,
   * só o TEXTO, pelo mesmo motivo que o backend já duplica de
   * `registro/situacao.ts`: nunca importar um arquivo congelado de outra
   * fase. Usado só para rotular as OPÇÕES de filtro por estado (o código
   * em si vem de `/filtros`, nunca escolhido aqui); código desconhecido sai
   * como está.
   */
  var ROTULO_ESTADO_OPERACIONAL = {
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

  function rotuloEstadoOperacional(codigo) {
    return ROTULO_ESTADO_OPERACIONAL[codigo] || String(codigo);
  }

  var ROTULO_CACHE = {
    VALIDO: null, // nada a avisar — é o caminho normal.
    OBSOLETO: 'Cálculo desatualizado em relação aos dados atuais; será refeito pelo processamento automático.',
    AUSENTE: null,
  };

  /**
   * `RelogioLeitura` (de um lado) → view-model de apresentação. `lado` é
   * `'cliente'` ou `'rocket'` — só decide o título do bloco e o texto de
   * INDISPONIVEL; os DOIS relógios do contêiner passam por esta MESMA função,
   * cada um isoladamente (nunca com o outro como argumento).
   */
  function formatarRelogio(relogio, lado) {
    if (!relogio) {
      return {
        titulo: TITULO_RELOGIO[lado] || lado,
        statusTexto: 'Relógio pendente', statusMotivo: 'Dado pendente',
        descarga: null, freeTimeDias: null, ultimoDiaLivre: null, primeiroDiaDemurrage: null,
        dataFinalApuracao: null, dias: null, diasOperacionais: null,
        avisoCache: null, valor: formatarEnvelope(null, lado), tabela: null, prazo: null,
      };
    }
    var statusTexto = null, statusMotivo = null;
    if (relogio.status === 'PENDING') { statusTexto = 'Relógio pendente'; statusMotivo = rotuloMotivoPendente(relogio.pendencias); }
    else if (relogio.status === 'INVALID') { statusTexto = 'Cálculo inválido — requer verificação'; statusMotivo = null; }

    return {
      titulo: TITULO_RELOGIO[lado] || lado,
      statusOk: relogio.status === 'OK',
      statusTexto: statusTexto,
      statusMotivo: statusMotivo,
      descarga: {
        data: formatarDataCivil(relogio.descarga && relogio.descarga.data),
        fonte: (relogio.descarga && relogio.descarga.fonte) || null,
        observadoEm: formatarInstante(relogio.descarga && relogio.descarga.observadoEm),
      },
      freeTimeDias: relogio.freeTime ? relogio.freeTime.dias : null,
      freeTimeFonte: relogio.freeTime ? relogio.freeTime.fonte : null,
      freeTimeFallbackManual: relogio.freeTime ? relogio.freeTime.fallbackManual : null,
      ultimoDiaLivre: formatarDataCivil(relogio.ultimoDiaLivre),
      primeiroDiaDemurrage: formatarDataCivil(relogio.primeiroDiaDemurrage),
      dataFinalApuracao: formatarDataCivil(relogio.dataFinalApuracao),
      dias: relogio.dias,
      diasOperacionais: relogio.diasOperacionais,
      avisoCache: ROTULO_CACHE[relogio.cache] || null,
      valor: formatarEnvelope(relogio.valor, lado),
      tabela: relogio.tabela,
      prazo: formatarPrazoRelogio(relogio),
    };
  }

  /** Bloco de prazo (`PrazoRelogioLeitura`) → texto fixo, sem recalcular nada. */
  function formatarPrazoRelogio(relogio) {
    if (relogio.encerradoPorDevolucao) return { texto: 'Encerrado pela devolução — sem prazo futuro.', vencido: false };
    if (relogio.vencido) return { texto: 'Prazo vencido.', vencido: true };
    if (relogio.proximoMarco) {
      return {
        texto: 'Fim do Free Time em ' + formatarDataCivil(relogio.proximoMarco.data) + ' (faltam ' + relogio.proximoMarco.diasRestantes + ' dia(s)).',
        vencido: false,
        emPrazoProximo: relogio.emPrazoProximo,
      };
    }
    return { texto: null, vencido: false };
  }

  /** Os DOIS relógios de um contêiner → dois view-models SEPARADOS, nunca combinados. */
  function formatarDoisRelogios(relogios) {
    return {
      cliente: formatarRelogio(relogios && relogios.cliente, 'cliente'),
      rocket: formatarRelogio(relogios && relogios.rocket, 'rocket'),
    };
  }

  /* ================================================================== *
   * 5) Badges, estado, contêiner líder (seções 2/9).
   * ================================================================== */

  var ROTULO_BADGE = {
    clienteEmDemurrage: 'Cliente em demurrage',
    rocketExposta: 'Rocket exposta',
    trackingDesatualizado: 'Tracking desatualizado',
    pendenciaDadosCliente: 'Pendência de dados do cliente',
    pendenciaDadosRocket: 'Pendência de dados da Rocket',
    escalationRequired: 'Escalada obrigatória',
    divergenciaValor: 'Divergência de valor',
    responsabilidadeEmAnalise: 'Responsabilidade em análise',
  };

  /** Código de badge → rótulo em português; código desconhecido sai como está (nunca omitido). */
  function rotuloBadge(codigo) {
    return ROTULO_BADGE[codigo] || String(codigo);
  }

  function formatarBadges(badges) {
    var out = [];
    for (var i = 0; i < (badges || []).length; i++) out.push({ codigo: badges[i], rotulo: rotuloBadge(badges[i]) });
    return out;
  }

  /**
   * `LiderLeitura` → view-model. Rótulo explícito "Contêiner líder" (U-03):
   * os valores mostrados no cartão da fila são deste contêiner, nunca um
   * total calculado no navegador — isso é dito no texto, nunca escondido.
   */
  function formatarLider(lider) {
    if (!lider) return null;
    return {
      containerId: lider.containerId,
      numero: lider.numero,
      estadoRotulo: lider.estado ? lider.estado.rotulo : null,
      balde: lider.prioridade ? lider.prioridade.balde : null,
      promocaoTopo: !!(lider.prioridade && lider.prioridade.promocaoTopo),
      motivo: lider.motivoPrioridade,
    };
  }

  /** `ProximoVencimentoLeitura` → texto único, sem recalcular a data. */
  function formatarProximoVencimento(pv) {
    if (!pv) return null;
    return {
      containerId: pv.containerId, numero: pv.numero, relogio: pv.relogio,
      texto: 'Vence em ' + formatarDataCivil(pv.data) + ' (' + TITULO_RELOGIO[pv.relogio] + ', faltam ' + pv.diasRestantes + ' dia(s))',
    };
  }

  /* ================================================================== *
   * 6) Fila — view-model de UM item, PRESERVANDO a ordem recebida. Esta
   *    função NUNCA ordena um array (nenhuma chamada a `.sort(` em todo o
   *    arquivo); quem decide a ordem é só o `itens` que chega da API.
   * ================================================================== */

  /** Um `FilaItemV1` → view-model de exibição (mesmo item, nunca reordenado). */
  function formatarItemFila(item) {
    return {
      processoId: item.processo.id,
      numeroProcesso: item.processo.numero,
      cliente: item.cliente ? item.cliente.nome : null,
      house: item.house, mbl: item.mbl,
      armador: item.armador ? item.armador.nome : null,
      responsavel: item.responsavelOperacional ? item.responsavelOperacional.nome : null,
      composicao: item.conteineres,
      estadoRotulo: item.estadoMaisRelevante ? item.estadoMaisRelevante.rotulo : null,
      balde: item.prioridade ? item.prioridade.balde : null,
      promocaoTopo: !!(item.prioridade && item.prioridade.promocaoTopo),
      motivo: item.motivoPrioridade,
      lider: formatarLider(item.lider),
      badges: formatarBadges(item.badges),
      pendenciasTotal: item.pendenciasAbertas ? item.pendenciasAbertas.total : 0,
      falhasTotal: item.falhasTecnicas ? item.falhasTecnicas.total : 0,
      trackingAtualizadoEm: formatarInstante(item.trackingAtualizadoEm),
      ultimaAtualizacao: formatarInstante(item.ultimaAtualizacao),
      // Compatibilidade (envelope do líder) — rotulado "Contêiner líder" no módulo.
      valorClienteLider: formatarEnvelope(item.exposicaoFinanceira ? item.exposicaoFinanceira.valorCliente : null, 'cliente'),
      exposicaoRocketLider: formatarEnvelope(item.exposicaoFinanceira ? item.exposicaoFinanceira.exposicaoRocket : null, 'rocket'),
      // DV-01: agregado do PROCESSO inteiro, por lado e moeda — nunca somado aqui.
      agregadoFinanceiro: formatarAgregadoFinanceiro(item.agregadoFinanceiro),
      proximoVencimento: formatarProximoVencimento(item.proximoVencimento),
      // Linha de referências do cartão (só o que veio; ausente = omitido, nunca inventado).
      referencias: referenciasDoItem(item),
      composicaoTexto: textoComposicao(item.conteineres),
      secao: secaoDoBalde(item.prioridade ? item.prioridade.balde : null),
      trackingRelativo: item.trackingAtualizadoEm || null,
      derivadoRelativo: item.ultimaAtualizacao || null,
    };
  }

  function referenciasDoItem(item) {
    var refs = [];
    if (item.house) refs.push('HBL ' + item.house);
    if (item.mbl) refs.push('MBL ' + item.mbl);
    if (item.armador && item.armador.nome) refs.push(item.armador.nome);
    if (item.responsavelOperacional && item.responsavelOperacional.nome) refs.push('Resp.: ' + item.responsavelOperacional.nome);
    return refs;
  }

  /** `ComposicaoContainers` → texto, usando só as contagens que o backend já consolidou. */
  function textoComposicao(c) {
    if (!c || !c.total) return 'Nenhum contêiner derivado';
    var partes = [c.total + (c.total === 1 ? ' contêiner' : ' contêineres')];
    if (c.emDemurrage) partes.push(c.emDemurrage + ' em demurrage');
    if (c.devolvidos) partes.push(c.devolvidos + (c.devolvidos === 1 ? ' devolvido' : ' devolvidos'));
    if (c.comPendencia) partes.push(c.comPendencia + ' com pendência');
    return partes.join(' · ');
  }

  /**
   * Lista de itens da fila → lista de view-models, NA MESMA ORDEM e com o
   * MESMO TAMANHO do array recebido (requisito G2: "render na ordem da API").
   */
  function prepararItensFila(itens) {
    var out = [];
    for (var i = 0; i < (itens || []).length; i++) out.push(formatarItemFila(itens[i]));
    return out;
  }

  /* ================================================================== *
   * 6b) Painel no estilo da tela Demurrage original — grupos visuais por
   *     urgência. O grupo é um RÓTULO do balde OFICIAL que o backend já
   *     decidiu (`prioridade.balde`, Cap. 22), nunca uma regra nova; e a
   *     montagem PROVA que preserva a ordem recebida (ver
   *     `montarSecoesFila`).
   * ================================================================== */

  var SECAO_DO_BALDE = {
    CRITICA_15: 'demurrage', CRITICA_7_14: 'demurrage', ATENCAO_1_6: 'demurrage',
    DEVOLVIDO_TRATAMENTO: 'devolvidos',
    PRAZO_PREVENTIVO: 'prazo',
    SILENCIOSO: 'monitoramento',
  };

  /** Ordem das seções = ordem dos baldes do Cap. 22 (a mesma que o backend usa para ordenar a fila). */
  var ORDEM_SECOES = ['demurrage', 'devolvidos', 'prazo', 'monitoramento'];

  var METADADOS_SECAO = {
    demurrage: { titulo: 'Em demurrage', dica: 'Cliente ou Rocket já acumulando custo.', vazio: 'Nenhum processo em demurrage no momento.', sempreVisivel: true },
    devolvidos: { titulo: 'Devolvidos — aguardando tratamento', dica: 'Empty Return registrado; custo ou responsabilidade a tratar.', vazio: 'Nenhum contêiner devolvido aguardando tratamento.', sempreVisivel: true },
    prazo: { titulo: 'Risco iminente', dica: 'Free Time terminando — ainda sem custo.', vazio: 'Nenhum Free Time terminando agora.', sempreVisivel: true },
    monitoramento: { titulo: 'Monitoramento', dica: 'Sem urgência ou ainda sem contêiner derivado.', vazio: '', sempreVisivel: false },
    fila: { titulo: 'Fila operacional', dica: 'Na ordem oficial do backend.', vazio: 'Nenhum processo.', sempreVisivel: true },
  };

  /** Balde oficial → chave da seção visual (desconhecido → monitoramento, nunca descartado). */
  function secaoDoBalde(balde) {
    return SECAO_DO_BALDE[balde] || 'monitoramento';
  }

  /**
   * View-models da fila (já na ordem da API) → seções visuais. NÃO ordena:
   * cada item é só colocado na seção do seu balde, mantendo a ordem relativa.
   * Em seguida VERIFICA que ler as seções de cima para baixo dá exatamente a
   * sequência recebida (o backend ordena primeiro pelo balde, então isso
   * vale sempre). Se um dia não valer, devolve UMA seção única na ordem
   * recebida (`preservaOrdem: false`) — a tela nunca reordena para caber
   * nos grupos.
   */
  function montarSecoesFila(vms) {
    var lista = vms || [];
    var porSecao = { demurrage: [], devolvidos: [], prazo: [], monitoramento: [] };
    for (var i = 0; i < lista.length; i++) porSecao[lista[i].secao || secaoDoBalde(lista[i].balde)].push(lista[i]);

    var secoes = [];
    for (var j = 0; j < ORDEM_SECOES.length; j++) {
      var chave = ORDEM_SECOES[j];
      if (porSecao[chave].length || METADADOS_SECAO[chave].sempreVisivel) {
        secoes.push(Object.assign({ chave: chave, itens: porSecao[chave] }, METADADOS_SECAO[chave]));
      }
    }

    var lidaDeCimaParaBaixo = [];
    for (var k = 0; k < secoes.length; k++) {
      for (var n = 0; n < secoes[k].itens.length; n++) lidaDeCimaParaBaixo.push(secoes[k].itens[n].processoId);
    }
    var preserva = lidaDeCimaParaBaixo.length === lista.length;
    for (var m = 0; preserva && m < lista.length; m++) {
      if (lidaDeCimaParaBaixo[m] !== lista[m].processoId) preserva = false;
    }
    if (!preserva) {
      return { preservaOrdem: false, secoes: [Object.assign({ chave: 'fila', itens: lista.slice() }, METADADOS_SECAO.fila)] };
    }
    return { preservaOrdem: true, secoes: secoes };
  }

  /**
   * "Maior risco atual" = o PRIMEIRO item da fila oficial. Quem decide isso
   * é a ordem do backend (Cap. 22); aqui não há comparação nenhuma.
   */
  function primeiroDaFila(vms) {
    return vms && vms.length ? vms[0] : null;
  }

  /**
   * Consultas de CONTAGEM dos indicadores do topo — cada uma é a própria
   * fila oficial com um filtro já existente da D12 e `limite=1` (só o
   * `total` é lido). Sem filtros do usuário: os indicadores são a visão
   * geral da organização. Custo constante por consulta (D12 v1.2).
   */
  function consultasIndicadores() {
    return {
      emDemurrage: construirQueryFila(Object.assign(filtrosPadrao(), { emDemurrage: true }), { limite: 1 }),
      comPendencia: construirQueryFila(Object.assign(filtrosPadrao(), { comPendencia: true }), { limite: 1 }),
      comFalhaTecnica: construirQueryFila(Object.assign(filtrosPadrao(), { comFalhaTecnica: true }), { limite: 1 }),
    };
  }

  /** Contagem do balde em `/filtros` (contarEstadosEBaldes da D12): lida, nunca somada. Sem `/filtros` → null. */
  function totalDoBalde(opcoesFiltros, codigo) {
    if (!opcoesFiltros || !opcoesFiltros.baldes) return null;
    for (var i = 0; i < opcoesFiltros.baldes.length; i++) {
      if (opcoesFiltros.baldes[i].codigo === codigo) return opcoesFiltros.baldes[i].total;
    }
    return 0; // o backend só lista baldes com ao menos um processo.
  }

  function textoContagem(n) {
    return n === null || n === undefined ? '—' : String(n);
  }

  /**
   * Indicadores do topo (cartões de KPI da tela original). Cada número vem
   * de UMA resposta da D12 — contagem de processos, nunca valor monetário,
   * nunca uma soma feita aqui. Contagem que não chegou (falha da consulta)
   * fica `null` e é exibida como "—" com aviso: nunca "0".
   *
   * Não existe indicador de "impacto total": o contrato D12 não consolida
   * valores da fila inteira e a soma no navegador misturaria moedas e
   * situações (estimado × confirmado) — decisão DV-06 do diagnóstico.
   */
  function montarIndicadores(opcoesFiltros, contagens) {
    var c = contagens || {};
    var b15 = totalDoBalde(opcoesFiltros, 'CRITICA_15');
    var b714 = totalDoBalde(opcoesFiltros, 'CRITICA_7_14');
    var b16 = totalDoBalde(opcoesFiltros, 'ATENCAO_1_6');
    var emDem = c.emDemurrage === undefined ? null : c.emDemurrage;
    var pend = c.comPendencia === undefined ? null : c.comPendencia;
    var falha = c.comFalhaTecnica === undefined ? null : c.comFalhaTecnica;
    var prazo = totalDoBalde(opcoesFiltros, 'PRAZO_PREVENTIVO');
    var dev = totalDoBalde(opcoesFiltros, 'DEVOLVIDO_TRATAMENTO');
    return [
      {
        chave: 'demurrage', tema: 'demurrage', rotulo: 'Processos em demurrage', valor: emDem, valorTexto: textoContagem(emDem),
        sub: b15 === null ? 'Contêiner do cliente ou da Rocket já em demurrage' : ('Crítico 15+: ' + b15 + ' · 7–14: ' + textoContagem(b714) + ' · 1–6: ' + textoContagem(b16)),
        indisponivel: emDem === null,
      },
      {
        chave: 'prazo', tema: 'prazo', rotulo: 'Free Time terminando', valor: prazo, valorTexto: textoContagem(prazo),
        sub: 'Prazo próximo — ainda sem custo', indisponivel: prazo === null,
      },
      {
        chave: 'pendencias', tema: 'neutro', rotulo: 'Pendências de informação', valor: pend, valorTexto: textoContagem(pend),
        sub: falha === null ? 'Dados faltando ou divergentes' : (falha + (falha === 1 ? ' processo com falha técnica' : ' processos com falha técnica')),
        indisponivel: pend === null,
      },
      {
        chave: 'devolvidos', tema: 'neutro', rotulo: 'Devolvidos em tratamento', valor: dev, valorTexto: textoContagem(dev),
        sub: 'Empty Return com custo ou responsabilidade a tratar', indisponivel: dev === null,
      },
    ];
  }

  var LINHAS_RESUMO = [
    { codigo: 'CRITICA_15', rotulo: 'Crítico — 15 dias ou mais', tema: 'demurrage' },
    { codigo: 'CRITICA_7_14', rotulo: 'Crítico — 7 a 14 dias', tema: 'demurrage' },
    { codigo: 'ATENCAO_1_6', rotulo: 'Atenção — 1 a 6 dias', tema: 'prazo' },
    { codigo: 'DEVOLVIDO_TRATAMENTO', rotulo: 'Devolvidos — tratamento', tema: 'neutro' },
    { codigo: 'PRAZO_PREVENTIVO', rotulo: 'Prazo preventivo', tema: 'prazo' },
    { codigo: 'SILENCIOSO', rotulo: 'Monitoramento silencioso', tema: 'cinza' },
  ];

  /** "Resumo geral" da coluna direita: uma linha por balde oficial, com a contagem de `/filtros` (nenhuma soma). */
  function montarResumoOperacional(opcoesFiltros) {
    var out = [];
    for (var i = 0; i < LINHAS_RESUMO.length; i++) {
      var l = LINHAS_RESUMO[i];
      out.push({ codigo: l.codigo, rotulo: l.rotulo, tema: l.tema, total: totalDoBalde(opcoesFiltros, l.codigo), totalTexto: textoContagem(totalDoBalde(opcoesFiltros, l.codigo)) });
    }
    return out;
  }

  /** Quantidade de filtros ativos (mesmo critério da D13 original), para o botão "Filtros (N ativos)". */
  function contarFiltrosAtivos(filtros) {
    var f = filtros || {};
    var campos = ['responsavel', 'cliente', 'armador', 'estado', 'prioridade', 'comPendencia', 'comFalhaTecnica', 'dentroDoFreeTime', 'emDemurrage', 'devolvido', 'responsabilidadeEmAnalise', 'exposicaoIndisponivel', 'busca'];
    var n = 0;
    for (var i = 0; i < campos.length; i++) if (f[campos[i]]) n++;
    if (f.periodoInicio && f.periodoFim) n++;
    return n;
  }

  /** Estado inicial do painel de filtros: SEMPRE recolhido — a fila aparece primeiro (correção D13). */
  function estadoInicialPainelFiltros() {
    return false;
  }

  /* ================================================================== *
   * 7) Detalhe de processo e de contêiner.
   * ================================================================== */

  function formatarContainerResumo(c) {
    return {
      containerId: c.containerId, numero: c.numero,
      estadoRotulo: c.estado ? c.estado.rotulo : null,
      badges: formatarBadges(c.badges),
      documentaryStatus: c.documentaryStatus,
      relogios: formatarDoisRelogios(c.relogios),
      emptyReturn: formatarDataCivil(c.emptyReturn),
      gateOut: formatarDataCivil(c.gateOut),
      trackingAtualizadoEm: formatarInstante(c.trackingAtualizadoEm),
      falhaTrackingAtiva: !!c.falhaTrackingAtiva,
      minutas: (c.minutas || []).map(function (m) {
        return {
          id: m.id, estado: m.estado, numeroInformado: m.numeroInformado,
          dataInformada: formatarDataCivil(m.dataInformada), dataValidada: formatarDataCivil(m.dataValidada),
          divergenteDoTracking: !!m.divergenteDoTracking, motivoRejeicao: m.motivoRejeicao,
          criadoEm: formatarInstante(m.criadoEm),
        };
      }),
      // Bloco "Informação interna" — SÓ aqui, nunca na fila (requisito G4).
      responsabilidade: formatarResponsabilidade(c.interno && c.interno.responsabilidade),
    };
  }

  var ROTULO_RESPONSABILIDADE = {
    NAO_APLICAVEL: 'Sem demurrage',
    EM_ANALISE: 'Em análise',
    CONFIRMADA_ROCKET: 'Confirmada — Rocket',
    CONFIRMADA_CLIENTE: 'Confirmada — Cliente',
    DIVIDIDA: 'Dividida entre Rocket e Cliente',
  };

  function formatarResponsabilidade(resp) {
    if (!resp) return null;
    return {
      estadoRotulo: ROTULO_RESPONSABILIDADE[resp.estadoDerivado] || String(resp.estadoDerivado),
      decisaoVigente: resp.decisaoVigente ? {
        versao: resp.decisaoVigente.versao, status: resp.decisaoVigente.status,
        diasRocket: resp.decisaoVigente.diasRocket, diasCliente: resp.decisaoVigente.diasCliente,
        valorRocketTexto: formatarMoedaNumero(resp.decisaoVigente.valorRocket, resp.decisaoVigente.moeda),
        valorClienteTexto: formatarMoedaNumero(resp.decisaoVigente.valorCliente, resp.decisaoVigente.moeda),
        justificativa: resp.decisaoVigente.justificativa,
        autor: resp.decisaoVigente.autor ? resp.decisaoVigente.autor.nome : null,
        decididoEm: formatarInstante(resp.decisaoVigente.decididoEm),
      } : null,
      invalidada: resp.invalidada ? { motivo: resp.invalidada.motivo, em: formatarInstante(resp.invalidada.em) } : null,
      historico: (resp.historico || []).map(function (h) { return { versao: h.versao, status: h.status, decididoEm: formatarInstante(h.decididoEm) }; }),
    };
  }

  /** `number|null` (já numérico, da D11) + moeda → texto; `null` nunca vira "0". */
  function formatarMoedaNumero(valor, moeda) {
    if (valor === null || valor === undefined || !moeda) return null;
    return moeda + ' ' + formatarNumeroBr(valor);
  }

  function formatarProcessoDetalhe(p) {
    if (!p) return null;
    var containers = (p.conteineres || []).map(formatarContainerResumo);
    return {
      processoId: p.processoId, numeroProcesso: p.numeroProcesso,
      cliente: p.cliente ? p.cliente.nome : null, house: p.house, mbl: p.mbl,
      armador: p.armador ? p.armador.nome : null,
      responsavel: p.responsavelOperacional ? p.responsavelOperacional.nome : null,
      apuracaoStatus: p.apuracaoStatus, fechadoEm: formatarInstante(p.fechadoEm),
      estadoRotulo: p.estadoMaisRelevante ? p.estadoMaisRelevante.rotulo : null,
      balde: p.prioridade ? p.prioridade.balde : null,
      promocaoTopo: !!(p.prioridade && p.prioridade.promocaoTopo),
      motivo: p.motivoPrioridade,
      lider: formatarLider(p.lider),
      containers: containers,
      composicao: p.composicao,
      pendenciasTotal: p.pendenciasAbertas ? p.pendenciasAbertas.total : 0,
      falhasTotal: p.falhasTecnicas ? p.falhasTecnicas.total : 0,
      agregadoFinanceiro: formatarAgregadoFinanceiro(p.agregadoFinanceiro),
      proximoVencimento: formatarProximoVencimento(p.proximoVencimento),
      fechamento: p.fechamento ? { justificativa: p.fechamento.justificativa, em: formatarInstante(p.fechamento.em) } : null,
      reaberturas: (p.reaberturas || []).map(function (r) { return { id: r.id, estado: r.estado, justificativa: r.justificativa, criadoEm: formatarInstante(r.criadoEm) }; }),
    };
  }

  function formatarContainerDetalhe(c) {
    if (!c) return null;
    return formatarContainerResumo(c);
  }

  /* ================================================================== *
   * 8) Timeline — só os campos seguros do contrato (seção 9/5). Nunca
   *    inspeciona `payload`, `erro`, `raw_ref` ou qualquer campo fora desta
   *    lista fechada, mesmo que o objeto de entrada tenha outros campos.
   * ================================================================== */

  var ROTULO_ORIGEM_EVENTO = { automatico: 'Automático', humano: 'Humano' };

  var PREFIXO_TIPO_LABEL = [
    { re: /^tracking_/, rotulo: 'Evento de tracking' },
    { re: /^observacao_/, rotulo: 'Observação de campo' },
    { re: /^vessel_call_vinculo_/, rotulo: 'Vínculo de VesselCall' },
    { re: /^vessel_call_/, rotulo: 'Evento de VesselCall' },
    { re: /^falha_/, rotulo: 'Falha técnica' },
    { re: /^free_time_/, rotulo: 'Free Time' },
  ];

  var ROTULO_TIPO_EVENTO = {
    EMPTY_RETURN: 'Empty Return registrado',
    MINUTA_RECEBIDA: 'Minuta recebida',
    MINUTA_VALIDADA: 'Minuta validada',
    MINUTA_REJEITADA: 'Minuta rejeitada',
    DIVERGENCIA_TRACKING_MINUTA: 'Divergência entre tracking e minuta',
    RECALCULO: 'Recálculo da apuração',
    FECHAMENTO_FINAL: 'Processo fechado (FINAL)',
    REABERTURA_SOLICITADA: 'Reabertura solicitada',
    REABERTURA_AUTORIZADA: 'Reabertura autorizada',
    REABERTURA: 'Processo reaberto',
    REFECHAMENTO: 'Processo refechado',
    RESPONSABILIDADE_CONFIRMADA: 'Responsabilidade confirmada',
    RESPONSABILIDADE_CORRIGIDA: 'Responsabilidade corrigida',
    RESPONSABILIDADE_INVALIDADA: 'Decisão de responsabilidade invalidada',
    tracking_consulta: 'Consulta de tracking',
  };

  /** Rótulo de `tipo` do evento: exato se conhecido, por prefixo se reconhecido, senão o próprio código (nunca omitido). */
  function rotuloTipoEvento(tipo) {
    if (ROTULO_TIPO_EVENTO[tipo]) return ROTULO_TIPO_EVENTO[tipo];
    for (var i = 0; i < PREFIXO_TIPO_LABEL.length; i++) {
      if (PREFIXO_TIPO_LABEL[i].re.test(tipo)) return PREFIXO_TIPO_LABEL[i].rotulo;
    }
    return String(tipo);
  }

  /**
   * `EventoTimelineV1` (bruto) → view-model com SOMENTE os campos permitidos
   * (seção 9): resumo, tipo rotulado, dataOperacional, registradoEm, origem,
   * fonte, autor.nome, evidenciaRef, containerId/escopo. Qualquer outro campo
   * presente no objeto de entrada (ex.: `payload`, `erro`) é ignorado — nunca
   * repassado ao view-model, mesmo que exista.
   */
  function prepararEventoTimeline(evento) {
    return {
      tipo: evento.tipo, tipoRotulo: rotuloTipoEvento(evento.tipo),
      dataOperacional: formatarDataCivil(evento.dataOperacional),
      registradoEm: formatarInstante(evento.registradoEm),
      origem: evento.origem, origemRotulo: ROTULO_ORIGEM_EVENTO[evento.origem] || String(evento.origem),
      fonte: evento.fonte,
      autorNome: evento.autor ? evento.autor.nome : null,
      evidenciaRef: evento.evidenciaRef,
      containerId: evento.containerId,
      escopo: evento.escopo,
      resumo: evento.resumo,
    };
  }

  function prepararEventosTimeline(eventos) {
    var out = [];
    for (var i = 0; i < (eventos || []).length; i++) out.push(prepararEventoTimeline(eventos[i]));
    return out;
  }

  /* ================================================================== *
   * 9) Filtros da fila — 15 campos (seção 6 do diagnóstico), nomes de
   *    parâmetro EXATOS de `leitura/filtros.ts` (`normalizarFiltrosFila`).
   *    Esta função só monta a query string; a validação/tradução para SQL
   *    é inteiramente do backend.
   * ================================================================== */

  function filtrosPadrao() {
    return {
      responsavel: null, cliente: null, armador: null, estado: null, prioridade: null,
      comPendencia: null, comFalhaTecnica: null, dentroDoFreeTime: null, emDemurrage: null,
      devolvido: null, responsabilidadeEmAnalise: null, exposicaoIndisponivel: null,
      periodoCampo: 'descarga', periodoInicio: null, periodoFim: null,
      busca: null, incluirSilenciosos: false,
    };
  }

  var CAMPOS_BOOLEANOS_FILTRO = [
    'comPendencia', 'comFalhaTecnica', 'dentroDoFreeTime', 'emDemurrage',
    'devolvido', 'responsabilidadeEmAnalise', 'exposicaoIndisponivel',
  ];

  /** Ordem FIXA e explícita dos parâmetros na query string — nunca `.sort()` (guarda estática, G2/16). */
  var ORDEM_PARAMETROS_FILA = [
    'responsavel', 'cliente', 'armador', 'estado', 'prioridade',
    'comPendencia', 'comFalhaTecnica', 'dentroDoFreeTime', 'emDemurrage', 'devolvido',
    'responsabilidadeEmAnalise', 'exposicaoIndisponivel',
    'periodoCampo', 'periodoInicio', 'periodoFim', 'busca', 'incluirSilenciosos',
    'limite', 'cursor',
  ];

  /** Mesma ordem fixa, para a chave de comparação de `chaveFiltros` (todos os campos do filtro, sem `limite`/`cursor`). */
  var ORDEM_CAMPOS_FILTRO = [
    'responsavel', 'cliente', 'armador', 'estado', 'prioridade',
    'comPendencia', 'comFalhaTecnica', 'dentroDoFreeTime', 'emDemurrage', 'devolvido',
    'responsabilidadeEmAnalise', 'exposicaoIndisponivel',
    'periodoCampo', 'periodoInicio', 'periodoFim', 'busca', 'incluirSilenciosos',
  ];

  /**
   * `FiltroFila` (estado da UI) → mapa plano de parâmetros de query string,
   * só com os campos que DIFEREM do padrão (URL limpa). Nomes idênticos aos
   * de `normalizarFiltrosFila` — nenhuma tradução nova.
   */
  function construirParametrosFila(filtros) {
    var f = Object.assign({}, filtrosPadrao(), filtros || {});
    var out = {};
    if (f.responsavel) out.responsavel = f.responsavel;
    if (f.cliente) out.cliente = f.cliente;
    if (f.armador) out.armador = f.armador;
    if (f.estado) out.estado = f.estado;
    if (f.prioridade) out.prioridade = f.prioridade;
    for (var i = 0; i < CAMPOS_BOOLEANOS_FILTRO.length; i++) {
      var campo = CAMPOS_BOOLEANOS_FILTRO[i];
      if (f[campo] === true) out[campo] = 'true';
      else if (f[campo] === false) out[campo] = 'false';
    }
    if (f.periodoCampo && f.periodoCampo !== 'descarga') out.periodoCampo = f.periodoCampo;
    if (f.periodoInicio && f.periodoFim) { out.periodoInicio = f.periodoInicio; out.periodoFim = f.periodoFim; }
    if (f.busca) out.busca = f.busca;
    if (f.incluirSilenciosos === true) out.incluirSilenciosos = 'true';
    return out;
  }

  /** Monta a query string final (sem `?`), na ordem FIXA de `ORDEM_PARAMETROS_FILA` (nunca `.sort()`). */
  function construirQueryFila(filtros, extras) {
    var params = construirParametrosFila(filtros);
    if (extras) Object.assign(params, extras);
    var partes = [];
    for (var i = 0; i < ORDEM_PARAMETROS_FILA.length; i++) {
      var k = ORDEM_PARAMETROS_FILA[i];
      if (params[k] === null || params[k] === undefined) continue;
      partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return partes.join('&');
  }

  /**
   * Chave estável (para detectar "o filtro mudou") — serialização JSON na
   * ordem FIXA de `ORDEM_CAMPOS_FILTRO` (nunca `.sort()`). Usada só para
   * COMPARAR, nunca enviada ao servidor como está.
   */
  function chaveFiltros(filtros) {
    var f = Object.assign({}, filtrosPadrao(), filtros || {});
    var out = {};
    for (var i = 0; i < ORDEM_CAMPOS_FILTRO.length; i++) {
      var k = ORDEM_CAMPOS_FILTRO[i];
      out[k] = f[k] === undefined ? null : f[k];
    }
    return JSON.stringify(out);
  }

  /**
   * Regra DV-17/U-06: busca ativa liga "Incluir silenciosos" de forma VISÍVEL
   * (nunca escondida). `anterior`/`novo` são os filtros antes/depois da
   * edição; devolve os filtros efetivos e se o auto-ligamento ocorreu agora
   * (para a UI mostrar o aviso). É escolha de PARÂMETRO (U-06), não uma
   * regra de negócio nova — a decisão de incluir silenciosos no SQL continua
   * inteiramente do backend.
   */
  function aplicarAutoIncluirSilenciosos(anterior, novo) {
    var buscaAntes = !!(anterior && anterior.busca && String(anterior.busca).trim());
    var buscaDepois = !!(novo && novo.busca && String(novo.busca).trim());
    if (!buscaAntes && buscaDepois && novo.incluirSilenciosos !== true) {
      return { filtros: Object.assign({}, novo, { incluirSilenciosos: true }), autoHabilitado: true };
    }
    return { filtros: novo, autoHabilitado: false };
  }

  /* ================================================================== *
   * 10) Máquina de paginação por cursor (fila e timeline) — PURA: entrada e
   *     saída são dados, nunca o DOM nem o `fetch`. Nenhuma duplicação,
   *     nenhuma perda de item; respostas de um filtro antigo (`chave`
   *     diferente da atual) são descartadas (requisito "respostas atrasadas
   *     são descartadas").
   * ================================================================== */

  function estadoPaginacaoInicial() {
    return { itens: [], cursor: null, total: 0, carregando: false, erro: null, aviso: null, chave: null };
  }

  /**
   * Reducer puro `(estado, acao) → novoEstado`. Ações:
   *  - `{ tipo:'FILTROS_MUDARAM', chave }` — zera a lista, descarta o cursor.
   *  - `{ tipo:'PAGINA_CARREGADA', chave, substituir, dados:{itens,cursor,total} }`
   *    — `substituir:true` troca a lista (primeira página); senão concatena
   *    ao fim (nunca reordena, nunca remove duplicata por heurística — a
   *    API já garante itens distintos por página).
   *  - `{ tipo:'ERRO', chave, erro }`.
   *  - `{ tipo:'REINICIAR', chave, aviso }` — usado em `ordem_alterada`/`cursor_invalido`.
   * Qualquer ação cuja `chave` não é a do estado atual (filtro já mudou de
   * novo enquanto a requisição estava em voo) é IGNORADA.
   */
  function reduzirPaginacao(estado, acao) {
    estado = estado || estadoPaginacaoInicial();
    if (acao.tipo === 'FILTROS_MUDARAM') {
      return { itens: [], cursor: null, total: 0, carregando: true, erro: null, aviso: null, chave: acao.chave };
    }
    if (acao.chave !== undefined && acao.chave !== estado.chave) {
      return estado; // resposta atrasada de um filtro que já não é o atual.
    }
    if (acao.tipo === 'PAGINA_CARREGADA') {
      var itens = acao.substituir ? acao.dados.itens.slice() : estado.itens.concat(acao.dados.itens);
      return { itens: itens, cursor: acao.dados.cursor, total: acao.dados.total, carregando: false, erro: null, aviso: null, chave: estado.chave };
    }
    if (acao.tipo === 'ERRO') {
      return { itens: estado.itens, cursor: estado.cursor, total: estado.total, carregando: false, erro: acao.erro, aviso: null, chave: estado.chave };
    }
    if (acao.tipo === 'REINICIAR') {
      return { itens: [], cursor: null, total: 0, carregando: true, erro: null, aviso: acao.aviso || null, chave: estado.chave };
    }
    if (acao.tipo === 'CARREGANDO_MAIS') {
      return { itens: estado.itens, cursor: estado.cursor, total: estado.total, carregando: true, erro: null, aviso: null, chave: estado.chave };
    }
    return estado;
  }

  /* ================================================================== *
   * 11) sessionStorage de filtros (U-10) — por aba, nunca entre
   *     dispositivos/usuários. Recebe o objeto `sessionStorage` por fora
   *     (injeção de dependência) para ser testável sem DOM/navegador.
   * ================================================================== */

  var CHAVE_SESSION_FILTROS = 'priora.demurrageop.filtros';

  function salvarFiltros(storage, filtros) {
    if (!storage) return;
    try { storage.setItem(CHAVE_SESSION_FILTROS, JSON.stringify(filtros)); } catch (e) { /* storage indisponível — ignora, nunca quebra a tela */ }
  }

  function carregarFiltros(storage) {
    if (!storage) return filtrosPadrao();
    try {
      var bruto = storage.getItem(CHAVE_SESSION_FILTROS);
      if (!bruto) return filtrosPadrao();
      var salvo = JSON.parse(bruto);
      if (!salvo || typeof salvo !== 'object') return filtrosPadrao();
      return Object.assign({}, filtrosPadrao(), salvo);
    } catch (e) {
      return filtrosPadrao();
    }
  }

  /* ================================================================== *
   * 12) Estados de tela (seção 10 do diagnóstico) — seletor puro do estado
   *     visível a partir do estado interno do componente.
   * ================================================================== */

  /**
   * Deriva o que a tela deve mostrar a partir do estado de carregamento —
   * nenhuma decisão de negócio, só a máquina de estados da interface.
   */
  function estadoTela(s) {
    var temItens = !!(s && s.itens && s.itens.length);
    var carregandoPrimeiraVez = !!(s && s.carregando && !temItens);
    var erroBloqueante = !!(s && s.erro && !temItens);
    var vazio = !!(s && !s.carregando && !s.erro && !temItens);
    return {
      mostrarCarregandoInicial: carregandoPrimeiraVez,
      mostrarCarregandoMais: !!(s && s.carregando && temItens),
      mostrarErro: erroBloqueante,
      mostrarVazio: vazio,
      mostrarConteudo: temItens,
    };
  }

  /* ================================================================== *
   * API pública.
   * ================================================================== */

  return {
    classificarErro: classificarErro,
    rotuloSituacaoValor: rotuloSituacaoValor,
    formatarNumeroBr: formatarNumeroBr,
    formatarEnvelope: formatarEnvelope,
    formatarGrupoFinanceiro: formatarGrupoFinanceiro,
    simboloMoeda: simboloMoeda,
    formatarDecimalExatoBr: formatarDecimalExatoBr,
    secaoDoBalde: secaoDoBalde,
    montarSecoesFila: montarSecoesFila,
    primeiroDaFila: primeiroDaFila,
    consultasIndicadores: consultasIndicadores,
    totalDoBalde: totalDoBalde,
    montarIndicadores: montarIndicadores,
    montarResumoOperacional: montarResumoOperacional,
    contarFiltrosAtivos: contarFiltrosAtivos,
    estadoInicialPainelFiltros: estadoInicialPainelFiltros,
    formatarAgregadoLado: formatarAgregadoLado,
    formatarAgregadoFinanceiro: formatarAgregadoFinanceiro,
    formatarDataCivil: formatarDataCivil,
    formatarInstante: formatarInstante,
    tempoRelativo: tempoRelativo,
    rotuloMotivoPendente: rotuloMotivoPendente,
    formatarRelogio: formatarRelogio,
    formatarDoisRelogios: formatarDoisRelogios,
    rotuloBadge: rotuloBadge,
    rotuloEstadoOperacional: rotuloEstadoOperacional,
    formatarBadges: formatarBadges,
    formatarLider: formatarLider,
    formatarProximoVencimento: formatarProximoVencimento,
    formatarItemFila: formatarItemFila,
    prepararItensFila: prepararItensFila,
    formatarContainerResumo: formatarContainerResumo,
    formatarResponsabilidade: formatarResponsabilidade,
    formatarMoedaNumero: formatarMoedaNumero,
    formatarProcessoDetalhe: formatarProcessoDetalhe,
    formatarContainerDetalhe: formatarContainerDetalhe,
    rotuloTipoEvento: rotuloTipoEvento,
    prepararEventoTimeline: prepararEventoTimeline,
    prepararEventosTimeline: prepararEventosTimeline,
    filtrosPadrao: filtrosPadrao,
    construirParametrosFila: construirParametrosFila,
    construirQueryFila: construirQueryFila,
    chaveFiltros: chaveFiltros,
    aplicarAutoIncluirSilenciosos: aplicarAutoIncluirSilenciosos,
    estadoPaginacaoInicial: estadoPaginacaoInicial,
    reduzirPaginacao: reduzirPaginacao,
    salvarFiltros: salvarFiltros,
    carregarFiltros: carregarFiltros,
    estadoTela: estadoTela,
  };
}));
