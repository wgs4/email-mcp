/**
 * Unit tests for the pure osTicket subject tagger.
 *
 * The tag is PREPENDED to the raw Subject line and no decoded text is ever
 * emitted, so the assertions here are mostly structural: the tag is the first
 * osTicket token, encoded-words and folds survive byte-for-byte, and every
 * other byte of the message is untouched. Output is decoded with mailparser
 * (an independent parser) wherever the decoded subject matters.
 */

import { simpleParser } from 'mailparser';

import { inspectSubject, tagSubject } from './subject-tag.js';

const CRLF = '\r\n';

function message(headers: string[], body: string[] = ['body'], eol = CRLF): Buffer {
  return Buffer.from([...headers, '', ...body].join(eol), 'binary');
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

async function parsedSubject(raw: Buffer): Promise<string | undefined> {
  return (await simpleParser(raw)).subject;
}

describe('tagSubject', () => {
  it('prepends the tag to a plain ASCII subject and preserves the rest byte-for-byte', () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41]);
    const headers = [
      'Return-Path: <shop@example.com>',
      'From: Shop <shop@example.com>',
      'To: customer@example.com',
      'Subject: Your order is out for delivery',
      'Message-ID: <abc123@example.com>',
      'Date: Tue, 20 Oct 2026 10:00:00 -0500',
    ];
    const raw = Buffer.concat([Buffer.from([...headers, '', ''].join(CRLF), 'binary'), body]);
    const expected = Buffer.concat([
      Buffer.from(
        [
          ...headers.slice(0, 3),
          'Subject: [#31775] Your order is out for delivery',
          ...headers.slice(4),
          '',
          '',
        ].join(CRLF),
        'binary',
      ),
      body,
    ]);

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(result.rewritten).toBe(true);
      expect(result.raw.equals(expected)).toBe(true);
    }
  });

  it('makes the tag the first osTicket token even when the subject already has a number', async () => {
    const raw = message(['Subject: Re: Order #30885']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(inspectSubject(result.raw).firstToken).toBe('31775');
      expect(await parsedSubject(result.raw)).toBe('[#31775] Re: Order #30885');
    }
  });

  it('keeps encoded-words byte-identical after the prepended tag', async () => {
    const encoded = bWord('Re: Café order');
    const raw = message([`Subject: ${encoded}`, 'X-Test: 1']);
    const expected = message([`Subject: [#31775] ${encoded}`, 'X-Test: 1']);

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(result.raw.equals(expected)).toBe(true);
      expect(await parsedSubject(result.raw)).toBe('[#31775] Re: Café order');
    }
  });

  it('leaves a folded Subject header folded and unchanged after the tag', async () => {
    const raw = message([
      'From: shop@example.com',
      'Subject: Re: your order',
      ' is out for delivery',
      'Message-ID: <folded@example.com>',
    ]);
    const expected = message([
      'From: shop@example.com',
      'Subject: [#31775] Re: your order',
      ' is out for delivery',
      'Message-ID: <folded@example.com>',
    ]);

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(result.raw.equals(expected)).toBe(true);
      expect(await parsedSubject(result.raw)).toBe('[#31775] Re: your order is out for delivery');
    }
  });

  it('folds immediately after the tag when the first line would exceed 998 octets', async () => {
    const longSubject = 'a'.repeat(985);
    const raw = message([`Subject: ${longSubject}`, 'X-Test: 1']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      const [firstLine, secondLine] = text.split(CRLF);
      expect(firstLine).toBe('Subject: [#31775]');
      expect(firstLine.length).toBeLessThanOrEqual(998);
      expect(secondLine.length).toBeLessThanOrEqual(998);
      expect(secondLine).toBe(` ${longSubject}`);
      expect(await parsedSubject(result.raw)).toBe(`[#31775] ${longSubject}`);
    }
  });

  it('creates a Subject header when one is missing', async () => {
    const raw = message(['From: a@example.com', 'To: b@example.com'], ['hello']);
    const expected = message(
      ['From: a@example.com', 'To: b@example.com', 'Subject: [#31775]'],
      ['hello'],
    );

    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(result.raw.equals(expected)).toBe(true);
      expect(await parsedSubject(result.raw)).toBe('[#31775]');
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

  it('replaces an empty Subject header with the tag', async () => {
    const result = tagSubject(message(['Subject:']), '31775');
    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      expect(await parsedSubject(result.raw)).toBe('[#31775]');
    }
  });

  it('rejects duplicate top-level Subject fields', () => {
    const raw = message(['Subject: first', 'Subject: second [#11111]']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('duplicate_subject');
  });

  it('rejects duplicate Subject fields regardless of field-name case', () => {
    const raw = message(['Subject: first', 'subject: second']);
    expect(tagSubject(raw, '31775').status).toBe('duplicate_subject');
  });

  it('rejects a subject tagged for a different ticket', () => {
    const result = tagSubject(message(['Subject: Re: Your order [#11111]']), '31775');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.existingTicket).toBe('11111');
      expect(result.subject).toBe('Re: Your order [#11111]');
    }
  });

  it('rejects a different tag that appears first, even when the right tag follows', () => {
    const result = tagSubject(message(['Subject: Re: [#11111] [#31775]']), '31775');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.existingTicket).toBe('11111');
    }
  });

  it('leaves a subject whose first token is already the right number unchanged', () => {
    const raw = message(['Subject: [#31775] Re: Your order']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.raw).toBe(raw);
      expect(result.rewritten).toBe(false);
    }
  });

  it('keeps an encoded-word subject harmless when it carries CRLF in its payload', async () => {
    const injection = '=?UTF-8?Q?hello=0D=0AX-Injected:_yes=0D=0A=0D=0Aevil?=';
    const raw = message([`Subject: ${injection}`, 'X-Test: 1']);
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      const headerBlock = text.slice(0, text.indexOf(`${CRLF}${CRLF}`));
      expect(headerBlock).toContain(`Subject: [#31775] ${injection}`);
      expect(headerBlock.split(CRLF).some((line) => line.startsWith('X-Injected:'))).toBe(false);

      const parsed = await simpleParser(result.raw);
      expect(parsed.headers.get('x-injected')).toBeUndefined();
      // The injected CRLFs stay inside the encoded-word payload: no new header
      // fields appear.
      expect(Array.from(parsed.headers.keys()).sort()).toEqual(['subject', 'x-test']);
      expect(parsed.subject).toContain('[#31775] hello');
    }
  });

  it('decodes windows-1252 for conflict detection without re-encoding it', async () => {
    // Brackets and # are Q-encoded so the raw fallback cannot see the tag.
    const encoded = '=?windows-1252?Q?Re=3A_=5B=2311111=5D_=80_100?=';
    const result = tagSubject(message([`Subject: ${encoded}`]), '31775');

    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.existingTicket).toBe('11111');
    }

    const safe = tagSubject(message([`Subject: ${encoded.replace('11111', '')}`]), '31775');
    expect(safe.status).toBe('tagged');
    if (safe.status === 'tagged') {
      expect(safe.raw.toString('binary')).toContain(
        `Subject: [#31775] ${encoded.replace('11111', '')}`,
      );
    }
  });

  it('supports RFC 2047 language suffixes during detection', () => {
    const encoded = '=?UTF-8*en?Q?=5B=2331775=5D_Caf=C3=A9?=';
    const result = tagSubject(message([`Subject: ${encoded}`]), '31775');
    expect(result.status).toBe('unchanged');
  });

  it('falls back to the raw header when a charset is unsupported', () => {
    const encoded = '=?x-user-defined?Q?Re=3A_[#31775]?=';
    const result = tagSubject(message([`Subject: ${encoded}`]), '31775');
    expect(result.status).toBe('unchanged');
  });

  it('rejects a Subject field with a bare CR that is not a valid fold', () => {
    const raw = Buffer.from('Subject: a\rb\r\nX-Test: 1\r\n\r\nbody', 'binary');
    const result = tagSubject(raw, '31775');
    expect(result.status).toBe('malformed_subject');
  });

  it('preserves LF-only line endings without introducing CR', async () => {
    const raw = message(['From: a@example.com', 'Subject: LF mail'], ['body'], '\n');
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text).not.toContain('\r');
      expect(text).toContain('Subject: [#31775] LF mail\n');
      expect(await parsedSubject(result.raw)).toBe('[#31775] LF mail');
    }
  });

  it('does not touch Subject-like text in the body', async () => {
    const raw = message(
      ['From: a@example.com', 'Subject: real subject'],
      ['Subject: body text', '', 'More body'],
    );
    const result = tagSubject(raw, '31775');

    expect(result.status).toBe('tagged');
    if (result.status === 'tagged') {
      const text = result.raw.toString('binary');
      expect(text).toContain('Subject: [#31775] real subject');
      expect(text).toContain('Subject: body text');
      expect(text.match(/Subject:/g)).toHaveLength(2);
      expect(await parsedSubject(result.raw)).toBe('[#31775] real subject');
    }
  });

  it('does not touch a nested message/rfc822 attachment', async () => {
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
      expect(text).toContain('Subject: [#31775] Fwd: original');
      expect(text).toContain('Subject: inner ticket [#99999]');
      expect(text).toContain('forwarded below');
      expect(text).toContain('inner body');
    }
  });

  it('uses the first token rule for a bare hash number already in the subject', () => {
    const raw = message(['Subject: Order #31775 shipped']);
    expect(tagSubject(raw, '31775').status).toBe('unchanged');
  });

  it('leaves a Q-encoded same-number subject byte-identical', () => {
    const encoded = qWord('[#31775] Café order');
    const raw = message([`Subject: ${encoded}`]);
    const result = tagSubject(raw, '31775');
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.raw.equals(raw)).toBe(true);
    }
  });
});
