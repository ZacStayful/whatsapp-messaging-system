# whatsapp-messaging-system

A WhatsApp messaging system for following up Stayful management leads, running
alongside the Monday.com pipeline.

**Current state: Phase 0a — environment layer only.** There is no feature code,
no database schema, no routes and no UI yet. What exists is a validated
configuration layer so every later phase starts from a known-good environment.

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run check-env              # validates config and hits all four services
```

[`ENVIRONMENT.md`](./ENVIRONMENT.md) walks through every variable: what it is,
which console screen it comes from, whether it differs per environment and
whether it is a secret. Follow it top to bottom and you finish with a working
`.env.local`.

## Scripts

| Command | Does |
|---|---|
| `npm run check-env` | Validates the environment, then makes one authenticated call to Supabase, Twilio, Monday and Resend. Exits non-zero on any failure. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint, including the rule that forbids reading `process.env` outside the env modules. |
| `npm run dev` | Next.js dev server. |
| `npm run build` | Production build. |

## Configuration

- `src/lib/env.ts` — server environment. Validates everything at import, marked
  `server-only`. Import `env` from here in server code.
- `src/lib/env.client.ts` — the public subset. The only environment module a
  Client Component may import.
- `src/lib/env.shared.ts` — schema primitives and the error formatter. No values.

Nothing else reads `process.env`; ESLint enforces it. Secrets are never prefixed
`NEXT_PUBLIC_`, and the boot refuses to start if one ever is.

## Stack

Next.js (App Router) and TypeScript strict on Vercel, Supabase for database and
auth, Twilio for WhatsApp, Monday.com for CRM sync, Resend for email.
