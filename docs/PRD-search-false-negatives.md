# PRD: `search_emails` False Negatives on Large Folders

**Status:** Proposed
**Author:** (filed via Claude Code investigation, 2026-05-16)
**Severity:** High — silent data-integrity / trust failure
**Components:** `src/services/imap.service.ts`, `src/services/search-criteria.ts`, `search_emails` / `search_all_accounts` tools

---

## 1. Summary

`search_emails` (and `search_all_accounts`) return `"No emails found"`
for messages that **demonstrably exist** when the target mailbox is
large (tens of thousands of messages). The empty result is
indistinguishable from a genuine zero-match: no error, no warning, no
`totalApprox`. Callers (human or agent) reasonably but wrongly conclude
the mail was deleted/lost.

## 2. Observed Incident

During a cross-account move of two Adam Green emails
(`green.jonadam@gmail.com`, subject "Re: Order #29804 confirmed") from
`wgs-usa/INBOX` to `support-wgs`:

- The move succeeded; osTicket then ingested both into tickets #29248 /
  #29249 and filed the mail copies into `support-wgs/INBOX.osTicket`
  (~18,127 messages). Source copies went to `wgs-usa/INBOX.Trash`
  (~3,200 messages).
- Every `search_emails` call against `INBOX.osTicket` and the Trash
  folders — by `from:`, by free-text `query:`, by `subject:` — returned
  `"No emails found"`.
- The messages were in fact present (confirmed in Mac Mail and via
  `osticket-mcp`).
- Result: a false "the emails are gone" escalation. ~15 minutes of
  user-facing alarm over data that was never at risk.

## 3. Root Cause

Two compounding defects in the search path:

### 3.1 Free-text `query` always forces a `BODY` scan

`src/services/search-criteria.ts:92-95`:

```ts
if (params.query && params.query.length > 0) {
  const q = sanitizeSearchQuery(params.query);
  andConditions.push({ or: [{ subject: q }, { from: q }, { body: q }] });
}
```

The `{ body: q }` term makes the IMAP server perform a full-body
`SEARCH ... BODY "<q>"`. On Dovecot **without a full-text-search (FTS)
index**, a `BODY` search across an ~18k-message folder is pathologically
slow and routinely exceeds the imapflow client socket/command timeout.

### 3.2 Search errors/timeouts are silently coerced to an empty result

`src/services/imap.service.ts` (both the export path ~line 602 and
`searchEmails` ~line 874):

```ts
const searchResult = await client.search(criteria, { uid: true });
let uids: number[] = Array.isArray(searchResult) ? searchResult : [];
...
if (uids.length === 0) {
  return { items: [], total: 0, ... };   // looks identical to a real zero-match
}
```

If `client.search()` rejects, times out, or returns a non-array, the
ternary swallows it into `[]`. The function then returns a normal
"zero results" payload with **no `warning`, no error, no `totalApprox`
flag**. The failure is invisible to the caller.

`from:` / `subject:` searches on the same giant folder also returned
empty, consistent with the same swallow path (a costly header SEARCH
over ~18k messages timing out, not just `BODY`).

### 3.3 What is NOT the cause

`MAX_SEARCH_UIDS = 5000` (`imap.service.ts:43`) is **not** implicated.
The cap sorts UIDs **descending** (`uids.sort((a,b) => b - a)`) and
keeps the newest 5000, so recently-appended/moved messages are
*retained*, not dropped. Any fix must not target the cap.

## 4. Impact

