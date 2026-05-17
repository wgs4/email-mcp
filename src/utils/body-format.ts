/**
 * Shared email-body presentation helpers.
 *
 * Single source of truth for `applyBodyFormat` + the HTML/quote strippers.
 * Previously these were copy-pasted into `emails.tool.ts` (used by
 * `get_email` AND `get_emails`) and `thread.tool.ts` — three call sites, two
 * divergent copies, one shared bug class (the empty-string `??` defect that
 * made multipart bodies render blank). Consolidating here kills the
 * duplicate-bug class: fix once, every tool benefits.
 *
 * Decision flow (applyBodyFormat):
 *
 *   bodyText / bodyHtml (trimmed-non-empty?)
 *        │
 *        ├─ have text or html ──► format=full     → text ?? html
 *        │                        format=text     → text ?? stripHtml(html)
 *        │                        format=stripped → stripReplyChain(above)
 *        │
 *        └─ nothing decodable ──► ALWAYS a visible "⚠️ body extraction
 *                                 failed: <reason>" marker (never silent)
 *                                   • format=full → marker + capped raw
 *                                     source (the operator escape hatch)
 *                                   • text/stripped → marker only
 *        │
 *        ▼
 *   optional caller maxLength truncation (ergonomic shaping, applied last)
 *
 * Empty/whitespace-only `bodyText`/`bodyHtml` count as "missing" (trim
 * check, NOT `??`) — `??` only falls through on null/undefined, so a
 * stage that produced `""` used to win over a real HTML alternative.
 */

export type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Hard safety cap (bytes/chars) on the raw RFC822 fallback. A multipart
 * message can carry megabytes of base64 attachment in its source; without
 * this cap `format=full` on an undecodable message would dump the whole
 * blob into the tool response. Applied BEFORE the caller's optional
 * `maxLength` because `maxLength` is ergonomic output shaping, not a
 * safety boundary (a caller can pass a huge maxLength).
 */
export const RAW_CAP = 256 * 1024;

/** Strips HTML markup and decodes common entities to produce readable plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes quoted reply chains and signatures from plain text. */
export function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Treats whitespace-only / non-string as "missing". Exported so
 * `messageToEmail` normalizes parsed `text`/`html` with the EXACT same
 * definition of "empty" the formatter uses — otherwise a value one side
 * considers present and the other considers blank reopens the fallback bug.
 */
export function nonEmpty(s: string | undefined | null): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.trim().length > 0 ? s : undefined;
}

/**
 * The subset of an `Email` that drives body presentation. Passing the
 * object (not 4 positional args) keeps the three call sites from drifting.
 */
export interface BodySource {
  bodyText?: string;
  bodyHtml?: string;
  /**
   * Capped raw RFC822 source. Set by `messageToEmail` ONLY when no
   * decodable text/html part was recovered — the `format=full` escape
   * hatch. Undefined on the normal path so threads stay memory-bounded.
   */
  raw?: string;
  /**
   * One-line reason body extraction yielded nothing (oversized source,
   * MIME parse error, or no decodable part). Drives the visible marker so
   * a failure is never presented as a clean empty body.
   */
  bodyWarning?: string;
}

function capRaw(raw: string): string {
  if (raw.length <= RAW_CAP) return raw;
  return `${raw.slice(0, RAW_CAP)}\n\n… (raw source truncated at ${RAW_CAP} bytes — extraction failed; this is the undecoded RFC822 source)`;
}

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     full decoded body (text preferred, else HTML). When nothing
 *             is decodable, a visible failure marker followed by the capped
 *             raw RFC822 source — never a silent empty string.
 * - text:     plain text (bodyText, else HTML stripped to text).
 * - stripped: like text, but also removes quoted reply chains/signatures.
 */
export function applyBodyFormat(src: BodySource, format: BodyFormat, maxLength?: number): string {
  const text = nonEmpty(src.bodyText);
  const html = nonEmpty(src.bodyHtml);

  let body: string;
  if (text || html) {
    if (format === 'full') {
      body = text ?? html ?? '';
    } else {
      const base = text ?? (html ? stripHtml(html) : '');
      body = format === 'stripped' ? stripReplyChain(base) : base;
    }
  } else {
    // Nothing decodable. Never silent: always emit a visible marker.
    const reason = nonEmpty(src.bodyWarning) ?? 'no decodable text or HTML part';
    const marker = `⚠️ body extraction failed: ${reason}`;
    const raw = nonEmpty(src.raw);
    body = format === 'full' && raw ? `${marker}\n\n--- Raw source ---\n${capRaw(raw)}` : marker;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}
