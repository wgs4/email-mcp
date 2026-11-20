# Raw Maildir search (`maildir_*` tools)

Read-only search of the Dovecot Maildir store on the mail server, over SSH.

> **Privacy.** These tools read the mail of **every mailbox on the server — every employee**.
> They are **off by default**. Turn them on only on a machine and for a user that the owner of the
> mail store has authorized (at WGS: David, 2026-11-19). Every call writes one local audit line.

---

## 1. What and why

The IMAP tools in email-mcp see only the accounts configured in `config.toml`. Many mailboxes on the
mail server (for example Justin's and Bart's) are not configured, so the IMAP tools cannot reach them.

On 2026-11-19 a supplier drawing was found in 4 mailboxes with a one-off `grep -rl` over the whole
store (≈1.55 million messages). It took about 10 minutes and many manual steps. The `maildir_*` tools
make that a safe, repeatable search:

| Tool | Purpose |
|---|---|
| `maildir_search` | Find messages in all mailboxes / folders / years. Header search (default), full-text search, attachment-name search, date range, scope filters, paging. |
| `maildir_get_email` | Read one message by id: headers, text body (size-capped), attachment list. |
| `maildir_save_attachment` | Save one attachment of a message to a local file (home or tmp dir only). |

Nothing on the mail server is ever written, moved, deleted or flagged.

---

## 2. Architecture

```
 MCP client ──stdio──> email-mcp (iMac)
                          │
                          │  MaildirService (src/services/maildir/maildir.service.ts)
                          │    ├─ paths.ts     id / path validation, Dovecot layout, allow/deny lists
                          │    ├─ patterns.ts  grep patterns (PCRE), term variants, local matchers
                          │    ├─ mime.ts      RFC 2047 / RFC 2231 decoding, header parsing
                          │    └─ remote.ts    the ONLY place that talks to the server
                          │
                          │  spawn('ssh', argv)  — no local shell
                          ▼
                 ssh -T -o BatchMode=yes ... -- mailserver '<command>'
                          │
                          ▼
     mail server: LC_ALL=C sudo -n -u 'vmail' '/usr/bin/<find|grep|head>' '<arg>' '<arg>' ...
```

Files:

| File | Role |
|---|---|
| `src/tools/maildir.tool.ts` | MCP tool schemas (zod) and result formatting (`isError` rules). |
| `src/tools/register.ts` | Registers the tools only when `[maildir] enabled = true`. |
| `src/config/schema.ts`, `loader.ts` | `[maildir]` section: validation and defaults. |
| `src/services/maildir/*.ts` | The service and its helpers (above). |

### 2.1 Search pipeline

1. **Discover** folder directories (one call, ≈0.6 s for the whole store, cached 5 minutes):
   `find /var/vmail -mindepth 4 -maxdepth 5 -type d ( -name cur -o -name new ) -prune -printf '%p\0'`.
   Only paths that match the strict Dovecot layout are kept (see §3); config allow/deny lists and the
   caller's `domains` / `users` / `folders` / `exclude_folders` are applied locally.
2. **Primary pass** — one ssh call per mailbox, 3 in parallel (`concurrency`):
   `find <cur/new dirs of the mailbox> -maxdepth 1 -type f [-newermt SINCE] [! -newermt BEFORE] -exec /usr/bin/grep <opts> -e <pattern> -- {} +`
3. **Sort** candidates newest first by the delivery time in the file name.
4. **Verify in batches of 150**, newest first, until `max_results` hits:
   - secondary remote filters (`grep -l` on the batch) — e.g. `attachment_name` when there is also a `query`;
   - fetch the header block of each candidate (`grep -m1 -B1000 '^\r?$'`) — used for local
     verification of folded-header hits and of `from`/`to`/`subject` filters, and for display.
5. **Cache** the verified rows for 10 minutes (only complete results). Later pages (`offset`) read
   the cache and do not scan again.
6. **Attachment names** are read only for the rows on the returned page.

### 2.2 How the header search reads only headers

