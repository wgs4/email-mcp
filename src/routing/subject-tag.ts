/**
 * osTicket threading via the Subject header.
 *
 * osTicket attaches an incoming email to an existing ticket when the FIRST hash
 * token in the Subject resolves to that ticket (`Re: [#31775] Your order`) and
 * the sender is already a requester or collaborator. It does not look for the
 * tag anywhere and it never tries a second number: it takes the first match of
 * `/#((\p{P}*[^\p{C}\p{Z}\p{P}]+)+)/u`. A customer reply to an automated store
 * email has no tag, so osTicket opens a duplicate ticket.
 *
 * {@link tagSubject} therefore PREPENDS the literal ASCII text `[#N] ` to the
 * top-level Subject, right after `Subject:` and its following whitespace. It
 * never decodes and re-emits the subject: encoded-words, folding and every
 * other byte in the header stay exactly as the sender wrote them. Decoding is
 * used only to READ the subject for conflict/no-op detection.
 *
 * Contract:
 *   - Only the top-level Subject header is touched — everything before the
 *     first blank line. A `Subject:` in a MIME body part, an attached
 *     message/rfc822, or the body text itself is left byte-for-byte alone.
 *   - Every byte outside the Subject line is preserved, including line endings
 *     (CRLF and LF are both handled and kept), NUL bytes and binary attachment
 *     payloads. The message is processed as a latin1 string for exactly that
 *     reason.
 *   - Missing Subject: `Subject: [#N]` is added at the end of the header block.
 *   - If prepending would push the first physical line past RFC 5322's 998
 *     octets, the tag line is folded immediately after the tag.
 *   - An existing first token for the SAME ticket number is a no-op. Multiple
 *     top-level Subject fields, a `[#N]` tag for a DIFFERENT number, a raw
 *     Subject field with malformed line endings, or an encoded-word that
 *     cannot be decoded (unsupported charset, malformed B/Q) is a hard failure:
 *     the caller must not move that message. Decode failure fails closed
 *     because an undecodable word could hide a conflicting tag.
 */

interface RawLine {
  text: string;
  eol: string;
}

/** RFC 5322 §2.1.1 hard line limit (excluding CRLF). */
const MAX_LINE_OCTETS = 998;

export interface SubjectTagged {
  status: 'tagged';
  raw: Buffer;
  /** Best-effort decoded subject after prepending; null when decoding failed. */
  subject: string | null;
  rewritten: true;
}

export interface SubjectUnchanged {
  status: 'unchanged';
  raw: Buffer;
  /** Best-effort decoded subject (already carries the requested tag). */
  subject: string | null;
  rewritten: false;
}

export interface SubjectConflict {
  status: 'conflict';
  subject: string | null;
  /** A different `[#N]` tag already present in the subject. */
  existingTicket: string;
}

export interface SubjectDuplicate {
  status: 'duplicate_subject';
  subject: string | null;
}

export interface SubjectMalformed {
  status: 'malformed_subject';
  subject: string | null;
}

export interface SubjectUndecodable {
  status: 'undecodable_subject';
  subject: null;
}

export type SubjectTagResult =
  | SubjectTagged
  | SubjectUnchanged
  | SubjectConflict
  | SubjectDuplicate
  | SubjectMalformed
  | SubjectUndecodable;

/**
 * Read-only view of the top-level Subject. `decoded` is false when any
 * encoded-word uses an unsupported charset or has undecodable bytes. Callers
 * fail closed in that case: without a trustworthy decode we cannot prove the
 * subject is free of a conflicting ticket tag.
 */
export interface SubjectInspection {
  rawValue: string | null;
  decoded: boolean;
  subject: string | null;
  /** First osTicket hash token, using osTicket's own expression. */
  firstToken: string | null;
  /** Every `[#digits]` tag visible in the subject. */
  bracketTags: string[];
  subjectFieldCount: number;
  /** A bare CR/LF (not the message's normal fold) inside the Subject field. */
  malformedEol: boolean;
}

