/**
 * Byte-preserving MIME surgery for draft attachment resync (design §2).
 *
 * The current draft's exact RFC822 is wrapped as the first child of a fresh
 * multipart/mixed; recovered attachment parts are appended. The original body
 * part's bytes are copied VERBATIM (acceptance #5). The single permitted body
 * mutation is opt-in dangling-cid stripping, which re-encodes only the located
 * text/html leaf.
 */
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { ResolvedAttachment } from './attachment-resolver.js';

const CRLF = '\r\n';
const CID_REF = /cid:([^"'\s>)]+)/gi;

/** cid values referenced anywhere in an HTML string (unique, first-seen order). */
function cidRefsIn(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let match = CID_REF.exec(html);
  while (match !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      out.push(match[1]);
    }
    match = CID_REF.exec(html);
  }
  return out;
}

/** Split raw RFC822 into unfolded header lines + the verbatim body buffer. */
export function splitHeadersAndBody(raw: Buffer): { headerLines: string[]; body: Buffer } {
  let sepIdx = -1;
  let sepLen = 4;
  for (let i = 0; i + 3 < raw.length; i += 1) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      sepIdx = i;
      sepLen = 4;
      break;
    }
  }
  if (sepIdx < 0) {
    for (let i = 0; i + 1 < raw.length; i += 1) {
      if (raw[i] === 10 && raw[i + 1] === 10) {
        sepIdx = i;
        sepLen = 2;
        break;
      }
    }
  }
  const headerBuf = sepIdx >= 0 ? raw.subarray(0, sepIdx) : raw;
  const body = sepIdx >= 0 ? raw.subarray(sepIdx + sepLen) : Buffer.alloc(0);
  const headerLines: string[] = [];
  headerBuf
    .toString('utf8')
    .split(/\r\n|\n/)
    .forEach((line) => {
      if (/^[ \t]/.test(line) && headerLines.length > 0) {
        headerLines[headerLines.length - 1] += CRLF + line;
      } else {
        headerLines.push(line);
      }
    });
  return { headerLines, body };
}

function headerName(line: string): string {
  const i = line.indexOf(':');
  return i >= 0 ? line.slice(0, i).trim().toLowerCase() : '';
}

function contentTypeOf(headerLines: string[]): string {
  const ct = headerLines.find((l) => headerName(l) === 'content-type');
  return ct ? ct.slice(ct.indexOf(':') + 1).trim() : '';
}

/**
 * Partition the original top-level headers: Content-* stay with the inner
 * entity; MIME-Version is regenerated on the outer; everything else (identity,
 * addressing, threading, X-Universally-Unique-Identifier) lifts to the outer.
 */
export function partitionHeaders(headerLines: string[]): { outer: string[]; inner: string[] } {
  const outer: string[] = [];
  const inner: string[] = [];
  headerLines.forEach((line) => {
    const name = headerName(line);
    if (!name || name === 'mime-version') return;
    if (name.startsWith('content-')) inner.push(line);
    else outer.push(line);
  });
  return { outer, inner };
}

function base64Wrapped(buf: Buffer): string {
  return buf.toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
}