Header search uses GNU grep with one PCRE that has three alternatives, and `-o -m 1`:

```
^(?=\r?$)  |  ^(?:from|to|cc|subject)[ \t]*:.*?TERM  |  ^[ \t].*?TERM
```

- `^(?=\r?$)` matches the blank line that ends the headers. It is an *empty* match, so `-o` prints
  nothing; `-m 1` then makes grep stop reading that file. Bodies and attachments are never read.
- The second alternative is a direct hit on a selected header line.
- The third alternative is a hit on a folded continuation line. Which header it continues is
  unknown at that point, so these candidates are checked locally against the unfolded, decoded
  headers. False ones (for example a `Received:` continuation) are dropped.

Output per hit: `<path>\0<matched text>\n`. Measured on Justin's mailbox (27,220 messages): this
method took 9.4 s cold; a fold-aware `grep -z` multi-line regex took 28–30 s (CPU-bound), so the
line method was chosen.

### 2.3 Term forms (raw-byte matching)

All matching runs on the **raw message bytes** in the C locale (`LC_ALL=C`, ASCII case folding,
`-a` treats binary as text). Fixed terms are sent as PCRE with every non-alphanumeric byte written
as `\xHH`, so a term can never be read as regex syntax, and never as a `find -exec` terminator
(`;`, `+`) or placeholder (`{}`). A term is searched in these forms:

| Form | Example for `外` | Finds |
|---|---|---|
| plain | bytes `E5 A4 96` | ASCII text, 8-bit UTF-8 headers and bodies |
| RFC 2047 Q-encoding of the UTF-8 bytes | `=E5=A4=96` (space → `_`) | `=?UTF-8?Q?...?=` headers and names |
| RFC 2231 / %-encoding of the UTF-8 bytes | `%E5%A4%96` | `filename*=utf-8''...` names |

**The C locale is required.** `LC_ALL=C` is set in front of `sudo`, and sudo keeps it (Ubuntu's
default `env_keep` includes the `LC_*` variables). Verified 11/19/26: with it, `grep -P '\xe5\xa4\x96'`
matches the UTF-8 bytes of `外`; without it, grep reads `\xe5` as the code point U+00E5 and finds
nothing. If a future sudo policy drops `LC_ALL`, non-ASCII searches would silently miss — see
Troubleshooting.

**Not found:** words inside base64 (B-encoded headers `=?UTF-8?B?...?=`, base64 bodies) and
non-UTF-8 encodings of non-ASCII terms (for example GBK `=CD=E2`). ASCII parts of a name are still
found: `RV9110NO` finds `=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?=`. Every result carries
this limit in `notes`.

### 2.4 Decoding

- Search results: header values and attachment names are decoded with a small built-in RFC 2047 /
  RFC 2231 decoder (`mime.ts`) using Node's `TextDecoder` (full ICU: GBK, GB18030, Big5, Shift_JIS …).
  Attachment names in search results are best effort.
- `maildir_get_email` and `maildir_save_attachment` parse the whole message with `mailparser`, so
  their attachment list and names are exact.

---

## 3. Mail server layout

| Item | Value |
|---|---|
| Host | Mac-Mini-Mail, Ubuntu, `192.168.1.147`, SSH port `23500`, user `itdept` |
| Dovecot | `mail_location = maildir:/var/vmail/%d/%n/Maildir`; owner `vmail:vmail`, mode 770 |
| INBOX | `/var/vmail/<domain>/<user>/Maildir/{cur,new}` |
| Other folders | `/var/vmail/<domain>/<user>/Maildir/.<Name>/{cur,new}`; sub-folders `.Name.Sub` (Maildir++) |
| File name | `1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,RSa` — Unix delivery time, unique part, `S=` size, flags after `:2,` |
| Size (11/19/26) | 9 domains, 148 mailboxes, 1,801 folders, 3,603 `cur`/`new` dirs, ≈1.55 M messages |

Accepted path pattern (root-relative), everything else is ignored or refused:

