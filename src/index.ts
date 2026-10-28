import { criarApp, verificarArmazenamentoNoBoot, verificarTabelaDeSessoes } from './app';
import { inicializarPersistenciaAuth } from './auth/persistenciaAuth';
import { config } from './config';
import { iniciarSchedulerDemurrage } from './demurrage/schedulerBootstrap';
import { iniciarCapturaPreAlerta } from './demurrage/capturaBootstrap';

/** Montagem HTTP (sessões humanas, rotas, erros): `src/app.ts`. */
const app = criarApp();

/**
 * Boot assíncrono: a persistência DURÁVEL da autenticação Microsoft (cache do
 * MSAL cifrado + conta ativa no PostgreSQL — ou o cache só em memória, falha
 * segura, se a chave estiver ausente/inválida) precisa estar configurada
 * ANTES de o servidor aceitar requisições e antes de o laço da captura
 * automática (que depende dela para renovar tokens em background) iniciar.
 * `inicializarPersistenciaAuth` nunca lança: sem banco, cai no cache em
 * arquivo (comportamento legado); com erro de chave/banco, cai em memória.
 */
async function main(): Promise<void> {
  // Sessões humanas exigem a migration 0049 (`sessoes_humanas`): em produção,
  // sem ela o servidor NÃO sobe (o health check falha e o host mantém o
  // deploy anterior) em vez de responder 500 a todo login. Rode
  // `npm run db:migrate:demurrage` ANTES de publicar o código.
  await verificarTabelaDeSessoes();
  // Produção P1 (arquivos de minuta): sonda do bucket (não fatal; só código no log).
  await verificarArmazenamentoNoBoot();
  await inicializarPersistenciaAuth();

  const server = app.listen(config.port, () => {
    console.log(`Priora rodando em http://localhost:${config.port}`);
  });

  // Scheduler de demurrage IN-PROCESS (Fase 6, revisão 13): roda no mesmo Web
  // Service, dispara um tick no boot (recupera janela vencida após deploy) e
  // depois a cada ~1h. Não bloqueia o boot nem as requisições; o claim em
  // PostgreSQL é a proteção definitiva contra duplicidade. Falha aqui nunca
  // derruba o servidor (o bootstrap é defensivo e cada tick captura erros).
  let scheduler: ReturnType<typeof iniciarSchedulerDemurrage> = null;
  try {
    scheduler = iniciarSchedulerDemurrage();
  } catch (err) {
    console.error('[demurrage-scheduler] falha ao iniciar (app segue no ar):', err);
  }

  // Captura automática do pré-alerta: CICLO PRÓPRIO, separado do scheduler
  // acima (intervalo/kill switch próprios). Falha aqui nunca afeta tracking,
  // relógios, apuração nem o scheduler principal.
  let captura: ReturnType<typeof iniciarCapturaPreAlerta> = null;
  try {
    captura = iniciarCapturaPreAlerta();
  } catch (err) {
    console.error('[captura-pre-alerta] falha ao iniciar (app segue no ar):', err);
  }

  if (scheduler || captura) {
    const encerrar = (sinal: string) => {
      console.log(`[boot] ${sinal} recebido — parando os laços em background.`);
      scheduler?.stop(); // um tick em andamento termina sozinho; o claim/lease o cobre
      captura?.stop();
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', () => encerrar('SIGTERM')); // Render envia SIGTERM no deploy
    process.once('SIGINT', () => encerrar('SIGINT'));
  }
}

main().catch((err) => {
  console.error('[boot] falha fatal ao iniciar o servidor:', err);
  process.exit(1);
});

// Rede de segurança: uma rejeição não tratada não derruba o Web Service.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
