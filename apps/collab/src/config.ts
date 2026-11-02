export interface CollabConfig {
  port: number;
  apiUrl: string;
  collabSecret: string;
  /** Debounce for persisting document state (ms). */
  storeDebounceMs: number;
  /** Max time a dirty document may go without being persisted (ms). */
  storeMaxDebounceMs: number;
  /** Minimum time between automatic version snapshots of one document (ms). */
  snapshotIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  const collabSecret = env.COLLAB_SECRET;
  if (!collabSecret) throw new Error('COLLAB_SECRET is required');
  return {
    port: Number(env.PORT ?? 1234),
    apiUrl: (env.API_INTERNAL_URL ?? 'http://localhost:8421').replace(/\/+$/, ''),
    collabSecret,
    storeDebounceMs: Number(env.COLLAB_STORE_DEBOUNCE_MS ?? 2000),
    storeMaxDebounceMs: Number(env.COLLAB_STORE_MAX_DEBOUNCE_MS ?? 10000),
    snapshotIntervalMs: Number(env.COLLAB_SNAPSHOT_INTERVAL_MS ?? 10 * 60 * 1000),
  };
}
