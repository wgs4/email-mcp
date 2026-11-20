import {
  fixedTermPcre,
  headerSearchPcre,
  makeLocalMatcher,
  pcreEscape,
  percentEncodedForm,
  qEncodedForm,
  termVariants,
} from './patterns.js';

describe('term variants', () => {
  it('ASCII terms have one variant', () => {
    expect(termVariants('PO208780')).toEqual(['PO208780']);
  });

  it('non-ASCII terms add Q- and %-encoded UTF-8 forms', () => {
    expect(qEncodedForm('外 形')).toBe('=E5=A4=96_=E5=BD=A2');
    expect(percentEncodedForm('外 形')).toBe('%E5%A4%96%20%E5%BD%A2');
    expect(termVariants('外')).toEqual(['外', '=E5=A4=96', '%E5%A4%96']);
  });
});

describe('pcre builders', () => {
  it('escapes metacharacters so a fixed term is literal', () => {
    expect(pcreEscape('a.b*(c)')).toBe('a\\.b\\*\\(c\\)');
    expect(fixedTermPcre('a.b')).toBe('(?:a\\x2eb)');
  });

  it('writes non-ASCII as byte escapes', () => {
    expect(fixedTermPcre('外')).toBe(
      '(?:\\xe5\\xa4\\x96|\\x3dE5\\x3dA4\\x3d96|\\x25E5\\x25A4\\x2596)',
    );
  });

  it('header pattern has the blank-line stop, field and continuation alternatives', () => {
    const p = headerSearchPcre(['from', 'subject'], 'PO208780', false);
    expect(p).toBe('^(?=\\r?$)|^(?:from|subject)[ \\t]*:.*?(?:PO208780)|^[ \\t].*?(?:PO208780)');
    // Sanity-check the semantics with JS (same syntax for this subset).
    const re = new RegExp(p, 'i');
    expect('Subject:  ***SPAM***  Re:PO208780-WGS'.match(re)?.[0]).toBe(
      'Subject:  ***SPAM***  Re:PO208780',
    );
    expect(''.match(re)?.[0]).toBe(''); // header end: empty match, not printed by grep -o
    expect('\tRe: PO208780'.match(re)?.[0].startsWith('\t')).toBe(true);
    expect('X-Other: PO208780'.match(re)).toBeNull();
  });

  it('regex mode embeds the user pattern as a group', () => {
    expect(headerSearchPcre(['subject'], 'PO2087\\d+', true)).toContain('(?:PO2087\\d+)');
  });
});

describe('makeLocalMatcher', () => {
  it('fixed: case-insensitive substring', () => {
    const m = makeLocalMatcher('po208780', false);
    expect(m('Re: PO208780')).toBe(true);
    expect(m('Re: PO20878')).toBe(false);
  });

  it('regex: JavaScript RegExp, case-insensitive', () => {
    expect(makeLocalMatcher('^re:', true)('RE: x')).toBe(true);
    expect(() => makeLocalMatcher('(', true)).toThrow();
  });
});
