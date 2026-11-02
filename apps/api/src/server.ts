import { createDb, runMigrations } from '@bee/db';
import { loadConfig } from './env.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (process.env.SKIP_MIGRATIONS !== '1') await runMigrations(config.databaseUrl);
const { db, pool } = createDb(config.databaseUrl);
const app = await buildApp({ db, config, logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
