# Design — Draft Attachment Resync (`resync_draft_attachments` + supersession hints)

**Date:** 2026-07-19
**Status:** Approved for planning
**Source PRD:** `.context/attachments/UATzjZ/PRD-email-mcp-draft-attachment-resync.md`
**Owner:** David Young

---

## 1. Problem (recap)

When the MCP attaches files to an IMAP draft and the user then edits that draft in
Apple Mail, Mail APPENDs its own stale copy under a new UID **without** the MCP-added
attachments (and with dangling `cid:` inline-signature image refs), then expunges the
ancestor UID. The loss is client-side and cannot be prevented server-side.

**Empirically confirmed (2026-07-16, wgs-usa):** the restored draft (UID 59882) survives,
but every ancestor (59874/59878/59880) is already **gone** from `INBOX.Drafts`. Apple Mail
expunges the ancestor on re-save. Therefore, by the time resync runs, the draft that carried
the PDFs is deleted — so the **session attachment cache is load-bearing for the primary
scenario, not merely a fallback.**

This feature turns the manual `list_emails → get_email → update_draft` recovery dance into
one call (`resync_draft_attachments`) and makes the superseded-UID failure self-describing.

## 2. Chosen approach

**Approach C — byte-preserving raw-MIME surgery with maximum reuse.**

The PRD's hardest gate is acceptance criterion #5 / #1: the newest draft's **body bytes must
pass through untouched** (byte-identical, except opt-in cid-stub stripping). The existing
`update_draft` **cannot** meet this — it re-parses `bodyHtml`/`bodyText` and re-composes the
whole MIME via `MailComposer`, re-encoding and potentially altering the user's text. So
`resync` is **not** a thin wrapper over `update_draft`.

Instead, on `apply=True`:

1. Fetch the current draft's exact RFC822 via the existing `fetchDraftRaw`.
2. Parse structure with `mailparser` (already a dependency) to locate the top-level entity,
   the body part(s), and any existing attachment parts.
3. **Splice** the missing attachment MIME parts into the tree while keeping the original body
   part(s) **verbatim** (byte-for-byte). If the top level is not already `multipart/mixed`,
   wrap the original top-level entity as the first child of a new `multipart/mixed`,
   preserving that entity's headers+body bytes exactly. When wrapping, the **container
   headers** (`From`, `To`, `Cc`, `Subject`, `Date`, `Message-ID`, `In-Reply-To`,
   `References`, and `X-Universally-Unique-Identifier`) are lifted from the original top-level
   onto the new outer message so recipients, threading, and lineage identity are preserved;
   the original entity keeps only its content headers (`Content-Type`,
   `Content-Transfer-Encoding`, etc.) as the first child part.
4. (Opt-in) strip dangling `cid:` tags — the single allowed body mutation, touching only the
   HTML part.
5. APPEND the assembled raw message to Drafts; delete the old UID only after APPEND succeeds
   (same APPEND-then-delete safety the current code already uses).

Reuse: the attachment **resolver** (`resolveAttachments`), Drafts-folder autodetect,
append/delete plumbing, and the `extractCidReferences` helper.

## 3. Lineage resolution

**Lineage rule (final):** two drafts belong to the same lineage iff they are in the same
Drafts folder, have the same **normalized From**, AND (share a non-empty
`X-Universally-Unique-Identifier` value **OR** share a **normalized Subject**).

- The UUID edge only ever *adds* links (it rescues the case where the subject line is edited
  in Mail); it never *splits* a lineage. So correctness does **not** depend on whether Apple
  Mail preserves our stamped UUID: if it does, we gain linkage; if it doesn't, we are no worse
  than Subject+From. Fully headless.
