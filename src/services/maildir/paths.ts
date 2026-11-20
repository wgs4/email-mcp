/**
 * Path rules for the raw Maildir store.
 *
 * Dovecot layout (mail_location = maildir:<root>/%d/%n/Maildir):
 *   <root>/<domain>/<user>/Maildir/{cur,new}             → folder "INBOX"
 *   <root>/<domain>/<user>/Maildir/.<Name>/{cur,new}     → folder "<Name>"
 * Sub-folders use `.` as the separator (Maildir++): `.Archive.2020`.
 *
 * Every path that crosses the wire — a discovered directory, a grep hit or a
 * caller-supplied message id — must match these patterns exactly, stay under
 * the root, and pass the domain/user allow/deny lists. Anything else is
 * refused (ids) or dropped (remote output).
 */

import type { MaildirConfig } from '../../types/index.js';
import { MaildirIdError } from './errors.js';

// A folder or file name segment: no `/`, no NUL/CR/LF, not `.` / `..`.
const SEGMENT = '[^/\\u0000-\\u001f\\u007f]+';
const DOMAIN = '[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?';
const USER = '[A-Za-z0-9._+-]{1,64}';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — refuse control chars
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/; // eslint-disable-line no-control-regex

/** `<domain>/<user>/Maildir[/.<Folder>]/(cur|new)` relative to the root. */
const DIR_RE = new RegExp(`^(${DOMAIN})/(${USER})/Maildir(?:/(\\.${SEGMENT}))?/(cur|new)$`);
/** A message file: DIR_RE + `/<file>`. */
const FILE_RE = new RegExp(
  `^(${DOMAIN})/(${USER})/Maildir(?:/(\\.${SEGMENT}))?/(cur|new)/(${SEGMENT})$`,
);

export interface MaildirDir {
  /** Path relative to the root, e.g. `wgsusa.com/lisa/Maildir/.Archive/cur`. */
  rel: string;
  domain: string;
  user: string;
  /** `user@domain`, lower-case. */
  mailbox: string;
  /** Maildir++ directory name (`.Archive`) or `''` for INBOX. */
  folderDir: string;
  /** Display name: `INBOX`, `Archive`, `Archive.2020` (modified UTF-7 decoded). */
  folder: string;
  sub: 'cur' | 'new';
}

export interface MaildirFile extends MaildirDir {
  /** File name, e.g. `1742362272.M944266P6252.host,S=647637,W=656098:2,RSa`. */
  file: string;
  /** Unique part before `:2,` — stable across flag changes. */
  base: string;
  /** Maildir flags after `:2,` (e.g. `RSa`), '' when none. */
  flags: string;
  /** Delivery time from the file name prefix (Unix seconds), or null. */
  savedAt: number | null;
  /** Size from the `S=` file name field, or null. */
  size: number | null;
}

function hasDotSegment(rel: string): boolean {
  return rel.split('/').some((seg) => seg === '.' || seg === '..' || seg === '');
}

/** Decode an IMAP modified UTF-7 folder name (`&AOk-` → `é`). Lenient. */
export function decodeModifiedUtf7(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (_m, b64: string) => {
    if (b64 === '') return '&';
    try {
      const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
      // UTF-16BE → string (swap to LE for Node's utf16le decoder).
      const even = buf.subarray(0, buf.length - (buf.length % 2));
      return Buffer.from(even).swap16().toString('utf16le');
    } catch {
      return `&${b64}-`;
    }
  });
}

function folderName(folderDir: string): string {
  return folderDir === '' ? 'INBOX' : decodeModifiedUtf7(folderDir.slice(1));
}

/** Parse a root-relative directory; null when it is not a Dovecot cur/new dir. */
export function parseDir(rel: string): MaildirDir | null {
  if (hasDotSegment(rel)) return null;
  const m = DIR_RE.exec(rel);
  if (!m) return null;
  const [, domain, user, folderDir = '', sub] = m;
  if (folderDir === '.' || folderDir === '..') return null;
  return {
    rel,
    domain,
    user,
    mailbox: `${user.toLowerCase()}@${domain}`,
    folderDir,
    folder: folderName(folderDir),
    sub: sub as 'cur' | 'new',
  };
}

