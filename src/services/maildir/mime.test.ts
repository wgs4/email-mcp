import {
  attachmentNamesFromLines,
  decodedHeader,
  decodeMimeWords,
  decodeRfc2231,
  NAME_LINE_PCRE,
  parseHeaderBlock,
} from './mime.js';

describe('decodeMimeWords', () => {
  it('decodes the real GBK Q-encoded supplier drawing name', () => {
    expect(decodeMimeWords('=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?=')).toBe(
      'RV9110NO-FB12.5A7.0 外形图.pdf',
    );
  });

  it('decodes UTF-8 B words and drops whitespace between adjacent words', () => {
    const a = Buffer.from('Hello ').toString('base64');
    const b = Buffer.from('wörld').toString('base64');
    expect(decodeMimeWords(`=?UTF-8?B?${a}?= =?utf-8?B?${b}?= !`)).toBe('Hello wörld !');
  });

  it('joins a multi-byte character split across two words', () => {
    // 外 = E5 A4 96, split after the first byte.
    expect(decodeMimeWords('=?UTF-8?Q?=E5?= =?UTF-8?Q?=A4=96?=')).toBe('外');
  });

  it('leaves plain text and unknown charsets readable', () => {
    expect(decodeMimeWords('Re: PO208780')).toBe('Re: PO208780');
    expect(decodeMimeWords('=?x-unknown?Q?abc?=')).toBe('abc');
  });
});

describe('decodeRfc2231', () => {
  it('percent-decodes in the given charset', () => {
    expect(decodeRfc2231('%E5%A4%96.pdf', 'utf-8')).toBe('外.pdf');
    expect(decodeRfc2231('%CD%E2.pdf', 'gbk')).toBe('外.pdf');
  });
});

describe('parseHeaderBlock', () => {
  it('unfolds continuation lines and stops at the blank line', () => {
    const h = parseHeaderBlock([
      'From: Rita <sales1hongyuan@163.com>',
      'Subject: Re: a very long',
      '\tsubject PO208780\r',
      'X-A: 1',
      '',
      'Subject: body line, not a header',
    ]);
    expect(decodedHeader(h, 'subject')).toBe('Re: a very long subject PO208780');
    expect(h.raw.get('subject')).toHaveLength(1);
    expect(decodedHeader(h, 'from')).toBe('Rita <sales1hongyuan@163.com>');
  });
});

describe('attachmentNamesFromLines', () => {
  it('pairs name= and filename= of one part and decodes them (real message lines)', () => {
    const lines = [
      '\tname="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
      ' filename="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
      '\tname="=?GBK?Q?208780=A1=A1WGS_Paypal__invoice___Mar_19th_2025.pdf?="',
      ' filename="=?GBK?Q?208780=A1=A1WGS_Paypal__invoice___Mar_19th_2025.pdf?="',
    ];
    expect(attachmentNamesFromLines(lines)).toEqual([
      'RV9110NO-FB12.5A7.0 外形图.pdf',
      '208780　WGS Paypal  invoice   Mar 19th 2025.pdf',
    ]);
  });

  it('handles single-line Content-Type / Content-Disposition params', () => {
    expect(
      attachmentNamesFromLines([
        'Content-Type: application/pdf; name="a.pdf"',
        'Content-Disposition: attachment; filename="a.pdf"',
        'Content-Disposition: attachment; filename=b.xlsx',
      ]),
    ).toEqual(['a.pdf', 'b.xlsx']);
  });

  it('assembles RFC 2231 continuations', () => {
    expect(
      attachmentNamesFromLines([
        " filename*0*=utf-8''%E5%A4%96%E5%BD%A2;",
        ' filename*1*=%E5%9B%BE.pdf',
      ]),
    ).toEqual(['外形图.pdf']);
  });
});

describe('NAME_LINE_PCRE (JS approximation)', () => {
  // The server runs it with grep -P -i; JS with the `i` flag is equivalent here.
  const re = new RegExp(NAME_LINE_PCRE, 'i');

  it.each([
    '\tname="x.pdf"',
    ' filename="x.pdf"',
    'Content-Type: application/pdf; name="x.pdf"',
    'Content-Disposition: attachment;filename=x.pdf',
    "\tfilename*0*=utf-8''%E5",
    '\tcharset=utf-8; name="x.pdf"',
  ])('matches %j', (line) => {
    expect(re.test(line)).toBe(true);
  });

  it.each([
    '  <meta name="viewport" content="x">',
    'Please send the file name=foo to me',
    'Subject: name=x',
  ])('does not match %j', (line) => {
    expect(re.test(line)).toBe(false);
  });
});
