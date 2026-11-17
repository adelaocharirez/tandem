import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db/client';

async function main() {
  const config = loadConfig();
  const { db, driver, close } = await openDb({ databaseUrl: config.DATABASE_URL, dataDir: config.DATA_DIR });
  const app = await buildApp({ config, db });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });

  const url = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  const database = driver === 'postgres' ? 'Postgres' : `embedded PGlite (${config.DATA_DIR}/pglite)`;
  console.log(`\n  Tandem is running\n  API + MCP   ${url}\n  Database    ${database}`);
  console.log(`  Signup      ${config.SIGNUP_MODE === 'invite' ? 'invite-only (first account is free)' : 'open to anyone'}`);
  if (config.NODE_ENV !== 'production') console.log('  Dashboard   http://localhost:5173  (Vite dev server)');
  if (config.NODE_ENV === 'production' && driver === 'pglite') {
    console.warn(
      '\n  WARNING: no DATABASE_URL set. Data is stored on this machine\'s disk and will be lost\n' +
        '  on hosts that wipe the disk on every deploy (Render, Fly, Railway). Set DATABASE_URL.',
    );
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
