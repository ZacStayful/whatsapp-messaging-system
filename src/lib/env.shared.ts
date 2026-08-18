/**
 * Shared environment-validation primitives.
 *
 * This module contains ONLY schema definitions, helpers and the error
 * formatter. It never reads `process.env` and never holds a value, so it is
 * safe to include in the browser bundle (it is pulled in by
 * `src/lib/env.client.ts`).
 *
 * Everything here must be isomorphic — no `Buffer`, no `fs`, no Node globals.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export type VarScope = 'client' | 'server';

export interface VarMeta {
  /** Where the value is allowed to be read. */
  readonly scope: VarScope;
  /** If true, the value is never echoed back in error output or logs. */
  readonly secret: boolean;
  /** One-line description, used in error output. See ENVIRONMENT.md for detail. */
  readonly describe: string;
  /**
   * `required`      — boot fails without it.
   * `optional`      — absence is a supported, documented degradation.
   * `conditional`   — required only under certain conditions (see cross-field checks).
   */
  readonly requirement: 'required' | 'optional' | 'conditional';
}

export type VarMetaMap = Readonly<Record<string, VarMeta>>;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Treat empty strings as missing.
 *
 * Both `dotenv` and the Vercel dashboard happily produce `FOO=""`. Without this
 * an empty variable passes a `.min(1)`-less check and the app boots half-broken,
 * which is exactly the failure mode this module exists to prevent.
 */
export const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/** Wrap any schema so that `""` is reported as missing rather than malformed. */
export const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema);

/** Wrap any schema so that `""` and unset both mean "not provided". */
export const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Return the first reason `value` is not an acceptable E.164 number, or null.
 *
 * The UK-specific rules exist because the lead board is full of `+4407…` — the
 * country code and the national trunk zero together — which passes a generic
 * E.164 regex and is then rejected by Twilio at send time. Full parsing with
 * libphonenumber-js arrives in Phase 0; this catches the shapes already known
 * to be in the data.
 */
export function e164Problem(label: string, value: string): string | null {
  if (!E164_PATTERN.test(value)) {
    return `${label} value "${value}" is not E.164. It needs a leading "+", then the country code, with no spaces, no punctuation and no leading zero after the country code (e.g. +447700900123, not 07700900123).`;
  }
  if (value.startsWith('+440')) {
    return `${label} value "${value}" starts "+440" — that is the country code plus the national trunk zero. Drop the 0 (e.g. +447700900123). Twilio rejects it as written.`;
  }
  if (value.startsWith('+44') && value.length !== 13) {
    return `${label} value "${value}" is a +44 number of the wrong length. UK numbers are the country code plus 10 digits: 13 characters including the "+".`;
  }
  return null;
}

