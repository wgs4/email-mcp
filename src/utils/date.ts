/**
 * Date parsing utilities for Power Search filters.
 *
 * `normalizeDate` accepts several user-friendly formats and returns a `Date`:
 *   - ISO 8601            e.g. `2024-01-15T10:00:00Z`
 *   - `YYYY-MM-DD`        e.g. `2024-01-15` (parsed as UTC midnight)
 *   - Relative tokens     e.g. `7d`, `3w`, `2m` (days/weeks/months ago)
 *   - Named tokens        `today`, `yesterday`
 *
 * Throws `Error` with message `Invalid date: ${input}` for unparseable input.
 */

const RELATIVE_PATTERN = /^(\d+)([dwm])$/i;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// eslint-disable-next-line import-x/prefer-default-export -- named export keeps call site self-documenting (`normalizeDate('7d')`)
export function normalizeDate(input: string): Date {
  if (typeof input !== 'string') {
    throw new Error(`Invalid date: ${String(input)}`);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid date: ${input}`);
  }

  const lower = trimmed.toLowerCase();

  // Named tokens
  if (lower === 'today') {
    return startOfDayUtc(new Date());
  }
  if (lower === 'yesterday') {
    const d = startOfDayUtc(new Date());
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }

  // Relative tokens: Nd, Nw, Nm
  const rel = RELATIVE_PATTERN.exec(lower);
  if (rel) {
    const amount = Number.parseInt(rel[1], 10);
    const unit = rel[2];
    const d = startOfDayUtc(new Date());
    if (unit === 'd') d.setUTCDate(d.getUTCDate() - amount);
    else if (unit === 'w') d.setUTCDate(d.getUTCDate() - amount * 7);
    else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - amount);
    return d;
  }

  // YYYY-MM-DD — parse as UTC midnight (avoid local TZ drift)
  if (ISO_DATE_ONLY.test(trimmed)) {
    const [y, m, day] = trimmed.split('-').map((s) => Number.parseInt(s, 10));
    if (
      !Number.isFinite(y) ||
      !Number.isFinite(m) ||
      !Number.isFinite(day) ||
      m < 1 ||
      m > 12 ||
      day < 1 ||
      day > 31
    ) {
      throw new Error(`Invalid date: ${input}`);
    }
    const dt = new Date(Date.UTC(y, m - 1, day));
    if (Number.isNaN(dt.getTime())) {
      throw new Error(`Invalid date: ${input}`);
    }
    return dt;
  }

  // Full ISO 8601
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return parsed;
}
