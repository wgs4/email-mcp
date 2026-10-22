/**
 * osTicket threading via the Subject header.
 *
 * osTicket attaches an incoming email to an existing ticket when the Subject
 * carries that ticket's tag (`[#31775]`) and the sender is already a requester
 * or collaborator. A customer reply to an automated store email has no such
 * tag, so osTicket opens a duplicate ticket. {@link tagSubject} injects the tag
 * into the raw RFC822 before the message is APPENDed to the help-desk mailbox.
 *
 * Contract:
 *   - Only the TOP-LEVEL Subject header is touched — everything before the
 *     first blank line. A `Subject:` in a MIME body part, an attached
 *     message/rfc822, or the body text itself is left byte-for-byte alone.
 *   - Every byte outside the rewritten header is preserved, including line
 *     endings (CRLF and LF are both handled and kept), NUL bytes and binary
 *     attachment payloads. The message is processed as a latin1 string for
 *     exactly that reason.
 *   - Folded headers are unfolded for inspection; encoded-words (RFC 2047 B/Q)
 *     are decoded before the tag is appended, and the result is re-encoded as
 *     RFC 2047 UTF-8 only when it contains non-ASCII characters.
 *   - An existing tag for the SAME ticket number is a no-op. A tag for a
 *     DIFFERENT number is a conflict: the caller must not move that message.
 */

interface RawLine {
  text: string;
  eol: string;
}

export interface SubjectTagged {
  status: 'tagged';
  raw: Buffer;
  /** Decoded subject including the injected tag. */
  subject: string;
  rewritten: true;
}

export interface SubjectUnchanged {
  status: 'unchanged';
  raw: Buffer;
  subject: string;
  rewritten: false;
}

export interface SubjectConflict {
  status: 'conflict';
  subject: string;
  /** The different ticket number already present in the subject. */
  existingTicket: string;
}

export type SubjectTagResult = SubjectTagged | SubjectUnchanged | SubjectConflict;

/** osTicket's ticket tag, e.g. `[#31775]`. */
const TICKET_TAG_RE = /\[#(\d+)\]/g;

/**
 * One RFC 2047 encoded-word. The charset may include a language suffix
 * (`UTF-8*en`); the payload cannot contain `?` or whitespace in either the B or
 * Q encoding.
 */
const ENCODED_WORD_BODY = String.raw`=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=`;
const ENCODED_WORD_SPLIT_RE = new RegExp(`(${ENCODED_WORD_BODY})`);
const ENCODED_WORD_RE = /^=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=$/;

/** Field name up to the first colon (no whitespace allowed in a field name). */
const HEADER_NAME_RE = /^([^\s:]+):/;

/** Line-start continuation of a folded header. */
const CONTINUATION_RE = /^[ \t]+/;

/**
 * Encoded-word payload budget: `=?UTF-8?B?` (10) + payload + `?=` (2) stays
 * within RFC 2047's 75-character limit, and 39 input bytes → 52 base64
 * characters keeps the first line (`Subject: ` prefix) under the recommended
 * 78-character line length.
 */
const MAX_ENCODED_WORD_BYTES = 39;

function splitRawLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = pos;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end += 1;
    }
    let eol = '';
    if (text[end] === '\r') {
      eol = text[end + 1] === '\n' ? '\r\n' : '\r';
    } else if (text[end] === '\n') {
      eol = '\n';
    }
    lines.push({ text: text.slice(pos, end), eol });
    pos = end + eol.length;
  }
  return lines;
}

interface HeaderGroup {
  start: number;
  end: number;
  name: string;
  /** Unfolded (but still encoded) value, without the field name and colon. */
  value: string;
}

/** Group the top-level header lines into field-name + folded continuations. */
function parseHeaderGroups(lines: RawLine[], headerEnd: number): HeaderGroup[] {
  const groups: HeaderGroup[] = [];
  let i = 0;
  while (i < headerEnd) {
    let end = i + 1;
    while (end < headerEnd && CONTINUATION_RE.test(lines[end].text)) {
      end += 1;
    }
    const match = HEADER_NAME_RE.exec(lines[i].text);
    if (match) {
      // Unfolding collapses each CRLF + continuation whitespace run to one
      // space, so a tab-folded header reads the same as a space-folded one.
      const value = [
        lines[i].text.slice(match[0].length),
        ...lines.slice(i + 1, end).map((line) => line.text.replace(CONTINUATION_RE, ' ')),
      ].join('');
      groups.push({
        start: i,
        end,
        name: match[1].toLowerCase(),
        value,
      });
    }
    i = end;
  }
  return groups;
}

/**
 * Raw 8-bit header bytes (illegal under RFC 5322 but common in the wild) arrive
 * as latin1 characters. Decode them as UTF-8 when they are valid UTF-8; fall
 * back to latin1 otherwise. Pure ASCII is returned untouched.
 */
function normalizeEightBit(value: string): string {
  if (!/[\u0080-\uFFFF]/.test(value)) {
    return value;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'binary'));
  } catch {
    return value;
  }
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const normalized = charset.toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return bytes.toString('utf8');
  }
  if (normalized === 'us-ascii' || normalized === 'ascii') {
    return bytes.toString('ascii');
  }
  // iso-8859-1, windows-1252 and unknown charsets: single-byte fallback. Node
  // has no windows-1252 codec and the 0x80–0x9F differences are typographic
  // punctuation, never ticket tags.
  return bytes.toString('latin1');
}

