/**
 * Shared helper that translates a high-level Power Search parameter object
 * into an imapflow search criteria object plus any post-pagination filters.
 *
 * Used by `ImapService.searchEmails` and `ImapService.listEmails` so the two
 * entry points share identical filter semantics.
 */

import { sanitizeSearchQuery } from '../safety/validation.js';
import { normalizeDate } from '../utils/date.js';

export interface SearchParams {
  query?: string;
  /**
   * R2: controls how far a free-text `query` reaches.
   *
   * `undefined`/`true` (default) — subject + from + BODY. Deep by default is
   * what callers expect from a "search"; PR-2 made the big-folder body scan
   * safe (detected, warned, bounded on an isolated connection) rather than
   * removing it, so the default is a cost question, not a correctness one.
   *
   * `false` — header-only (subject + from + to). The PRD's explicit cheap
   * opt-out: no BODY term reaches the server, so the search stays a header
   * scan even on an 80k-message non-FTS folder. Use it when you know the
   * token is in the subject/sender and you want speed over reach.
   *
   * Only affects `query`. An explicit `body:`/`text:` filter always scans
   * bodies regardless — that is its own opt-in.
   */
  deep?: boolean;
  to?: string;
  from?: string;
  subject?: string;
  cc?: string;
  bcc?: string;
  text?: string;
  body?: string;
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  deleted?: boolean;
  keyword?: string | string[];
  notKeyword?: string | string[];
  header?: Record<string, string>;
  uids?: number[] | string;
  largerThan?: number; // tool-facing KB — multiplied to bytes here
  smallerThan?: number;
  // Post-pagination filters (not part of IMAP search — applied client-side):
  hasAttachment?: boolean;
  /** Substring match (case-insensitive) against any attachment filename. */
  attachmentFilename?: string;
  /** Regex (case-insensitive) applied to `${type}/${subtype}` of each attachment. */
  attachmentMimetype?: string;
  /** Faceted counts to return alongside the paginated result. */
  facets?: ('sender' | 'year' | 'mailbox')[];
  gmailRaw?: string;
}

export interface BuildResult {
  criteria: Record<string, unknown>;
  postFilters: {
    hasAttachment?: boolean;
    attachmentFilename?: string;
    attachmentMimetype?: string;
    facets?: ('sender' | 'year' | 'mailbox')[];
  };
  gmailRawUsed: boolean;
  /**
   * True when the built criteria will make the server scan message BODIES —
   * a free-text `query` (deep by default: subject/from/body OR), or an
   * explicit `body:`/`text:` filter. Drives PR-2's R5 at-risk gate (a body
   * scan over a large non-FTS folder is the expensive/abortable case).
   */
  bodyScan: boolean;
  warnings: string[];
}

/**
 * Money amounts vs. Dovecot fts-xapian tokenisation. Measured by the WGS
 * mail-server team on 2026-09-09 against real mail, index and raw scan
 * side by side:
 *
 *   - a digits-only term ("2950") is a SUBSTRING match inside tokens that
 *     carry no thousands separator: it finds 2950, $2950.00, 12950 — but
 *     never "2,950", because the comma splits that token;
 *   - a term containing "," or "." ("2,950", "1463.84") is matched as a whole
 *     token or prefix: "2,950" finds 2,950 and $2,950.00 but not 2950, and
 *     "1463.84" does NOT find "1,463.84".
 *
 * So either spelling on its own silently misses mail written the other way,
 * and the caller has no way to know which way the sender wrote it. For any
 * amount whose integer part has four or more digits — the only case where a
 * thousands separator can appear — we search BOTH the grouped form and the
 * plain digits, decimals dropped ("1,463" and "1463" both also match the .84
 * forms). Under 1,000 there is nothing to expand and the term is left alone.
 *
 * A 4+-digit non-money number (a PO or order number) gets the same treatment;
 * the extra grouped variant is a harmless OR term and the plain-digits term
 * still matches exactly as it always did.
 */
const AMOUNT_RE = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

export function amountVariants(term: string): [grouped: string, digits: string] | undefined {
  const m = AMOUNT_RE.exec(term.trim());
  if (!m) return undefined;
  const digits = m[1].replace(/,/g, '').replace(/^0+(?=\d)/, '');
  if (digits.length < 4) return undefined;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [grouped, digits];
}

function amountNote(term: string, [grouped, digits]: [string, string]): string {
  return (
    `Amount "${term}" searched as "${grouped}" OR "${digits}": the full-text index ` +
    'treats a comma or dot as part of the word and matches plain digits as a substring, ' +
    'so either spelling alone misses mail written the other way.'
  );
}

