/**
 * MIME header re-folding for composed messages.
 *
 * nodemailer folds long headers at the nearest whitespace, which can drop the
 * CRLF *inside* a quoted parameter value when an attachment filename contains
 * spaces:
 *
 *   Content-Disposition: attachment; filename="Farmpedals Statement
 *    08-07-2026.pdf"
 *
 * That is legal RFC 5322 folding — unfolding restores the name — but iOS Mail
 * refuses to load such a part and reports "One or more attachments failed to
 * load", so the attachment silently goes missing from a draft opened on the
 * phone. Short filenames stay on one line and are unaffected, which is why the
 * bug looks intermittent: it only bites names long enough to be folded.
 *
 * Apple Mail folds at the parameter boundary instead:
 *
 *   Content-Disposition: attachment;
 *    filename="Farmpedals Statement 08-07-2026.pdf"
 *
 * {@link refoldParamHeaders} rewrites composed messages into that shape: it
 * unfolds Content-Type / Content-Disposition headers and re-folds them only at
 * top-level `;` separators, never inside a quoted string.
 */

/** Headers whose parameters may carry a quoted filename. */
const PARAM_HEADER = /^(content-type|content-disposition):/i;

/** Soft line-length target (RFC 5322 recommends <= 78 including CRLF). */
const MAX_LINE = 76;

interface SplitState {
  segments: string[];
  current: string;
  inQuotes: boolean;
  escaped: boolean;
}

/**
 * Split a logical header into `;`-delimited segments, ignoring separators that
 * sit inside a quoted string (`filename="a;b.pdf"` is ONE segment). Each
 * segment except the last keeps its trailing `;`.
 */
function splitParams(logical: string): string[] {
  const state = Array.from(logical).reduce<SplitState>(
    (acc, ch) => {
      if (acc.escaped) return { ...acc, current: acc.current + ch, escaped: false };
      if (ch === '\\' && acc.inQuotes) return { ...acc, current: acc.current + ch, escaped: true };
      if (ch === '"') return { ...acc, current: acc.current + ch, inQuotes: !acc.inQuotes };
      if (ch === ';' && !acc.inQuotes) {
        return { ...acc, segments: [...acc.segments, `${acc.current};`], current: '' };
      }
      return { ...acc, current: acc.current + ch };
    },
    { segments: [], current: '', inQuotes: false, escaped: false },
  );

  return [...state.segments, state.current].map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Re-fold one unfolded header at parameter boundaries. A single segment longer
 * than the target stays on its own (long) line rather than being broken
 * mid-value — a long line is universally accepted, a fold inside quotes is not.
 */
function foldParams(logical: string, eol: string): string {
  if (logical.length <= MAX_LINE) return logical;

  const [head, ...rest] = splitParams(logical);
  if (head === undefined || rest.length === 0) return logical;

  const folded = rest.reduce<{ lines: string[]; current: string }>(
    (acc, segment) =>
      acc.current.length + 1 + segment.length <= MAX_LINE
        ? { ...acc, current: `${acc.current} ${segment}` }
        : { lines: [...acc.lines, acc.current], current: ` ${segment}` }, // continuations start with one space
    { lines: [], current: head },
  );

  return [...folded.lines, folded.current].join(eol);
}

interface FoldState {
  out: string[];
  inHeaders: boolean;
  /** A Content-* header being accumulated across its folded continuations. */
  pending: string | null;
}

/**
 * Rewrite a composed message so no Content-Type / Content-Disposition fold
 * lands inside a quoted parameter value.
 *
 * Only header blocks are touched. A block starts at the message beginning or on
 * the line after a `--boundary` delimiter and ends at the first blank line — so
 * base64 and body text pass through byte-for-byte.
 *
 * The message is handled as binary (latin1) so attachment bytes survive the
 * round trip unchanged.
 */
// eslint-disable-next-line import-x/prefer-default-export -- named export keeps call sites self-documenting (`refoldParamHeaders(composed)`)
export function refoldParamHeaders(raw: Buffer): Buffer {
  const text = raw.toString('binary');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  const flush = (state: FoldState): string[] =>
    state.pending === null ? state.out : [...state.out, foldParams(state.pending, eol)];

  const final = text.split(eol).reduce<FoldState>(
    (state, line) => {
      // RFC 5322 unfolding removes the CRLF and keeps the leading whitespace,
      // which is exactly what restores a space-bearing filename.
      if (state.pending !== null && /^[ \t]/.test(line)) {
        return { ...state, pending: state.pending + line };
      }

      const out = flush(state);

      // In a body: pass through, and treat a MIME delimiter as the start of the
      // next part's headers.
      if (!state.inHeaders) {
        return { out: [...out, line], inHeaders: line.startsWith('--'), pending: null };
      }
      if (line === '') return { out: [...out, line], inHeaders: false, pending: null };
      if (PARAM_HEADER.test(line)) return { out, inHeaders: true, pending: line };
      return { out: [...out, line], inHeaders: true, pending: null };
    },
    { out: [], inHeaders: true, pending: null },
  );

  return Buffer.from(flush(final).join(eol), 'binary');
}
