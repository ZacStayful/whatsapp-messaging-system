# Phase 0 — data truth

Dry run over board 5891626711 (Management Leads), 18 August 2026. Read-only:
nothing was written to Monday and nothing was sent.

Reproduce with `npm run dry-run:phones` once `MONDAY_API_TOKEN` is set.

## The number

**143 leads are in a sendable group and have a working WhatsApp number.**

That is the population this system can talk to today. It is small, and it is the
right size — the working set was always going to be far smaller than the 1,167
items on the board.

## Population

| | Count |
|---|---|
| Items on the board | 1,167 |
| Excluded — Cold Management Leads / Leads that can be sold | 7 |
| Excluded — `status5` = "Lead for sale" | 0 |
| **Syncable into the system** | **1,160** |
| Of those, in a sendable group | 150 |
| Of those, reachable on WhatsApp | **143** |

## Phone data quality

Across all 1,160 syncable leads:

| | Count | Share |
|---|---|---|
| Reachable on WhatsApp | 1,102 | 95.0% |
| Valid but a landline — cannot receive WhatsApp | 11 | 0.9% |
| Unusable | 47 | 4.1% |
| **Needed repair to become valid E.164** | **939** | **80.9%** |

**Four numbers in five are not stored in a form Twilio would accept.** Sending
straight from the board would have failed on most of the population. What had to
be repaired:

| Count | Repair |
|---|---|
| 527 | added the GB country code (stored as `07…`) |
| 235 | removed the national trunk zero after the country code (`+4407…`) |
| 169 | added the missing `+` (stored as `447…`) |
| 8 | replaced the `00` international dialling prefix with `+` |

The 47 unusable numbers break down as 27 with no phone number at all, 10 that
could not be parsed as GB numbers, and 10 with a country code that is invalid for
it. These go to a review queue rather than being dropped — a dropped lead is
invisible, a queued one gets looked at. One lead was recovered from the
`Text Number format` column when the `Phone` column was unusable.

## Things worth knowing before Phase 1

**Cold Management Leads is nearly empty — 7 items, not the bulk of the board.**
The build plan assumed Cold was the large triage stage and Qualified the small
one. In practice the large group is **Abandoned Leads at 914 items**, which
syncs for history but is not sendable. Worth confirming that is intended: 875 of
those 914 have working WhatsApp numbers, so if Abandoned should be reachable the
addressable population goes from 143 to roughly 1,000, and that is a very
different system with very different risk.

**`Leads that can be sold` is empty**, and no lead anywhere carries the
`Lead for sale` status. The sale exclusion is in place and currently excludes 7
leads. It stays enforced on both axes regardless.

**`Abandoned Leads follow up flow` is empty (0 items)** but is configured as
sendable. Nothing to do, but the intent behind an empty sendable group is worth
confirming.

**51 numbers are shared across 112 leads** board-wide — about one lead in ten is
a duplicate record. Inside sendable groups it is only 3 numbers across 6 leads,
and all three are plainly the same person entered twice:

- Jack Macdonald / Jack
- Michael / michael
- Moyo Sankofa / Moyo Sankofa

Small enough to fix by hand on the board before go-live. Left alone, each of
those people receives every message sent to either record, which reads as a
mistake to the recipient. Phase 1 should also key contacts on `monday_item_id`
rather than phone number, so a duplicate is two contacts rather than a corrupted
single one.

**The qualified label is confirmed.** `status5` carries "Qualified lead" — there
is no label called "Qualified" — and exactly 10 leads hold it, matching the 10 in
Qualified Management Leads. `MONDAY_QUALIFIED_STATUS_LABEL` has been corrected.

**Group and status overlap but do not agree.** 829 syncable leads have status
"Abandoned" against 914 in the Abandoned Leads group, and 42 have status
"Customer" against 96 in Customer / signed. This is why the sync subscribes to
both `move_item_to_group` and `change_column_value`: tracking either one alone
would miss changes.

## What was built

- `src/lib/monday/board-config.ts` — every column and group id, in one place,
  with the sync and sendability rules. Verified against the live board.
- `src/lib/phone.ts` — the normaliser. Repairs the four known-bad shapes, refuses
  to guess, and reports what it changed. Never writes back to Monday.
- `scripts/phone-dry-run.ts` — `npm run dry-run:phones`, the report above.

## Still open

- Whether Abandoned Leads (914 leads, 875 reachable) should be sendable.
- Whether the existing n8n WhatsApp flow is retired, or two systems write the
  same nine WhatsApp columns on this board. Unresolved from the build plan; it
  blocks Phase 4, not Phase 1.
- Whether the 47 unusable numbers get a review queue in the app or a one-off
  cleanup pass on the board.
