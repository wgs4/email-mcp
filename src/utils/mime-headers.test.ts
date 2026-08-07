import { describe, expect, it } from 'vitest';
import { refoldParamHeaders } from './mime-headers.js';

const CRLF = '\r\n';

function build(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'binary');
}

describe('refoldParamHeaders', () => {
  it('moves a fold out of a quoted filename and onto the parameter boundary', () => {
    const raw = build([
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: application/pdf; name="Farmpedals Statement 08-07-2026.pdf"',
      'Content-Disposition: attachment; filename="Farmpedals Statement',
      ' 08-07-2026.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--b1--',
      '',
    ]);

    const out = refoldParamHeaders(raw).toString('binary');

    // The filename survives intact on one line — no CRLF inside the quotes.
    expect(out).toContain('filename="Farmpedals Statement 08-07-2026.pdf"');
    expect(out).not.toContain('filename="Farmpedals Statement\r\n');
    // …and the fold moved to the parameter boundary, Apple Mail style.
    expect(out).toContain(`Content-Disposition: attachment;${CRLF} filename=`);
  });

  it('leaves short headers and the body untouched', () => {
    const raw = build(['Content-Type: text/plain; charset=utf-8', '', 'hello', '']);

    expect(refoldParamHeaders(raw).toString('binary')).toBe(raw.toString('binary'));
  });

  it('does not split on a semicolon inside a quoted value', () => {
    const raw = build([
      'Content-Disposition: attachment; filename="weird;name that is quite long indeed.pdf"; size=100',
      '',
      'body',
      '',
    ]);

    const out = refoldParamHeaders(raw).toString('binary');

    // The quoted value stays whole — the `;` inside it is not a fold point.
    expect(out).toContain('filename="weird;name that is quite long indeed.pdf"; size=100');
    // The one fold sits at the parameter boundary after `attachment;`.
    expect(out).toContain(`Content-Disposition: attachment;${CRLF} filename=`);
  });

  it('preserves attachment bytes verbatim, including body lines that look like headers', () => {
    const body =
      'Content-Disposition: attachment; filename="not a real header, just body text.pdf"';
    const raw = build(['Content-Type: text/plain', '', body, '']);

    expect(refoldParamHeaders(raw).toString('binary')).toContain(body);
  });

  it('handles LF-only messages', () => {
    const raw = Buffer.from(
      [
        'Content-Disposition: attachment; filename="A rather long attachment',
        ' name goes here.pdf"',
        '',
        'body',
      ].join('\n'),
      'binary',
    );

    const out = refoldParamHeaders(raw).toString('binary');

    expect(out).toContain('filename="A rather long attachment name goes here.pdf"');
    expect(out).not.toContain('\r');
  });
});
