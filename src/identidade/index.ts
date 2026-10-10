// Liberação S6 — contrato público da identidade central (N-3, N-4, N-14, N-16, N-18).
export { ErroIdentidade } from './comum';
export type { Db, Evidencia, Origem, CodigoErroIdentidade } from './comum';
export { limparCodigoProcesso, ehCodigoCompleto, chaveMaster } from './normalizacao';
export { resolverProcesso, registrarReferenciaProcesso, registrarAliasProcesso } from './processo';
export type { ResultadoResolucaoProcesso, ResultadoRegistroProcesso, ResultadoAliasProcesso } from './processo';
export { resolverMaster, registrarReferenciaMaster } from './master';
export type { ResultadoResolucaoMaster, ResultadoRegistroMaster } from './master';
export { iniciarAnalisePendencia } from './pendencias';
export type { EstadoPendencia, MotivoPendenciaProcesso, MotivoPendenciaMaster } from './pendencias';
export { encerrarPendenciaPorEvidenciaInvalida, invalidarEvidenciaDeReferencia } from './invalidacao';
