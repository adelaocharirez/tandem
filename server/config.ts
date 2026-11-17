import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  // Render sets this for every web service, so a deploy there needs no PUBLIC_URL.
  RENDER_EXTERNAL_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /**
   * Who may create an account. 'invite': the first account is free (that's
   * you), everyone after needs a room invite code. Defaults to 'invite' in
   * production and 'open' elsewhere.
   */
  SIGNUP_MODE: z.preprocess(emptyToUndefined, z.enum(['open', 'invite']).optional()),
  DATA_DIR: z.string().default('.data'),
});

export type Config = Omit<z.infer<typeof schema>, 'SIGNUP_MODE' | 'RENDER_EXTERNAL_URL'> & {
  SIGNUP_MODE: 'open' | 'invite';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const { RENDER_EXTERNAL_URL, SIGNUP_MODE, ...rest } = parsed.data;
  return {
    ...rest,
    PUBLIC_URL: rest.PUBLIC_URL ?? RENDER_EXTERNAL_URL,
    SIGNUP_MODE: SIGNUP_MODE ?? (rest.NODE_ENV === 'production' ? 'invite' : 'open'),
  };
}
