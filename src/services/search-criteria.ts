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
  if (params.query && params.query.length > 0) {
    const q = sanitizeSearchQuery(params.query);
    andConditions.push({
      or: deepQuery
        ? [{ subject: q }, { from: q }, { body: q }]
        : [{ subject: q }, { from: q }, { to: q }],
    });
  }

  // Simple passthrough string fields
  if (params.to) andConditions.push({ to: params.to });
  if (params.from) andConditions.push({ from: params.from });
  if (params.subject) andConditions.push({ subject: params.subject });
  if (params.cc) andConditions.push({ cc: params.cc });
  if (params.bcc) andConditions.push({ bcc: params.bcc });
  if (params.text) andConditions.push({ text: params.text });
  if (params.body) andConditions.push({ body: params.body });

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
