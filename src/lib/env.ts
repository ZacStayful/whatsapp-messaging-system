/**
 * Server environment — the single source of truth for configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULES
 *
 * 1. Nothing else in this codebase reads `process.env`. Import `env` from here.
 *    The ESLint rule `no-restricted-properties` enforces this; the only files
 *    exempt are this one, `env.client.ts` and `scripts/check-env.ts`.
 *
 * 2. No credential is ever prefixed `NEXT_PUBLIC_`. `SUPABASE_SERVICE_ROLE_KEY`,
 *    `TWILIO_AUTH_TOKEN` and `MONDAY_API_TOKEN` must never reach the browser
 *    under any circumstance. `assertNoPublicSecrets()` below fails the boot if
 *    any of them is mirrored into a public variable.
 *
 * 3. This module is `server-only`. Importing it — directly or transitively —
 *    from a Client Component fails the build. Client Components import
 *    `src/lib/env.client.ts`, whose type contains only `NEXT_PUBLIC_*` keys, so
 *    reading a secret from the browser is a *type* error before it is anything
 *    else.
 *
 * 4. Validation is complete and loud. Every problem found is reported in one
 *    pass and the process refuses to boot. A half-working boot caused by a
 *    silently-undefined variable is worse than no boot at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import 'server-only';

import { z } from 'zod';

import { rawClientEnv } from './env.client-raw';
import {
  booleanFromString,
  clientEnvSchema,
  csvE164List,
  csvList,
  CLIENT_VAR_META,
  e164,
  emailAddress,
  EnvValidationError,
  formatEnvProblems,
  httpUrl,
  ianaTimeZone,
  issuesToProblems,
  optional,
  required,
  supabaseKeyRole,
  timeOfDay,
  twilioSid,
  type EnvProblem,
  type VarMetaMap,
} from './env.shared';

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const serverEnvSchema = z.object({
  /* ---------------------------------------------------------------- Supabase */

  SUPABASE_SERVICE_ROLE_KEY: required(
    z
      .string()
      .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short to be a Supabase key')
      .refine(
        (v) => v.startsWith('sb_secret_') || supabaseKeyRole(v) === 'service_role',
        'SUPABASE_SERVICE_ROLE_KEY must be the service_role (secret) key, not the anon/publishable key. Project Settings → API keys → service_role.',
      ),
  ),

  SUPABASE_PROJECT_REF: required(
    z
      .string()
      .regex(
        /^[a-z0-9]{20}$/,
        'SUPABASE_PROJECT_REF must be the 20-character project ref (the subdomain of your project URL), not the full URL',
      ),
  ),

  // Optional by design: only the Supabase CLI needs it, and it is never set in
  // Vercel. `npm run check-env` warns when it is missing locally.
  SUPABASE_DB_PASSWORD: optional(z.string().min(1)),

  /* ------------------------------------------------------------------ Twilio */

  TWILIO_ACCOUNT_SID: required(twilioSid('AC', 'TWILIO_ACCOUNT_SID')),

  // Required even when outbound calls use an API key: the auth token is the
  // signing key for the X-Twilio-Signature header on inbound webhooks.
  TWILIO_AUTH_TOKEN: required(
    z
      .string()
      .regex(/^[0-9a-fA-F]{32}$/, 'TWILIO_AUTH_TOKEN must be 32 hexadecimal characters'),
  ),

  // Optional pair. When present it is preferred for outbound API calls so the
  // auth token can be rotated without breaking sending. Both or neither —
  // enforced in the cross-field checks below.
  TWILIO_API_KEY_SID: optional(twilioSid('SK', 'TWILIO_API_KEY_SID')),
  TWILIO_API_KEY_SECRET: optional(
    z.string().min(20, 'TWILIO_API_KEY_SECRET looks too short'),
  ),

  TWILIO_WHATSAPP_NUMBER: required(e164('TWILIO_WHATSAPP_NUMBER')),

  // Optional by design: absence degrades to sending from the number directly.
  TWILIO_MESSAGING_SERVICE_SID: optional(
    twilioSid('MG', 'TWILIO_MESSAGING_SERVICE_SID'),
  ),

  /* -------------------------------------------------------------- Monday.com */

  MONDAY_API_TOKEN: required(
    z.string().min(20, 'MONDAY_API_TOKEN looks too short to be a Monday API v2 token'),
  ),

  MONDAY_BOARD_ID: required(
    z.string().regex(/^\d+$/, 'MONDAY_BOARD_ID must be numeric (e.g. 5891626711)'),
  ),

  MONDAY_WEBHOOK_SIGNING_SECRET: required(
    z
      .string()
      .min(
        8,
        'MONDAY_WEBHOOK_SIGNING_SECRET must be the signing secret from the Monday app, used to verify the JWT on inbound webhooks',
      ),
  ),

  MONDAY_STATUS_COLUMN_ID: required(z.string().min(1)),

  MONDAY_QUALIFIED_STATUS_LABEL: required(
    z
      .string()
      .min(1)
      .refine(
        (v) => v === v.trim(),
        'MONDAY_QUALIFIED_STATUS_LABEL must match the Monday label exactly — leading/trailing whitespace will never match',
      ),
  ),

  MONDAY_EXCLUDED_GROUP_IDS: required(
    csvList().refine(
      (v) => v.length > 0,
      'MONDAY_EXCLUDED_GROUP_IDS must list at least one group id. Leads in excluded groups may have been sold on; messaging them is a commercial failure, not a technical one.',
    ),
  ),

  /* --------------------------------------------------------- Email/alerting */

  RESEND_API_KEY: required(
    z
      .string()
      .regex(/^re_[A-Za-z0-9_-]{10,}$/, 'RESEND_API_KEY must start with "re_"'),
  ),

  ALERT_EMAIL_TO: required(emailAddress('ALERT_EMAIL_TO')),

  ALERT_EMAIL_FROM: required(
    emailAddress('ALERT_EMAIL_FROM', { allowDisplayName: true }),
  ),

  /* ------------------------------------------------------------ Application */

  APP_ENV: required(
    z.enum(['local', 'preview', 'production'], {
      message: 'APP_ENV must be exactly one of: local, preview, production',
    }),
  ),

  WEBHOOK_BASE_URL: required(httpUrl('WEBHOOK_BASE_URL')),

  // Safety rail. Enforced inside the send function, never in the UI.
  ALLOWED_TEST_NUMBERS: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    csvE164List('ALLOWED_TEST_NUMBERS'),
  ),

  // Master kill switch. Defaults closed — a missing value must never mean
  // "sending is on". The database-level switch arrives in a later phase.
  SEND_ENABLED: z.preprocess(
    (v) => (v === undefined || v === '' ? 'false' : v),
    booleanFromString('SEND_ENABLED'),
  ),

  WORKING_HOURS_START: required(timeOfDay('WORKING_HOURS_START')),
  WORKING_HOURS_END: required(timeOfDay('WORKING_HOURS_END')),
  WORKING_HOURS_TIMEZONE: required(ianaTimeZone('WORKING_HOURS_TIMEZONE')),

  CRON_SECRET: required(
    z
      .string()
      .min(
        16,
        'CRON_SECRET must be at least 16 characters. Generate one with: openssl rand -hex 32',
      ),
  ),

  /* --------------------------------------------------- Deferred integrations */
  /* Explicitly optional. Absence degrades a feature that is not built yet; it
     must never fail the boot. Keep them declared here rather than reaching for
     process.env when the feature lands. */

  CALENDLY_API_TOKEN: optional(z.string().min(10)),
  CALENDLY_WEBHOOK_SIGNING_KEY: optional(z.string().min(10)),
  SENTRY_DSN: optional(httpUrl('SENTRY_DSN')),
});

