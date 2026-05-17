/**
 * Runtime helpers for IMAP SEARCH failure classification (R1 — search
 * false-negatives). The type + const-union live in `src/types/index.ts`
 * (the shared-contract leaf, because `PaginatedResult` carries them); this
 * module holds the runtime error class + status builders, mirroring the
 * MoveError/error-kinds split in the routing engine.
 */

import type { SearchStatus } from '../types/index.js';
import { SEARCH_FAIL_KIND } from '../types/index.js';

/**
 * Thrown by batch search paths (`searchForExport`, `extractContacts`) where a
 * discriminated result has no carrier and `isError` is the correct UX (D2
 * REFINED). The interactive paths (`searchEmails`, `listEmails`,
 * `searchAcrossAccounts`) return the discriminated `PaginatedResult` instead.
 */
export class SearchFailedError extends Error {
  constructor(readonly status: SearchStatus) {
    super(status.message);
    this.name = 'SearchFailedError';
  }
}

/** Default actionable guidance — narrowing beats a swallowed false-negative. */
const NARROW_SUGGESTION =
  'The messages may still exist. Narrow the search and retry: add a date filter ' +
  '(since:/before:/on:), or use subject:/from: instead of a full-text query. ' +
  'osTicket-ingested mailboxes (e.g. INBOX.osTicket) are very large — always ' +
  'date-scope searches there.';

/** Build the SearchStatus for a non-array (`false`) `client.search()` result. */
export function searchFailedStatus(): SearchStatus {
  return {
    kind: SEARCH_FAIL_KIND.SEARCH_FAILED,
    message:
      'IMAP SEARCH did not complete — the server returned no result set ' +
      '(typically a resource limit / NO on an expensive query, or a swallowed ' +
      'socket timeout). This is NOT a zero-match result.',
    suggestion: NARROW_SUGGESTION,
  };
}

/**
 * Build the SearchStatus for our OWN bounded-wait expiry on an ephemeral
 * connection (R3/D3). The abandoned SEARCH dies with that connection; the
 * account's shared client is untouched. NOT a zero-match result.
 */
export function timeoutStatus(timeoutMs: number): SearchStatus {
  return {
    kind: SEARCH_FAIL_KIND.TIMEOUT,
    message:
      `IMAP SEARCH exceeded the ${timeoutMs}ms bounded-wait budget on an ` +
      'isolated connection and was abandoned. This is NOT a zero-match result.',
    suggestion: NARROW_SUGGESTION,
  };
}

/** Build the SearchStatus for a rejected `client.search()` (connection error). */
export function connectionErrorStatus(err: unknown): SearchStatus {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    kind: SEARCH_FAIL_KIND.CONNECTION_ERROR,
    message: `IMAP SEARCH failed — the connection errored mid-search: ${detail}. This is NOT a zero-match result.`,
    suggestion: NARROW_SUGGESTION,
  };
}
