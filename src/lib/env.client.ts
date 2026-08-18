/**
 * Client-safe environment.
 *
 * This is the ONLY environment module a Client Component may import. It exposes
 * exactly the `NEXT_PUBLIC_*` variables and nothing else, so reaching for a
 * secret from the browser — `clientEnv.SUPABASE_SERVICE_ROLE_KEY` — is a
 * TypeScript error ("Property does not exist on type ClientEnv"), caught by
 * `npm run typecheck` and by the Next build, not at runtime in front of a user.
 *
 * The server-side counterpart is `src/lib/env.ts`, which is marked
 * `server-only`: importing it from a Client Component fails the build. It
 * validates these same public variables alongside the private ones, so a server
 * boot reports every problem in one pass rather than surfacing the public ones
 * first.
 */

import { rawClientEnv } from './env.client-raw';
import {
  CLIENT_VAR_META,
  clientEnvSchema,
  EnvValidationError,
  formatEnvProblems,
  issuesToProblems,
  type ClientEnv,
} from './env.shared';

const parsed = clientEnvSchema.safeParse(rawClientEnv);

if (!parsed.success) {
  const problems = issuesToProblems(parsed.error.issues, rawClientEnv);
  const message = formatEnvProblems('client', problems, rawClientEnv, CLIENT_VAR_META);
  // Printed as well as thrown: in a browser bundle the thrown message can be
  // swallowed by an error boundary, and this is a configuration bug worth
  // seeing in the console verbatim.
  console.error(message);
  throw new EnvValidationError(
    message,
    problems.map((p) => `${p.variable}: ${p.message}`),
  );
}

/** Validated, browser-safe environment. Contains no credentials. */
export const clientEnv: ClientEnv = Object.freeze(parsed.data);

export type { ClientEnv };