/** osTicket class.thread.php: preg_match("/#((\p{P}*[^\p{C}\p{Z}\p{P}]+)+)/u", ...) */
const OSTICKET_TOKEN_RE = /#((\p{P}*[^\p{C}\p{Z}\p{P}]+)+)/u;

/** osTicket's `[#31775]` tag. */
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

interface ParsedMessage {
  text: string;
  lines: RawLine[];
  headerEnd: number;
  groups: HeaderGroup[];
  subjectGroups: HeaderGroup[];
  dominantEol: string;
}

function parseMessage(raw: Buffer): ParsedMessage {
  const text = raw.toString('binary');
  const lines = splitRawLines(text);
  const blankLine = lines.findIndex((line) => line.text === '');
  const headerEnd = blankLine === -1 ? lines.length : blankLine;
  const groups = parseHeaderGroups(lines, headerEnd);
  // Header line endings are decided by the header block only. A CRLF in the
  // body must never make an LF-only header block look malformed.
  const headerText = lines
    .slice(0, headerEnd)
    .map((line) => line.text + line.eol)
    .join('');
  return {
    text,
    lines,
    headerEnd,
    groups,
    subjectGroups: groups.filter((group) => group.name === 'subject'),
    dominantEol: headerText.includes('\r\n') ? '\r\n' : '\n',
  };
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

/**
 * Decode one encoded-word's bytes. Returns null for an unsupported charset or
 * bytes that are invalid in that charset — the caller then falls back to the
 * raw header text for detection instead of trusting corrupted text.
 */
function decodeBytes(bytes: Buffer, charset: string): string | null {
  // RFC 2231 language suffix: `UTF-8*en`.
  const label = charset.split('*')[0].trim().toLowerCase();
  // WHATWG maps "us-ascii" to windows-1252; enforce true ASCII here.
  if (label === 'us-ascii' || label === 'ascii') {
    return bytes.every((byte) => byte < 0x80) ? bytes.toString('ascii') : null;
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeQ(payload: string): string | null {
  // In Q encoding a literal '=' must be written as =3D; anything else is a
  // malformed escape and makes the encoded-word untrustworthy.
  if (/=(?![0-9A-Fa-f]{2})/.test(payload)) {
    return null;
  }
  return payload
    .replace(/_/g, ' ')
    .replace(/=([0-9A-Fa-f]{2})/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function decodeBase64(payload: string): Buffer | null {
  // Buffer.from(..., 'base64') silently ignores garbage; reject it instead.
  const unpadded = payload.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(unpadded) || unpadded.length % 4 === 1) {
    return null;
  }
  return Buffer.from(unpadded, 'base64');
}

function decodeWord(word: string): string | null {
  const match = ENCODED_WORD_RE.exec(word);
  if (!match) {
    return null;
  }
  const [, charset, encoding, payload] = match;
  if (encoding.toLowerCase() === 'b') {
    const bytes = decodeBase64(payload);
    return bytes === null ? null : decodeBytes(bytes, charset);
  }
  const decodedQ = decodeQ(payload);
  if (decodedQ === null) {
    return null;
  }
  return decodeBytes(Buffer.from(decodedQ, 'binary'), charset);
}

interface DecodeResult {
  ok: boolean;
  text: string | null;
}

/**
 * Decode RFC 2047 encoded-words for READ-ONLY inspection. Whitespace between
 * two adjacent encoded words is folding noise and is dropped (RFC 2047 §6.2).
 * Any undecodable word fails the whole decode.
 */
function decodeHeaderValue(value: string): DecodeResult {
  const parts = value.split(ENCODED_WORD_SPLIT_RE);
  const decoded = parts.reduce<{ text: string; ok: boolean; previousWasEncoded: boolean }>(
    (acc, part, index) => {
      // split() with one capture group puts matches at odd indices.
      if (index % 2 === 1) {
        const word = decodeWord(part);
        if (word === null) {
          return { ...acc, ok: false, previousWasEncoded: true };
        }
        return { text: acc.text + word, ok: acc.ok, previousWasEncoded: true };
      }
      const dropWhitespace = acc.previousWasEncoded && /^\s+$/.test(part);
      return {
        text: dropWhitespace ? acc.text : acc.text + part,
        ok: acc.ok,
        previousWasEncoded: false,
      };
    },
    { text: '', ok: true, previousWasEncoded: false },
  );
  if (!decoded.ok) {
    return { ok: false, text: null };
  }
  // Literal 8-bit bytes only need the UTF-8/latin1 heuristic when there were no
  // encoded-words; decoded-words are already Unicode and must not be re-read as
  // latin1 bytes.
  const text = parts.length > 1 ? decoded.text : normalizeEightBit(decoded.text);
  return { ok: true, text: text.trim() };
}

function firstOsticketToken(text: string): string | null {
  const match = OSTICKET_TOKEN_RE.exec(text);
  return match ? match[1] : null;
}

function bracketTags(text: string): string[] {
  return Array.from(text.matchAll(TICKET_TAG_RE), (match) => match[1]);
}

/** Read-only inspection of the top-level Subject. Never mutates the raw bytes. */
export function inspectSubject(raw: Buffer): SubjectInspection {
  const message = parseMessage(raw);
  const [subject] = message.subjectGroups;
  if (!subject) {
    return {
      rawValue: null,
      decoded: false,
      subject: null,
      firstToken: null,
      bracketTags: [],
      subjectFieldCount: 0,
      malformedEol: false,
    };
  }

  const malformedEol = message.lines
    .slice(subject.start, subject.end)
    .some((line) => line.eol !== '' && line.eol !== message.dominantEol);
  const decodedValue = decodeHeaderValue(subject.value);
  // No raw fallback: an undecodable word could hide a conflicting tag, so
  // detection is only meaningful when the whole value decoded cleanly.
  const detectionText = decodedValue.ok ? (decodedValue.text ?? '') : '';

  return {
    rawValue: subject.value,
    decoded: decodedValue.ok,
    subject: decodedValue.ok ? decodedValue.text : null,
    firstToken: firstOsticketToken(detectionText),
    bracketTags: bracketTags(detectionText),
    subjectFieldCount: message.subjectGroups.length,
    malformedEol,
  };
}

/** Insert a missing Subject header directly before the blank-line separator. */
function insertSubjectLine(message: ParsedMessage, tag: string): Buffer {
  const { lines, headerEnd, dominantEol } = message;
  const before = lines.slice(0, headerEnd);
  const after = lines.slice(headerEnd);
  const terminated =
    before.length === 0 || before[before.length - 1].eol !== ''
      ? before
      : [...before.slice(0, -1), { ...before[before.length - 1], eol: dominantEol }];
  // A headers-only message without a trailing newline must not gain a stray
  // one; when there is following content (the blank line and body), the
  // inserted header needs a terminator of its own.
  const finalEol = after.length === 0 ? '' : dominantEol;
  const built: RawLine[] = [{ text: `Subject: ${tag}`, eol: finalEol }];
  return Buffer.from(
    [...terminated, ...built, ...after].map((line) => line.text + line.eol).join(''),
    'binary',
  );
}

/** Prepend the tag to the first physical Subject line, folding when too long. */
function prependTag(message: ParsedMessage, subject: HeaderGroup, tag: string): Buffer {
  const { lines, dominantEol } = message;
  const firstLine = lines[subject.start];
  const nameMatch = HEADER_NAME_RE.exec(firstLine.text);
  if (!nameMatch) {
    // parseHeaderGroups only returns groups with a field name.
    return Buffer.from(lines.map((line) => line.text + line.eol).join(''), 'binary');
  }

  // Insert after `Subject:` and its inline whitespace, at the start of the
  // value. String lengths are byte lengths: the text is latin1.
  const colonEnd = nameMatch[0].length;
  let valueStart = colonEnd;
  while (valueStart < firstLine.text.length) {
    const char = firstLine.text[valueStart];
    if (char !== ' ' && char !== '\t') {
      break;
    }
    valueStart += 1;
  }
  const inlineWhitespace = firstLine.text.slice(colonEnd, valueStart);
  const rest = firstLine.text.slice(valueStart);
  const lineLength =
    colonEnd + inlineWhitespace.length + tag.length + (rest.length > 0 ? rest.length + 1 : 0);

  let replacement: RawLine[];
  if (lineLength > MAX_LINE_OCTETS) {
    // Normalize the whitespace after the colon so a huge leading run cannot
    // survive on the first line. Fold immediately after the tag; the
    // continuation line keeps the original terminator so headers-only mail
    // gains no trailing newline.
    replacement = [{ text: `${nameMatch[1]}: ${tag}`, eol: firstLine.eol || dominantEol }];
    if (rest.length > 0) {
      replacement.push({ text: ` ${rest}`, eol: firstLine.eol });
    }
  } else {
    const prefix = firstLine.text.slice(0, valueStart);
    replacement = [
      { text: rest.length > 0 ? `${prefix}${tag} ${rest}` : prefix + tag, eol: firstLine.eol },
    ];
  }

  const rebuilt = [
    ...lines.slice(0, subject.start),
    ...replacement,
    // Continuation lines are part of the same value and stay byte-identical.
    ...lines.slice(subject.start + 1, subject.end),
    ...lines.slice(subject.end),
  ];
  return Buffer.from(rebuilt.map((line) => line.text + line.eol).join(''), 'binary');
}

/** Best-effort display subject after prepending, or null when undecodable. */
function taggedDisplaySubject(inspection: SubjectInspection, tag: string): string | null {
  if (!inspection.decoded || inspection.subject === null) {
    return null;
  }
  return inspection.subject.length > 0 ? `${tag} ${inspection.subject}` : tag;
}

/**
 * Prepend `[#ticketNumber]` to the top-level Subject of a raw RFC822 message.
 *
 * Returns the original Buffer untouched for `unchanged`, a rebuilt Buffer for
 * `tagged`, and no Buffer at all for the failure statuses — the caller must
 * leave those messages where they are.
 */
export function tagSubject(raw: Buffer, ticketNumber: string): SubjectTagResult {
  const inspection = inspectSubject(raw);

  if (inspection.subjectFieldCount > 1) {
    return { status: 'duplicate_subject', subject: inspection.subject };
  }
  if (inspection.malformedEol) {
    return { status: 'malformed_subject', subject: inspection.subject };
  }

  const tag = `[#${ticketNumber}]`;
  if (inspection.subjectFieldCount === 0) {
    const message = parseMessage(raw);
    return {
      status: 'tagged',
      raw: insertSubjectLine(message, tag),
      subject: tag,
      rewritten: true,
    };
  }

  // A trustworthy decode is required to prove there is no conflicting tag. An
  // unsupported charset (UTF-7) or malformed encoded-word fails closed.
  if (!inspection.decoded) {
    return { status: 'undecodable_subject', subject: null };
  }

  // Any bracketed tag for another ticket is a refusal, even when the first
  // token is already correct: the message demonstrably belongs elsewhere too.
  const conflicting = inspection.bracketTags.find((number) => number !== ticketNumber);
  if (conflicting !== undefined) {
    return { status: 'conflict', subject: inspection.subject, existingTicket: conflicting };
  }

  // osTicket only ever resolves the FIRST token, so that is what decides
  // "already correct".
  if (inspection.firstToken === ticketNumber) {
    return { status: 'unchanged', raw, subject: inspection.subject, rewritten: false };
  }

  const message = parseMessage(raw);
  const [subject] = message.subjectGroups;
  return {
    status: 'tagged',
    raw: prependTag(message, subject, tag),
    subject: taggedDisplaySubject(inspection, tag),
    rewritten: true,
  };
}
