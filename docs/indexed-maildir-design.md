# Direct indexed Maildir implementation

`[maildir].indexed_sweep` stays `false` until a pilot comparison passes. The helper is `/usr/local/libexec/maildir-index-sweep` (source `scripts/maildir-index-sweep`). It is fixed to the `/var/vmail/<domain>/<user>/Maildir` layout. Other roots keep the raw reader. The client still applies domain, account and folder rules before it calls the helper.

## Query and index selection

The helper has two modes.

1. Date-window sweep (broad header census):

```text
doveadm -f tab fetch -u <user> storageid mailbox-guid <guid> ( since <since-1d> [before <before+2d>] ) OR uid *
```

`uid *` is Dovecot's highest UID, not every UID. One call returns the delivery window and proves the index still knows the newest message. The helper then applies the raw reader's nanosecond bounds (`mtime > since` and `mtime <= before`) by stating only those candidates.

2. Text or amount search:

```text
doveadm -o plugin/fts_enforced=yes search -u <user> mailbox-guid <guid> [since <since-1d>] [before <before+2d>] <clauses>
```

`mode=full_text` sends `text "<token>"` for each token. That is `fts-xapian`'s `wldcrd` query: every indexed header plus the body. `mode=headers` sends `header <field> "<token>"`. One field is a single clause. Several fields become `( header f1 "<token>" OR header f2 "<token>" ... )`. The fields Xapian is allowed to answer are `from`, `to`, `cc`, `bcc`, `subject` and `list-id`.

`fts_xapian` on this host is `partial=3 full=20`. The service therefore keeps lowercase ASCII runs of 3 to 20 characters (`[a-z0-9]{3,20}`). A run longer than 20 is sliced into the first 20 and the last 20 characters. At most eight tokens are sent, longest first. Punctuation is not part of the token, so `"$590,550.00"` and `"PO-208780"` still produce `590`/`550` and `208780`. `Xapian::TermGenerator`, `XNGram` and `XQuerySet` disagree on punctuation; searching the alphanumeric pieces avoids a false negative. Grep on only the returned files removes every false positive, including a token that happened to match a different header or a different amount.

These queries skip the helper and use the raw scan directly:

* a term that is not printable ASCII (for example `外形图`)
* a term whose longest ASCII run is shorter than 3 characters (`ab`)
* any `regex=true` query other than the broad `.*` date census
* an attachment-name-only primary scan
* a header field Xapian does not index: `reply-to`, `sender`, `message-id`, `in-reply-to`, `references`, `delivered-to`, `x-original-to`

Each probe gets at most one third of the remaining search deadline, capped at 28 seconds. The helper's own alarm is 25 seconds. Any error, timeout, partial protocol or out-of-scope path retries the original raw search for that mailbox only.

## Cheap, sound coverage proof

Statting every file in an 84,000-message Archive is nearly as expensive as the raw scan. The helper no longer does that. Coverage is two checks, then `stat()` only on candidates.

1. Physical Maildir to `dovecot-uidlist`. `os.scandir` reads `cur/` and `new/` and uses `d_type` (`entry.is_file(follow_symlinks=False)`), so this step makes no per-file `stat()`. Every physical file's base name must have a UID, and that UID must be `<= max_uid` in the folder's v3 `dovecot-uidlist`. A small fixture with an incomplete UID list (256 files or fewer) may still stat each in-window file and require its base name in the doveadm reply. A larger incomplete folder refuses the index.

2. Index to `dovecot-uidlist`.
   * Date sweeps require `uid_to_base[max_uid]` in the doveadm reply (`OR uid *`). They then `stat()` only the returned candidates and apply `lo < st_mtime_ns <= hi`.
   * FTS searches read `xapian-indexes/db_<guid>/iamglass` (about 146 bytes) and one to three 8 KiB blocks of `postlist.glass`. The value-slot 1 key is `\x00\xd0\x01`. `sortable_unserialise` yields `last_indexed_uid`. The helper requires `doccount > 0`, `freq >=` the number of physical files, and `last_indexed_uid >= max_uid`. That is the same condition Dovecot's `fts_indexer_init` uses before it skips `/var/run/dovecot/indexer`. An unreadable component (including a root-owned `0600` `iamglass`) or a short index raises coverage failure. `stat()` runs only when `since` or `before` is set, and only on the FTS hits.

The helper rechecks directory, UID-list and glass-file versions before it prints paths. It emits `maildir-index-v1-complete` only after every folder succeeds. The client checks every path against the requested directories.

## Dedicated mailreader account

