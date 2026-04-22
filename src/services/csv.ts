/**
 * Minimal CSV writer helpers — RFC 4180 conformant field escaping.
 *
 * We avoid pulling in a dependency for a ~20 LOC helper. The only tricky rule
 * is the quoting: fields containing `"`, `,`, `\r`, or `\n` must be wrapped in
 * double-quotes, with any embedded `"` doubled up.
 */

/**
 * Escape a single CSV field per RFC 4180.
 *
 * - Stringifies non-string values with `String(value)`.
 * - `null` / `undefined` become empty strings (no quotes, no literal "null").
 * - Wraps in double-quotes only when the value contains `"`, `,`, `\r`, or `\n`.
 * - Doubles up embedded `"` inside quoted fields.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (str === '') return '';
  const needsQuoting = /["\n\r,]/.test(str);
  if (!needsQuoting) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Serialize one row of fields to a single CSV line (no trailing newline).
 * Each field is escaped with `escapeCsvField`.
 */
export function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(',');
}
