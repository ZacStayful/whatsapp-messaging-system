/**
 * Phone number normalisation.
 *
 * Twilio requires strict E.164. The lead board does not contain strict E.164 —
 * it contains, at least:
 *
 *   +4407700900123   country code AND the national trunk zero. Thirteen digits,
 *                    invalid, rejected by Twilio at send time.
 *   447700900123     valid digits, no leading "+".
 *   07700900123      national format.
 *   +44 7700 900123  spaces.
 *
 * The rule this module exists to enforce: a number is either confidently valid
 * and reachable, or it goes to a review queue. It is never quietly dropped and
 * never guessed at. A dropped lead is invisible; a queued one gets looked at.
 *
 * The normalised value is NOT written back to Monday. Monday owns the raw field.
 */

import { parsePhoneNumberWithError, type PhoneNumber } from 'libphonenumber-js';

/** The board is UK-based, so a bare national number is assumed to be GB. */
export const DEFAULT_REGION = 'GB' as const;

export type PhoneFailureReason =
  | 'empty'
  | 'too_short'
  | 'not_a_number'
  | 'unparseable'
  | 'invalid_for_region'
  | 'not_mobile';

export interface PhoneNormalisationSuccess {
  readonly ok: true;
  /** Exactly as it appeared on the board. Stored as `phone_raw`. */
  readonly raw: string;
  /** Strict E.164, safe to hand to Twilio. Stored as `phone_e164`. */
  readonly e164: string;
  /** `mobile`, `fixed_line`, etc. WhatsApp effectively requires a mobile. */
  readonly type: string | undefined;
  readonly country: string | undefined;
  /**
   * True when the raw value needed more than whitespace tidying — a trunk zero
   * stripped, a missing "+" added. Useful for reporting how dirty the data is.
   */
  readonly wasRepaired: boolean;
  readonly repairs: readonly string[];
}

export interface PhoneNormalisationFailure {
  readonly ok: false;
  readonly raw: string;
  readonly reason: PhoneFailureReason;
  /** Plain-English explanation, suitable for a review queue shown to a human. */
  readonly detail: string;
}

export type PhoneNormalisationResult = PhoneNormalisationSuccess | PhoneNormalisationFailure;

/**
 * Strip the national trunk zero that follows a country code.
 *
 * `+4407700900123` is the country code and the national prefix concatenated —
 * a very common spreadsheet mistake. libphonenumber will not repair it for you:
 * it reads `+44` then `07700900123` and correctly reports an invalid number.
 *
 * Only applied when the country code is unambiguous and the result actually
 * parses as valid. Never a blind character deletion.
 */
function stripTrunkZeroAfterCountryCode(input: string): string | null {
  const match = /^\+(\d{1,3})0(\d+)$/.exec(input);
  if (!match) return null;
  return `+${match[1]}${match[2]}`;
}

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