export const e164 = (label: string) =>
  z.string().superRefine((v, ctx) => {
    const problem = e164Problem(label, v);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

/** Twilio resource SIDs are a two-letter prefix followed by 32 hex characters. */
export const twilioSid = (prefix: 'AC' | 'SK' | 'MG', label: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}[0-9a-fA-F]{32}$`),
      `${label} must start with "${prefix}" and be 34 characters long (${prefix} + 32 hex)`,
    );

export const httpUrl = (label: string) =>
  z
    .string()
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${label} must be an absolute http(s) URL (e.g. https://example.com)`)
    // No trailing slash, so callers can always concatenate paths safely.
    .transform((v) => v.replace(/\/+$/, ''));

/** `HH:MM` on a 24-hour clock. */
export const timeOfDay = (label: string) =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be 24-hour HH:MM (e.g. 09:00)`);

/**
 * An IANA `Region/City` timezone name that the runtime recognises and does not
 * silently rewrite.
 *
 * Both halves matter. `Intl` accepts "BST" and quietly resolves it to
 * Asia/Dhaka, and accepts "GMT" and resolves it to UTC — either of which would
 * put the out-of-hours notification logic hours out, all year, with no error
 * anywhere. So the value must round-trip through `resolvedOptions()` unchanged
 * and must name a region, not an abbreviation or a fixed offset.
 */
export const ianaTimeZone = (label: string) =>
  z.string().refine((v) => {
    if (v !== 'UTC' && !v.includes('/')) return false;
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: v }).resolvedOptions().timeZone === v;
    } catch {
      return false;
    }
  }, `${label} must be an IANA Region/City timezone name, e.g. Europe/London. Abbreviations and offsets are rejected: "BST" silently resolves to Asia/Dhaka, "GMT" to UTC, and "UTC+1" is not a zone at all. Working-hours logic has to be DST-aware, and only a region name carries the DST rules.`);

/** `"true" | "1" | "yes"` → true; `"false" | "0" | "no" | unset` → false. */
export const booleanFromString = (label: string) =>
  z
    .string()
    .refine(
      (v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(v.trim().toLowerCase()),
      `${label} must be "true" or "false"`,
    )
    .transform((v) => ['true', '1', 'yes'].includes(v.trim().toLowerCase()));

/** Comma-separated list → trimmed, de-duplicated, non-empty entries. */
export const csvList = () =>
  z
    .string()
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]);

/** Comma-separated list of E.164 numbers, held to the same rules as a single one. */
export const csvE164List = (label: string) =>
  csvList().superRefine((values, ctx) => {
    for (const value of values) {
      const problem = e164Problem(label, value);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
    }
  });

/**
 * An email address, optionally in `Display Name <address@example.com>` form,
 * which is what Resend expects for a "from" header.
 */
export const emailAddress = (label: string, { allowDisplayName = false } = {}) =>
  z.string().refine((v) => {
    const address = allowDisplayName ? extractEmailAddress(v) : v;
    return z.email().safeParse(address).success;
  }, `${label} must be a valid email address${allowDisplayName ? ' (optionally as "Name <name@domain.com>")' : ''}`);

/** Pull `a@b.com` out of `Name <a@b.com>`, or return the input unchanged. */
export function extractEmailAddress(value: string): string {
  const match = /<([^>]+)>\s*$/.exec(value.trim());
  return (match?.[1] ?? value).trim();
}

/** Domain part of an email address, lower-cased. */
export function emailDomain(value: string): string {
  return extractEmailAddress(value).split('@')[1]?.toLowerCase() ?? '';
}

/* -------------------------------------------------------------------------- */
/* JWT helpers (isomorphic — no Buffer)                                       */
/* -------------------------------------------------------------------------- */

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

/**
 * Read the `role` claim from a legacy Supabase JWT key without verifying it.
 * Returns null for the new `sb_publishable_` / `sb_secret_` key format, which
 * carries no claims. Used only to catch the anon/service-role keys being
 * swapped — never for authorisation.
 */
export function supabaseKeyRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    const payload: unknown = JSON.parse(json);
    if (payload && typeof payload === 'object' && 'role' in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === 'string' ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Client-safe schema                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The complete set of variables the browser may see. If you are tempted to add
 * something here, check whether it is a credential first — see the rule at the
 * top of `src/lib/env.ts`.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: required(
    httpUrl('NEXT_PUBLIC_SUPABASE_URL').refine(
      (v) => v.startsWith('https://'),
      'NEXT_PUBLIC_SUPABASE_URL must use https',
    ),
  ),

  NEXT_PUBLIC_SUPABASE_ANON_KEY: required(
    z
      .string()
      .min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be a Supabase key')
      .refine(
        (v) => !v.startsWith('sb_secret_'),
        'NEXT_PUBLIC_SUPABASE_ANON_KEY is a secret key (sb_secret_…). The anon/publishable key is the one that may reach the browser.',
      )
      .refine(
        (v) => supabaseKeyRole(v) !== 'service_role',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY contains a service_role JWT. That key bypasses RLS and must never be exposed to the browser — rotate it immediately and use the anon key here.',
      ),
  ),

  NEXT_PUBLIC_APP_URL: required(httpUrl('NEXT_PUBLIC_APP_URL')),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export const CLIENT_VAR_META: VarMetaMap = {
  NEXT_PUBLIC_SUPABASE_URL: {
    scope: 'client',
    secret: false,
    requirement: 'required',
    describe: 'Supabase project URL (Project Settings → Data API).',
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    scope: 'client',
    secret: false,
    requirement: 'required',
    describe: 'Supabase anon / publishable key. Safe in the browser; RLS applies.',
  },
  NEXT_PUBLIC_APP_URL: {
    scope: 'client',
    secret: false,
    requirement: 'required',
    describe: 'Base URL of this app, used for deep links in alert emails.',
  },
};

/* -------------------------------------------------------------------------- */
/* Error reporting                                                             */
/* -------------------------------------------------------------------------- */

export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[]) {
    super(message);
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

export interface EnvProblem {
  readonly variable: string;
  readonly message: string;
}

/**
 * Render a value for error output.
 *
 * Redacts anything marked secret, and anything unrecognised: an undeclared
 * variable turning up in a failure report is usually a leaked credential, and
 * printing it to a terminal — and from there into a scrollback buffer or a CI
 * log — is precisely the thing the report is complaining about.
 */
export function displayValue(raw: unknown, meta: VarMeta | undefined): string {
  if (raw === undefined || raw === null) return '(not set)';
  const str = String(raw);
  if (str.trim() === '') return '(empty string)';
  if (meta === undefined || meta.secret) {
    return `(set, ${str.length} characters, value withheld)`;
  }
  return JSON.stringify(str);
}

/** Turn zod issues into `{ variable, message }` pairs keyed by variable name. */
export function issuesToProblems(
  issues: readonly z.core.$ZodIssue[],
  raw: Record<string, unknown> = {},
): EnvProblem[] {
  return issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : '(environment)';
    const rawValue = raw[variable];
    const isAbsent = rawValue === undefined || (typeof rawValue === 'string' && rawValue.trim() === '');
    // An absent value always reads as "missing" rather than as whatever the
    // field-level message happens to say about a malformed one — `z.enum`, for
    // instance, reports an invalid value rather than an invalid type.
    const message = isAbsent
      ? 'Required, but not set (or set to an empty string).'
      : issue.message;
    return { variable, message };
  });
}

/**
 * Build the single, complete, human-readable failure message.
 *
 * Every problem found in this pass is listed at once. A boot that reports one
 * missing variable per restart wastes a morning; this reports all of them.
 */
export function formatEnvProblems(
  context: string,
  problems: readonly EnvProblem[],
  raw: Record<string, unknown>,
  meta: VarMetaMap,
): string {
  const byVariable = new Map<string, string[]>();
  for (const problem of problems) {
    const list = byVariable.get(problem.variable) ?? [];
    list.push(problem.message);
    byVariable.set(problem.variable, list);
  }

  const lines: string[] = [
    '',
    '━'.repeat(76),
    `Invalid ${context} environment configuration — ${byVariable.size} variable${
      byVariable.size === 1 ? '' : 's'
    } need attention.`,
    '━'.repeat(76),
    '',
  ];

  for (const [variable, messages] of [...byVariable].sort(([a], [b]) => a.localeCompare(b))) {
    const info = meta[variable];
    lines.push(`  ${variable}`);
    lines.push(`    current value : ${displayValue(raw[variable], info)}`);
    if (info) lines.push(`    purpose       : ${info.describe}`);
    for (const message of messages) {
      lines.push(`    problem       : ${message}`);
    }
    lines.push('');
  }

  lines.push('━'.repeat(76));
  lines.push('Fix every variable listed above, then start again.');
  lines.push('ENVIRONMENT.md documents where each value is found.');
  lines.push('`npm run check-env` verifies the values actually work.');
  lines.push('━'.repeat(76));
  lines.push('');

  return lines.join('\n');
}