/**
 * Public and private variables validated together.
 *
 * Combining them is what makes the failure report complete: a boot that reports
 * the three `NEXT_PUBLIC_*` problems, then on the next attempt reports twenty
 * more, costs a morning.
 */
const fullEnvSchema = serverEnvSchema.extend(clientEnvSchema.shape);

type FullEnv = z.infer<typeof fullEnvSchema>;

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export const SERVER_VAR_META: VarMetaMap = {
  SUPABASE_SERVICE_ROLE_KEY: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Supabase service_role key. Bypasses RLS. Server only, always.',
  },
  SUPABASE_PROJECT_REF: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Supabase project ref, used by the CLI and migrations.',
  },
  SUPABASE_DB_PASSWORD: {
    scope: 'server',
    secret: true,
    requirement: 'optional',
    describe: 'Supabase database password. Local migrations only; not set in Vercel.',
  },
  TWILIO_ACCOUNT_SID: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Twilio account SID (starts AC).',
  },
  TWILIO_AUTH_TOKEN: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Twilio auth token. Signs and verifies the X-Twilio-Signature header.',
  },
  TWILIO_API_KEY_SID: {
    scope: 'server',
    secret: false,
    requirement: 'optional',
    describe: 'Twilio API key SID (starts SK). Preferred for outbound API calls.',
  },
  TWILIO_API_KEY_SECRET: {
    scope: 'server',
    secret: true,
    requirement: 'conditional',
    describe: 'Secret paired with TWILIO_API_KEY_SID. Shown once, at creation.',
  },
  TWILIO_WHATSAPP_NUMBER: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'The WhatsApp sender, E.164. Separate from the voice line.',
  },
  TWILIO_MESSAGING_SERVICE_SID: {
    scope: 'server',
    secret: false,
    requirement: 'optional',
    describe: 'Twilio Messaging Service SID (starts MG). Leave unset if unused.',
  },
  MONDAY_API_TOKEN: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Monday personal API v2 token. Server only, always.',
  },
  MONDAY_BOARD_ID: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Monday board id for Management Leads.',
  },
  MONDAY_WEBHOOK_SIGNING_SECRET: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Verifies the JWT on inbound Monday webhook requests.',
  },
  MONDAY_STATUS_COLUMN_ID: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Column id of the Status column on the leads board.',
  },
  MONDAY_QUALIFIED_STATUS_LABEL: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Exact status label that admits a lead to the system.',
  },
  MONDAY_EXCLUDED_GROUP_IDS: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Comma-separated Monday group ids that must never sync or be messaged.',
  },
  RESEND_API_KEY: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Resend API key (starts re_).',
  },
  ALERT_EMAIL_TO: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Recipient of out-of-hours and system alerts.',
  },
  ALERT_EMAIL_FROM: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Sender address. Its domain must be verified in Resend.',
  },
  APP_ENV: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Deployment tier: local | preview | production. Distinct from NODE_ENV.',
  },
  WEBHOOK_BASE_URL: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Public URL that Twilio and Monday webhooks resolve to.',
  },
  ALLOWED_TEST_NUMBERS: {
    scope: 'server',
    secret: false,
    requirement: 'conditional',
    describe: 'Send allowlist. Required outside production; enforced in the send function.',
  },
  SEND_ENABLED: {
    scope: 'server',
    secret: false,
    requirement: 'optional',
    describe: 'Boot-time master kill switch for all outbound sending. Defaults false.',
  },
  WORKING_HOURS_START: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'Start of working hours, HH:MM, in WORKING_HOURS_TIMEZONE.',
  },
  WORKING_HOURS_END: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'End of working hours, HH:MM, in WORKING_HOURS_TIMEZONE.',
  },
  WORKING_HOURS_TIMEZONE: {
    scope: 'server',
    secret: false,
    requirement: 'required',
    describe: 'IANA timezone the working hours are expressed in.',
  },
  CRON_SECRET: {
    scope: 'server',
    secret: true,
    requirement: 'required',
    describe: 'Shared secret authenticating Vercel cron invocations of the queue worker.',
  },
  CALENDLY_API_TOKEN: {
    scope: 'server',
    secret: true,
    requirement: 'optional',
    describe: 'Deferred. Calendly integration is not built yet.',
  },
  CALENDLY_WEBHOOK_SIGNING_KEY: {
    scope: 'server',
    secret: true,
    requirement: 'optional',
    describe: 'Deferred. Calendly integration is not built yet.',
  },
  SENTRY_DSN: {
    scope: 'server',
    secret: false,
    requirement: 'optional',
    describe: 'Deferred. Error reporting is not wired up yet.',
  },
  ...CLIENT_VAR_META,
};

