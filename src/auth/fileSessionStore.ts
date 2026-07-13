import fs from 'fs';
import path from 'path';
import session, { SessionData, Store } from 'express-session';

/**
 * Armazém de sessões simples baseado em arquivos (uma sessão por arquivo JSON).
 *
 * O padrão do express-session é o MemoryStore, que perde TODAS as sessões
 * quando o processo reinicia. No Render gratuito a instância "dorme" e reinicia
 * sozinha, então o usuário logava e minutos depois via "Não autenticado".
 * Gravando em disco, a sessão sobrevive a reinícios do processo.
 *
 * Sem dependências externas para manter o build simples.
 */
export class FileSessionStore extends Store {
  private dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(sid: string): string {
    return path.join(this.dir, encodeURIComponent(sid) + '.json');
  }

  get = (
    sid: string,
    callback: (err: any, session?: SessionData | null) => void,
  ): void => {
    fs.readFile(this.file(sid), 'utf8', (err, raw) => {
      if (err) {
        // Sessão inexistente não é erro: o express-session cria uma nova.
        return callback(null, null);
      }
      try {
        const parsed = JSON.parse(raw) as SessionData & { __expires?: number };
        if (parsed.__expires && Date.now() > parsed.__expires) {
          fs.unlink(this.file(sid), () => undefined);
          return callback(null, null);
        }
        delete parsed.__expires;
        callback(null, parsed);
      } catch {
        callback(null, null);
      }
    });
  };

  set = (sid: string, sess: SessionData, callback?: (err?: any) => void): void => {
    const toStore: SessionData & { __expires?: number } = Object.assign(
      {},
      sess,
    );
    const maxAge = sess.cookie && (sess.cookie as any).maxAge;
    toStore.__expires =
      typeof maxAge === 'number' ? Date.now() + maxAge : undefined;
    fs.writeFile(this.file(sid), JSON.stringify(toStore), (err) => {
      if (callback) callback(err || undefined);
    });
  };

  destroy = (sid: string, callback?: (err?: any) => void): void => {
    fs.unlink(this.file(sid), () => {
      if (callback) callback();
    });
  };

  touch = (
    sid: string,
    sess: SessionData,
    callback?: (err?: any) => void,
  ): void => {
    this.set(sid, sess, callback);
  };
}

/** Fábrica: cria o store garantindo que a pasta exista. */
export function createFileSessionStore(dir: string): session.Store {
  return new FileSessionStore(dir);
}
