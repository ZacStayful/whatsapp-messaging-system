/**
 * Raw, unvalidated reads of the public environment.
 *
 * This module exists so that the client and server validators can share one set
 * of reads without either of them throwing on import. `env.client.ts` validates
 * these for the browser; `env.ts` folds them into the full server-side pass so a
 * single boot reports every problem — public and private — at once.
 *
 * Note the literal `process.env.NEXT_PUBLIC_X` references. Next.js inlines
 * public variables into the browser bundle by static analysis of exactly this
 * syntax; a dynamic lookup such as `process.env[name]` yields `undefined` in the
 * browser.
 */

/* eslint-disable no-restricted-properties -- one of the three modules permitted to read process.env */
export const rawClientEnv: Record<string, string | undefined> = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};
/* eslint-enable no-restricted-properties */