/** Every variable this application knows about, in declaration order. */
export const KNOWN_ENV_VARS: readonly string[] = Object.keys(SERVER_VAR_META);

/* -------------------------------------------------------------------------- */
/* Raw read                                                                   */
/* -------------------------------------------------------------------------- */

/* eslint-disable no-restricted-properties -- this module is the one place allowed to read process.env */
const rawServerEnv: Record<string, string | undefined> = {
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_PROJECT_REF: process.env.SUPABASE_PROJECT_REF,
  SUPABASE_DB_PASSWORD: process.env.SUPABASE_DB_PASSWORD,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
  TWILIO_WHATSAPP_NUMBER: process.env.TWILIO_WHATSAPP_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
  MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN,
  MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID,
  MONDAY_WEBHOOK_SIGNING_SECRET: process.env.MONDAY_WEBHOOK_SIGNING_SECRET,
  MONDAY_STATUS_COLUMN_ID: process.env.MONDAY_STATUS_COLUMN_ID,
  MONDAY_QUALIFIED_STATUS_LABEL: process.env.MONDAY_QUALIFIED_STATUS_LABEL,
  MONDAY_EXCLUDED_GROUP_IDS: process.env.MONDAY_EXCLUDED_GROUP_IDS,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
  APP_ENV: process.env.APP_ENV,
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL,
  ALLOWED_TEST_NUMBERS: process.env.ALLOWED_TEST_NUMBERS,
  SEND_ENABLED: process.env.SEND_ENABLED,
  WORKING_HOURS_START: process.env.WORKING_HOURS_START,
  WORKING_HOURS_END: process.env.WORKING_HOURS_END,
  WORKING_HOURS_TIMEZONE: process.env.WORKING_HOURS_TIMEZONE,
  CRON_SECRET: process.env.CRON_SECRET,
  CALENDLY_API_TOKEN: process.env.CALENDLY_API_TOKEN,
  CALENDLY_WEBHOOK_SIGNING_KEY: process.env.CALENDLY_WEBHOOK_SIGNING_KEY,
  SENTRY_DSN: process.env.SENTRY_DSN,
};