/** Assemble a multipart/mixed: [inner content headers + body verbatim] + attachments. */
export function buildWrappedMixed(
  outer: string[],
  inner: string[],
  body: Buffer,
  attachments: ResolvedAttachment[],
  ensureUuid: boolean,
): Buffer {
  const boundary = `----=_wgsresync_${randomUUID()}`;
  const hasUuid = outer.some((l) => headerName(l) === 'x-universally-unique-identifier');
  const outerLines = [...outer];
  if (ensureUuid && !hasUuid) {
    outerLines.push(`X-Universally-Unique-Identifier: ${randomUUID().toUpperCase()}`);
  }
  const parts: Buffer[] = [];
  const push = (s: string): void => {
    parts.push(Buffer.from(s, 'utf8'));
  };

  push(outerLines.join(CRLF) + CRLF);
  push(`MIME-Version: 1.0${CRLF}`);
  push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}`);

  // First child: original entity, byte-for-byte.
  push(`--${boundary}${CRLF}`);
  push((inner.length > 0 ? inner.join(CRLF) + CRLF : '') + CRLF);
  parts.push(body);
  push(CRLF);

  attachments.forEach((a) => {
    push(`--${boundary}${CRLF}`);
    push(`Content-Type: ${a.contentType}; name="${a.filename}"${CRLF}`);
    push(`Content-Transfer-Encoding: base64${CRLF}`);
    push(`Content-Disposition: attachment; filename="${a.filename}"${CRLF}${CRLF}`);
    push(base64Wrapped(a.content) + CRLF);
  });
  push(`--${boundary}--${CRLF}`);
  return Buffer.concat(parts);
}

/** cids referenced by the HTML body that have no matching inline part anywhere. */
export async function findDanglingCids(raw: Buffer): Promise<string[]> {
  const parsed = await simpleParser(raw);
  const referenced = cidRefsIn(typeof parsed.html === 'string' ? parsed.html : '');
  if (referenced.length === 0) return [];
  const present = new Set<string>();
  (parsed.attachments ?? []).forEach((a) => {
    const { cid } = a as { cid?: string };
    const { contentId } = a as { contentId?: string };
    if (cid) present.add(cid);
    if (contentId) present.add(contentId.replace(/^<|>$/g, ''));
  });
  return referenced.filter((cid) => !present.has(cid));
}

function stripCidTags(html: string, dangling: Set<string>): { html: string; stripped: string[] } {
  const stripped: string[] = [];
  const drop = (m: string, cid: string): string => {
    if (dangling.has(cid)) {
      stripped.push(cid);
      return '';
    }
    return m;
  };
  let out = html.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'>\s]+)[^>]*>/gi, drop);
  out = out.replace(/<object\b[^>]*?\bdata\s*=\s*["']?cid:([^"'>\s]+)[\s\S]*?<\/object>/gi, drop);
  return { html: out, stripped };
}

const HTML_LEAF = (strippedHtml: string): { inner: string[]; body: Buffer } => ({
  inner: ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64'],
  body: Buffer.from(base64Wrapped(Buffer.from(strippedHtml, 'utf8')) + CRLF, 'utf8'),
});

/**
 * Replace the text/html leaf inside a one-level multipart body with the
 * base64-encoded stripped html, keeping every other segment byte-for-byte.
 * Returns null when no direct text/html child exists (deeper nesting).
 */
function replaceHtmlSegmentOneLevel(
  body: Buffer,
  boundary: string,
  strippedHtml: string,
): Buffer | null {
  const text = body.toString('latin1');
  const delim = `--${boundary}`;
  let i = text.indexOf(delim);
  while (i >= 0) {
    const afterDelim = i + delim.length;
    if (text.slice(afterDelim, afterDelim + 2) === '--') break; // closing delimiter
    const next = text.indexOf(delim, afterDelim);
    if (next < 0) break;
    const seg = text.slice(afterDelim, next);
    const hdrSep = seg.indexOf('\r\n\r\n');
    if (hdrSep >= 0 && /content-type:\s*text\/html/i.test(seg.slice(0, hdrSep))) {
      const newSeg =
        `${CRLF}Content-Type: text/html; charset=utf-8${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Wrapped(Buffer.from(strippedHtml, 'utf8'))}${CRLF}`;
      return Buffer.from(text.slice(0, afterDelim) + newSeg + text.slice(next), 'latin1');
    }
    i = next;
  }
  return null;
}

/**
 * Apply the stripped html to the entity (inner headers + body). Solid for
 * singlepart text/html; best-effort for one-level multipart with a direct
 * text/html child. Returns null when the html leaf can't be located.
 */
function stripInEntity(
  inner: string[],
  body: Buffer,
  strippedHtml: string,
): { inner: string[]; body: Buffer } | null {
  const ct = contentTypeOf(inner);
  if (/^text\/html/i.test(ct)) return HTML_LEAF(strippedHtml);
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(ct)?.[1];
  if (!boundary) return null;
  const newBody = replaceHtmlSegmentOneLevel(body, boundary, strippedHtml);
  return newBody ? { inner, body: newBody } : null;
}

/** Public entry: strip (opt-in) then wrap the current entity + append attachments. */
export async function injectAttachments(
  raw: Buffer,
  attachments: ResolvedAttachment[],
  opts: { stripDanglingCids: boolean; ensureUuid?: boolean },
): Promise<{ raw: Buffer; strippedCids: string[]; warnings: string[] }> {
  const { headerLines, body } = splitHeadersAndBody(raw);
  const { outer, inner } = partitionHeaders(headerLines);
  let entInner = inner;
  let entBody = body;
  let strippedCids: string[] = [];
  const warnings: string[] = [];

  if (opts.stripDanglingCids) {
    const dangling = await findDanglingCids(raw);
    if (dangling.length > 0) {
      const parsed = await simpleParser(raw);
      const html = typeof parsed.html === 'string' ? parsed.html : undefined;
      if (html) {
        const { html: cleaned, stripped } = stripCidTags(html, new Set(dangling));
        if (stripped.length > 0) {
          const res = stripInEntity(inner, body, cleaned);
          if (res) {
            entInner = res.inner;
            entBody = res.body;
            strippedCids = stripped;
          } else {
            warnings.push(
              `${dangling.length} dangling cid ref(s) left in place — draft structure too nested to strip safely.`,
            );
          }
        }
      }
    }
  }

  const out = buildWrappedMixed(outer, entInner, entBody, attachments, opts.ensureUuid ?? true);
  return { raw: out, strippedCids, warnings };
}
