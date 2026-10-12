import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Importar PRIMEIRO nos testes de fatos duráveis: o JSON legado do Courier
 * (`config.dataDir`) vai para um diretório temporário novo, então nenhum teste
 * (inclusive `resetCourierStore()`) toca dados reais.
 */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-fatos-'));
export const DATA_DIR_TESTE = process.env.DATA_DIR;
