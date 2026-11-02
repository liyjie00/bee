import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid input',
      'validation',
    );
  }
  return r.data;
}

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });
