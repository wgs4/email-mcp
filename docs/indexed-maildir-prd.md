# Indexed direct Maildir searches

A scheduled reader needs every eligible message in a date window, and people also search for a word or an amount such as "invoice" or "590550". A successful empty response can advance a checkpoint. An incomplete index must therefore be distinguishable from an empty mailbox.

The release covers two query shapes when `[maildir].indexed_sweep` is on (it stays off by default):

* Broad header sweeps: `mode=headers`, `regex=true`, `query=".*"`, with a `since` bound.
* Fixed-string text and amount searches in `headers` or `full_text` mode, when the term yields one or more ASCII tokens that Dovecot's `fts-xapian` index can see (`from`, `to`, `cc`, `bcc`, `subject`, `list-id`, or the whole message).

Both shapes use Dovecot's local mailbox metadata. Text and amount searches also use the per-folder `fts-xapian` glass database. No IMAP search and no separate database are added.

## Reader contract

* Keep the existing `maildir_search`, `maildir_get_email` and `maildir_save_attachment` API. A single service setting applies to every caller. Run a recurring discovery query with an explicit account scope, folder exclusions, a lower date bound, headers mode, `regex=true` and `query=".*"`. Read each page to exhaustion. Retain the caller's existing deadline and watermark rules.
* Enumerate candidates on the mail host. Preserve folder membership, file IDs, exact boundary behavior, ordering, MIME reads, attachments, page counts and partial-result reporting.
* Text and amount searches are two-stage. Dovecot/Xapian returns candidate files. `MaildirService` then runs the existing raw-byte GNU grep matcher on only those files. Results keep exact raw-byte semantics, including folded headers and Q-encoded or percent-encoded bytes. Grep drops every Xapian false positive.
* Fallback is per mailbox. A missing index, a stale index (`last_indexed_uid` below the mailbox's highest UID), an unreadable index file, a timeout, any helper error, or a candidate file that vanishes during confirmation falls back to the full raw scan for that mailbox. The other mailboxes keep their own route. A failed index never becomes a clean "no results".
* `scope` and `criteria` report `mailbox_backends` (`"index"` or `"raw"` per mailbox), `indexed_mailboxes`, `raw_mailboxes`, `indexed_candidates` and `indexed_hits`.

## Acceptance and rollout

Run the pilot on a restored or synthetic mailbox first, then compare direct readers in an approved observation window. For each query require identical scoped IDs and header fields (`from`, `to`, `subject`, `message_id`, `saved_at`), clean coverage receipts, and zero wrong-folder IDs. `scripts/benchmark-maildir-index.mjs` records p50, p95 and mean for a normal day, a busy day, a large Archive, an amount search and a word search. Reject enablement on a coverage difference. These are acceptance targets. Production timing is pending. Keep `[maildir].indexed_sweep = false` until that comparison passes. Start with one caller, then the standard service config.

See the [implementation and measurement plan](indexed-maildir-design.md).
