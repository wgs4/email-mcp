/**
 * Small, dependency-free MIME helpers for search results.
 *
 * maildir_search only fetches header blocks and `name=`/`filename=` lines, not
 * whole messages, so it cannot use mailparser. These helpers decode just
 * enough: RFC 2047 encoded words (`=?GBK?Q?...?=`, `=?UTF-8?B?...?=`) and
 * RFC 2231 parameters (`filename*0*=utf-8''%E5...`). Charset conversion uses
 * the WHATWG TextDecoder (Node ships full ICU, so GBK/GB18030/Big5/Shift_JIS
 * work). Anything undecodable is returned raw rather than dropped.
 */

/* eslint-disable no-restricted-syntax, no-bitwise -- byte-level codecs read clearest as plain loops */

function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = charset.trim().toLowerCase().replace(/\*.*$/, ''); // RFC 2231 language suffix
  try {
    return new TextDecoder(cs || 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    // Unknown label — latin1 keeps every byte visible.
    return bytes.toString('latin1');
  }
}

function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '_') {
      bytes.push(0x20);
    } else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;

/**
 * Decode RFC 2047 encoded words. Whitespace between two adjacent encoded words
 * is removed (RFC 2047 §6.2); adjacent words in the same charset are joined at
 * the byte level so multi-byte characters split across words survive.
 */
export function decodeMimeWords(input: string): string {
  if (!input.includes('=?')) return input;
  // Collapse whitespace between adjacent encoded words first.
  const joined = input.replace(/(\?=)\s+(?==\?)/g, '$1');
  const tokens: ({ text: string } | { charset: string; bytes: Buffer[] })[] = [];
  let last = 0;
  for (const m of joined.matchAll(ENCODED_WORD)) {
    const [whole, charset, enc, text] = m;
    if (m.index > last) tokens.push({ text: joined.slice(last, m.index) });
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQ(text);
    const cs = charset.toLowerCase();
    const prev = tokens[tokens.length - 1];
    if (prev && 'charset' in prev && prev.charset === cs) prev.bytes.push(bytes);
    else tokens.push({ charset: cs, bytes: [bytes] });
    last = m.index + whole.length;
  }
  if (last < joined.length) tokens.push({ text: joined.slice(last) });
  return tokens
    .map((t) => ('text' in t ? t.text : decodeBytes(Buffer.concat(t.bytes), t.charset)))
    .join('');
}

/** Decode one RFC 2231 extended value: `charset'lang'%XX..` (charset optional). */
export function decodeRfc2231(value: string, charset?: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return decodeBytes(Buffer.from(bytes), charset ?? 'utf-8');
}

// ---------------------------------------------------------------------------
// Header blocks
// ---------------------------------------------------------------------------

export interface HeaderMap {
  /** Lower-case header name → unfolded raw values, in order. */
  raw: Map<string, string[]>;
}

/**
 * Parse a header block (lines up to the first blank line). Continuation lines
 * (leading space/tab) are unfolded into the previous header. Bytes are read as
 * latin1 first; if the block is valid UTF-8 it is re-read as UTF-8 (8-bit
 * headers from modern clients).
 */
export function parseHeaderBlock(lines: string[]): HeaderMap {
  const raw = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  const commit = (): void => {
    if (!current) return;
    const list = raw.get(current.name) ?? [];
    list.push(current.value.trim());
    raw.set(current.name, list);
    current = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') break;
    if (/^[ \t]/.test(line)) {
      if (current) (current as { value: string }).value += ` ${line.trim()}`;
    } else {
      commit();
      const colon = line.indexOf(':');
      if (colon > 0) {
        current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) };
      }
    }
  }
  commit();
  return { raw };
}

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const v = headers.raw.get(name.toLowerCase());
  return v?.[0];
}

/** First value of a header, RFC 2047-decoded. */
export function decodedHeader(headers: HeaderMap, name: string): string | undefined {
  const v = headerValue(headers, name);
  return v === undefined ? undefined : decodeMimeWords(v);
}

/** Interpret raw bytes as UTF-8 when valid, else latin1 (keeps every byte). */
export function bytesToText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

// ---------------------------------------------------------------------------
// Attachment names from `name=` / `filename=` lines
// ---------------------------------------------------------------------------

/**
 * PCRE for grep: a MIME header line that carries a `name`/`filename`
 * parameter. Matches `Content-Type: x; name=...`, `Content-Disposition:
 * attachment; filename=...` and folded parameter lines (`\tfilename*0*=...`).
 * Indented HTML (`  <meta name=`) does not match: the parameter must follow
 * the leading whitespace or a `;`.
 */
export const NAME_LINE_PCRE =
  '^(?:[ \\t]+|content-(?:type|disposition)[ \\t]*:)(?:.*?;)?[ \\t]*(?:file)?name(?:\\*[0-9]+)?\\*?[ \\t]*=';

const PARAM_RE = /(?:^|[;\s])((?:file)?name)(?:\*(\d+))?(\*)?\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+)/gi;

interface ParamEvent {
  kind: 'name' | 'filename';
  index: number | null;
  extended: boolean;
  value: string;
}

function paramEvents(line: string): ParamEvent[] {
  const events: ParamEvent[] = [];
  for (const m of line.matchAll(PARAM_RE)) {
    let value = m[4];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    events.push({
      kind: m[1].toLowerCase() as 'name' | 'filename',
      index: m[2] === undefined ? null : Number(m[2]),
      extended: m[3] === '*',
      value,
    });
  }
  return events;
}

interface Building {
  name: ParamEvent[];
  filename: ParamEvent[];
}

function assemble(parts: ParamEvent[]): string {
  if (parts.length === 0) return '';
  const sorted = [...parts].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const [first] = sorted;
  if (sorted.some((p) => p.extended)) {
    // RFC 2231: charset'lang' prefix only on the first (extended) segment.
    let charset: string | undefined;
    const pieces = sorted.map((p, i) => {
      let v = p.value;
      if (i === 0 && p.extended) {
        const q = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (q) {
          const [, cs, rest] = q;
          charset = cs || undefined;
          v = rest;
        }
      }
      return { v, extended: p.extended };
    });
    // Join raw, then percent-decode the extended pieces as one byte string.
    const joined = pieces.map((p) => (p.extended ? p.v : encodeURIComponent(p.v))).join('');
    return decodeRfc2231(joined, charset);
  }
  if (sorted.length === 1) return decodeMimeWords(first.value);
  return decodeMimeWords(sorted.map((p) => p.value).join(''));
}

/**
 * Best-effort attachment names from the matched parameter lines of ONE
 * message, in file order. A `name=` (Content-Type) followed by a `filename=`
 * (Content-Disposition) for the same part yields one entry. Duplicates in a
 * row are collapsed. Exact lists come from maildir_get_email.
 */
export function attachmentNamesFromLines(lines: string[]): string[] {
  const done: Building[] = [];
  let cur: Building | null = null;
  for (const line of lines) {
    for (const ev of paramEvents(line)) {
      const startsNew = ev.index === null || ev.index === 0;
      if (startsNew) {
        const slotTaken = cur !== null && cur[ev.kind].length > 0;
        if (cur === null || slotTaken) {
          if (cur) done.push(cur);
          cur = { name: [], filename: [] };
        }
      } else {
        cur ??= { name: [], filename: [] };
      }
      cur[ev.kind].push(ev);
    }
  }
  if (cur) done.push(cur);
  const names: string[] = [];
  for (const b of done) {
    const n = assemble(b.filename) || assemble(b.name);
    if (n && names[names.length - 1] !== n) names.push(n);
  }
  return names;
}
