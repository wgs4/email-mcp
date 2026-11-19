/**
 * grep pattern builders for maildir_search.
 *
 * All remote matching runs GNU grep in the C locale (byte semantics, ASCII
 * case folding) with `-a` (binary as text). Terms are matched against the RAW
 * message bytes, so we also search the forms a term takes inside MIME
 * encodings that keep bytes visible:
 *   - the term itself (plain ASCII, or 8-bit UTF-8 headers);
 *   - RFC 2047 Q-encoding of its UTF-8 bytes (`外` → `=E5=A4=96`, space → `_`);
 *   - RFC 2231 / URL %-encoding of its UTF-8 bytes (`%E5%A4%96`).
 * Base64 content (B-encoded words, base64 bodies) cannot be matched by grep;
 * that limit is reported in every search result's notes.
 */

/* eslint-disable no-restricted-syntax -- byte-level encoders read clearest as plain loops */

export const HEADER_FIELDS = [
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
  'sender',
  'message-id',
  'in-reply-to',
  'references',
  'list-id',
  'delivered-to',
  'x-original-to',
] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

export const DEFAULT_HEADER_FIELDS: HeaderField[] = ['from', 'to', 'cc', 'subject'];

/** Escape every PCRE metacharacter (PCRE treats `\<non-alnum>` as a literal). */
export function pcreEscape(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x80) return `\\${c}`;
    return c; // non-ASCII: handled by byte escaping below
  });
}

/** PCRE literal for a byte string in the C locale: non-ASCII bytes → `\xHH`. */
function pcreLiteralBytes(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) {
    if (
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      b === 0x5f
    ) {
      out += String.fromCharCode(b);
    } else {
      out += `\\x${b.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

function hex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

/** RFC 2047 Q-encoded form of the UTF-8 bytes (only when the term has non-ASCII). */
export function qEncodedForm(term: string): string | null {
  const bytes = Buffer.from(term, 'utf-8');
  if (bytes.every((b) => b < 0x80)) return null;
  let out = '';
  for (const b of bytes) {
    if (b === 0x20) out += '_';
    else if (b >= 0x80 || b === 0x3d || b === 0x3f || b === 0x5f || b < 0x20) out += `=${hex2(b)}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

/** RFC 2231 %-encoded form of the UTF-8 bytes (only when the term has non-ASCII). */
export function percentEncodedForm(term: string): string | null {
  const bytes = Buffer.from(term, 'utf-8');
  if (bytes.every((b) => b < 0x80)) return null;
  let out = '';
  for (const b of bytes) {
    if (b >= 0x80 || b === 0x25 || b === 0x20 || b === 0x27 || b === 0x2a) out += `%${hex2(b)}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

/** Every byte form of a fixed term to search for, as UTF-8 strings. */
export function termVariants(term: string): string[] {
  const forms = [term, qEncodedForm(term), percentEncodedForm(term)].filter(
    (f): f is string => f !== null && f.length > 0,
  );
  return [...new Set(forms)];
}

/** PCRE alternation that matches any variant of a fixed term, byte-exact. */
export function fixedTermPcre(term: string): string {
  return `(?:${termVariants(term)
    .map((v) => pcreLiteralBytes(Buffer.from(v, 'utf-8')))
    .join('|')})`;
}

/** PCRE fragment for the term: fixed (escaped, with variants) or a user regex. */
export function termPcre(term: string, regex: boolean): string {
  return regex ? `(?:${term})` : fixedTermPcre(term);
}

/**
 * Header-only pattern, used with `grep -P -i -o -H -Z -m 1`:
 *   alt 1 `^(?=\r?$)` — the blank line that ends the headers. It is an EMPTY
 *         match, so `-o` prints nothing, and `-m 1` makes grep stop reading
 *         the file there: bodies and attachments are never read.
 *   alt 2 `^(?:from|to|...):.*?TERM` — a direct hit on a selected header line.
 *   alt 3 `^[ \t].*?TERM` — a hit on a folded continuation line. Which header
 *         it continues is unknown, so these are verified locally.
 * Output per hit: `<path>\0<matched text>\n`.
 */
export function headerSearchPcre(fields: HeaderField[], term: string, regex: boolean): string {
  const names = fields.map((f) => pcreEscape(f)).join('|');
  const t = termPcre(term, regex);
  return `^(?=\\r?$)|^(?:${names})[ \\t]*:.*?${t}|^[ \\t].*?${t}`;
}

/** Whole-message pattern (`grep -l`): every line, headers and body. */
export function fullTextPcre(term: string, regex: boolean): string {
  return termPcre(term, regex);
}

/**
 * Attachment-name pattern (`grep -l`): a MIME `name=`/`filename=` parameter
 * line whose value contains the term.
 */
export function attachmentNamePcre(namePrefixPcre: string, term: string, regex: boolean): string {
  return `${namePrefixPcre}.*?${termPcre(term, regex)}`;
}

/**
 * Local matcher used to verify a candidate against decoded/unfolded header
 * values. Fixed terms: case-insensitive substring on the raw value OR any
 * variant. Regex terms: JavaScript RegExp with the `i` flag.
 */
export function makeLocalMatcher(term: string, regex: boolean): (value: string) => boolean {
  if (regex) {
    const re = new RegExp(term, 'i');
    return (value) => re.test(value);
  }
  const needles = termVariants(term).map((v) => v.toLowerCase());
  return (value) => {
    const hay = value.toLowerCase();
    return needles.some((n) => hay.includes(n));
  };
}