export function buildSearchCriteria(params: SearchParams, opts: { isGmail: boolean }): BuildResult {
  const warnings: string[] = [];

  // ---------------------------------------------------------------------------
  // Gmail fast-path short-circuit
  // ---------------------------------------------------------------------------
  if (params.gmailRaw !== undefined && params.gmailRaw !== null && params.gmailRaw !== '') {
    if (!opts.isGmail) {
      throw new Error('gmail_raw is only valid on Gmail accounts (imap.host === "imap.gmail.com")');
    }
    const otherFilters = Object.keys(params).filter(
      (k) => k !== 'gmailRaw' && params[k as keyof SearchParams] !== undefined,
    );
    if (otherFilters.length > 0) {
      warnings.push(
        `gmail_raw takes precedence — other filters ignored: ${otherFilters.join(', ')}`,
      );
    }
    return {
      criteria: { gmailRaw: params.gmailRaw },
      postFilters: {},
      gmailRawUsed: true,
      // Gmail searches natively server-side — our at-risk gate does not apply.
      bodyScan: false,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Regular filter build — AND across all conditions, OR across query fields
  // ---------------------------------------------------------------------------
  const andConditions: Record<string, unknown>[] = [];

  // Tri-state read of the R2 opt-out: only an explicit `false` turns the
  // free-text query header-only. `undefined` keeps the deep default.
  const deepQuery = params.deep !== false;

  // Free-text `query` is DEEP BY DEFAULT — subject/from/body OR (the behavior
  // users expect). The big-folder body-scan risk this used to create is now
  // handled by PR-2: a body scan over a large non-FTS folder is detected
  // (R5), warned about, and run on a bounded ephemeral connection (R3) so it
  // fails loudly/cleanly instead of silently. `bodyScan` (below) flags this
  // path for that gate.
  //
  // R2: `deep: false` is the explicit header-only opt-out — subject/from/to,
  // no BODY term, so the server never leaves the header index. TO is included
  // here (and only here) because it is the third cheap envelope field and the
  // PRD asks for it "where cheap"; it is NOT in the deep OR, where the body
  // term already dominates the cost.
  // Whether the single top-level `or` slot is taken by the free-text query.
  // Conditions are merged with Object.assign, so a second `or` would silently
  // overwrite the first — see the explicit-filter expansion below.
  let orSlotUsed = false;
  if (params.query && params.query.length > 0) {
    const q = sanitizeSearchQuery(params.query);
    const amt = amountVariants(q);
    if (amt) {
      // An amount lives in a subject or a body, never in a sender or
      // recipient, so FROM/TO drop out and both spellings go in their place.
      warnings.push(amountNote(q, amt));
      const subject = amt.map((v) => ({ subject: v }));
      andConditions.push({
        or: deepQuery ? [...subject, ...amt.map((v) => ({ body: v }))] : subject,
      });
    } else {
      andConditions.push({
        or: deepQuery
          ? [{ subject: q }, { from: q }, { body: q }]
          : [{ subject: q }, { from: q }, { to: q }],
      });
    }
    orSlotUsed = true;
  }

  // Explicit subject:/body:/text: filters get the same amount expansion, but
  // only while the `or` slot is free (imapflow criteria are a flat object and
  // hold ONE `or`). With a free-text query present the filter is passed through
  // unexpanded and the caller is told, rather than silently losing one of them.
  const expandable = (
    field: 'subject' | 'body' | 'text',
    value: string,
  ): Record<string, unknown> => {
    const amt = amountVariants(value);
    if (!amt) return { [field]: value };
    if (orSlotUsed) {
      warnings.push(
        `${field}: "${value}" looks like an amount but was NOT expanded to both spellings ` +
          'because the free-text query already occupies the OR clause; put the amount in ' +
          'query instead, or search each spelling separately.',
      );
      return { [field]: value };
    }
    orSlotUsed = true;
    warnings.push(amountNote(value, amt));
    return { or: amt.map((v) => ({ [field]: v })) };
  };

  // Simple passthrough string fields
  if (params.to) andConditions.push({ to: params.to });
  if (params.from) andConditions.push({ from: params.from });
  if (params.subject) andConditions.push(expandable('subject', params.subject));
  if (params.cc) andConditions.push({ cc: params.cc });
  if (params.bcc) andConditions.push({ bcc: params.bcc });
  if (params.text) andConditions.push(expandable('text', params.text));
  if (params.body) andConditions.push(expandable('body', params.body));

  // Dates
  if (params.since) andConditions.push({ since: normalizeDate(params.since) });
  if (params.before) andConditions.push({ before: normalizeDate(params.before) });
  if (params.on) andConditions.push({ on: normalizeDate(params.on) });
  if (params.sentSince) andConditions.push({ sentSince: normalizeDate(params.sentSince) });
  if (params.sentBefore) andConditions.push({ sentBefore: normalizeDate(params.sentBefore) });

  // Flags — imapflow accepts booleans and handles UN- prefixing internally
  if (params.seen !== undefined) andConditions.push({ seen: params.seen });
  if (params.flagged !== undefined) andConditions.push({ flagged: params.flagged });
  if (params.answered !== undefined) andConditions.push({ answered: params.answered });
  if (params.draft !== undefined) andConditions.push({ draft: params.draft });
  if (params.deleted !== undefined) andConditions.push({ deleted: params.deleted });

  // Keywords (custom IMAP flags / labels)
  if (params.keyword) {
    const kws = Array.isArray(params.keyword) ? params.keyword : [params.keyword];
    kws.forEach((k) => {
      andConditions.push({ keyword: k });
    });
  }
  if (params.notKeyword) {
    const kws = Array.isArray(params.notKeyword) ? params.notKeyword : [params.notKeyword];
    // imapflow's compiler upper-cases keys; both `unKeyword` and `unkeyword` compile to UNKEYWORD.
    kws.forEach((k) => {
      andConditions.push({ unKeyword: k });
    });
  }

  // Arbitrary header match (pass-through object)
  if (params.header && Object.keys(params.header).length > 0) {
    andConditions.push({ header: params.header });
  }

  // UIDs
  if (params.uids !== undefined) {
    const uidStr = Array.isArray(params.uids) ? params.uids.join(',') : params.uids;
    if (uidStr && uidStr.length > 0) {
      andConditions.push({ uid: uidStr });
    }
  }

  // Size — tool accepts KB, IMAP expects bytes
  if (params.largerThan !== undefined) {
    andConditions.push({ larger: params.largerThan * 1024 });
  }
  if (params.smallerThan !== undefined) {
    andConditions.push({ smaller: params.smallerThan * 1024 });
  }

  let criteria: Record<string, unknown>;
  if (andConditions.length === 0) {
    criteria = {};
  } else if (andConditions.length === 1) {
    [criteria] = andConditions;
  } else {
    criteria = Object.assign({}, ...andConditions);
  }

  // A deep free-text query (body-inclusive) or an explicit body:/text: filter
  // makes the server scan message bodies — the expensive/abortable case the
  // R5 at-risk gate guards. TEXT covers headers+body, so it counts too. A
  // `deep: false` query emits no BODY term, so it does NOT set this flag and
  // never takes the bounded ephemeral path — that is the whole point of the
  // opt-out.
  // (Boolean sub-expressions: an empty string is "no value", and `||` here is
  // a true logical-OR of booleans — not a nullish-default, hence not `??`.)
  const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.length > 0;
  const bodyScan =
    (deepQuery && nonEmpty(params.query)) || nonEmpty(params.body) || nonEmpty(params.text);

  return {
    criteria,
    postFilters: {
      hasAttachment: params.hasAttachment,
      attachmentFilename: params.attachmentFilename,
      attachmentMimetype: params.attachmentMimetype,
      facets: params.facets,
    },
    gmailRawUsed: false,
    bodyScan,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// R6 — automatic recency-window fallback
// ---------------------------------------------------------------------------

/**
 * R6: the recency window an automatic post-failure retry narrows to.
 *
 * 90 days is the PRD's answer to its own open question. It is long enough to
 * cover the realistic "where did that mail go?" lookup (the incident messages
 * were days old) and short enough that `SEARCH SINCE <date>` prunes the
 * candidate set hard on the folders that provoke the failure — Dovecot
 * evaluates the internal-date term cheaply before it ever opens a body.
 */
export const RECENCY_WINDOW_DAYS = 90;

/**
 * True when the caller already scoped the search by date. R6 must not fire in
 * that case: the request is already narrow, so a failure is not "too broad",
 * and silently ANDing our own `since` on top would shrink an explicit range
 * the caller chose — a second, quieter false-negative.
 */
export function hasDateNarrowing(params: SearchParams): boolean {
  const dated = [params.since, params.before, params.on, params.sentSince, params.sentBefore];
  return dated.some((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Return a copy of `criteria` ANDed with `SINCE <days ago>`.
 *
 * imapflow ANDs top-level criteria keys, so adding `since` alongside an
 * existing `or:[…]` narrows the whole expression rather than replacing it —
 * the windowed retry searches for the same thing, just over less mail.
 */
export function withRecencyWindow(
  criteria: Record<string, unknown>,
  days: number,
): Record<string, unknown> {
  return { ...criteria, since: normalizeDate(`${days}d`) };
}

/** Splits a UID list into fixed-size chunks — handy for bounded FETCH ranges. */
export function chunkUids(uids: number[], chunkSize: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < uids.length; i += chunkSize) {
    chunks.push(uids.slice(i, i + chunkSize));
  }
  return chunks;
}
