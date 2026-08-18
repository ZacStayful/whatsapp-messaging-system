# Environment setup

Everything needed to get from a fresh clone to a working `.env.local`. Work top
to bottom; each section says exactly which console screen the value comes from.

Budget about 45 minutes if you already have access to all four accounts. Twilio
WhatsApp sender registration is the one thing that cannot be done in a sitting —
see [§8](#8-if-the-twilio-whatsapp-sender-is-not-registered-yet).

```bash
git clone git@github.com:ZacStayful/whatsapp-messaging-system.git
cd whatsapp-messaging-system
npm install
cp .env.example .env.local
# fill in .env.local as you work through this document
npm run check-env
```

`npm run check-env` is the finish line. It validates every value, then makes one
authenticated call to each of Supabase, Twilio, Monday and Resend and prints the
real error for anything that fails. It exits non-zero if anything is wrong.

---

## How configuration works here

- **Everything is validated at boot.** `src/lib/env.ts` parses the whole
  environment when it is first imported. A missing or malformed variable stops
  the process with a list of *every* problem at once, not one per restart.
- **Nothing reads `process.env` directly.** Server code imports `env` from
  `@/lib/env`; Client Components import `clientEnv` from `@/lib/env.client`.
  ESLint fails the build on any other `process.env` access.
- **Secrets cannot reach the browser.** `env.ts` is marked `server-only`, so
  importing it from a Client Component fails the build, and `clientEnv`'s type
  contains only the `NEXT_PUBLIC_*` keys, so reading a secret in the browser is
  a TypeScript error. On top of that, the boot refuses to proceed if any
  `NEXT_PUBLIC_*` variable holds a credential's value or has a credential-shaped
  name.
- **`.env.local` is git-ignored.** `.env.example` is the only `.env*` file that
  is ever committed, and it holds no real values.

### The three that must never reach the browser

`SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_AUTH_TOKEN`, `MONDAY_API_TOKEN`.

Between them they bypass row-level security, sign every inbound webhook, and
grant full read/write on the leads board. None of them is ever prefixed
`NEXT_PUBLIC_`, passed to a Client Component, or logged. If one is ever
committed or pasted somewhere public, rotate it — do not reason about whether it
was actually exposed.

### Which values differ per environment

| Environment | `APP_ENV` | Notes |
|---|---|---|
| Your machine | `local` | Webhooks resolve through the Cloudflare tunnel on the Mac Mini. |
| Vercel preview | `preview` | `NODE_ENV` is `production` here — which is why `APP_ENV` exists separately. |
| Vercel production | `production` | The only tier where the send allowlist is not enforced. |

Marked **per-env** below: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_PROJECT_REF`, `APP_ENV`, `NEXT_PUBLIC_APP_URL`, `WEBHOOK_BASE_URL`,
`ALLOWED_TEST_NUMBERS`, `SEND_ENABLED`, `CRON_SECRET`.

Everything else is the same value everywhere.

---

## 1. Supabase

Dashboard: <https://supabase.com/dashboard> → select the project.

### `NEXT_PUBLIC_SUPABASE_URL` — client-safe, required, per-env

**Project Settings → Data API → Project URL.**

Looks like `https://abcdefghijklmnopqrst.supabase.co`. Must be `https`. A
trailing slash is stripped automatically.

### `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client-safe, required, per-env

**Project Settings → API Keys → `anon` `public`** (newer projects call this the
*publishable* key and it starts `sb_publishable_`; older ones give a JWT
starting `eyJ`). Either format is accepted.

Safe in the browser by design: it carries no privileges beyond what row-level
security grants. The boot rejects it if it is actually a service-role key.

### `SUPABASE_SERVICE_ROLE_KEY` — **secret**, required, per-env

**Project Settings → API Keys → `service_role` `secret`** (newer projects:
*secret* key, starting `sb_secret_`).

**This key bypasses row-level security entirely.** Server-side only, always.
Never in a `NEXT_PUBLIC_` variable, never in client code, never in a commit.
The boot checks that it really is a service-role key and that it is not the same
string as the anon key.

### `SUPABASE_PROJECT_REF` — required, per-env

The 20-character project ref. It is the first label of the project URL — for
`https://abcdefghijklmnopqrst.supabase.co` the ref is `abcdefghijklmnopqrst`.
Also shown at **Project Settings → General → Reference ID**.

Used by the Supabase CLI and by migrations. `check-env` confirms it matches
`NEXT_PUBLIC_SUPABASE_URL`, so migrations cannot silently target one project
while the app talks to another.

### `SUPABASE_DB_PASSWORD` — **secret**, optional, local only

The database password chosen when the project was created. If it has been lost:
**Project Settings → Database → Database password → Reset database password**
(this rotates it; anything else using it will need updating).

Needed only for `supabase db push` and other CLI migration commands. **Do not
set this in Vercel** — the app never connects to Postgres directly. `check-env`
warns rather than fails when it is missing locally.

---

## 2. Twilio

Console: <https://console.twilio.com>

### `TWILIO_ACCOUNT_SID` — required

**Console dashboard → Account Info → Account SID.** Starts `AC`, 34 characters.

### `TWILIO_AUTH_TOKEN` — **secret**, required

**Console dashboard → Account Info → Auth Token** (click to reveal).
32 hexadecimal characters.

Required even though outbound calls use an API key. Twilio signs the
`X-Twilio-Signature` header on inbound webhooks with this token, and every
inbound request is verified against it. Without it, the webhook endpoints cannot
tell a real Twilio request from anyone else's POST.

### `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` — optional pair, secret

**Account → API keys & tokens → Create API key.** Choose a **Standard** key,
region **United States (US1)** unless the account says otherwise.

Set both or neither — the boot rejects one without the other. When set, outbound
API calls use the API key, so the auth token can be rotated (after a webhook
signature incident, say) without taking sending down. When unset, outbound calls
fall back to the auth token; `check-env` reports this as a skipped check rather
than a failure.

**The secret is displayed exactly once, at creation.** If it is lost, delete the
key and make a new one.

### `TWILIO_WHATSAPP_NUMBER` — required, E.164

The WhatsApp sender: **Messaging → Senders → WhatsApp senders**.

- Must be E.164: leading `+`, country code, digits only. `+447700900123`.
- **Not** `07700900123`, and **not** `+4407700900123` — the second is the country
  code plus the national trunk zero, which passes a naive regex and is then
  rejected by Twilio at send time. The boot rejects both.
- This is the **WhatsApp** number, not the voice line. They are different
  numbers on purpose.

During development this may be the Twilio WhatsApp **sandbox** number,
`+14155238886`. `check-env` recognises it and passes with a warning; recipients
must have joined the sandbox by sending its join code, and it cannot be used in
production.

### `TWILIO_MESSAGING_SERVICE_SID` — optional

**Messaging → Services →** your service. Starts `MG`, 34 characters.

Leave unset if you are not using a Messaging Service; sending then goes direct
from the number. Absence is a supported configuration, not an error.

---

## 3. Monday.com

<https://stayful.monday.com>

### `MONDAY_API_TOKEN` — **secret**, required

**Avatar (bottom left) → Developers → My Access Tokens**, or
**Avatar → Administration → Connections → API**. This is a personal API v2
token, so it carries the permissions of whoever generated it — generate it from
an account that can see the Management Leads board and will not be deactivated.

### `MONDAY_BOARD_ID` — required

`5891626711` (Management Leads). Numeric only. It is the number in the board
URL: `https://stayful.monday.com/boards/5891626711`.

### `MONDAY_WEBHOOK_SIGNING_SECRET` — **secret**, required

The signing secret for the Monday integration that posts webhooks to this app.
Found with the app's credentials in **Developers → your app → Basic
Information → Signing Secret**.

Monday signs inbound webhook requests as a JWT; this verifies them. Note also
that Monday's *first* request to a new webhook URL is a challenge payload that
must be echoed back in the response — that is handled in Phase 1, not here.

### `MONDAY_STATUS_COLUMN_ID` — required

`status5`. The id, not the title. `check-env` confirms a column with this id
exists on the board and, if not, lists the status-type columns that do.

### `MONDAY_QUALIFIED_STATUS_LABEL` — required

The exact label text that admits a lead to the system.

**It must match Monday character for character, including capitalisation.** A
near miss does not error — it simply never fires, and the failure looks like
nothing happening. `check-env` reads the column's labels and tells you the exact
available set if yours is not among them.

To read the labels yourself: open the board, click the Status column header →
**Settings → Edit labels**.

### `MONDAY_EXCLUDED_GROUP_IDS` — required

Comma-separated group ids that must never sync and must never be messaged:

| Group id | Title | Why excluded |
|---|---|---|
| `topics` | Cold Management Leads | Triage stage — leads here may be sold to other operators. |
| `group_mkwhk3z9` | Leads that can be sold | As above. |
| `group_mkwtw6he` | Abandoned Leads | Syncs for history, but the send gate is closed. |
| `group_mm1dtkdm` | Customer / signed | Syncs for history, but the send gate is closed. |

**This is a commercial safety rail, not a filter.** Messaging a lead that has
been sold to another operator puts Stayful in direct conflict with the buyer.
`check-env` verifies every id actually exists on the board, because a typo'd
group id silently excludes nothing.

To read group ids: open the board and use the API, or check the group's URL
fragment when you open it.

---

## 4. Resend

<https://resend.com>

### `RESEND_API_KEY` — **secret**, required

**API Keys → Create API Key.** Sending permission is enough. Starts `re_`, and
is shown exactly once.

### `ALERT_EMAIL_TO` — required

`zac@stayful.co.uk`. Where out-of-hours reply digests and system alerts go.

### `ALERT_EMAIL_FROM` — required

`zac@stayful.co.uk` — the same address the alerts go to, so replies land back in
your inbox. A display-name form (`Name <address@domain.com>`) is also accepted if
you ever want one.

**Its domain must be verified in Resend → Domains** — status `verified`, with
the DKIM and SPF records published in DNS. An unverified domain does not fail at
boot; it fails at the moment the first alert is sent, which is exactly when you
need the alert. `check-env` checks this explicitly.

---

## 5. Application

### `APP_ENV` — required, per-env

`local`, `preview` or `production`. Nothing else.

Deliberately separate from `NODE_ENV`: `next build` sets `NODE_ENV=production`
on preview deployments too, and preview must not behave like production — most
importantly, it must still enforce the send allowlist.

### `NEXT_PUBLIC_APP_URL` — client-safe, required, per-env

Base URL of this app, used for deep links in alert emails so a notification
takes you straight to the thread.

| Environment | Value |
|---|---|
| local | `http://localhost:3000` |
| preview | the Vercel preview URL |
| production | `https://<your-domain>` |

Must be `https` in production.

### `WEBHOOK_BASE_URL` — required, per-env

The public URL that Twilio and Monday webhooks resolve to.

**In local development this is the Cloudflare tunnel hostname on the Mac Mini,
not `localhost`.** Neither provider can reach your machine directly. The boot
rejects a localhost value outright, because the resulting failure — webhooks
registering fine and then simply never arriving — is very hard to read.

In preview and production this is the same host as `NEXT_PUBLIC_APP_URL`.

### `ALLOWED_TEST_NUMBERS` — required outside production, per-env

Comma-separated E.164 numbers, e.g. `+447700900000,+447700900123`.

**This is the safety rail.** When `APP_ENV` is not `production`, the send
function refuses any number not on this list. The check lives inside the send
function, not in the UI, so no code path can route around it.

Put your own mobile here and nothing else until there is a reason to add more.
Accidentally messaging a real lead during development burns the WhatsApp quality
rating on a number that takes weeks to replace.

The boot refuses to start if this is unset outside production.

### `SEND_ENABLED` — optional, defaults `false`, per-env

`true` or `false`. The boot-time master kill switch for all outbound sending.

Unset means `false`. A missing value must never mean "sending is on". A
database-level switch — the one to flip in an incident — arrives in a later
phase; this is the one that stops a bad deploy sending anything at all.

Setting it `true` outside production without an allowlist is refused at boot.

### `WORKING_HOURS_START` / `WORKING_HOURS_END` — required

`09:00` and `17:00`. 24-hour `HH:MM`. End must be later than start; overnight
windows are not supported.

Inside working hours there are no email notifications — the reps are in the app.
Outside them, inbound replies are batched into a digest to `ALERT_EMAIL_TO`.

### `WORKING_HOURS_TIMEZONE` — required

`Europe/London`. An IANA `Region/City` name.

Abbreviations and offsets are rejected, and the reason is worth knowing:
JavaScript's `Intl` silently accepts `"BST"` and resolves it to **Asia/Dhaka**,
and accepts `"GMT"` and resolves it to UTC. Either would put the out-of-hours
logic hours out, all year, with no error anywhere. Only a region name carries
the daylight-saving rules, and a naive UTC comparison is an hour wrong for seven
months of the year.

### `CRON_SECRET` — **secret**, required, per-env

Shared secret authenticating Vercel cron invocations of the queue worker.
At least 16 characters. Generate one:

```bash
openssl rand -hex 32
```

Use a different value in each environment.

---

## 6. Deferred — leave commented out

`CALENDLY_API_TOKEN`, `CALENDLY_WEBHOOK_SIGNING_KEY`, `SENTRY_DSN`.

These are declared as explicitly optional in `src/lib/env.ts` so that their
absence degrades a feature that is not built yet, rather than failing the boot.
Leave them commented out in `.env.local` until the feature they belong to
arrives.

---

## 7. Verify

```bash
npm run check-env
```

It runs in two stages.

**Stage one — configuration.** Parses everything. If anything is missing or
malformed it prints every problem at once, with the variable name, its purpose,
what it is currently set to (secrets redacted) and what is wrong, then stops
without making any network calls.

**Stage two — connectivity.** One cheap authenticated call per service:

| Service | Check |
|---|---|
| Supabase | Service-role key authenticates (`auth.admin.listUsers`); anon key authenticates against PostgREST; project ref matches the project URL |
| Twilio | Account fetched using the **auth token** specifically, and its status is `active`; API key authenticates if configured; the WhatsApp sender exists on the account; the Messaging Service exists if configured |
| Monday | Board name fetched for the configured board id; the status column exists; the qualified label exists on it; every excluded group id exists |
| Resend | API key valid; `ALERT_EMAIL_FROM`'s domain present and `verified` |

Failures print the provider's actual error, not a generic message. Warnings are
non-blocking but worth reading. Exit code is non-zero if anything failed.

**Phase 0a is complete when this passes.**

### Common failures

| What you see | What it means |
|---|---|
| `fetch failed — could not reach https://….supabase.co` | Wrong project URL, or the project is paused. Free-tier projects pause after a week of inactivity; resume it in the dashboard. |
| Twilio `20003 Authenticate` | Wrong account SID or auth token. Check you copied the token and not the SID, and that the SID belongs to the right subaccount. |
| `TWILIO_WHATSAPP_NUMBER … could not be found on account` | The number is not a registered WhatsApp sender on this account. See §8. |
| Monday `Not authenticated` | Token is wrong, expired, or was generated by a user without access to the board. |
| Monday board `returned no result` | The board id is wrong, or the token's user cannot see that board. |
| `"Qualified" is not a label on status5` | The label text differs from Monday. The error lists the exact available labels — copy one. |
| Resend `API key is invalid` | Wrong key, or it was revoked. |
| `"stayful.co.uk" is not among the domains` | The sending domain is not added to Resend, or its DNS records are still outstanding. |

---

## 8. If the Twilio WhatsApp sender is not registered yet

This is the long pole — allow two to three weeks, and start it in parallel with
the build rather than after it. It is admin, not code.

1. **Pick the number.** It must be separate from the voice line, and it must not
   already be registered with WhatsApp. If it is, it has to be deleted from
   WhatsApp first, and the message history goes with it.
2. **Check inbound routing.** A number attached to an IVR or any
   computer-operated phone system cannot receive the verification OTP, and an
   outbound-only number cannot be registered at all.
3. **Complete Meta Business verification** on the Stayful Business Manager.
4. **Create the WABA and register the sender** through Twilio.
5. **Get the display name approved.**
6. **Submit the initial templates** — cold opener, post-meeting contract chase,
   re-engagement. A day or two each, and expect at least one rejection.
7. **Register a fallback number.**

Until this is done, use the sandbox number `+14155238886` in
`TWILIO_WHATSAPP_NUMBER` for local development.

---

## 9. Vercel

Set the variables through **Project Settings → Environment Variables**, scoped
per environment. Two things to get right:

- **`SUPABASE_DB_PASSWORD` is not set in Vercel.** It exists for local CLI
  migrations only.
- **`APP_ENV` must be set explicitly for each scope** — `preview` for Preview,
  `production` for Production. Nothing infers it, and the send allowlist depends
  on it.

The deferred variables stay unset until their features land.
