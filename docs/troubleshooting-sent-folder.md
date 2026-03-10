# Troubleshooting: Sent Mail Appears in Wrong Folder

## Symptom

After sending an email through email-mcp, the sent copy appears in a folder that
Mac Mail displays with a plain folder icon — not the folder with the paper airplane
icon that Mac Mail uses as its native Sent mailbox. Both folders may appear with
the same label ("Sent") in the Mac Mail sidebar.

## Root Cause

cPanel/Dovecot servers typically expose **two** sent-related folders:

| IMAP Path | IMAP Name | specialUse attribute | Mac Mail display |
|-----------|-----------|---------------------|-----------------|
| `INBOX.Sent` | Sent | `\Sent` (RFC 6154 SPECIAL-USE) | "Sent" — plain folder icon |
| `INBOX.Sent Messages` | Sent Messages | *(none)* | "Sent" — paper airplane icon |

The discrepancy arises because:

1. **Mac Mail** configured `INBOX.Sent Messages` as the sent mailbox when the
   account was first added — likely before `INBOX.Sent` existed on the server.
   Mac Mail's paper airplane icon follows whatever folder it has designated as the
   sent mailbox in its own preferences, not the IMAP SPECIAL-USE attribute.

2. **email-mcp** uses the standard RFC 6154 SPECIAL-USE detection algorithm:
   it calls `IMAP LIST` and looks for a mailbox flagged with `\Sent`. On cPanel
   servers this resolves to `INBOX.Sent` — technically correct per the standard,
   but not the folder Mac Mail is watching.

The result: email-mcp appends sent copies to `INBOX.Sent`; Mac Mail reads sent
mail from `INBOX.Sent Messages`. They never overlap.

## Fix

Use the `sent_folder` config key to pin each cPanel account directly to
`INBOX.Sent Messages`, bypassing auto-detection entirely:

```toml
[[accounts]]
name = "my-account"
email = "example@sample.com"
password = "________"
sent_folder = "INBOX.Sent Messages"   # <-- add this line

[accounts.imap]
host = "your-cpanel-server.com"
port = 993
tls = true
```

Apply this to every account hosted on cPanel. Gmail and iCloud do not need it:

- **Gmail** — auto-saves sent mail server-side via SMTP; email-mcp skips the
  IMAP append entirely for Gmail accounts.
- **iCloud** — uses standard SPECIAL-USE correctly; no mismatch observed.

See `config.example.toml` in the repo root for a complete template with this
setting pre-applied to the cPanel account stanzas.

## Verifying Your Folder Names

If you are on a different mail host and want to see exactly what folders and
SPECIAL-USE attributes your server exposes, run this one-off debug script from
the repo root:

```js
// debug-folders.mjs  (delete after use — do not commit)
import { ImapFlow } from 'imapflow';

const client = new ImapFlow({
  host: 'your-imap-host.com',
  port: 993,
  secure: true,
  auth: { user: 'you@example.com', pass: 'yourpassword' },
  logger: false,
});

await client.connect();
for (const mb of await client.list('', '*')) {
  console.log(`${mb.path}  specialUse=${mb.specialUse ?? '(none)'}  flags=${[...(mb.flags ?? [])].join(',')}`);
}
await client.logout();
```

```bash
node debug-folders.mjs
```

Look for the folder that Mac Mail shows with the paper airplane icon and use its
`path` value as `sent_folder` in your config.

## email-mcp Sent Folder Resolution Order

For reference, `resolveSentFolder()` in `src/services/imap.service.ts` tries
these in order:

1. **Config override** — if `sent_folder` is set in `config.toml`, use it
   immediately (no server query).
2. **RFC 6154 SPECIAL-USE** — find the mailbox with `specialUse === '\Sent'`
   from the IMAP LIST response.
3. **Common name fallback** — check for `INBOX.Sent`, `Sent`, `Sent Items`,
   `Sent Mail`, `[Gmail]/Sent Mail`, `INBOX.Sent Items`, `INBOX.Sent Messages`
   in that order.

On cPanel hosts, step 2 resolves to `INBOX.Sent` (which has the SPECIAL-USE
flag) rather than `INBOX.Sent Messages` (which does not). The config override
in step 1 is the correct fix.
