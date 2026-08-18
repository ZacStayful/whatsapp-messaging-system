/**
 * Monday board mapping — the single source of truth.
 *
 * Column and group ids appear here and nowhere else. They are opaque strings
 * (`text_mm459b8j`, `group_mkwtw6he`) that carry no meaning at the call site, so
 * one inlined anywhere else in the codebase is a bug waiting to be untraceable.
 *
 * Verified against board 5891626711 on 18 August 2026. The board carries roughly
 * 80 columns; only the ones below are ever requested — Monday's API budget is
 * complexity-point based, so asking for all 80 on every sync is expensive for no
 * benefit.
 */

/** Management Leads. Also configured as MONDAY_BOARD_ID; this is the documented default. */
export const MANAGEMENT_LEADS_BOARD_ID = '5891626711';

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Columns Monday owns. The app reads these and never writes them.
 */
export const MONDAY_OWNED_COLUMNS = {
  shortName: 'text_mm459b8j',
  email: 'text_mkygb5xx',
  phone: 'phone_mm1hp0a8',
  /** A second, free-text phone field maintained by the existing n8n flow. */
  textNumberFormat: 'text_mm1jzzzc',
  address: 'text6',
  shortenedAddress: 'text_mm45w5nr',
  bedrooms: 'text5',
  monthlyFigure: 'text_mm26pf4c',
  annualFigure: 'text_mm2dc5ka',
  leadProfile: 'text_mm1x8cgy',
  qualifiedScore: 'color_mm4t61wc',
  dateAdded: 'date',
  leadLastResponse: 'date_mm1nmb17',
  callBrief: 'long_text_mm2tp6aw',
  noAnswerCount: 'numeric_mm2tj6ny',
  agreement: 'file_mm2cqjjh',
} as const;

/**
 * The status column. Shared ownership: both Monday and the app may write it,
 * last write wins, every change logged to `sync_log`.
 */
export const STATUS_COLUMN_ID = 'status5';

/**
 * WhatsApp tracking columns that already exist on the board, written today by
 * the existing n8n flow.
 *
 * OPEN ITEM — see §3 of the build plan. Either this app takes these columns over
 * and the n8n WhatsApp flow is retired, or two systems write the same columns
 * and the data is untrustworthy within days. Nothing here is written before
 * Phase 4, and not at all until that call is made.
 */
export const APP_OWNED_COLUMNS = {
  smsStatus: 'color_mm3j9rd4',
  smsConversation: 'long_text_mm3jj9fg',
  smsTemplateUsed: 'text_mm3jr05s',
  smsMessagesSent: 'numeric_mm3jrh70',
  smsReplies: 'numeric_mm3j1dff',
  smsFirstSent: 'date_mm3jbstp',
  smsLastReply: 'date_mm3jzdca',
  waCompleted: 'boolean_mm3jfr4g',
  lastText: 'date_mm1jj0vr',
} as const;

/** Every column the sync requests. Never ask Monday for more than this. */
export const SYNCED_COLUMN_IDS: readonly string[] = [
  ...Object.values(MONDAY_OWNED_COLUMNS),
  STATUS_COLUMN_ID,
];

/* -------------------------------------------------------------------------- */
/* Groups                                                                     */
/* -------------------------------------------------------------------------- */

export interface GroupRule {
  readonly id: string;
  readonly title: string;
  /** Whether contacts in this group are pulled into the system at all. */
  readonly sync: boolean;
  /** Whether the send function may message contacts in this group. */
  readonly sendable: boolean;
}

/**
 * All 14 groups on the board.
 *
 * The model is: sync broadly, gate the sending. Group membership is a live
 * attribute on a contact, not an entry condition — a lead moving between groups
 * changes one field and keeps one continuous thread. Reading is cheap; sending
 * is what carries risk.
 *
 * The exceptions are the two `sync: false` groups. Leads there may have been
 * sold on to other operators, and messaging a lead you have sold puts Stayful in
 * direct conflict with the buyer. That is a commercial failure, not a technical
 * one, so those leads do not enter the system at all.
 */
export const GROUPS: readonly GroupRule[] = [
  { id: 'group_mm28ypgs', title: 'Qualified Management Leads', sync: true, sendable: true },
  { id: 'group_mksxb5m0', title: 'Web meeting booked', sync: true, sendable: true },
  { id: 'group_mksx27r4', title: 'Web meeting sat/warm', sync: true, sendable: true },
  { id: 'group_mkwx4dhv', title: 'Web meeting No show', sync: true, sendable: true },
  { id: 'group_mm16jhqm', title: 'Special offer applied', sync: true, sendable: true },
  { id: 'group_mm47p8js', title: 'Warm due to call', sync: true, sendable: true },
  { id: 'group_mm151eer', title: 'Abandoned Leads follow up flow', sync: true, sendable: true },
  { id: 'group_mm1htyz7', title: 'In the future Due to call', sync: true, sendable: true },
  { id: 'group_mkwthdxq', title: 'In the future management leads', sync: true, sendable: true },
  { id: 'group_mkwt7bfr', title: 'Abandoned Due to call', sync: true, sendable: true },

  // Sync for history, but the send gate is closed. A rep can read the thread.
  { id: 'group_mkwtw6he', title: 'Abandoned Leads', sync: true, sendable: false },
  { id: 'group_mm1dtkdm', title: 'Customer / signed', sync: true, sendable: false },

  // Sale exclusion — do not sync, do not send, ever.
  { id: 'topics', title: 'Cold Management Leads', sync: false, sendable: false },
  { id: 'group_mkwhk3z9', title: 'Leads that can be sold', sync: false, sendable: false },
];

const GROUPS_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

/* -------------------------------------------------------------------------- */
/* Status labels                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The `status5` label marking a lead as sold, or for sale, to another operator.
 *
 * The sale exclusion has to be evaluated on both axes. This label can sit on an
 * item in any group, so group membership alone is not sufficient protection: a
 * lead sitting in Qualified Management Leads with this status must still be
 * excluded.
 */
export const FOR_SALE_STATUS_LABEL = 'Lead for sale';

/**
 * The label that admits a lead to the system.
 *
 * Verified on the board: the label is "Qualified lead". There is no label called
 * simply "Qualified". Configurable via MONDAY_QUALIFIED_STATUS_LABEL because it
 * is the kind of thing that gets renamed in the Monday UI without warning.
 */
export const DEFAULT_QUALIFIED_STATUS_LABEL = 'Qualified lead';

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a contact may be pulled into the system at all.
 *
 * Excluded on either axis:
 *   - group is Cold Management Leads or Leads that can be sold, OR
 *   - status5 is "Lead for sale"
 *
 * An unknown group id is treated as excluded. If someone adds a group to the
 * board, the safe default is that its leads do not enter the system until
 * somebody decides they should — not that they are silently swept in.
 */
export function isSyncable(groupId: string, statusLabel: string | null): boolean {
  if (statusLabel === FOR_SALE_STATUS_LABEL) return false;
  return GROUPS_BY_ID.get(groupId)?.sync ?? false;
}

/**
 * Whether the send function may message a contact in this group.
 *
 * This is one of several conditions checked at send time — opt-out status, a
 * valid phone number, the kill switch and the environment allowlist all apply
 * too. Never call this on its own as a permission check.
 */
export function isGroupSendable(groupId: string, statusLabel: string | null): boolean {
  if (!isSyncable(groupId, statusLabel)) return false;
  return GROUPS_BY_ID.get(groupId)?.sendable ?? false;
}

export function groupTitle(groupId: string): string {
  return GROUPS_BY_ID.get(groupId)?.title ?? `(unknown group ${groupId})`;
}