- **Correctness:** false negatives presented as authoritative zeroes.
- **Trust/safety:** drives wrong conclusions ("email lost", "move
  failed") and wrong remediations (re-moving, re-sending, escalation).
- **Agent risk:** an automated agent acting on a silent empty result
  could take destructive compensating actions.
- **Scope:** every account with a large folder. Known large here:
  `support-wgs/INBOX.osTicket` (~18k), `wgs-usa/INBOX.Archive` (~79k),
  Trash folders (3–5k).

## 5. Goals

1. A failed/timed-out/truncated search must **never** be presented as a
   clean zero-match.
2. Common lookups (`from:`, `subject:`, exact token) must succeed on
   large folders within a reasonable time.
3. Callers get an actionable signal to narrow or retry.

## 6. Requirements

### 6.1 Must

- **R1 — No silent failure.** Distinguish "0 genuine matches" from
  "search did not complete". If `client.search()` throws/times out or
  yields a non-array, surface a structured error or a result with an
  explicit `searchFailed: true` + `warning`. Never coerce an error to
  an empty success.
- **R2 — Decouple `BODY` from `query`.** Free-text `query` must default
  to header-only fields (`SUBJECT`, `FROM`, and where cheap, `TO`).
  Full-body search becomes opt-in (e.g. `body:` filter or an explicit
  `deep: true` flag), and when requested on a non-FTS server emits a
  cost warning.
- **R3 — Bounded search with honest truncation.** Apply a per-command
  timeout to `client.search()`. On timeout, return whatever is safely
  obtainable (e.g. via a `since:`-narrowed retry) plus a warning that
  results are partial — explicitly flagged, not silent.
- **R4 — Surface existing warnings.** The `warnings` array already
  built in `searchEmails` must always reach the tool response (it does
  on the empty path today only if non-empty; verify it is populated on
  the failure path per R1).

### 6.2 Should

- **R5 — FTS detection.** On mailbox open, detect server FTS capability
  (`SEARCH=FUZZY` / Dovecot FTS). If absent and a `BODY` search is
  requested on a folder above a size threshold, warn and suggest
  `since:`/`subject:` narrowing before executing.
- **R6 — Auto-fallback.** If an unfiltered/`query` search times out,
  automatically retry with a default recency window (e.g. last 90 days)
  and label the response as windowed.
- **R7 — Telemetry.** Log search criteria, folder size, elapsed ms, and
  outcome (ok / truncated / timeout) for large-folder searches.

### 6.3 Could

- **R8 — Folder-size hint.** Include the opened mailbox's message count
  in the response so callers can judge truncation risk.
- **R9 — Server-side dedupe guidance.** Document that osTicket-ingested
  addresses (e.g. `support@wgsusa.com`) accumulate huge `INBOX.osTicket`
  folders; recommend date-scoped searches there.

## 7. Acceptance Criteria

- **AC1.** With `client.search()` forced to throw/timeout, `search_emails`
  returns a response where `searchFailed`/error is set and a `warning`
  is present. A regression test asserts it is **not** an empty success.
- **AC2.** `search_emails(account=support-wgs, from="green.jonadam@gmail.com",
  folder="INBOX.osTicket")` returns the known messages (UIDs/Message-IDs
  for tickets #29248/#29249) within the timeout budget.
- **AC3.** A free-text `query` on `INBOX.osTicket` either returns header
  matches quickly, or returns a partial result **explicitly flagged**
  truncated/timed-out — never a clean `total: 0`.
- **AC4.** `subject:"Order #29804"` on `INBOX.osTicket` returns both
  messages.
- **AC5.** Unit test: `MAX_SEARCH_UIDS` cap retains the newest UIDs
  (guards against a regression that drops fresh mail).

## 8. Test Plan

1. Repro harness: point at `support-wgs/INBOX.osTicket`; assert current
   `from:` search returns empty (captures the bug), then assert fixed
   build returns the two known messages.
2. Fault injection: stub `client.search` to reject / return non-array →
   assert R1 (no silent empty).
3. Timeout simulation: artificial delay on a large folder → assert R3
   (bounded + flagged partial).
4. Server matrix: Dovecot with FTS vs. without (osTicket host) vs. Gmail
   (`gmail_raw` path unaffected).
5. Regression: `MAX_SEARCH_UIDS` newest-retention unit test (AC5).

## 9. Open Questions

- Does the osTicket IMAP host (Dovecot?) have an FTS plugin available to
  enable, making `BODY` search viable rather than only avoidable?
- Preferred default recency window for R6 auto-fallback (90d? 180d?).
- Should `search_all_accounts` fail-soft per-account (warn) or hard-fail
  the whole call when one account's folder search times out? (Current
  behavior: partial failures → warnings.)

## 10. References

- Incident: cross-account move of UIDs 316705 / 316401 →
  `support-wgs`, osTicket tickets #29248 / #29249, 2026-05-16.
- Code: `src/services/search-criteria.ts:92-95`,
  `src/services/imap.service.ts:43, ~602, ~874-901`.
- Tool descriptions reference an existing "5000-UID cap" warning
  (`src/server.ts:25`, `src/tools/emails.tool.ts:616`) — the cap is
  documented but the *silent-failure* path is not.
