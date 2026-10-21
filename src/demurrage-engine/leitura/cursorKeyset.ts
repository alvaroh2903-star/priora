import { ErroLeitura } from './contrato';
import { codificarCursorAssinado, decodificarCursorAssinado, hmacLeitura } from './cursorAssinado';

/**
 * Produção P1 (Entrega 3) — cursor KEYSET assinado, compartilhado pelas três
 * leituras operacionais novas (pendências, reaberturas, minutas). Reusa o
 * MESMO primitivo de assinatura do D12 (`cursorAssinado.ts` —
 * `codificarCursorAssinado`/`decodificarCursorAssinado`/`hmacLeitura`, HMAC-SHA256
 * com o segredo de sessão do servidor): nenhum formato de assinatura novo,
 * incompatível com o já existente.
 *
 * Diferença deliberada do cursor da FILA (`filaOperacional.ts`): a fila
 * pagina um OFFSET sobre uma ordenação derivada em memória (necessário ali —
 * a ordem depende de estado/prioridade calculados, não de uma coluna
 * persistida). As três leituras desta entrega são listas simples sobre
 * UMA/DUAS tabelas, ordenadas por uma coluna persistida (`criado_em`) — aqui
 * o pedido explícito é paginação KEYSET verdadeira (nunca OFFSET): o cursor
 * carrega o valor da chave de ordenação e o `id` (desempate imutável) do
 * ÚLTIMO item da página anterior, e a consulta SQL usa esses dois valores
 * direto no `WHERE`, com `LIMIT (limite + 1)` para saber se há próxima
 * página sem contar o total.
 *
 * Contrato de validação do cursor (fechado, nunca "ignora silenciosamente"):
 *  - `v` amarra o cursor a uma ROTA e VERSÃO DE ORDEM específicas — um
 *    cursor de `/reaberturas` nunca é aceito por `/minutas`, e uma futura
 *    mudança na ordem/forma desta rota muda `v` e invalida cursores antigos;
 *  - `organizationId` amarra o cursor à organização do pedido original —
 *    nunca aceito por outra organização, mesmo que a assinatura HMAC (que
 *    usa um segredo ÚNICO do servidor, não por organização) seja válida;
 *  - `filtrosHash` amarra o cursor à combinação EXATA de filtros ativos —
 *    qualquer filtro que mude invalida o cursor; `limite` NUNCA entra no
 *    hash (mudar só o tamanho da página preserva o mesmo cursor);
 *  - qualquer cursor malformado, adulterado, de outra organização, de outra
 *    rota/versão ou com filtros divergentes é SEMPRE `400 cursor_invalido`
 *    — nunca uma tentativa de "recuperar" ou interpretar parcialmente.
 *
 * Entrega 3 v1.1 (corretiva — precisão da chave): `criado_em` é
 * `TIMESTAMPTZ` com resolução de MICROSSEGUNDOS, mas a v1 montava
 * `ultimaChave` via `new Date(...).toISOString()` — o driver `pg` já entrega
 * a coluna como `Date` do JavaScript, que só tem MILISSEGUNDOS. A chave do
 * cursor ficava truncada (ex.: `...16.004474` virava `...16.004`), e a
 * comparação da página seguinte repetia a última linha (rotas ASC — e com
 * `limite=1` nunca avançava) ou pulava linhas empatadas/no mesmo
 * milissegundo (rota DESC). Agora a chave sai do PRÓPRIO PostgreSQL como
 * texto exato (`expressaoChaveExata`, 6 dígitos de fração, UTC), viaja no
 * cursor sem nunca passar por `Date`, e volta ao SQL como
 * `$n::timestamptz` — ida e volta sem perda. A versão `v` de cada rota
 * subiu para `.v2`: cursores v1 (chave truncada) são rejeitados com o mesmo
 * `400 cursor_invalido`, nunca reinterpretados.
 */

/** Formato EXATO da chave de ordenação no cursor: ISO-8601 UTC com 6 dígitos de fração (microssegundos). */
const RE_CHAVE_EXATA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Expressão SQL que serializa uma coluna `TIMESTAMPTZ` no formato EXATO de
 * `RE_CHAVE_EXATA`, sem perda de microssegundos e independente do
 * `TimeZone`/`DateStyle` da sessão. `coluna` é sempre um identificador fixo
 * escrito no próprio código (nunca entrada do chamador).
 *
 * Premissa: valores finitos d.C. entre os anos 0001 e 9999 (`infinity`
 * vira NULL, anos a.C. perdem a era e anos ≥ 10000 têm 5 dígitos). Nas três
 * tabelas ordenadas, `criado_em` é sempre `DEFAULT now()` — nenhuma escrita
 * de produção define o valor.
 */
export function expressaoChaveExata(coluna: string): string {
  return `to_char(${coluna} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export interface CursorKeysetPayload {
  v: string;
  organizationId: string;
  filtrosHash: string;
  /** Chave de ordenação EXATA (texto, microssegundos — ver `expressaoChaveExata`) do ÚLTIMO item da página anterior. */
  ultimaChave: string;
  /** `id` (UUID) do ÚLTIMO item da página anterior — desempate imutável e determinístico. */
  ultimoId: string;
}

export function hashFiltrosKeyset(pares: ReadonlyArray<readonly [string, unknown]>): string {
  return hmacLeitura(JSON.stringify(pares));
}

export function codificarCursorKeyset(payload: CursorKeysetPayload): string {
  return codificarCursorAssinado({ ...payload });
}

/**
 * Decodifica e valida um cursor keyset contra o CONTEXTO atual do pedido
 * (versão/rota, organização, filtros). Lança `ErroLeitura(400,
 * 'cursor_invalido')` em qualquer divergência — nunca devolve um payload
 * parcialmente confiável.
 */
export function decodificarCursorKeyset(
  cursor: string, versaoEsperada: string, organizationId: string, filtrosHashAtual: string,
): CursorKeysetPayload {
  const payload = decodificarCursorAssinado(cursor) as unknown as CursorKeysetPayload;
  if (
    typeof payload.v !== 'string' || typeof payload.organizationId !== 'string'
    || typeof payload.filtrosHash !== 'string' || typeof payload.ultimaChave !== 'string'
    || typeof payload.ultimoId !== 'string'
  ) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  // Rota/versão, organização e filtros são verificados juntos, sem distinguir
  // qual deles falhou na resposta — o mesmo código fechado para todos (nunca
  // vaza "quase certo, só a organização está errada").
  if (payload.v !== versaoEsperada || payload.organizationId !== organizationId || payload.filtrosHash !== filtrosHashAtual) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  // Defesa em profundidade (a assinatura já impede adulteração): confere só
  // a FORMA da chave (6 dígitos de fração, UTC) e do id. Como só o servidor
  // assina cursores, a chave é sempre um `to_char` do próprio banco.
  if (!RE_CHAVE_EXATA.test(payload.ultimaChave) || !RE_UUID.test(payload.ultimoId)) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  return payload;
}
