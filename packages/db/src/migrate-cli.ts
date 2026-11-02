import { existsSync } from 'node:fs';
import { runMigrations } from './index.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

await runMigrations();
console.log('migrations applied');
