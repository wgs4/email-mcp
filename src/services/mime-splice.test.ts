import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { describe, expect, it } from 'vitest';
import type { ResolvedAttachment } from './attachment-resolver.js';
import { findDanglingCids, injectAttachments } from './mime-splice.js';

async function compose(opts: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(opts)
      .compile()
      .build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)));
  });
}

const pdf = (name: string, body: string): ResolvedAttachment => ({
  filename: name,
  content: Buffer.from(body),
  contentType: 'application/pdf',
});

describe('injectAttachments — no-strip path', () => {
  it('appends attachments and keeps the original body bytes verbatim', async () => {
    const raw = await compose({
      from: 'David Young <david@wgsusa.com>',
      to: 'andy@chk-electronics.com',
      subject: 'New WGS orders',
      html: '<p>Andy, two POs attached.</p>',
    });

    const out = await injectAttachments(
      raw,
      [pdf('PO-1.pdf', '%PDF one'), pdf('PO-2.pdf', '%PDF two')],
      { stripDanglingCids: true },
    );

    // Verbatim survival: the exact HTML bytes appear in the output (not re-encoded).
    expect(out.raw.toString('utf8')).toContain('<p>Andy, two POs attached.</p>');
    expect(out.strippedCids).toEqual([]);

    const parsed = await simpleParser(out.raw);
    expect(parsed.subject).toBe('New WGS orders');
    expect((parsed.to as { text: string }).text).toContain('andy@chk-electronics.com');
    expect(
      (parsed.attachments ?? [])
        .map((a) => a.filename)
        .sort((x, y) => (x ?? '').localeCompare(y ?? '')),
    ).toEqual(['PO-1.pdf', 'PO-2.pdf']);
  });
});

describe('findDanglingCids + strip path', () => {
  it('detects dangling cids and strips only those <img> tags, keeping user text + attachments', async () => {
    const raw = await compose({
      from: 'david@wgsusa.com',
      to: 'andy@chk-electronics.com',
      subject: 'CHK order',
      html: '<p>Hello Andy.</p><img src="cid:sig-logo@apple">',
    });
    expect(await findDanglingCids(raw)).toEqual(['sig-logo@apple']);

    const out = await injectAttachments(raw, [pdf('PO-9.pdf', '%PDF nine')], {
      stripDanglingCids: true,
    });
    const parsed = await simpleParser(out.raw);
    expect(out.strippedCids).toEqual(['sig-logo@apple']);
    expect(parsed.html).toContain('Hello Andy.');
    expect(parsed.html).not.toContain('cid:sig-logo@apple');
    expect((parsed.attachments ?? []).map((a) => a.filename)).toEqual(['PO-9.pdf']);
  });

  it('does not strip a cid that has a matching inline part', async () => {
    const raw = await compose({
      from: 'david@wgsusa.com',
      subject: 'inline ok',
      html: '<p>hi</p><img src="cid:real@x">',
      attachments: [{ filename: 'i.png', content: Buffer.from('PNG'), cid: 'real@x' }],
    });
    expect(await findDanglingCids(raw)).toEqual([]);
    const out = await injectAttachments(raw, [], { stripDanglingCids: true });
    expect(out.strippedCids).toEqual([]);
  });
});