/** Split a Maildir file name into base / flags / time / size. */
export function parseMaildirFileName(
  file: string,
): Pick<MaildirFile, 'base' | 'flags' | 'savedAt' | 'size'> {
  const colon = file.indexOf(':2,');
  const base = colon >= 0 ? file.slice(0, colon) : file;
  const flags = colon >= 0 ? file.slice(colon + 3) : '';
  const t = /^(\d{9,11})\./.exec(base);
  const s = /,S=(\d+)/.exec(base);
  return {
    base,
    flags,
    savedAt: t ? Number(t[1]) : null,
    size: s ? Number(s[1]) : null,
  };
}

/** Parse a root-relative message path; null when it is not a message file. */
export function parseFile(rel: string): MaildirFile | null {
  if (hasDotSegment(rel)) return null;
  const m = FILE_RE.exec(rel);
  if (!m) return null;
  const [, domain, user, folderDir = '', sub, file] = m;
  if (folderDir === '.' || folderDir === '..') return null;
  const dir = parseDir(`${domain}/${user}/Maildir${folderDir ? `/${folderDir}` : ''}/${sub}`);
  if (!dir) return null;
  return { ...dir, rel, file, ...parseMaildirFileName(file) };
}

/** Is this mailbox inside the configured allow/deny lists? */
export function isMailboxAllowed(
  config: Pick<
    MaildirConfig,
    'allowedDomains' | 'excludedDomains' | 'allowedUsers' | 'excludedUsers'
  >,
  domain: string,
  user: string,
): boolean {
  const d = domain.toLowerCase();
  const mailbox = `${user.toLowerCase()}@${d}`;
  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(d)) return false;
  if (config.excludedDomains.includes(d)) return false;
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(mailbox)) return false;
  if (config.excludedUsers.includes(mailbox)) return false;
  return true;
}

/** Root-relative → absolute. `rel` must already be validated. */
export function toAbsolute(root: string, rel: string): string {
  return `${root}/${rel}`;
}

/**
 * Absolute path from remote output → validated root-relative path, or null
 * when it is outside the root or not a message file.
 */
export function fromAbsolute(root: string, abs: string): string | null {
  const prefix = `${root}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length);
}

/**
 * Validate a caller-supplied message id (root-relative path, as returned by
 * maildir_search). Accepts an absolute path under the root too. Refuses
 * anything with `..`, NUL/CR/LF, a non-Dovecot layout, or a mailbox outside
 * the allow/deny lists.
 */
export function validateMessageId(
  config: Pick<
    MaildirConfig,
    'root' | 'allowedDomains' | 'excludedDomains' | 'allowedUsers' | 'excludedUsers'
  >,
  id: string,
): MaildirFile {
  if (CONTROL_CHAR_RE.test(id)) {
    throw new MaildirIdError('Invalid id: it contains control characters.');
  }
  if (id.length > 1024) throw new MaildirIdError('Invalid id: too long.');
  let rel = id;
  if (id.startsWith('/')) {
    const r = fromAbsolute(config.root, id);
    if (r === null) throw new MaildirIdError('Invalid id: it is outside the Maildir root.');
    rel = r;
  }
  if (rel.split('/').includes('..')) throw new MaildirIdError('Invalid id: ".." is not allowed.');
  const parsed = parseFile(rel);
  if (!parsed) {
    throw new MaildirIdError(
      'Invalid id: expected <domain>/<user>/Maildir[/.<Folder>]/(cur|new)/<file> as returned by maildir_search.',
    );
  }
  if (!isMailboxAllowed(config, parsed.domain, parsed.user)) {
    throw new MaildirIdError(`Mailbox ${parsed.mailbox} is excluded by the [maildir] config.`);
  }
  return parsed;
}

/** Convert a simple glob (`*`, `?`) to an anchored case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Escape find(1) -name glob metacharacters so the name matches literally. */
export function escapeFindGlob(name: string): string {
  return name.replace(/[*?[\]\\]/g, '\\$&');
}
