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
  gmailRaw?: string;
}

export interface BuildResult {
  criteria: Record<string, unknown>;
  postFilters: {
    hasAttachment?: boolean;
  };
  gmailRawUsed: boolean;
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
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Regular filter build — AND across all conditions, OR across query fields
  // ---------------------------------------------------------------------------
  const andConditions: Record<string, unknown>[] = [];

  // Base full-text OR query (matches current search_emails behavior)
  if (params.query && params.query.length > 0) {
    const q = sanitizeSearchQuery(params.query);
    andConditions.push({
      or: [{ subject: q }, { from: q }, { body: q }],
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

  return {
    criteria,
    postFilters: { hasAttachment: params.hasAttachment },
    gmailRawUsed: false,
    warnings,
  };
}

/** Splits a UID list into fixed-size chunks — handy for bounded FETCH ranges. */
export function chunkUids(uids: number[], chunkSize: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < uids.length; i += chunkSize) {
    chunks.push(uids.slice(i, i + chunkSize));
  }
  return chunks;
}
