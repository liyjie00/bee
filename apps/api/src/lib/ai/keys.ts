import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AiProvider } from '@bee/shared';

/** AES-256-GCM sealing for the provider keys in ai_settings.keys. */
export type KeyRing = Partial<Record<AiProvider, string>>;

const keyOf = (secret: string) => createHash('sha256').update(secret).digest();

export function sealKeys(secret: string, keys: KeyRing): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(keys), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openKeys(secret: string, sealed: string): KeyRing {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) return {};
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    return JSON.parse(pt.toString('utf8')) as KeyRing;
  } catch {
    // Secret rotated: the stored keys are unusable, the user reconnects.
    return {};
  }
}