/**
 * Every `NEXT_PUBLIC_*` variable actually present in the process, not just the
 * ones this app declares. Used by `publicSecretProblems()` to catch a secret
 * that someone has exposed through a variable we never intended to exist.
 */
const publicEnvSnapshot: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('NEXT_PUBLIC_')),
);
/* eslint-enable no-restricted-properties */

/** The complete raw environment this module validates. */
const rawEnv: Record<string, string | undefined> = { ...rawServerEnv, ...rawClientEnv };

/* -------------------------------------------------------------------------- */
/* Cross-field and safety checks                                              */
/* -------------------------------------------------------------------------- */

const value = (name: string): string | undefined => {
  const raw = rawEnv[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
};

const isSet = (name: string): boolean => value(name) !== undefined;

/**
 * Checks that span more than one variable. These run against the raw values
 * regardless of whether the field-level parse succeeded, so a single boot
 * reports the complete picture rather than revealing one layer at a time.
 */
function crossFieldProblems(): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const add = (variable: string, message: string) => problems.push({ variable, message });

  const appEnv = value('APP_ENV');

  // Twilio API key: both halves or neither.
  if (isSet('TWILIO_API_KEY_SID') !== isSet('TWILIO_API_KEY_SECRET')) {
    const missing = isSet('TWILIO_API_KEY_SID')
      ? 'TWILIO_API_KEY_SECRET'
      : 'TWILIO_API_KEY_SID';
    add(
      missing,
      'TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET are a pair. Set both to use an API key for outbound calls, or neither to fall back to the auth token.',
    );
  }

  // The allowlist is the only thing standing between development and a real
  // lead's phone. Outside production it is mandatory.
  if (appEnv !== undefined && appEnv !== 'production') {
    const allowlist = value('ALLOWED_TEST_NUMBERS');
    if (allowlist === undefined) {
      add(
        'ALLOWED_TEST_NUMBERS',
        `APP_ENV is "${appEnv}", so ALLOWED_TEST_NUMBERS must list at least one E.164 number. Outside production the send function refuses every number not on this list; an empty list means nothing can be sent and, worse, an unset list invites someone to remove the check.`,
      );
    }
  }

  // Anon and service_role keys must not be the same string.
  const anon = value('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceRole = value('SUPABASE_SERVICE_ROLE_KEY');
  if (anon !== undefined && serviceRole !== undefined && anon === serviceRole) {
    add(
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY is identical to NEXT_PUBLIC_SUPABASE_ANON_KEY. One of the two is wrong, and if it is the public one your service_role key is already in the browser bundle. Rotate it.',
    );
  }

  // Working hours must describe a real window.
  const start = value('WORKING_HOURS_START');
  const end = value('WORKING_HOURS_END');
  if (start !== undefined && end !== undefined && start >= end) {
    add(
      'WORKING_HOURS_END',
      `WORKING_HOURS_END (${end}) must be later than WORKING_HOURS_START (${start}). Overnight windows are not supported.`,
    );
  }

  // Public URLs.
  const appUrl = value('NEXT_PUBLIC_APP_URL');
  const webhookUrl = value('WEBHOOK_BASE_URL');

  if (appEnv === 'production') {
    if (appUrl !== undefined && !appUrl.startsWith('https://')) {
      add('NEXT_PUBLIC_APP_URL', 'Must use https in production.');
    }
    if (webhookUrl !== undefined && !webhookUrl.startsWith('https://')) {
      add('WEBHOOK_BASE_URL', 'Must use https in production. Twilio will not post to http.');
    }
  }

  if (webhookUrl !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(webhookUrl)) {
    add(
      'WEBHOOK_BASE_URL',
      'Points at localhost. Twilio and Monday must reach this URL from the public internet — in local development use the Cloudflare tunnel hostname, not localhost.',
    );
  }

  // Sending outside production with the switch on is legal, but only ever with
  // an allowlist. Catch the combination that would be dangerous.
  const sendEnabled = (value('SEND_ENABLED') ?? 'false').toLowerCase();
  if (
    ['true', '1', 'yes'].includes(sendEnabled) &&
    appEnv !== undefined &&
    appEnv !== 'production' &&
    !isSet('ALLOWED_TEST_NUMBERS')
  ) {
    add(
      'SEND_ENABLED',
      `SEND_ENABLED is true with APP_ENV "${appEnv}" and no ALLOWED_TEST_NUMBERS. Refusing to boot rather than risk messaging a real lead from a development environment.`,
    );
  }

  return problems;
}

/**
 * Rule 2, enforced rather than documented: no credential may be exposed through
 * a `NEXT_PUBLIC_*` variable, by name or by value.
 */
function publicSecretProblems(): EnvProblem[] {
  const problems: EnvProblem[] = [];

  const secretNames = Object.entries(SERVER_VAR_META)
    .filter(([, meta]) => meta.secret)
    .map(([name]) => name);

  const secretValues = new Map<string, string>();
  for (const name of secretNames) {
    const v = value(name);
    if (v !== undefined && v.length >= 8) secretValues.set(v, name);
  }

  const suspiciousName =
    /(SERVICE_ROLE|AUTH_TOKEN|API_TOKEN|_SECRET|SIGNING_KEY|PASSWORD|PRIVATE_KEY|CRON_SECRET)/;

  for (const [publicName, publicValue] of Object.entries(publicEnvSnapshot)) {
    if (suspiciousName.test(publicName)) {
      problems.push({
        variable: publicName,
        message:
          'A NEXT_PUBLIC_ variable with a credential-shaped name is exposed to the browser. Rename it without the NEXT_PUBLIC_ prefix and read it through src/lib/env.ts.',
      });
      continue;
    }
    const trimmed = publicValue?.trim();
    if (trimmed !== undefined && secretValues.has(trimmed)) {
      problems.push({
        variable: publicName,
        message: `Holds the same value as ${secretValues.get(trimmed)}, which is a server-only credential. It is now in the client bundle — rotate that credential and remove this variable.`,
      });
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                      */
/* -------------------------------------------------------------------------- */

function loadEnv(): FullEnv {
  const parsed = fullEnvSchema.safeParse(rawEnv);

  // Field-level, cross-field and leakage problems are gathered in one pass so a
  // single failed boot tells you everything that is wrong.
  const problems: EnvProblem[] = [
    ...(parsed.success ? [] : issuesToProblems(parsed.error.issues, rawEnv)),
    ...crossFieldProblems(),
    ...publicSecretProblems(),
  ];

  if (problems.length > 0) {
    throw new EnvValidationError(
      formatEnvProblems('server', problems, { ...rawEnv, ...publicEnvSnapshot }, SERVER_VAR_META),
      problems.map((p) => `${p.variable}: ${p.message}`),
    );
  }

  if (!parsed.success) {
    // Unreachable: `problems` would be non-empty. Present so the return type
    // needs no cast.
    throw new EnvValidationError('Environment validation failed.', []);
  }

  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The validated environment. Server-side only.
 *
 * Includes the `NEXT_PUBLIC_*` values so server code has one place to look;
 * Client Components import `clientEnv` from `src/lib/env.client.ts` instead,
 * which is typed to the public subset.
 */
export const env = Object.freeze(loadEnv());

export type Env = typeof env;

export { EnvValidationError } from './env.shared';