- Different From or different folder never merge (acceptance criterion #4). Two independent
  `save_draft` calls mint different UUIDs and won't share one, so distinct drafts don't merge
  via the UUID edge either.

**Normalization**
- `normalizeFrom` → the sender email address, lowercased; display name ignored.
- `normalizeSubject` → trim, strip leading `Re:`/`Fwd:`/`Fw:` runs (case-insensitive),
  collapse internal whitespace, casefold.

**Ordering:** by IMAP `INTERNALDATE` ascending. Newest = the *current* draft; older UIDs are
ancestors.

**The `subject=` param** (when the UID is unknown) is an **exact-match** lineage key against
the Drafts folder (as the PRD specifies), then normalized for grouping. `draft_id=` may be any
UID in the lineage (ancestor or current).

## 4. MCP UUID stamp

`save_draft` stamps `X-Universally-Unique-Identifier: <uuid>` (via nodemailer's `headers`
option; value from `crypto.randomUUID()`).

- **New draft** (`save_draft`): mint a fresh UUID.
- **Rebuild** (`update_draft`, `resync apply`): **carry forward** the current draft's existing
  `X-Universally-Unique-Identifier` if present, so the whole chain shares one value; mint a new
  one only if the current draft has none.

This is additive and non-breaking; existing drafts without the header simply fall back to
Subject+From matching.

## 5. Byte-recovery source + session cache (§3.3)

On `apply=True`, recover each missing attachment's bytes in this priority:

1. **Surviving ancestor UID** still in Drafts carrying the file → server-side carry via the
   existing `sourceEmailId` attachment-reference path (no cache needed; bytes never traverse
   the MCP wire).
2. **Session cache** → for attachments the MCP added this session.
3. Neither → report `recoverable: false` for that file. Never fail the whole call.

**Cache (in-memory, server-process lifetime; no disk persistence in v1).**

Populated whenever `save_draft` / `update_draft` / `resync apply` **adds** an attachment.
Entry shape:

```
{ account, from, subjectNorm, uuid, filename, origin, size }
origin =
  | { kind: 'path', path }           // re-read at apply time (large files never pin memory)
  | { kind: 'bytes', content }       // base64/source-ref origins with no stable local path
```

- `{path}` attachments store the path and re-read at apply (lighter; survives large files).
- base64 / source-message-ref attachments store the resolved bytes (bounded by the existing
  `REBUILD_ATTACHMENT_CAP_BYTES` = 25 MB cap).
- **sha256 is dropped** for v1 (YAGNI — it would hash up to 25 MB on every save for marginal
  change-detection value). If a stored `{path}` file is missing/moved at apply time, that file
  reports `recoverable: false`.

**Cache lookup uses the same-lineage predicate as §3:** match entries where `account` matches
AND `from` matches AND (`subjectNorm` matches OR `uuid` matches). This unifies the cache with
lineage grouping and keeps recovery working even if Mail changed the UUID or the subject.

**Intentional-removal tracking (acceptance criterion #3).** When
`update_draft(attachments_remove=[...])` runs, record `(lineageKey, filename)` in a per-session
"removed" set. A **default** resync (no explicit `attachments` allowlist) excludes those
filenames. An explicit `attachments` allowlist always wins (restores exactly what's listed).

**UID → lineageKey map (for supersession hints, §7).** The session also remembers, for every
draft UID the MCP writes or reads, its lineage key — so a superseded (now-dead) UID can still
be resolved to its lineage. Dead UIDs the session never saw cannot be resolved from the dead
UID alone and fall back to the plain not-found error.

## 6. `resync_draft_attachments` tool

```
resync_draft_attachments(
  account,                    # required
  draft_id?,                  # UID of ANY draft in the lineage (ancestor or current)
  subject?,                   # exact-match lineage key when the UID is unknown
  apply = false,              # false = report only (no write); true = re-apply
  attachments?,               # explicit allowlist of filenames to restore (overrides removal exclusion)
  strip_dangling_cids = true, # applies only when apply=true
  mailbox?,                   # Drafts folder autodetect (same as update_draft)
)
```

Requires exactly one of `draft_id` / `subject`. If `apply=true` and nothing is missing (and no
dangling cids to strip), it is a **no-op**: no new UID is created and the response says there
was nothing to restore.

**`apply=false` (report):**
```
{
  current_uid, lineage_uids: [...],
  missing: [ { filename, size?, last_seen_on_uid | 'cache', recoverable: bool, source } ],
  intentionally_removed_excluded: [ filename... ],
  dangling_cids: [ cid... ]        // preview of what stripping would remove
}
```
No write.

**`apply=true`:**
```
{
  new_uid, mailbox,
  restored: [ filename... ],
  skipped_unrecoverable: [ filename... ],
  old_uid_replaced,               // the superseded current UID that was deleted
  stripped_cids: [ cid... ],
  warnings: [ ... ]
}
```
Body of the current draft is byte-identical apart from opt-in cid-stub stripping.

## 7. Supersession hint (§3.2)

`update_draft` and `send_draft` today throw `Email <uid> not found in <Drafts>` when the target
UID is gone. Change: catch that specific not-found, resolve the lineage **via the session
UID→lineageKey map**, and return a structured hint instead of a bare error:

```
{ error: 'draft_superseded', newest_uid, newest_date, attachment_diff: [ { filename, present_on_newest: bool } ] }
```

- `send_draft`: **warn-only** (acceptance criterion / §6 Q2) — sending a non-newest lineage
  member returns the hint as a warning but does not hard-block (the user may keep variants).
- If the dead UID is unknown to the session, fall back to the existing not-found error.

## 8. New components

| File | Responsibility |
|---|---|
| `src/services/draft-lineage.ts` | Pure lineage grouping + attachment diff (normalize From/Subject, UUID-or-subject union, INTERNALDATE ordering). Testable in isolation. |
| `src/services/draft-attachment-cache.ts` | In-memory session cache, removed-set, UID→lineageKey map, same-lineage lookup predicate. |
| `src/services/mime-splice.ts` | Byte-preserving attachment injection + dangling-cid stripping over raw RFC822. |
| `src/services/imap.service.ts` | `resyncDraftAttachments()` orchestrator; supersession lookup helper; hooks in `saveDraft`/`updateDraft` to stamp the UUID, populate the cache, and record removals. |
| `src/tools/drafts.tool.ts` | New `resync_draft_attachments` tool; structured `draft_superseded` hint wired into `update_draft` / `send_draft`. |
| `src/tools/register.ts` | Register the new tool (write-tools block; skipped in read-only mode). |

## 9. Testing

- **Integration:** replay the §2 fixture — seed a draft shaped like 59874 (2 PDFs) →
  59878 (same subject, bare, +dangling cids). `apply=false` names both PDFs + current UID;
  `apply=true` yields a new draft with the 59878 body **byte-identical** (minus cid stubs),
  both PDFs re-attached, the 59878 UID replaced.
- **Unit — `draft-lineage`:** criterion #4 (different From / different folder not merged;
  same-subject same-From merged; UUID rescues a changed subject).
- **Unit — cache:** criterion #3 (an `attachments_remove` filename is excluded from default
  resync but restored by an explicit `attachments` allowlist).
- **Unit — `mime-splice`:** criterion #5 — assert the body part bytes are unchanged when no
  stripping; assert only the HTML part changes when stripping dangling cids; multipart/mixed
  vs singlepart wrapping both preserve the body.
- **Unit — UUID stamp:** `save_draft` mints a fresh UUID; `update_draft`/`resync` carry the
  existing one forward.

## 10. Non-goals (v1, from PRD §4)

Preventing Mail's overwrite; cross-account/cross-folder lineage; fuzzy subject matching;
persisting the cache across restarts; auto-resync daemons.

## 11. Scope decisions locked

- Approach **C** (byte-preserving MIME surgery, max reuse).
- Lineage = **Subject+From**, with the **MCP UUID stamp added now** and used as an additive
  lineage edge (headless; no reliance on verifying Mail-side preservation).
- **One PR.**
