export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  sessionSecret: string;
  collabSecret: string;
  collabInternalUrl: string;
  publicUrl: string;
  uploadDir: string;
  maxUploadBytes: number;
  allowRegistration: boolean;
  /** max auth attempts per IP per minute */
  authRateLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string, dev?: string) => {
    const v = env[k] ?? (env.NODE_ENV !== 'production' ? dev : undefined);
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    port: Number(env.PORT ?? 8421),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: need('DATABASE_URL', 'postgres://bee:bee@localhost:54329/bee'),
    sessionSecret: need('SESSION_SECRET', 'dev-session-secret'),
    collabSecret: need('COLLAB_SECRET', 'dev-collab-secret'),
    collabInternalUrl: env.COLLAB_INTERNAL_URL ?? 'http://localhost:1234',
    publicUrl: (env.BEE_PUBLIC_URL ?? 'http://localhost:7070').replace(/\/$/, ''),
    uploadDir: env.UPLOAD_DIR ?? './data/uploads',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
    allowRegistration: env.ALLOW_REGISTRATION !== 'false',
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 20),
  };
}
