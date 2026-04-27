import { normalizeDate } from './date.js';

describe('normalizeDate', () => {
  it('parses full ISO 8601 with time and Z', () => {
    const d = normalizeDate('2024-01-15T10:00:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('parses YYYY-MM-DD as UTC midnight', () => {
    const d = normalizeDate('2024-01-15');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('parses "today" as UTC midnight of current day', () => {
    const d = normalizeDate('today');
    const now = new Date();
    expect(d.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(d.getUTCMonth()).toBe(now.getUTCMonth());
    expect(d.getUTCDate()).toBe(now.getUTCDate());
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it('parses "yesterday" as UTC midnight of previous day', () => {
    const d = normalizeDate('yesterday');
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 1);
    expect(d.getUTCFullYear()).toBe(expected.getUTCFullYear());
    expect(d.getUTCMonth()).toBe(expected.getUTCMonth());
    expect(d.getUTCDate()).toBe(expected.getUTCDate());
    expect(d.getUTCHours()).toBe(0);
  });

  it('parses "7d" as 7 days ago (UTC midnight)', () => {
    const d = normalizeDate('7d');
    const now = new Date();
    const expectedMs =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 7 * 24 * 60 * 60 * 1000;
    expect(d.getTime()).toBe(expectedMs);
  });

  it('parses "3w" as 21 days ago', () => {
    const d = normalizeDate('3w');
    const now = new Date();
    const expectedMs =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      21 * 24 * 60 * 60 * 1000;
    expect(d.getTime()).toBe(expectedMs);
  });

  it('parses "2m" as 2 months ago', () => {
    const d = normalizeDate('2m');
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    expected.setUTCMonth(expected.getUTCMonth() - 2);
    expect(d.getTime()).toBe(expected.getTime());
  });

  it('parses relative tokens case-insensitively', () => {
    const a = normalizeDate('7D');
    const b = normalizeDate('7d');
    expect(a.getTime()).toBe(b.getTime());
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDate('  2024-01-15  ').toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('throws Error with "Invalid date: " prefix on garbage input', () => {
    expect(() => normalizeDate('not a date')).toThrow(/^Invalid date: not a date$/);
  });

  it('throws on empty string', () => {
    expect(() => normalizeDate('')).toThrow(/^Invalid date: $/);
  });

  it('throws on out-of-range month', () => {
    expect(() => normalizeDate('2024-13-01')).toThrow(/^Invalid date: 2024-13-01$/);
  });
});