function tryParse(candidate: string): PhoneNumber | null {
  try {
    const parsed = parsePhoneNumberWithError(candidate, DEFAULT_REGION);
    return parsed.isValid() ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Describe what actually changed between the board value and the E.164 result.
 *
 * Derived from the values rather than from which repair candidate happened to
 * parse, because libphonenumber silently performs some repairs itself — it will
 * strip a trunk zero after the country code without saying so. The dry-run
 * report is only useful if it names the real defect in the data.
 */
function describeRepairs(raw: string, cleaned: string, e164: string): string[] {
  const repairs: string[] = [];

  if (raw.replace(/\s/g, '') !== cleaned) {
    repairs.push('removed punctuation or trailing notes');
  }

  const cleanedDigits = cleaned.replace(/\D/g, '');
  const e164Digits = e164.replace(/\D/g, '');

  if (cleaned.startsWith('00')) {
    repairs.push('replaced the 00 international dialling prefix with "+"');
  } else if (cleanedDigits.length > e164Digits.length) {
    repairs.push('removed the national trunk zero following the country code');
  } else if (cleanedDigits.length < e164Digits.length) {
    repairs.push(`added the ${DEFAULT_REGION} country code`);
  } else if (!cleaned.startsWith('+')) {
    repairs.push('added the missing "+"');
  }

  if (repairs.length === 0 && raw !== e164) repairs.push('reformatted to E.164');
  return repairs;
}

/**
 * Normalise one board value to E.164, repairing the known-bad shapes.
 *
 * Candidates are tried in order of confidence, and the first one that parses as
 * a *valid* number wins. "Possible" is not good enough — libphonenumber will
 * call almost any 11-digit string possible, and a possible-but-invalid number
 * sent to Twilio is a failed message and a small charge, repeated across the
 * whole board.
 */
export function normalisePhone(rawInput: string | null | undefined): PhoneNormalisationResult {
  const raw = (rawInput ?? '').trim();

  if (raw === '') {
    return { ok: false, raw, reason: 'empty', detail: 'No phone number on the record.' };
  }

  // Keep digits, a leading +, and nothing else. Extensions ("x123"), notes
  // ("07700 900123 (mobile)") and separators all go.
  const cleaned = raw.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');

  if (digitCount(cleaned) === 0) {
    return {
      ok: false,
      raw,
      reason: 'not_a_number',
      detail: 'Contains no digits.',
    };
  }

  if (digitCount(cleaned) < 7) {
    return {
      ok: false,
      raw,
      reason: 'too_short',
      detail: `Only ${digitCount(cleaned)} digits — too short to be a phone number.`,
    };
  }

  // Tried in order of confidence. The first candidate that parses as a *valid*
  // number wins — "possible" is not good enough, because libphonenumber calls
  // almost any eleven-digit string possible, and a possible-but-invalid number
  // is a failed send and a charge, repeated across the whole board.
  const candidates: string[] = [cleaned];

  const trunkStripped = stripTrunkZeroAfterCountryCode(cleaned);
  if (trunkStripped !== null) candidates.push(trunkStripped);

  // No "+" at all: try it as an international number, then as a national one.
  if (!cleaned.startsWith('+')) {
    candidates.push(`+${cleaned}`);
    const asNational = stripTrunkZeroAfterCountryCode(`+${cleaned}`);
    if (asNational !== null) candidates.push(asNational);
  }

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed === null) continue;

    const e164 = parsed.number;
    return {
      ok: true,
      raw,
      e164,
      type: parsed.getType(),
      country: parsed.country,
      wasRepaired: e164 !== raw,
      repairs: describeRepairs(raw, cleaned, e164),
    };
  }

  // Nothing parsed. Say which country was assumed, because "invalid" without
  // that is not enough to act on.
  const looksInternational = cleaned.startsWith('+');
  return {
    ok: false,
    raw,
    reason: looksInternational ? 'invalid_for_region' : 'unparseable',
    detail: looksInternational
      ? `"${cleaned}" has a country code but is not a valid number for it.`
      : `"${cleaned}" could not be parsed as a ${DEFAULT_REGION} number and has no country code.`,
  };
}

/**
 * Whether a normalised number can receive WhatsApp.
 *
 * WhatsApp runs on mobile numbers. libphonenumber returns undefined for numbers
 * whose type it cannot determine, which is common and not a reason to reject —
 * so unknown is treated as sendable, and only a positively-identified landline
 * is refused. Being wrong in that direction costs one failed message; the
 * opposite silently drops reachable leads.
 */
export function isWhatsAppCapable(result: PhoneNormalisationResult): boolean {
  if (!result.ok) return false;
  if (result.type === undefined) return true;
  return result.type === 'MOBILE' || result.type === 'FIXED_LINE_OR_MOBILE';
}

/** Digits hidden for logs and screenshots: `+447700900123` → `+4477****0123`. */
export function maskPhone(e164: string): string {
  if (e164.length <= 8) return e164;
  return `${e164.slice(0, 6)}${'*'.repeat(e164.length - 10)}${e164.slice(-4)}`;
}
