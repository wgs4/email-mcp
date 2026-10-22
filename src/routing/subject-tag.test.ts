/**
 * Unit tests for the pure osTicket subject tagger.
 *
 * The important properties are structural: only the top-level Subject header
 * changes, every other byte survives (including binary attachment bytes), and
 * an existing tag is respected rather than overwritten.
 */

import { tagSubject } from './subject-tag.js';

const CRLF = '\r\n';

function message(headers: string[], body: string[] = ['body'], eol = CRLF): Buffer {
  return Buffer.from([...headers, '', ...body].join(eol), 'binary');
}

function headerBlock(raw: Buffer): string {
  const text = raw.toString('binary');
  const split = text.indexOf(`${CRLF}${CRLF}`);
  const lfSplit = text.indexOf('\n\n');
  if (split !== -1) return text.slice(0, split);
  if (lfSplit !== -1) return text.slice(0, lfSplit);
  return text;
}

function bWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function qWord(text: string): string {
  const payload = Array.from(Buffer.from(text, 'utf8'))
    .map((byte) => {
      if (byte === 0x20) {
        return '_';
      }
      const printable = byte >= 0x21 && byte <= 0x7e && byte !== 0x3f && byte !== 0x5f;
      return printable
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
  return `=?UTF-8?Q?${payload}?=`;
}

describe('tagSubject', () => {
  it('appends the tag to a plain ASCII subject and preserves the rest byte-for-byte', () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41]);
    const raw = Buffer.concat([
      Buffer.from(
        [
          'Return-Path: <shop@example.com>',
          'From: Shop <shop@example.com>',
          'To: customer@example.com',
          'Subject: Your order is out for delivery',
          'Message-ID: <abc123@example.com>',
          'Date: Tue, 20 Oct 2026 10:00:00 -0500',
          '',
          '',
        ].join(CRLF),
        'binary',
      ),
      body,
    ]);
    const expected = Buffer.concat([
      Buffer.from(
        [
          'Return-Path: <shop@example.com>',
          'From: Shop <shop@example.com>',
          'To: customer@example.com',
          'Subject: Your order is out for delivery [#31775]',
          'Message-ID: <abc123@example.com>',
          'Date: Tue, 20 Oct 2026 10:00:00 -0500',
          '',
          '',
        ].join(CRLF),
        'binary',
      ),
      body,
    ]);

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Your order is out for delivery [#31775]');
    if (result.status === 'tagged') {
      expect(result.rewritten).toBe(true);
      expect(result.raw.equals(expected)).toBe(true);
    }
  });

  it('keeps a Re: prefix', () => {
    const result = tagSubject(message(['Subject: Re: Your order']), '40001');
    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Re: Your order [#40001]');
  });

  it('leaves a subject already tagged with the same number unchanged', () => {
    const raw = message(['Subject: Re: Your order [#31775]']);
    const result = tagSubject(raw, '31775');
    expect(result.status).toBe('unchanged');
    expect(result.subject).toBe('Re: Your order [#31775]');
    if (result.status === 'unchanged') {
      expect(result.raw).toBe(raw);
      expect(result.rewritten).toBe(false);
    }
  });

  it('refuses a subject tagged with a different ticket number', () => {
    const result = tagSubject(message(['Subject: Re: Your order [#11111]']), '31775');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.existingTicket).toBe('11111');
      expect(result.subject).toBe('Re: Your order [#11111]');
    }
  });

  it('detects a different tag inside an encoded-word', () => {
    const result = tagSubject(message([`Subject: ${bWord('Re: Your order [#11111]')}`]), '31775');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.existingTicket).toBe('11111');
    }
  });

  it('unfolds a multi-line Subject header', () => {
    const raw = message([
      'From: shop@example.com',
      'Subject: Re: your order',
      ' is out for delivery',
      'Message-ID: <folded@example.com>',
    ]);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Re: your order is out for delivery [#31775]');
    if (result.status === 'tagged') {
      const headers = headerBlock(result.raw);
      expect(headers).toContain('Subject: Re: your order is out for delivery [#31775]');
      expect(headers).not.toContain('Subject: Re: your order\r\n is out');
      expect(headers).toContain('From: shop@example.com');
      expect(headers).toContain('Message-ID: <folded@example.com>');
    }
  });

  it('unfolds a Subject folded with a leading tab', () => {
    const result = tagSubject(message(['Subject: Re: your order', '\tis ready']), '31775');
    expect(result.subject).toBe('Re: your order is ready [#31775]');
  });

  it('decodes a B-encoded word and appends the tag (ASCII stays plain)', () => {
    const raw = message([`Subject: ${bWord('Re: Your order')}`]);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Re: Your order [#31775]');
    if (result.status === 'tagged') {
      expect(headerBlock(result.raw)).toContain('Subject: Re: Your order [#31775]');
      expect(headerBlock(result.raw)).not.toContain('=?UTF-8?B?');
    }
  });

  it('decodes a Q-encoded word', () => {
    const raw = message([`Subject: ${qWord('Re: Café order')}`]);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Re: Café order [#31775]');
  });

  it('re-encodes a non-ASCII subject as RFC 2047 UTF-8 and round-trips', () => {
    const raw = message([`Subject: ${qWord('Café order')}`]);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(headerBlock(result.raw)).toContain('=?UTF-8?B?');
      const second = tagSubject(result.raw, '31775');
      expect(second.status).toBe('unchanged');
      expect(second.subject).toBe('Café order [#31775]');
    }
  });

  it('handles a literal 8-bit UTF-8 Subject header', () => {
    const raw = Buffer.from(['Subject: Café order', '', 'body'].join(CRLF), 'utf8');
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('Café order [#31775]');
    if (result.status === 'tagged') {
      const second = tagSubject(result.raw, '31775');
      expect(second.subject).toBe('Café order [#31775]');
    }
  });

  it('concatenates adjacent encoded-words, dropping only folding whitespace', () => {
    const raw = message([
      `Subject: ${bWord('Re: Your')}`,
      ` ${bWord(' order')}`,
      ` ${bWord(' is out')}`,
    ]);
    const result = tagSubject(raw, '31775');
    expect(result.subject).toBe('Re: Your order is out [#31775]');
  });

  it('is case-insensitive about the Subject field name', () => {
    const result = tagSubject(message(['subject: lower case']), '31775');
    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(headerBlock(result.raw)).toContain('Subject: lower case [#31775]');
      expect(headerBlock(result.raw)).not.toContain('subject:');
    }
  });

  it('creates a Subject header when one is missing', () => {
    const raw = message(['From: a@example.com', 'To: b@example.com'], ['hello']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('[#31775]');
    if (result.status === 'tagged') {
      const expected = message(
        ['From: a@example.com', 'To: b@example.com', 'Subject: [#31775]'],
        ['hello'],
      );
      expect(result.raw.equals(expected)).toBe(true);
    }
  });

  it('creates a Subject header without adding a trailing newline to headers-only mail', () => {
    const raw = Buffer.from('From: a@example.com\r\nTo: b@example.com', 'binary');
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(result.raw.toString('binary')).toBe(
        'From: a@example.com\r\nTo: b@example.com\r\nSubject: [#31775]',
      );
    }
  });

  it('replaces an empty Subject header with the tag', () => {
    const result = tagSubject(message(['Subject:']), '31775');
    expect(result.status).toBe('tagged');
    expect(result.subject).toBe('[#31775]');
    if (result.status === 'tagged') {
      expect(headerBlock(result.raw)).toContain('Subject: [#31775]');
    }
  });

  it('does not touch Subject-like text in the body', () => {
    const raw = message(
      ['From: a@example.com', 'Subject: real subject'],
      ['Subject: body text', '', 'More body'],
    );
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text).toContain('Subject: real subject [#31775]');
      expect(text).toContain('Subject: body text');
      expect(text.match(/Subject:/g)).toHaveLength(2);
    }
  });

  it('does not touch a nested message/rfc822 attachment', () => {
    const raw = Buffer.from(
      [
        'From: a@example.com',
        'Subject: Fwd: original',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        '--outer',
        'Content-Type: text/plain',
        '',
        'forwarded below',
        '--outer',
        'Content-Type: message/rfc822',
        '',
        'From: customer@example.com',
        'Subject: inner ticket [#99999]',
        '',
        'inner body',
        '--outer--',
        '',
      ].join(CRLF),
      'binary',
    );

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text).toContain('Subject: Fwd: original [#31775]');
      expect(text).toContain('Subject: inner ticket [#99999]');
      expect(text).toContain('forwarded below');
      expect(text).toContain('inner body');
    }
  });

  it('preserves LF-only line endings without introducing CR', () => {
    const raw = message(['From: a@example.com', 'Subject: LF mail'], ['body'], '\n');
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text).not.toContain('\r');
      expect(text).toContain('Subject: LF mail [#31775]\n');
      expect(text.endsWith('body')).toBe(true);
    }
  });

  it('keeps CRLF line endings on every rebuilt header', () => {
    const result = tagSubject(message(['Subject: CRLF mail']), '31775');
    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text.split(CRLF)[0]).toBe('Subject: CRLF mail [#31775]');
      expect(text.split('\n').every((line) => line.endsWith('\r') || line === 'body')).toBe(true);
    }
  });

  it('folds long non-ASCII subjects into legal encoded-words', () => {
    const long = `Re: ${'é'.repeat(120)}`;
    const raw = message([`Subject: ${qWord(long)}`]);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const headerLines = headerBlock(result.raw).split(CRLF);
      expect(headerLines.length).toBeGreaterThan(1);
      headerLines.forEach((line) => {
        expect(line.length).toBeLessThanOrEqual(75);
      });
      const second = tagSubject(result.raw, '31775');
      expect(second.subject).toBe(`${long} [#31775]`);
    }
  });

  it('leaves a same-number Q-encoded tag byte-identical', () => {
    const raw = message([`Subject: ${qWord('Re: Café order [#31775]')}`]);
    const result = tagSubject(raw, '31775');
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.raw.equals(raw)).toBe(true);
    }
  });
});