function decodeQ(payload: string): string {
  return payload
    .replace(/_/g, ' ')
    .replace(/=([0-9A-Fa-f]{2})/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function decodeWord(word: string): string {
  const match = ENCODED_WORD_RE.exec(word);
  if (!match) {
    return word;
  }
  const [, charset, encoding, payload] = match;
  const bytes =
    encoding.toLowerCase() === 'b'
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeQ(payload), 'binary');
  return decodeBytes(bytes, charset);
}

/**
 * Decode RFC 2047 encoded-words. Whitespace between two adjacent encoded words
 * is folding noise and is dropped (RFC 2047 §6.2); all other text is kept.
 */
function decodeRfc2047(value: string): string {
  const parts = value.split(ENCODED_WORD_SPLIT_RE);
  return parts.reduce<{ text: string; previousWasEncoded: boolean }>(
    (acc, part, index) => {
      // split() with one capture group puts matches at odd indices.
      if (index % 2 === 1) {
        return { text: acc.text + decodeWord(part), previousWasEncoded: true };
      }
      const dropWhitespace = acc.previousWasEncoded && /^\s+$/.test(part);
      return {
        text: dropWhitespace ? acc.text : acc.text + part,
        previousWasEncoded: false,
      };
    },
    { text: '', previousWasEncoded: false },
  ).text;
}

function decodeHeaderValue(value: string): string {
  return decodeRfc2047(normalizeEightBit(value)).trim();
}

/** Split a Unicode string into encoded-word chunks without breaking a code point. */
function encodeRfc2047(subject: string): string[] {
  const folded = Array.from(subject).reduce<{ words: string[]; current: string; bytes: number }>(
    (acc, char) => {
      const size = Buffer.byteLength(char, 'utf8');
      if (acc.bytes + size > MAX_ENCODED_WORD_BYTES && acc.current.length > 0) {
        return { words: [...acc.words, acc.current], current: char, bytes: size };
      }
      return { words: acc.words, current: acc.current + char, bytes: acc.bytes + size };
    },
    { words: [], current: '', bytes: 0 },
  );
  const chunks = folded.current.length > 0 ? [...folded.words, folded.current] : folded.words;
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
}

/** Build the replacement `Subject:` line(s), folding only where necessary. */
function buildSubjectLines(subject: string, eol: string): RawLine[] {
  if (!/[\u0080-\uFFFF]/.test(subject)) {
    return [{ text: `Subject: ${subject}`, eol }];
  }
  const words = encodeRfc2047(subject);
  return words.map((word, index) => ({
    text: index === 0 ? `Subject: ${word}` : ` ${word}`,
    eol,
  }));
}

/** Insert a missing Subject header directly before the blank-line separator. */
function insertSubjectLines(
  lines: RawLine[],
  headerEnd: number,
  subjectLines: RawLine[],
  eol: string,
): RawLine[] {
  const before = lines.slice(0, headerEnd);
  const after = lines.slice(headerEnd);
  const terminated =
    before.length === 0 || before[before.length - 1].eol !== ''
      ? before
      : [...before.slice(0, -1), { ...before[before.length - 1], eol }];
  // A headers-only message without a trailing newline must not gain a stray
  // one; when there is following content (the blank line and body), the
  // inserted header needs a terminator of its own.
  const finalEol = after.length === 0 ? '' : eol;
  const built = subjectLines.map((line, index) => ({
    ...line,
    eol: index === subjectLines.length - 1 ? finalEol : eol,
  }));
  return [...terminated, ...built, ...after];
}

/**
 * Append `[#ticketNumber]` to the top-level Subject of a raw RFC822 message.
 *
 * Returns the original Buffer untouched for `unchanged`, a rebuilt Buffer for
 * `tagged`, and no Buffer at all for `conflict` — the caller must leave that
 * message where it is.
 */
export function tagSubject(raw: Buffer, ticketNumber: string): SubjectTagResult {
  const text = raw.toString('binary');
  const lines = splitRawLines(text);
  const blankLine = lines.findIndex((line) => line.text === '');
  const headerEnd = blankLine === -1 ? lines.length : blankLine;
  const groups = parseHeaderGroups(lines, headerEnd);
  const subjectGroup = groups.find((group) => group.name === 'subject');
  const defaultEol = text.includes('\r\n') ? '\r\n' : '\n';

  const decoded = subjectGroup ? decodeHeaderValue(subjectGroup.value) : '';
  const existingTags = Array.from(decoded.matchAll(TICKET_TAG_RE), (match) => match[1]);

  if (existingTags.includes(ticketNumber)) {
    return { status: 'unchanged', raw, subject: decoded, rewritten: false };
  }
  if (existingTags.length > 0) {
    return { status: 'conflict', subject: decoded, existingTicket: existingTags[0] };
  }

  const subject = decoded.length > 0 ? `${decoded} [#${ticketNumber}]` : `[#${ticketNumber}]`;

  if (!subjectGroup) {
    const subjectLines = buildSubjectLines(subject, defaultEol);
    const rebuilt = insertSubjectLines(lines, headerEnd, subjectLines, defaultEol);
    return {
      status: 'tagged',
      raw: Buffer.from(rebuilt.map((line) => line.text + line.eol).join(''), 'binary'),
      subject,
      rewritten: true,
    };
  }

  const headerEol = lines[subjectGroup.start].eol || defaultEol;
  const trailingEol = lines[subjectGroup.end - 1].eol;
  const built = buildSubjectLines(subject, headerEol).map((line, index, all) => ({
    ...line,
    eol: index === all.length - 1 ? trailingEol : headerEol,
  }));
  const rebuilt = [
    ...lines.slice(0, subjectGroup.start),
    ...built,
    ...lines.slice(subjectGroup.end),
  ];
  return {
    status: 'tagged',
    raw: Buffer.from(rebuilt.map((line) => line.text + line.eol).join(''), 'binary'),
    subject,
    rewritten: true,
  };
}