```
<domain>/<user>/Maildir[/.<Folder>]/(cur|new)[/<file>]
domain = [a-z0-9][a-z0-9.-]*   user = [A-Za-z0-9._+-]{1,64}
Folder/file = no "/", no control chars, not "." or ".."
```

Not searched: `tmp/`, Dovecot index files, `xapian-indexes/`, and non-standard directories such as
`wgsusa.com/jesse/Maildir/jesse/cur`.

Folder names are shown without the leading dot, with IMAP modified UTF-7 decoded
(`.WGS.Justin &- Valerie` → `WGS.Justin & Valerie`). INBOX is `INBOX`.

**Date.** `since` / `before` filter on the file **mtime** with `find -newermt` (Dovecot sets mtime to
the IMAP INTERNALDATE = delivery time). Dates are in the mail server's local time. Results show
`saved_at` (time in the file name, UTC ISO) and `date` (the sender's `Date:` header).

---

## 4. Server access: SSH and the sudo rule

### 4.1 sudo rule (installed 11/19/26)

`/etc/sudoers.d/claude-mail-read`:

```
itdept ALL=(vmail) NOPASSWD: /usr/bin/find, /usr/bin/grep, /usr/bin/zgrep, /usr/bin/cat, /usr/bin/zcat, /usr/bin/ls, /usr/bin/head
```

The code uses only `find`, `grep` and `head` (`REMOTE_TOOLS` in `remote.ts`), always as
`sudo -n -u vmail /usr/bin/<tool>`. `-n` = never prompt; a missing rule fails fast with
"refused the sudo command". email-mcp never asks for, adds or changes sudo rights.

### 4.2 SSH

The client uses an `ssh_config` alias (default `mailserver`) with key login. On the iMac:

```
Host mailserver
    HostName 192.168.1.147
    Port 23500
    User itdept
    IdentityFile ~/.ssh/mail_server
    IdentitiesOnly yes
```

ssh options set by email-mcp: `-T`, `BatchMode=yes` (no password prompts), `ConnectTimeout`,
`ServerAliveInterval=15`, `ServerAliveCountMax=2`, `ClearAllForwardings=yes`, `RequestTTY=no`, then
`--`, the host and the command. stdin is closed. One ssh connection per remote call (≈0.2 s); no
connection sharing (a `ControlPersist` master keeps the child's stdio open).

---

## 5. Tools and parameters

### 5.1 `maildir_search`

At least one of `query`, `from`, `to`, `subject`, `attachment_name` is required. All given criteria
are combined with AND. Matching is case-insensitive.

| Parameter | Type / default | Meaning |
|---|---|---|
| `query` | string | Term to find. Where: see `mode` and `fields`. |
| `mode` | `headers` (default) \| `full_text` | `headers` reads only the header block (fast). `full_text` reads whole files (headers + body + attachments as raw bytes). |
| `fields` | array, default `from,to,cc,subject` | Header fields for `mode=headers`. Allowed: `from, to, cc, bcc, subject, reply-to, sender, message-id, in-reply-to, references, list-id, delivered-to, x-original-to`. |
| `regex` | bool, `false` | Treat every term as a regular expression: PCRE on the server; it must also compile as a JavaScript RegExp (used for local verification). |
| `from` / `to` / `subject` | string | That header contains the term. |
| `attachment_name` | string | A MIME `name=` / `filename=` parameter contains the term. |
| `domains` | string[] | e.g. `["wgsusa.com"]`. Default: all allowed. |
| `users` | string[] | `"justin"` (any domain) or `"justin@wgsusa.com"`. |
| `folders` | string[] | Folder globs (`*`, `?`), case-insensitive: `"INBOX"`, `"Sent*"`, `"Archive*"`. |
| `exclude_folders` | string[] | Folder globs to skip, e.g. `["Junk","spam","Trash"]`. Default: nothing skipped (spam-tagged mail is often real — the PO208780 drawing was tagged `***SPAM***`). |
| `since` | `YYYY-MM-DD[ HH:MM[:SS]]` | Delivered after this time (server local time). A bare date is the start of that day. |
| `before` | same | Delivered before this time (`find ! -newermt`). A bare date is the start of that day, so `since=2025-03-01`, `before=2025-04-01` is all of March. |
| `offset` | int, 0 | Paging offset. |
| `limit` | int, 50 (max 200) | Page size. |
| `max_results` | int | Stop after this many hits (capped by config `max_results`). |
| `timeout_seconds` | int | Budget for the whole search (default config `default_timeout_seconds`, capped by `max_timeout_seconds`). |

Which criterion drives the scan:

| Given | Primary scan (per mailbox) | Then |
|---|---|---|
| `query`, `mode=headers` | header grep on `fields` | other criteria as filters |
| `query`, `mode=full_text` | `grep -P -l` (byte-escaped fixed term, or the user regex) | other criteria as filters |
| no `query`, some of `from`/`to`/`subject` | header grep on the first of them | the rest checked locally on headers |
| only `attachment_name` | `grep -P -l` on `name=`/`filename=` lines | — |

Result (JSON, after a one-line summary):

```jsonc
{
  "complete": true,              // false = cut short; see partial_reasons
  "partial_reasons": [],         // timeout, output cap, result cap, server errors, skipped mailboxes
  "warnings": [],                // e.g. files renamed during the search
  "total_hits": 26, "offset": 0, "limit": 50, "returned": 26, "next_offset": null,
  "from_cache": false, "elapsed_ms": 21321,
  "scope": { "mailboxes": 148, "mailboxes_searched": 148, "mailboxes_not_searched": [],
             "folders": 1801, "since": "2025-03-01", "before": "2025-04-01" },
  "criteria": { ... },
  "notes": [ "Matching is on raw message bytes ..." ],
  "results": [{
    "id": "wgsusa.com/justin/Maildir/cur/1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,RSa",
    "mailbox": "justin@wgsusa.com", "folder": "INBOX",
    "saved_at": "2025-03-19T05:31:12.000Z", "date": "Wed, 19 Mar 2025 13:28:28 +0800 (CST)",
    "from": "Rita  <sales1hongyuan@163.com>", "to": "\"Lisa Hall\" <lisa@wgsusa.com>", "cc": "...",
    "subject": " ***SPAM***  Re:PO208780-WGS Paypal  invoice   Mar 19th 2025",
    "message_id": "<333998fb.4c63.195acdfe350.Coremail.sales1hongyuan@163.com>",
    "size": 647637, "flags": "RSa",
    "attachments": ["RV9110NO-FB12.5A7.0 外形图.pdf", "208780　WGS Paypal  invoice   Mar 19th 2025.pdf"]
  }]
}
```

`id` = the path under the root. It is stable enough to pass to the other two tools: Dovecot renames a
file when its flags change (`:2,S` → `:2,RS`), and the tools then find it again by its unique base
name in the same folder (`cur/` or `new/`).

The same message delivered to several people appears once per mailbox; group by `message_id`.

### 5.2 `maildir_get_email`

| Parameter | Type / default | Meaning |
|---|---|---|
| `id` | string | From `maildir_search` (root-relative, or absolute under the root). |
| `max_body_chars` | int | Cap on returned text (capped by config `max_body_chars`, default 20,000). |
| `include_headers` | bool, false | Also return the raw header block (max 64 KiB). |

Returns `id`, `mailbox`, `folder`, `flags`, `saved_at`, `size`, `headers` (from, to, cc, bcc,
reply_to, subject, date, message_id, in_reply_to), `text`, `text_truncated`, `text_length`,
`has_html`, `attachments` (`index`, `filename`, `content_type`, `size`, `inline`, `content_id`) and
`message_truncated`. Reads at most `max_message_bytes` (default 64 MiB) with `head -c`; a larger
message is parsed partly and says so in `warning`.

### 5.3 `maildir_save_attachment`

| Parameter | Type / default | Meaning |
|---|---|---|
| `id` | string | From `maildir_search`. |
| `filename` | string | Exact decoded name from `maildir_get_email`. |
| `index` | int | Attachment index from `maildir_get_email` (use when names repeat). If both are given they must agree. |
| `destination` | string, `~/Downloads/` | Absolute file path or directory. |
| `overwrite` | bool, false | Otherwise `name-1.ext`, `name-2.ext`, … |

Same path rules as `save_attachment`: the destination must be under the user's home directory or the
OS tmp dir (`os.tmpdir()`, on macOS `/var/folders/...`, **not** `/tmp`); `..` is refused; the file
name is sanitized. The file is written with `wx` (no overwrite) unless `overwrite` is true. A message
larger than `max_message_bytes` is refused (raise the limit to save from it).

---

## 6. Configuration

```toml
[maildir]
enabled = true                 # default false — tools are not registered at all when false
ssh_host = "mailserver"        # ssh_config alias or user@host; never an ssh option
root = "/var/vmail"            # absolute, [A-Za-z0-9._/-], no "." / ".." segments
sudo_user = "vmail"
allowed_domains = []           # empty = all domains under root
excluded_domains = []
allowed_users = []             # "user@domain"; empty = all mailboxes
excluded_users = []            # e.g. ["bart@wgsusa.com"]
connect_timeout_seconds = 10
default_timeout_seconds = 300  # search budget when the caller gives none
max_timeout_seconds = 900      # hard cap on timeout_seconds
max_results = 2000             # hard cap on hits per search
max_output_bytes = 16777216    # cap on stdout of any one remote command (16 MiB)
max_message_bytes = 67108864   # largest message read by get/save (64 MiB)
max_body_chars = 20000
concurrency = 3                # parallel ssh calls (1-8)
```

Allow/deny lists apply everywhere: discovery, search scope and every id passed to
`maildir_get_email` / `maildir_save_attachment`.

---

## 7. Limits

| Limit | Default | Effect when hit |
|---|---|---|
| One mailbox fails (ssh error, sudo refusal) | — | That mailbox is listed in `mailboxes_not_searched` with the reason; the other mailboxes still return. `complete: false`. |
| Remote command killed on the server (exit > 2 or signal) | — | `complete: false` ("ended abnormally"). |
| Search time (`timeout_seconds`) | 300 s (max 900) | Remaining mailboxes are not started; the running ssh calls are killed (SIGTERM, then SIGKILL after 2 s). `complete: false`, `mailboxes_not_searched` lists them. |
| Output per remote call | 16 MiB | ssh is killed; `complete: false` ("too many matches"). |
| Hits per search (`max_results`) | 2000 | `complete: false` ("Result cap reached"). |
| Page size | 50 (max 200) | Use `offset` / `next_offset`. |
| Header block read | 1000 lines before the first blank line | Very long Received chains lose their oldest lines (display only). |
| Attachment-name lines per file (page fetch) | 400 | Display only. |
| Message read (get/save) | 64 MiB | get: partial parse + warning; save: refused. |
| Text body | 20,000 chars | `text_truncated: true`. |
| Term length | 500 chars; no NUL/CR/LF | Refused. |

---

## 8. Safety model

| Rule | How |
|---|---|
| Read-only | Only `find`, `grep`, `head` run on the server. No write, move, delete or flag change exists in the code. `maildir_save_attachment` writes only a local file. |
| No shell injection | ssh is spawned with an argv array (no local shell). The remote side runs a shell, so **every** argument — paths, patterns, dates, the sudo user, the tool path — is single-quoted with `'\''` escaping (`shQuote`). Arguments with NUL, CR or LF are refused before anything is sent. The command shape is fixed: `LC_ALL=C sudo -n -u '<user>' '/usr/bin/<tool>' '<arg>' ...` — no pipes, redirects, `;`, `&&` or subshells. `ssh_host`, `root` and `sudo_user` are validated at config load and again before use; `--` precedes the host so it cannot be read as an ssh option. |
| Allow-listed tools | `buildRemoteCommand` refuses any tool outside `REMOTE_TOOLS = find, grep, head`. |
| No find primaries from input | The only find primaries are fixed in code (`-mindepth`, `-maxdepth`, `-type`, `-name`, `-prune`, `-newermt`, `-printf`, `-print0`, `-exec /usr/bin/grep ... {} +`). Caller values reach find only as: start directories (validated paths under the root), `-newermt` dates (strict `YYYY-MM-DD[ HH:MM[:SS]]`), `-name` globs (escaped base names) and grep arguments inside `-exec`. A grep argument that is `;`, `+` or contains `{}` is refused before any scan, so input can never end `-exec` early and start new primaries (such as `-delete`). |
| Local writes stay in home/tmp | `maildir_save_attachment` checks the path text (`assertSafeDestination`), then the **real** directory after symlinks (`realpath`) against the real home and tmp dirs, and refuses a target that is itself a symbolic link. Without `overwrite` the file is opened with `wx` (exclusive create). |
| Paths stay in the root | Ids must match the Dovecot layout (§3), contain no `..`/`.` segments, no control characters, and (if absolute) start with `<root>/`. Remote output paths are re-validated the same way and must belong to the mailbox that was scanned; anything else is dropped. `find -name` globs built from ids are escaped. |
| Bounded | Every remote call has a deadline and a byte cap (§7). |
| Honest results | Anything cut short sets `complete: false` with reasons. A cut-short search with **no** hits returns `isError: true` with the text "Missing results do NOT mean the message does not exist" — the user never reads "not found" after a timeout (lesson from PR #12, search false negatives). Partial results are never cached. Errors say "nothing was found or ruled out". |
| No body/credential logging | Nothing from message bodies is logged. stderr from the server is used only for error classification and short error messages (paths, not content). `find:`/`grep:` error lines make a result partial; "No such file or directory" (a message renamed by a flag change mid-search) is a warning; other stderr lines (banners, ssh notices) are passed on as `Server said: ...` warnings. |
| Audit | One JSON line per call in `~/.local/share/email-mcp/audit.log` (tool `maildir_search` / `maildir_get_email` / `maildir_save_attachment`, account `maildir`): local OS user, criteria and scope, hit count, `complete`, elapsed time; for get/save the id and saved path. |
| Off by default | `enabled = false` unless set; with no `[maildir]` section the tools do not exist. |

---

## 9. Privacy

- The tools read **all** mailboxes on the server, including mailboxes of people who did not configure
  email-mcp. Use them only for business needs the mail-store owner authorized.
- Keep them disabled on shared machines. Enable them per machine in `~/.config/email-mcp/config.toml`.
- Use `allowed_users` / `excluded_users` / `allowed_domains` / `excluded_domains` to narrow access
  (for example exclude HR or personal mailboxes).
- Every search, read and save is in the local audit log.
- Saved attachments are ordinary local files; delete them when done.

---

## 10. Performance (measured 2026-11-19, iMac → mail server, LAN)

| Search | Scope | Time | Result |
|---|---|---|---|
| Discovery (`find -prune`) | whole store | 0.6 s | 148 mailboxes, 3,603 dirs |
| Header `PO208780`, March 2025 | all 148 mailboxes, 1,801 folders | **21 s** | 26 hits, complete |
| Header `PO208780`, all years | ≈1.55 M messages | **254 s** (concurrency 3); 219 s (concurrency 6) | 26 hits, complete |
| Attachment name `RV9110NO-FB12.5A7.0`, since 2025-01-01 | all mailboxes | 142 s | 4 mailboxes: kayla, gina, justin, lisa |
| Full text `RV9110NO` | justin (27,220 msgs) | 25 s | 2 hits |
| Header grep, raw | lisa (4,252 msgs, 1.5 GB) | 2.4 s | — |
| Header grep, raw | kayla (20,197 msgs) cold | 9.4 s | — |
| `maildir_get_email` / `maildir_save_attachment` | one 648 KB message | 0.7 s | GBK name decoded; valid 184,569-byte PDF |

Guidance: always give a date range when you can — `find -newermt` only stats files, so it removes most
of the work. Header search reads only header blocks; full-text and attachment searches read whole
files and are disk-bound (≈5× slower). Concurrency above 3 gave only ≈14 % more speed and loads the
live mail server more, so 3 is the default.

---

## 11. Examples

Find the supplier drawing (the 11/19 case):

```json
{ "tool": "maildir_search",
  "args": { "query": "PO208780", "since": "2025-03-01", "before": "2025-04-01" } }
```

Attachment name, one domain, skip junk:

```json
{ "tool": "maildir_search",
  "args": { "attachment_name": "RV9110NO", "domains": ["wgsusa.com"],
            "exclude_folders": ["Junk", "spam", "Trash", "Deleted*"], "since": "2025-01-01" } }
```

Sender + subject in two mailboxes:

```json
{ "tool": "maildir_search",
  "args": { "from": "163.com", "subject": "invoice", "users": ["justin", "bart@wgsusa.com"] } }
```

Body text, regex, sent mail only:

```json
{ "tool": "maildir_search",
  "args": { "query": "PO2087[0-9]{2}", "regex": true, "mode": "full_text",
            "folders": ["Sent*"], "since": "2025-01-01" } }
```

Read and save:

```json
{ "tool": "maildir_get_email", "args": { "id": "wgsusa.com/justin/Maildir/cur/1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,RSa" } }
{ "tool": "maildir_save_attachment", "args": { "id": "<same id>", "index": 0 } }
```

Next page: repeat the same search with `"offset": <next_offset>` (served from the cache for 10 minutes).

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tools not listed | `[maildir] enabled = true` missing, or the MCP server was not restarted after the config change. |
| `SSH to the mail server failed: ...` | Check `ssh mailserver true` as the same OS user (key, `~/.ssh/config`, host reachable, port 23500). BatchMode forbids password prompts. |
| `The mail server refused the sudo command` | The sudo rule `/etc/sudoers.d/claude-mail-read` is missing or changed. Fix it on the server as an admin; email-mcp never changes it. |
| `No mail folders found under /var/vmail` | Wrong `root`, or `allowed_domains`/`allowed_users` exclude everything. |
| `No mailbox folder matches this scope` | `domains` / `users` / `folders` select nothing (folder globs match the display name, e.g. `Sent Messages`, `Archive.2020`). Nothing was searched — this is not "zero hits". |
| `complete: false`, "Time limit reached" | Add `since`/`before`, narrow users/folders, or raise `timeout_seconds` (≤ `max_timeout_seconds`). |
| `complete: false`, "too many matches (output cap)" / "Result cap reached" | The term is too broad; add filters. |
| Warning "renamed or moved during the search" | Someone read or moved mail while the search ran; run it again. |
| Non-ASCII term finds nothing, ASCII works | The server's sudo policy may no longer keep `LC_ALL` (see §2.3). Test: `printf '外\n' \| ssh mailserver "LC_ALL=C sudo -n -u vmail /usr/bin/grep -c -P '\\xe5\\xa4\\x96'"` must print `1`. |
| `The search pattern contains "{}" or is ";" / "+"` | Only in regex mode; write literal braces as `\{\}`. |
| A known message is not found | The term may only exist inside base64 (B-encoded subject, base64 body) or in a non-UTF-8 encoding. Search an ASCII part of it, use `from`/`message-id`, or `attachment_name` with the ASCII part of the file name. |
| `Message not found: <id>` | Deleted or moved to another folder since the search; search again. |
| Save refused: "outside the user's home directory and tmp dir" | Use a path under `~` or `os.tmpdir()` (macOS: `$TMPDIR`, not `/tmp`). |

---

## 13. How to disable

1. In `~/.config/email-mcp/config.toml` set `enabled = false` in `[maildir]` (or delete the section).
2. Restart the MCP server (restart the Claude session / client). The three tools disappear.
3. To remove server access completely, an admin deletes `/etc/sudoers.d/claude-mail-read` on the mail
   server (or removes the client's key from `itdept`'s `authorized_keys`).