Install this on Mac-Mini-Mail (`192.168.1.147`, SSH port `23500`) as an admin. `itdept` and `/etc/sudoers.d/claude-mail-read` stay in place until every client has switched, so nothing breaks during the move.

1. Create `mailreader` with no password login and no admin groups:

```bash
sudo adduser --disabled-password --gecos "email-mcp read-only mail reader" mailreader
```

2. Install the iMac and production keys:

```bash
sudo install -d -m 0700 -o mailreader -g mailreader /home/mailreader/.ssh
sudo tee /home/mailreader/.ssh/authorized_keys >/dev/null <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM2P5N/kHXoSBAEl10g16/uR5PYPB25MG6NqcJaTuZcE david@imac-to-mail
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILnDvz5Py8DbtvpYmwlka12LwQxtFPmSYY2AyIK5lA7E itdept@Screens-VM
EOF
sudo chown mailreader:mailreader /home/mailreader/.ssh/authorized_keys
sudo chmod 0600 /home/mailreader/.ssh/authorized_keys
```

3. Install the helper, root-owned, mode `0755`:

```bash
sudo install -d -m 0755 -o root -g root /usr/local/libexec
sudo install -m 0755 -o root -g root /tmp/maildir-index-sweep /usr/local/libexec/maildir-index-sweep
```

4. Let `mailreader` run only the helper and the three read-only fallback binaries, as `vmail`, with no password:

```bash
sudo tee /etc/sudoers.d/mailreader-maildir >/dev/null <<'EOF'
Defaults:mailreader env_keep += "LC_ALL"
mailreader ALL=(vmail) NOPASSWD: /usr/local/libexec/maildir-index-sweep, /usr/bin/find, /usr/bin/grep, /usr/bin/head
EOF
sudo chmod 0440 /etc/sudoers.d/mailreader-maildir
sudo visudo -cf /etc/sudoers.d/mailreader-maildir
sudo visudo -c
```

To try the helper as `itdept` before the switch, add `/usr/local/libexec/maildir-index-sweep` to the command list in `/etc/sudoers.d/claude-mail-read` and run `sudo visudo -cf /etc/sudoers.d/claude-mail-read`. After every client uses `mailreader`, an admin removes that file:

```bash
sudo rm /etc/sudoers.d/claude-mail-read
sudo visudo -c
```

5. On the iMac and on production `192.168.1.193`, point email-mcp at the new account and turn the sweep on only for the pilot:

```toml
[maildir]
ssh_host = "mailreader@mailserver"
indexed_sweep = true
```

Or set `User mailreader` on the `mailserver` host in `~/.ssh/config` and leave `ssh_host = "mailserver"`. Do not enable `indexed_sweep` on a host whose sudo rule does not list the helper.

The helper chooses the doveadm verb, the GUID and the flags itself. Granting the client a generic `doveadm` binary would also expose administrative verbs. No Dovecot config change is required: `fts = xapian` and `fts_autoindex = yes` are already set. The search probe passes `plugin/fts_enforced=yes` so doveadm cannot silently scan files when the index should have answered.

## Benchmarking and rollback

Self-test (no SSH, synthetic runner, two mailboxes, timing plus ID and header parity):

```bash
node scripts/benchmark-maildir-index.mjs --self-test
```

Live comparison. All six dates are required so an Archive scan is not accidental. `--run-live` is required as well. Without either flag the script exits 2.

```bash
node scripts/benchmark-maildir-index.mjs --run-live \
  --ssh-host mailreader@mailserver \
  --users david@wgsusa.com,kayla@wgsusa.com \
  --normal-since 2025-03-01 --normal-before 2025-03-02 \
  --busy-since 2025-03-19 --busy-before 2025-03-20 \
  --archive-since 2024-01-01 --archive-before 2024-02-01 \
  --amount 590550 --word invoice --iterations 3 \
  --json-out /tmp/maildir-index-bench.json
```

The table is raw versus indexed p50, p95 and mean for `normal_day`, `busy_day`, `big_archive`, and for `amount_search` and `word_search` in both `headers` and `full_text`. Parity is `complete`, `total_hits`, ordered ids compared by base name, and `from`, `to`, `subject`, `message_id`, `saved_at`. The indexed run must report `mailbox_backends` of `index`. The raw run must report `raw`. A mismatch exits nonzero.

Rollback, in `~/.config/email-mcp/config.toml`, then restart the MCP server:

```toml
[maildir]
indexed_sweep = false
ssh_host = "mailserver"
```

The next uncached query uses the previous grep path. Leave the helper and the `mailreader` sudoers file installed until you intend to remove them. The feature writes no message store.
