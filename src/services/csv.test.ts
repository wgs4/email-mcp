import { escapeCsvField, toCsvRow } from './csv.js';

describe('escapeCsvField', () => {
  it('returns empty string for null / undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(escapeCsvField('')).toBe('');
  });

  it('passes through plain values without quoting', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField('lease.pdf')).toBe('lease.pdf');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(true)).toBe('true');
  });

  it('quotes fields containing commas', () => {
    expect(escapeCsvField('Smith, John')).toBe('"Smith, John"');
  });

  it('quotes fields containing embedded double-quotes and doubles them', () => {
    expect(escapeCsvField('She said "hi"')).toBe('"She said ""hi"""');
  });

  it('quotes fields containing newlines (LF and CR)', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('handles a field with every edge case simultaneously', () => {
    const evil = 'He said "hi,there"\nline2';
    expect(escapeCsvField(evil)).toBe('"He said ""hi,there""\nline2"');
  });
});

describe('toCsvRow', () => {
  it('joins fields with commas', () => {
    expect(toCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('escapes each field independently', () => {
    expect(toCsvRow(['plain', 'has,comma', 'has"quote'])).toBe('plain,"has,comma","has""quote"');
  });

  it('serializes a row containing every edge case (single row with all escapes)', () => {
    const row = [
      '42', // id — plain
      'alice', // account
      '2024-01-15', // date
      'Smith, John <john@x.com>', // from — has comma
      'Subject with "quotes" and\nnewlines', // subject — has quote + newline
      '', // labels — empty
      'file,with,commas.pdf', // attachments
    ];
    const line = toCsvRow(row);
    expect(line).toBe(
      '42,alice,2024-01-15,"Smith, John <john@x.com>","Subject with ""quotes"" and\nnewlines",,"file,with,commas.pdf"',
    );
  });

  it('produces an empty CSV line for an empty row array', () => {
    expect(toCsvRow([])).toBe('');
  });
});
