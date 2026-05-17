import { applyBodyFormat, nonEmpty, RAW_CAP, stripHtml, stripReplyChain } from './body-format.js';

describe('nonEmpty', () => {
  it('treats whitespace-only and non-strings as missing', () => {
    expect(nonEmpty('hello')).toBe('hello');
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty('   \n\t ')).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty(null)).toBeUndefined();
  });
});

describe('stripHtml / stripReplyChain', () => {
  it('strips tags and decodes entities', () => {
    expect(stripHtml('<p>a &amp; b</p>')).toBe('a & b');
  });
  it('drops quoted reply chains and signatures', () => {
    expect(stripReplyChain('keep\n> quoted\n-- \nsig')).toBe('keep');
  });
});

describe('applyBodyFormat', () => {
  it('full prefers decoded text over HTML', () => {
    expect(applyBodyFormat({ bodyText: 'plain', bodyHtml: '<p>html</p>' }, 'full')).toBe('plain');
  });

  it('REGRESSION: empty-string bodyText does NOT win over a real HTML part', () => {
    // The core defect: old code did `bodyText ?? bodyHtml` so a stage that
    // produced "" beat the HTML alternative (── empty multipart bodies).
    const out = applyBodyFormat({ bodyText: '', bodyHtml: '<div>real content</div>' }, 'full');
    expect(out).toContain('real content');
    expect(out).not.toBe('');
  });

  it('whitespace-only bodyText is treated as missing', () => {
    const out = applyBodyFormat({ bodyText: '   \n ', bodyHtml: '<b>hi</b>' }, 'text');
    expect(out).toBe('hi');
  });

  it('text strips HTML when only HTML is present', () => {
    expect(applyBodyFormat({ bodyHtml: '<p>hello <b>world</b></p>' }, 'text')).toBe('hello world');
  });

  it('stripped also removes quoted replies', () => {
    const src = { bodyText: 'reply body\n> old quoted line\n-- \nsignature' };
    expect(applyBodyFormat(src, 'stripped')).toBe('reply body');
  });

  it('nothing decodable → visible marker for every format (never silent)', () => {
    const src = { bodyWarning: 'MIME parse error: boom' };
    expect(applyBodyFormat(src, 'full')).toBe('⚠️ body extraction failed: MIME parse error: boom');
    expect(applyBodyFormat(src, 'text')).toBe('⚠️ body extraction failed: MIME parse error: boom');
    expect(applyBodyFormat(src, 'stripped')).toBe(
      '⚠️ body extraction failed: MIME parse error: boom',
    );
  });

  it('default reason when bodyWarning absent', () => {
    expect(applyBodyFormat({}, 'text')).toBe(
      '⚠️ body extraction failed: no decodable text or HTML part',
    );
  });

  it('full appends capped raw source as the escape hatch; text/stripped do NOT', () => {
    const src = { raw: 'Raw-RFC822-Bytes-Here', bodyWarning: 'no decodable text or HTML part' };
    const full = applyBodyFormat(src, 'full');
    expect(full).toContain('⚠️ body extraction failed');
    expect(full).toContain('--- Raw source ---');
    expect(full).toContain('Raw-RFC822-Bytes-Here');

    const text = applyBodyFormat(src, 'text');
    expect(text).not.toContain('--- Raw source ---');
    expect(text).not.toContain('Raw-RFC822-Bytes-Here');
  });

  it('raw fallback is hard-capped at RAW_CAP regardless of maxLength', () => {
    const src = { raw: 'x'.repeat(RAW_CAP * 2), bodyWarning: 'oversized' };
    // No maxLength → still capped (safety boundary, not ergonomic shaping).
    const out = applyBodyFormat(src, 'full');
    expect(out).toContain('raw source truncated at');
    // marker + header + capped raw + truncation note — bounded well under 2×cap.
    expect(out.length).toBeLessThan(RAW_CAP + 1024);
  });

  it('maxLength truncates after formatting with a remaining-chars hint', () => {
    const out = applyBodyFormat({ bodyText: 'abcdefghij' }, 'full', 4);
    expect(out.startsWith('abcd')).toBe(true);
    expect(out).toContain('6 more characters');
  });
});
