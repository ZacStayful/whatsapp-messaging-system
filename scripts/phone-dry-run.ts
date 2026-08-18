/**
 * `npm run dry-run:phones`
 *
 * Phase 0 — data truth. Reads every syncable lead off the Monday board, runs the
 * phone normaliser over it, and reports how many are actually reachable on
 * WhatsApp.
 *
 * Read-only. It writes nothing to Monday, nothing to Supabase, and sends
 * nothing. The normalised number is deliberately never written back to the
 * board: Monday owns the raw field.
 *
 * The number it prints is what tells you whether this project is worth building
 * on the population you have, before a line of sync code exists.
 */

import { config as loadDotenv } from 'dotenv';

import {
  GROUPS,
  groupTitle,
  isGroupSendable,
  isSyncable,
  MONDAY_OWNED_COLUMNS,
  STATUS_COLUMN_ID,
} from '../src/lib/monday/board-config';
import { isWhatsAppCapable, normalisePhone, type PhoneFailureReason } from '../src/lib/phone';

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

const rule = () => console.log(dim('─'.repeat(78)));
function heading(title: string): void {
  console.log('');
  console.log(bold(cyan(title)));
  rule();
}

const pct = (n: number, total: number) => (total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`);

/* -------------------------------------------------------------------------- */
/* Monday                                                                     */
/* -------------------------------------------------------------------------- */

interface MondayItem {
  readonly id: string;
  readonly name: string;
  readonly group: { readonly id: string } | null;
  readonly column_values: readonly {
    readonly id: string;
    readonly text: string | null;
  }[];
}

interface MondayPage {
  readonly cursor: string | null;
  readonly items: readonly MondayItem[];
}

const PAGE_SIZE = 250;

async function fetchPage(
  token: string,
  boardId: string,
  cursor: string | null,
): Promise<MondayPage> {
  // Only the columns we actually map. Monday's API budget is complexity-point
  // based, and the board carries ~80 columns — asking for all of them on every
  // page is expensive for no benefit.
  const columnIds = [MONDAY_OWNED_COLUMNS.phone, MONDAY_OWNED_COLUMNS.textNumberFormat, STATUS_COLUMN_ID];

  const query = cursor
    ? `query Next($cursor: String!, $limit: Int!, $columnIds: [String!]) {
         next_items_page(cursor: $cursor, limit: $limit) {
           cursor
           items { id name group { id } column_values(ids: $columnIds) { id text } }
         }
       }`
    : `query First($boardIds: [ID!], $limit: Int!, $columnIds: [String!]) {
         boards(ids: $boardIds) {
           items_page(limit: $limit) {
             cursor
             items { id name group { id } column_values(ids: $columnIds) { id text } }
           }
         }
       }`;

  const variables = cursor
    ? { cursor, limit: PAGE_SIZE, columnIds }
    : { boardIds: [boardId], limit: PAGE_SIZE, columnIds };

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });

  const payload = (await response.json()) as {
    data?: {
      boards?: { items_page: MondayPage }[];
      next_items_page?: MondayPage;
    };
    errors?: { message?: string }[];
  };

  if (payload.errors !== undefined) {
    throw new Error(`Monday API: ${payload.errors.map((e) => e.message ?? '?').join('; ')}`);
  }

  const page = cursor ? payload.data?.next_items_page : payload.data?.boards?.[0]?.items_page;
  if (page === undefined) {
    throw new Error(`Monday returned no items page (HTTP ${response.status}).`);
  }
  return page;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

interface GroupTally {
  total: number;
  reachable: number;
  repaired: number;
  landline: number;
  failed: number;
}

async function main(): Promise<number> {
  for (const path of ['.env.local', '.env']) {
    loadDotenv({ path, override: false, quiet: true });
  }

  const { env } = await import('../src/lib/env');

  console.log('');
  console.log(bold('Phone dry run — Phase 0, data truth'));
  console.log(dim(`Board ${env.MONDAY_BOARD_ID} · read-only · nothing is written and nothing is sent`));

  /* ------------------------------------------------------------------ Fetch */

  const items: MondayItem[] = [];
  let cursor: string | null = null;
  let pageNumber = 0;

  do {
    const page: MondayPage = await fetchPage(env.MONDAY_API_TOKEN, env.MONDAY_BOARD_ID, cursor);
    items.push(...page.items);
    cursor = page.cursor;
    pageNumber += 1;
    process.stdout.write(dim(`\r  fetched ${items.length} items (${pageNumber} pages)…`));
  } while (cursor !== null);

  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  console.log(dim(`  fetched ${items.length} items across ${pageNumber} pages`));

  /* --------------------------------------------------------------- Classify */

  const columnText = (item: MondayItem, columnId: string): string | null =>
    item.column_values.find((c) => c.id === columnId)?.text ?? null;

  const byGroup = new Map<string, GroupTally>();
  const failureReasons = new Map<PhoneFailureReason, number>();
  const repairKinds = new Map<string, number>();
  const failureSamples: { name: string; raw: string; detail: string }[] = [];
  const duplicates = new Map<string, string[]>();

  let excludedFromSale = 0;
  let excludedByGroup = 0;
  let syncable = 0;
  let sendableGroup = 0;
  let reachable = 0;
  let repairedCount = 0;
  let landlineCount = 0;
  let failedCount = 0;
  let usedFallbackColumn = 0;

  for (const item of items) {
    const groupId = item.group?.id ?? '(none)';
    const status = columnText(item, STATUS_COLUMN_ID);

    if (!isSyncable(groupId, status)) {
      if (status === 'Lead for sale') excludedFromSale += 1;
      else excludedByGroup += 1;
      continue;
    }
    syncable += 1;

    const tally = byGroup.get(groupId) ?? {
      total: 0,
      reachable: 0,
      repaired: 0,
      landline: 0,
      failed: 0,
    };
    tally.total += 1;

    const isSendableGroup = isGroupSendable(groupId, status);
    if (isSendableGroup) sendableGroup += 1;

    // The phone column first; the free-text one the n8n flow maintains is a
    // fallback, because some records have only that populated.
    const primary = columnText(item, MONDAY_OWNED_COLUMNS.phone);
    let result = normalisePhone(primary);
    if (!result.ok) {
      const fallback = columnText(item, MONDAY_OWNED_COLUMNS.textNumberFormat);
      if (fallback !== null && fallback.trim() !== '') {
        const fallbackResult = normalisePhone(fallback);
        if (fallbackResult.ok) {
          result = fallbackResult;
          usedFallbackColumn += 1;
        }
      }
    }

    if (result.ok) {
      if (result.wasRepaired) {
        tally.repaired += 1;
        repairedCount += 1;
        for (const repair of result.repairs) {
          repairKinds.set(repair, (repairKinds.get(repair) ?? 0) + 1);
        }
      }

      if (isWhatsAppCapable(result)) {
        tally.reachable += 1;
        reachable += 1;
        const seen = duplicates.get(result.e164) ?? [];
        seen.push(item.name);
        duplicates.set(result.e164, seen);
      } else {
        tally.landline += 1;
        landlineCount += 1;
      }
    } else {
      tally.failed += 1;
      failedCount += 1;
      failureReasons.set(result.reason, (failureReasons.get(result.reason) ?? 0) + 1);
      if (failureSamples.length < 15 && result.reason !== 'empty') {
        failureSamples.push({ name: item.name, raw: result.raw, detail: result.detail });
      }
    }

    byGroup.set(groupId, tally);
  }

  /* ----------------------------------------------------------------- Report */

  heading('Population');
  console.log(`  Items on the board                 ${bold(String(items.length))}`);
  console.log(
    `  Excluded — sale groups            ${excludedByGroup}  ${dim('(Cold Management Leads, Leads that can be sold)')}`,
  );
  console.log(
    `  Excluded — "Lead for sale" status ${excludedFromSale}  ${dim('(in an otherwise syncable group)')}`,
  );
  console.log(`  ${bold('Syncable into the system')}          ${bold(String(syncable))}`);
  console.log(`  Of those, in a sendable group     ${sendableGroup}`);

  heading('Phone numbers, across all syncable leads');
  console.log(
    `  ${green('Reachable on WhatsApp')}             ${bold(String(reachable))}  ${dim(pct(reachable, syncable) + ' of syncable')}`,
  );
  console.log(
    `  ${yellow('Valid but not a mobile')}            ${landlineCount}  ${dim('landline — cannot receive WhatsApp')}`,
  );
  console.log(`  ${red('Unusable')}                          ${failedCount}  ${dim(pct(failedCount, syncable))}`);
  console.log('');
  console.log(
    `  Needed repair to become valid     ${repairedCount}  ${dim(pct(repairedCount, syncable) + ' of syncable — the board is not storing E.164')}`,
  );
  if (usedFallbackColumn > 0) {
    console.log(
      `  Recovered from "Text Number format" ${usedFallbackColumn}  ${dim('primary Phone column was unusable')}`,
    );
  }

  if (repairKinds.size > 0) {
    heading('What had to be repaired');
    for (const [repair, count] of [...repairKinds].sort(([, a], [, b]) => b - a)) {
      console.log(`  ${String(count).padStart(5)}  ${repair}`);
    }
  }

  if (failureReasons.size > 0) {
    heading('Why numbers were unusable');
    const labels: Record<PhoneFailureReason, string> = {
      empty: 'no phone number on the record at all',
      too_short: 'too few digits to be a phone number',
      not_a_number: 'contains no digits',
      unparseable: 'no country code and not valid as a GB number',
      invalid_for_region: 'has a country code but is invalid for it',
      not_mobile: 'not a mobile line',
    };
    for (const [reason, count] of [...failureReasons].sort(([, a], [, b]) => b - a)) {
      console.log(`  ${String(count).padStart(5)}  ${labels[reason]}`);
    }
  }

  if (failureSamples.length > 0) {
    heading('Sample of unusable values (for the review queue)');
    for (const sample of failureSamples) {
      console.log(`  ${sample.name}`);
      console.log(`    ${dim(`raw: ${JSON.stringify(sample.raw)} — ${sample.detail}`)}`);
    }
  }

  const collisions = [...duplicates].filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    heading('Duplicate numbers');
    console.log(
      dim(
        `  ${collisions.length} number(s) appear on more than one lead. Each would receive\n  every message sent to any of them, which reads as a mistake to the recipient.`,
      ),
    );
    for (const [e164, names] of collisions.slice(0, 10)) {
      console.log(`  ${e164}  ${dim(names.join(' | '))}`);
    }
    if (collisions.length > 10) console.log(dim(`  …and ${collisions.length - 10} more`));
  }

  heading('By group');
  const rows = GROUPS.filter((g) => g.sync).map((g) => ({
    group: g,
    tally: byGroup.get(g.id) ?? { total: 0, reachable: 0, repaired: 0, landline: 0, failed: 0 },
  }));
  console.log(dim('  group                                 total  reachable  landline  unusable  sendable'));
  for (const { group, tally } of rows) {
    const name = group.title.length > 35 ? `${group.title.slice(0, 34)}…` : group.title;
    console.log(
      `  ${name.padEnd(36)}${String(tally.total).padStart(6)}${String(tally.reachable).padStart(11)}` +
        `${String(tally.landline).padStart(10)}${String(tally.failed).padStart(10)}` +
        `${(group.sendable ? '  yes' : '   no').padStart(10)}`,
    );
  }

  // Any group on the board that the config does not know about.
  const unknownGroups = [...byGroup.keys()].filter((id) => !GROUPS.some((g) => g.id === id));
  if (unknownGroups.length > 0) {
    heading('Unrecognised groups');
    console.log(
      red('  These groups exist on the board but are not in board-config.ts, so their\n  leads are excluded by default. Add them to the config or confirm exclusion.'),
    );
    for (const id of unknownGroups) console.log(`  ${id}  ${dim(groupTitle(id))}`);
  }

  const sendableReachable = rows
    .filter(({ group }) => group.sendable)
    .reduce((sum, { tally }) => sum + tally.reachable, 0);

  heading('The number');
  console.log(
    `  ${bold(green(String(sendableReachable)))} leads are in a sendable group AND have a working WhatsApp number.`,
  );
  console.log(dim(`  That is the population this system can actually talk to today.`));
  console.log('');

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('');
    console.error(red('Dry run failed:'));
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
