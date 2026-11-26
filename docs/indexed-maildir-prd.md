# Indexed direct date-window searches

A scheduled reader needs every eligible incoming message since its last completed sweep. A successful empty response can advance its checkpoint. An incomplete index must therefore be distinguishable from an empty mailbox.

## Reader contract

* Keep the existing `maildir_search`, `maildir_get_email` and `maildir_save_attachment` API. A single service setting applies to every caller. Run the recurring discovery query with an explicit account scope, folder exclusions, a date-only lower bound, headers mode, `regex=true` and `query=".*"`. Read each page to exhaustion. Retain the caller's existing deadline and watermark rules.
* Enumerate the delivery window directly on the mail host. Preserve folder membership, file IDs, exact boundary behavior, ordering, MIME reads, attachments, page counts and partial-result reporting. Reading a candidate PDF requires its parent message ID and part identity.
* Enable the option only after the same physical messages appear in indexed and raw results for both ordinary and busy windows. Stale index, unsupported lookup, permission failure and concurrent change must take the existing direct path or leave a visible incomplete result. No IMAP search or separate database is required.
* The release covers broad, date-bounded header discovery. Exact substring, attachment-name, timestamp-precision and arbitrary regex searches retain their raw matching semantics. A word index could miss a MIME byte substring. Extending other query types requires a separately measurable compatibility contract.

## Acceptance and rollout

Run the pilot on a restored or synthetic mailbox first, then compare direct readers in an approved observation window. For each query require identical scoped IDs and page boundaries, clean coverage receipts, and zero wrong-folder IDs. Target at least 25% lower median first-page latency with p95 no slower than raw for the operational sweep. Reject enablement on a coverage difference or a regression during normal client traffic. These are acceptance targets. Production timing is pending. Start with one caller instance, then the standard service config. Keep the flag off by default.

See the [implementation and measurement plan](indexed-maildir-design.md).
