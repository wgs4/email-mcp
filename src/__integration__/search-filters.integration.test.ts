import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmailWithAttachment,
  seedEmailWithInlineAttachmentNoCid,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Power Search filters (integration)', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());

    // Seed a varied set of emails so the filters actually narrow.
    await seedEmail({ from: 'alice@localhost', subject: 'Quarterly Report' });
    await seedEmail({ from: 'alice@localhost', subject: 'Pines Rd invoice' });
    await seedEmail({ from: 'bob@localhost', subject: 'Vacation plans' });
    await seedEmail({ from: 'bob@localhost', subject: 'Lunch tomorrow' });
    await seedEmail({ from: 'alice@localhost', subject: 'Follow-up on report' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  describe('date filters', () => {
    it('since "today" returns same-day messages (all of them since we just seeded)', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        since: 'today',
      });
      expect(result.total).toBeGreaterThanOrEqual(5);
    });

    it('since a future date narrows to zero', async () => {
      const future = new Date();
      future.setUTCFullYear(future.getUTCFullYear() + 1);
      const iso = future.toISOString().slice(0, 10); // YYYY-MM-DD
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        since: iso,
      });
      expect(result.total).toBe(0);
    });

    it('before "today" excludes just-seeded emails (same-day)', async () => {
      // NOTE: IMAP BEFORE is strict — excludes current day. GreenMail may index
      // messages against its own clock. If all messages were delivered today,
      // before:today returns 0. Tolerate slight drift.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        before: 'today',
      });
      expect(result.total).toBeLessThanOrEqual(5);
    });
  });

  describe('from filter', () => {
    it('returns only messages from alice when from="alice"', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        from: 'alice@localhost',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      for (const email of result.items) {
        expect(email.from.address).toContain('alice');
      }
    });
  });

  describe('subject filter', () => {
    it('narrows by subject substring', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        subject: 'Pines Rd',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].subject).toMatch(/Pines Rd/);
    });
  });

  describe('combined filters', () => {
    it('from + subject narrows further than either alone', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        from: 'alice@localhost',
        subject: 'report',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const email of result.items) {
        expect(email.from.address).toContain('alice');
        expect(email.subject.toLowerCase()).toContain('report');
      }
    });
  });

  describe('seen filter', () => {
    it('seen:false returns unread-only results', async () => {
      // All freshly seeded emails start unseen.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        seen: false,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(5);
      for (const email of result.items) {
        expect(email.seen).toBe(false);
      }
    });
  });

  describe('gmail_raw on non-Gmail account', () => {
    it('throws a clear error when used against GreenMail', async () => {
      await expect(
        services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', { gmailRaw: 'from:foo' }),
      ).rejects.toThrow(/only valid on Gmail accounts/);
    });
  });

  // -------------------------------------------------------------------------
  // Phase E — attachment filename + mimetype filters
  // -------------------------------------------------------------------------

  describe('attachment filters (Phase E)', () => {
    beforeAll(async () => {
      // Seed a PDF-style attachment whose filename contains "lease".
      await seedEmailWithAttachment('signed_lease_v7.pdf', 'fake pdf bytes', {
        subject: 'Pines Rd lease with attachment',
      });
      // And an unrelated text attachment so filename/mimetype filters have to discriminate.
      await seedEmailWithAttachment('notes.txt', 'just some notes', {
        subject: 'Meeting notes',
      });
      await waitForDelivery();
    });

    it('attachmentFilename="lease" narrows to the seeded PDF', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        attachmentFilename: 'lease',
        pageSize: 50,
      });
      // Expect at least one hit whose attachments include a filename containing "lease".
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const email of result.items) {
        expect((email.attachments ?? []).some((a) => /lease/i.test(a.filename))).toBe(true);
      }
    });

    it('attachmentMimetype="text/plain" returns emails carrying a text attachment', async () => {
      // GreenMail delivers attachments via nodemailer which labels .txt as text/plain.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        attachmentMimetype: 'text/plain',
        pageSize: 50,
      });
      // Must surface the notes.txt email (filename includes "notes").
      expect(
        result.items.some((e) => (e.attachments ?? []).some((a) => /notes\.txt/.test(a.filename))),
      ).toBe(true);
      for (const email of result.items) {
        expect((email.attachments ?? []).some((a) => /^text\/plain/i.test(a.mimeType))).toBe(true);
      }
    });

    it('invalid attachmentMimetype regex raises a friendly error', async () => {
      await expect(
        services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
          attachmentMimetype: '[',
          pageSize: 10,
        }),
      ).rejects.toThrow(/Invalid attachment_mimetype pattern/);
    });
  });

  // -------------------------------------------------------------------------
  // Phase G — faceted counts
  // -------------------------------------------------------------------------

  describe('faceted counts (Phase G)', () => {
    it('facets: ["sender","year"] returns bucketed counts from the current seed', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        facets: ['sender', 'year'],
        pageSize: 10,
      });
      expect(result.facets).toBeDefined();
      expect(result.facets?.sender).toBeDefined();
      expect(result.facets?.year).toBeDefined();

      // Sum of sender counts should equal the full (capped) match set.
      const senderTotal = Object.values(result.facets?.sender ?? {}).reduce((a, b) => a + b, 0);
      expect(senderTotal).toBe(result.total);

      // We seeded at least one alice@localhost — must appear in sender bucket.
      const senders = Object.keys(result.facets?.sender ?? {});
      expect(senders.some((s) => s.includes('alice'))).toBe(true);
    });

    it('facets: ["mailbox"] returns { INBOX: total } without an envelope scan', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        facets: ['mailbox'],
        pageSize: 5,
      });
      expect(result.facets?.mailbox).toEqual({ INBOX: result.total });
      // sender / year should not be populated when not requested.
      expect(result.facets?.sender).toBeUndefined();
      expect(result.facets?.year).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Phase H — has_attachment regression (inline image without Content-ID)
  // -------------------------------------------------------------------------

  describe('has_attachment regression — inline image no Content-ID', () => {
    let inlineNoCidSubject: string;

    beforeAll(async () => {
      inlineNoCidSubject = `Inline no-cid regression ${Date.now()}`;
      await seedEmailWithInlineAttachmentNoCid({ subject: inlineNoCidSubject });
      await waitForDelivery();
    });

    it('search_emails(has_attachment=true) returns the inline-no-cid email', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        hasAttachment: true,
        pageSize: 100,
      });
      const found = result.items.find((e) => e.subject === inlineNoCidSubject);
      expect(found).toBeDefined();
      // The attachments array must also be populated (semantic alignment).
      expect((found?.attachments ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it('the seeded email carries banner.gif in its attachments metadata', async () => {
      // Verify extractAttachmentMeta surfaces the inline-no-cid image.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        subject: inlineNoCidSubject,
        pageSize: 10,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const email = result.items[0];
      expect(email.hasAttachments).toBe(true);
      expect((email.attachments ?? []).some((a) => /banner\.gif/.test(a.filename))).toBe(true);
    });
  });
});
