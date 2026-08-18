/**
 * `npm run check-env`
 *
 * The gate for Phase 0a. Loads `.env.local`, validates it through
 * `src/lib/env.ts`, then makes one cheap authenticated call per service and
 * reports pass or fail with the real error.
 *
 * Exits non-zero if anything fails, so it can sit in front of a deploy.
 *
 * This file and the two env modules are the only places allowed to touch
 * `process.env` — here, only to load the dotenv files before the env module is
 * imported.
 */

import { config as loadDotenv } from 'dotenv';

/* -------------------------------------------------------------------------- */
/* Output helpers                                                             */
/* -------------------------------------------------------------------------- */

const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string) => (useColour ? `\u001B[${code}m${text}\u001B[0m` : text);
const bold = (t: string) => paint('1', t);
const dim = (t: string) => paint('2', t);
const green = (t: string) => paint('32', t);
const red = (t: string) => paint('31', t);
const yellow = (t: string) => paint('33', t);
const cyan = (t: string) => paint('36', t);

type Status = 'pass' | 'fail' | 'warn' | 'skip';

interface CheckResult {
  readonly service: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const results: CheckResult[] = [];

function record(service: string, name: string, status: Status, detail: string): void {
  results.push({ service, name, status, detail });
  const badge = {
    pass: green('  PASS'),
    fail: red('  FAIL'),
    warn: yellow('  WARN'),
    skip: dim('  SKIP'),
  }[status];
  console.log(`${badge}  ${name}`);
  if (detail) console.log(`        ${dim(detail)}`);
}

function section(title: string): void {
  console.log('');
  console.log(bold(cyan(title)));
  console.log(dim('─'.repeat(76)));
}

/** Every failure path funnels through here so the real error is always shown. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* HTTP helper                                                                */
/* -------------------------------------------------------------------------- */

const REQUEST_TIMEOUT_MS = 20_000;

interface HttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

async function request(
  url: string,
  init: RequestInit & { readonly headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body, text };
}

/** Trim a response body down to something readable in a terminal. */
function snippet(result: HttpResult, max = 240): string {
  const raw = result.text.replace(/\s+/g, ' ').trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw || '(empty response body)';
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  console.log('');
  console.log(bold('Stayful WhatsApp — environment check'));

  // Load dotenv files before the env module is imported. `.env.local` wins.
  for (const path of ['.env.local', '.env']) {
    loadDotenv({ path, override: false, quiet: true });
  }

  /* ------------------------------------------------------- 1. Schema validation */

  section('1. Configuration');

  let env: import('../src/lib/env').Env;
  try {
    // Dynamic import: the module validates on load, and it must not be
    // evaluated before dotenv has run.
    const envModule = await import('../src/lib/env');
    env = envModule.env;
    record(
      'config',
      'Environment variables parse and validate',
      'pass',
      `APP_ENV=${env.APP_ENV}  SEND_ENABLED=${String(env.SEND_ENABLED)}  allowlist=${
        env.ALLOWED_TEST_NUMBERS.length
      } number(s)`,
    );
  } catch (error) {
    // EnvValidationError already carries the full, formatted list.
    console.log(red('  FAIL  Environment variables parse and validate'));
    console.error(error instanceof Error ? error.message : String(error));
    console.log(
      red(
        'Configuration is invalid, so no service checks were run. Fix the variables above and run again.',
      ),
    );
    return 1;
  }

  // Local-only conveniences that should warn rather than fail.
  if (env.APP_ENV === 'local' && env.SUPABASE_DB_PASSWORD === undefined) {
    record(
      'config',
      'SUPABASE_DB_PASSWORD present for local migrations',
      'warn',
      'Not set. Fine until you run `supabase db push`, which will then prompt or fail.',
    );
  }

  if (env.APP_ENV !== 'production' && env.SEND_ENABLED) {
    record(
      'config',
      'Send switch state',
      'warn',
      `SEND_ENABLED is true outside production. Sending is confined to the ${env.ALLOWED_TEST_NUMBERS.length} allowlisted number(s): ${env.ALLOWED_TEST_NUMBERS.join(', ')}`,
    );
  }

  // Show the working-hours window resolved through the configured timezone, so
  // a wrong timezone is visible now rather than at 6pm on a Friday in July.
  try {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.WORKING_HOURS_TIMEZONE,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // Shows BST vs GMT, which is the whole point of configuring a zone name
      // rather than an offset.
      timeZoneName: 'short',
    }).format(now);
    record(
      'config',
      'Working hours timezone resolves',
      'pass',
      `${env.WORKING_HOURS_START}–${env.WORKING_HOURS_END} ${env.WORKING_HOURS_TIMEZONE}; right now there it is ${formatted}`,
    );
  } catch (error) {
    record('config', 'Working hours timezone resolves', 'fail', describeError(error));
  }

  /* ------------------------------------------------------------- 2. Supabase */

  section('2. Supabase');

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Cheapest authenticated call that works against an empty project: the
    // admin user list. Requires the service_role key; the anon key returns 401.
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      // supabase-js flattens transport failures to "fetch failed"; the URL is
      // what makes that actionable.
      const transport =
        error.message === 'fetch failed'
          ? ` — could not reach ${env.NEXT_PUBLIC_SUPABASE_URL}. Check NEXT_PUBLIC_SUPABASE_URL and that the project is not paused.`
          : '';
      record(
        'supabase',
        'Service role key authenticates',
        'fail',
        `${error.message}${error.status === undefined || error.status === 0 ? '' : ` (HTTP ${String(error.status)})`}${transport}`,
      );
    } else {
      record(
        'supabase',
        'Service role key authenticates',
        'pass',
        `auth.admin.listUsers returned ${data.users.length} user(s) on page 1`,
      );
    }
  } catch (error) {
    record('supabase', 'Service role key authenticates', 'fail', describeError(error));
  }

  try {
    // The anon key is validated separately: it is the one the browser uses, and
    // a project can easily have a valid service key and a stale anon key.
    const result = await request(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
    });
    if (result.ok) {
      record('supabase', 'Anon key authenticates', 'pass', `PostgREST responded ${result.status}`);
    } else {
      record(
        'supabase',
        'Anon key authenticates',
        'fail',
        `HTTP ${result.status} from ${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/ — ${snippet(result)}`,
      );
    }
  } catch (error) {
    record('supabase', 'Anon key authenticates', 'fail', describeError(error));
  }

  {
    // Cheap consistency check, no network: the project ref must match the URL.
    const host = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname;
    const refFromUrl = host.split('.')[0] ?? '';
    if (refFromUrl === env.SUPABASE_PROJECT_REF) {
      record('supabase', 'Project ref matches project URL', 'pass', env.SUPABASE_PROJECT_REF);
    } else {
      record(
        'supabase',
        'Project ref matches project URL',
        'fail',
        `SUPABASE_PROJECT_REF is "${env.SUPABASE_PROJECT_REF}" but NEXT_PUBLIC_SUPABASE_URL points at "${refFromUrl}". Migrations and the app would target different projects.`,
      );
    }
  }

  /* --------------------------------------------------------------- 3. Twilio */

  section('3. Twilio');

  const TWILIO_API = 'https://api.twilio.com';
  const accountAuth = basicAuth(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const apiKeyAuth =
    env.TWILIO_API_KEY_SID !== undefined && env.TWILIO_API_KEY_SECRET !== undefined
      ? basicAuth(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET)
      : undefined;

  try {
    // Fetch the account using the AUTH TOKEN specifically. The token is what
    // signs inbound webhooks, so its validity has to be proven on its own —
    // an API key working tells you nothing about it.
    const result = await request(
      `${TWILIO_API}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`,
      { headers: { Authorization: accountAuth } },
    );
    if (result.ok) {
      const account = result.body as { friendly_name?: string; status?: string; type?: string };
      const status = account.status ?? 'unknown';
      record(
        'twilio',
        'Account SID + auth token authenticate',
        status === 'active' ? 'pass' : 'fail',
        `"${account.friendly_name ?? '(unnamed)'}" — type ${account.type ?? 'unknown'}, status ${status}${
          status === 'active' ? '' : '. A suspended or closed account cannot send.'
        }`,
      );
    } else {
      record(
        'twilio',
        'Account SID + auth token authenticate',
        'fail',
        `HTTP ${result.status} — ${snippet(result)}`,
      );
    }
  } catch (error) {
    record('twilio', 'Account SID + auth token authenticate', 'fail', describeError(error));
  }

  if (apiKeyAuth === undefined) {
    record(
      'twilio',
      'API key authenticates',
      'skip',
      'TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET not set — outbound calls will use the auth token. Supported, but the token then cannot be rotated independently.',
    );
  } else {
    try {
      const result = await request(
        `${TWILIO_API}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`,
        { headers: { Authorization: apiKeyAuth } },
      );
      record(
        'twilio',
        'API key authenticates',
        result.ok ? 'pass' : 'fail',
        result.ok
          ? `${env.TWILIO_API_KEY_SID} is valid for account ${env.TWILIO_ACCOUNT_SID}`
          : `HTTP ${result.status} — ${snippet(result)}`,
      );
    } catch (error) {
      record('twilio', 'API key authenticates', 'fail', describeError(error));
    }
  }

  // The WhatsApp sender is checked separately from the account: an account can
  // be perfectly healthy and simply not own the number in the config.
  await checkWhatsAppSender();

  async function checkWhatsAppSender(): Promise<void> {
    const wanted = env.TWILIO_WHATSAPP_NUMBER;
    const auth = apiKeyAuth ?? accountAuth;
    const attempts: string[] = [];

    // Twilio's WhatsApp sandbox number, which is shared and never appears on
    // an account's own sender or phone-number lists.
    if (wanted === '+14155238886') {
      record(
        'twilio',
        'WhatsApp sender exists on the account',
        'warn',
        'This is the Twilio WhatsApp sandbox number. Fine for development — recipients must have joined the sandbox — but it cannot be used in production.',
      );
      return;
    }

    // 1. The WhatsApp Senders API — the authoritative source once a sender is
    //    registered through Twilio's Senders flow.
    try {
      const result = await request(
        'https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=100',
        { headers: { Authorization: auth } },
      );
      if (result.ok) {
        const senders =
          (result.body as { senders?: { sender_id?: string; status?: string }[] }).senders ?? [];
        const match = senders.find((s) => s.sender_id === `whatsapp:${wanted}`);
        if (match) {
          // Senders API statuses: CREATING, ONLINE, OFFLINE, PENDING_VERIFICATION,
          // VERIFYING, ONLINE:UPDATING, TWILIO_REVIEW, DRAFT, STUBBED.
          const online = match.status?.startsWith('ONLINE') === true;
          record(
            'twilio',
            'WhatsApp sender exists on the account',
            online ? 'pass' : 'warn',
            `Found ${wanted} in the WhatsApp Senders list with status ${match.status ?? 'unknown'}${
              online ? '' : '. It will not send until it reaches ONLINE.'
            }`,
          );
          return;
        }
        attempts.push(
          `WhatsApp Senders API returned ${senders.length} sender(s), none matching whatsapp:${wanted}${
            senders.length > 0
              ? ` (found: ${senders.map((s) => s.sender_id ?? '?').join(', ')})`
              : ''
          }`,
        );
      } else {
        attempts.push(`WhatsApp Senders API: HTTP ${result.status} — ${snippet(result, 120)}`);
      }
    } catch (error) {
      attempts.push(`WhatsApp Senders API: ${describeError(error)}`);
    }

    // 2. Fall back to the account's incoming phone numbers. A WhatsApp sender
    //    registered against a Twilio-owned number shows up here.
    try {
      const result = await request(
        `${TWILIO_API}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(wanted)}`,
        { headers: { Authorization: auth } },
      );
      if (result.ok) {
        const numbers =
          (result.body as { incoming_phone_numbers?: { phone_number?: string; friendly_name?: string }[] })
            .incoming_phone_numbers ?? [];
        const match = numbers.find((n) => n.phone_number === wanted);
        if (match) {
          record(
            'twilio',
            'WhatsApp sender exists on the account',
            'warn',
            `${wanted} is owned by this account ("${match.friendly_name ?? 'unnamed'}") but did not appear in the WhatsApp Senders list. It is a Twilio number; WhatsApp sender registration may still be pending. Sending WhatsApp from it will fail until registration completes.`,
          );
          return;
        }
        attempts.push(`IncomingPhoneNumbers: no number matching ${wanted} on the account`);
      } else {
        attempts.push(`IncomingPhoneNumbers: HTTP ${result.status} — ${snippet(result, 120)}`);
      }
    } catch (error) {
      attempts.push(`IncomingPhoneNumbers: ${describeError(error)}`);
    }

    record(
      'twilio',
      'WhatsApp sender exists on the account',
      'fail',
      `TWILIO_WHATSAPP_NUMBER (${wanted}) could not be found on account ${env.TWILIO_ACCOUNT_SID}. Checked: ${attempts.join(' | ')}`,
    );
  }

  if (env.TWILIO_MESSAGING_SERVICE_SID === undefined) {
    record(
      'twilio',
      'Messaging Service',
      'skip',
      'TWILIO_MESSAGING_SERVICE_SID not set — sending goes direct from the number. Supported.',
    );
  } else {
    try {
      const result = await request(
        `https://messaging.twilio.com/v1/Services/${env.TWILIO_MESSAGING_SERVICE_SID}`,
        { headers: { Authorization: apiKeyAuth ?? accountAuth } },
      );
      const service = result.body as { friendly_name?: string };
      record(
        'twilio',
        'Messaging Service exists',
        result.ok ? 'pass' : 'fail',
        result.ok
          ? `"${service.friendly_name ?? '(unnamed)'}"`
          : `HTTP ${result.status} — ${snippet(result)}`,
      );
    } catch (error) {
      record('twilio', 'Messaging Service exists', 'fail', describeError(error));
    }
  }

  /* --------------------------------------------------------------- 4. Monday */

  section('4. Monday.com');

  try {
    const query = `
      query CheckBoard($boardIds: [ID!]) {
        boards(ids: $boardIds) {
          id
          name
          groups { id title }
          columns { id title type settings_str }
        }
      }
    `;
    const result = await request('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        Authorization: env.MONDAY_API_TOKEN,
        'Content-Type': 'application/json',
        'API-Version': '2024-10',
      },
      body: JSON.stringify({ query, variables: { boardIds: [env.MONDAY_BOARD_ID] } }),
    });

    interface MondayBoard {
      id: string;
      name: string;
      groups: { id: string; title: string }[];
      columns: { id: string; title: string; type: string; settings_str: string }[];
    }
    const payload = result.body as
      | { data?: { boards?: MondayBoard[] }; errors?: { message?: string }[]; error_message?: string }
      | undefined;

    const graphqlErrors = payload?.errors?.map((e) => e.message ?? '(no message)').join('; ');

    if (!result.ok || graphqlErrors !== undefined || payload?.error_message !== undefined) {
      record(
        'monday',
        'API token authenticates and board is readable',
        'fail',
        `HTTP ${result.status}${graphqlErrors === undefined ? '' : ` — ${graphqlErrors}`}${
          payload?.error_message === undefined ? '' : ` — ${payload.error_message}`
        }${graphqlErrors === undefined && payload?.error_message === undefined ? ` — ${snippet(result)}` : ''}`,
      );
    } else {
      const board = payload?.data?.boards?.[0];
      if (board === undefined) {
        record(
          'monday',
          'API token authenticates and board is readable',
          'fail',
          `Board ${env.MONDAY_BOARD_ID} returned no result. Either the id is wrong or the token's user cannot see the board.`,
        );
      } else {
        record(
          'monday',
          'API token authenticates and board is readable',
          'pass',
          `Board ${board.id} is "${board.name}" (${board.groups.length} groups, ${board.columns.length} columns)`,
        );

        // The status column and the qualified label are the trigger for entry
        // into the system. A near-miss here fails silently forever, so it is
        // worth one extra field on a query we are already making.
        const statusColumn = board.columns.find((c) => c.id === env.MONDAY_STATUS_COLUMN_ID);
        if (statusColumn === undefined) {
          record(
            'monday',
            'Status column exists',
            'fail',
            `No column with id "${env.MONDAY_STATUS_COLUMN_ID}" on board ${board.id}. Status-type columns present: ${
              board.columns
                .filter((c) => c.type === 'status' || c.type === 'color')
                .map((c) => `${c.id} ("${c.title}")`)
                .join(', ') || 'none'
            }`,
          );
        } else {
          record(
            'monday',
            'Status column exists',
            'pass',
            `${statusColumn.id} is "${statusColumn.title}" (type ${statusColumn.type})`,
          );

          let labels: string[] = [];
          try {
            const settings = JSON.parse(statusColumn.settings_str) as {
              labels?: Record<string, string>;
            };
            labels = Object.values(settings.labels ?? {}).filter((l) => l !== '');
          } catch {
            labels = [];
          }

          if (labels.length === 0) {
            record(
              'monday',
              'Qualified status label exists',
              'warn',
              `Could not read the labels for column ${statusColumn.id}, so "${env.MONDAY_QUALIFIED_STATUS_LABEL}" could not be verified.`,
            );
          } else if (labels.includes(env.MONDAY_QUALIFIED_STATUS_LABEL)) {
            record(
              'monday',
              'Qualified status label exists',
              'pass',
              `"${env.MONDAY_QUALIFIED_STATUS_LABEL}" is a label on ${statusColumn.id}`,
            );
          } else {
            record(
              'monday',
              'Qualified status label exists',
              'fail',
              `"${env.MONDAY_QUALIFIED_STATUS_LABEL}" is not a label on ${statusColumn.id}. It must match exactly. Available: ${labels.map((l) => `"${l}"`).join(', ')}`,
            );
          }
        }

        // Excluded groups are the commercial safety rail: a lead sold to
        // another operator must never be reachable. A typo'd group id silently
        // disables that protection.
        const groupIds = new Set(board.groups.map((g) => g.id));
        const unknownGroups = env.MONDAY_EXCLUDED_GROUP_IDS.filter((id) => !groupIds.has(id));
        if (unknownGroups.length === 0) {
          record(
            'monday',
            'Excluded group ids exist on the board',
            'pass',
            env.MONDAY_EXCLUDED_GROUP_IDS.map((id) => {
              const group = board.groups.find((g) => g.id === id);
              return `${id} ("${group?.title ?? '?'}")`;
            }).join(', '),
          );
        } else {
          record(
            'monday',
            'Excluded group ids exist on the board',
            'fail',
            `Not on board ${board.id}: ${unknownGroups.join(', ')}. An excluded group id that does not exist silently excludes nothing — these groups hold leads that may have been sold to other operators. Board groups: ${board.groups
              .map((g) => `${g.id} ("${g.title}")`)
              .join(', ')}`,
          );
        }
      }
    }
  } catch (error) {
    record('monday', 'API token authenticates and board is readable', 'fail', describeError(error));
  }

  /* --------------------------------------------------------------- 5. Resend */

  section('5. Resend');

  try {
    const result = await request('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });

    if (!result.ok) {
      record(
        'resend',
        'API key is valid',
        'fail',
        `HTTP ${result.status} — ${snippet(result)}`,
      );
    } else {
      const domains =
        (result.body as { data?: { name?: string; status?: string }[] }).data ?? [];
      record(
        'resend',
        'API key is valid',
        'pass',
        `${domains.length} domain(s) on the account${
          domains.length > 0
            ? `: ${domains.map((d) => `${d.name ?? '?'} (${d.status ?? '?'})`).join(', ')}`
            : ''
        }`,
      );

      // A key that works but a from-domain that is not verified fails at the
      // first alert, which is exactly when you need the alert.
      const fromDomain =
        env.ALERT_EMAIL_FROM.replace(/^.*<|>.*$/g, '').split('@')[1]?.toLowerCase() ?? '';
      const match = domains.find((d) => d.name?.toLowerCase() === fromDomain);
      if (match === undefined) {
        record(
          'resend',
          'ALERT_EMAIL_FROM domain is verified',
          'fail',
          `"${fromDomain}" is not among the domains on this Resend account, so alert emails will be rejected at send time. Add and verify it at https://resend.com/domains.`,
        );
      } else if (match.status !== 'verified') {
        record(
          'resend',
          'ALERT_EMAIL_FROM domain is verified',
          'fail',
          `"${fromDomain}" is on the account but its status is "${match.status ?? 'unknown'}", not "verified". DNS records are probably still outstanding.`,
        );
      } else {
        record('resend', 'ALERT_EMAIL_FROM domain is verified', 'pass', fromDomain);
      }
    }
  } catch (error) {
    record('resend', 'API key is valid', 'fail', describeError(error));
  }

  /* -------------------------------------------------------------- 6. Summary */

  const counts = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    warn: results.filter((r) => r.status === 'warn').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };

  section('Summary');
  console.log(
    `  ${green(`${counts.pass} passed`)}   ${counts.fail > 0 ? red(`${counts.fail} failed`) : `${counts.fail} failed`}   ${
      counts.warn > 0 ? yellow(`${counts.warn} warnings`) : `${counts.warn} warnings`
    }   ${dim(`${counts.skip} skipped`)}`,
  );

  if (counts.fail > 0) {
    console.log('');
    console.log(red(bold('Failures:')));
    for (const result of results.filter((r) => r.status === 'fail')) {
      console.log(`  ${red('•')} [${result.service}] ${result.name}`);
      console.log(`    ${dim(result.detail)}`);
    }
    console.log('');
    console.log(red('Phase 0a is not complete until every check passes.'));
    return 1;
  }

  console.log('');
  console.log(green(bold('All service checks passed.')));
  if (counts.warn > 0) {
    console.log(yellow('Warnings above are non-blocking but worth reading.'));
  }
  console.log('');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('');
    console.error(red('check-env crashed:'));
    console.error(describeError(error));
    process.exitCode = 1;
  });
