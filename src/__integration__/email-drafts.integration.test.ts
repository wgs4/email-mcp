import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Draft Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    // GreenMail does not auto-create Drafts — create it explicitly
    try {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
    } catch {
      // Already exists, ignore
    }
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------

  describe('saveDraft', () => {
    it('should save a draft to Drafts folder', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft test',
        body: 'This is a draft.',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.mailbox).toBeTruthy();
    });

    it('should save a draft without recipients', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: [],
        subject: 'Empty draft',
        body: 'Draft with no recipients.',
      });

      expect(result.id).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // saveDraftWithAttachments
  // ---------------------------------------------------------------------------

  describe('saveDraftWithAttachments (base64 input)', () => {
    it('saves a draft with three base64 attachments and round-trips them', async () => {
      const pdf1 = Buffer.from('%PDF-1.4 stub one');
      const pdf2 = Buffer.from('%PDF-1.4 stub two');
      const pdf3 = Buffer.from('%PDF-1.4 stub three');

      const saved = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft with 3 PDFs',
        body: 'Three attachments incoming.',
        attachments: [
          {
            contentBase64: pdf1.toString('base64'),
            filename: 'one.pdf',
            mimeType: 'application/pdf',
          },
          {
            contentBase64: pdf2.toString('base64'),
            filename: 'two.pdf',
            mimeType: 'application/pdf',
          },
          {
            contentBase64: pdf3.toString('base64'),
            filename: 'three.pdf',
            mimeType: 'application/pdf',
          },
        ],
      });

      expect(saved.id).toBeTruthy();

      // Verify the draft we just wrote has all three attachments via fetchDraft
      const fetched = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        saved.id,
        saved.mailbox,
      );
      const filenames = fetched.email.attachments.map((a) => a.filename).sort();
      expect(filenames).toEqual(['one.pdf', 'three.pdf', 'two.pdf']);
    });

    it('rejects the whole save when one attachment input is invalid', async () => {
      await expect(
        services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
          to: ['bob@localhost'],
          subject: 'Bad input',
          body: 'one good one bad',
          attachments: [
            { contentBase64: 'aGVsbG8=', filename: 'good.txt', mimeType: 'text/plain' },
            { path: '/definitely/does/not/exist/anywhere.pdf' },
          ],
        }),
      ).rejects.toThrow(/Failed to resolve/);
    });
  });

  // ---------------------------------------------------------------------------
  // updateDraft — body-only change preserves attachments
  // ---------------------------------------------------------------------------

  describe('updateDraft preserves attachments', () => {
    it('rewrites the body while keeping all attachments intact', async () => {
      const buf = Buffer.from('%PDF-1.4 lease body content');

      const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Lease draft',
        body: 'first body with italic styling',
        attachments: [
          {
            contentBase64: buf.toString('base64'),
            filename: 'lease.pdf',
            mimeType: 'application/pdf',
          },
        ],
      });

      const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, original.id, {
        mailbox: original.mailbox,
        body: 'clean rewritten body',
      });

      expect(updated.id).toBeTruthy();
      expect(updated.id).not.toBe(original.id);
      expect(updated.oldId).toBe(original.id);
      expect(updated.oldDraftDeleted).toBe(true);

      const fetchedNew = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        updated.id,
        updated.mailbox,
      );
      expect(fetchedNew.email.attachments.map((a) => a.filename)).toEqual(['lease.pdf']);
      const newBody = fetchedNew.email.bodyText ?? fetchedNew.email.bodyHtml ?? '';
      expect(newBody).toMatch(/clean rewritten body/);
      expect(newBody).not.toMatch(/italic/);
    });

    it('drops attachments when attachments_keep is empty array', async () => {
      const buf = Buffer.from('removable');

      const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Drop me',
        body: 'body',
        attachments: [
          { contentBase64: buf.toString('base64'), filename: 'gone.txt', mimeType: 'text/plain' },
        ],
      });

      const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, original.id, {
        mailbox: original.mailbox,
        attachmentsKeep: [],
      });

      const fetched = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        updated.id,
        updated.mailbox,
      );
      expect(fetched.email.attachments).toEqual([]);
    });

    it('honors attachments_remove on a subset', async () => {
      const a = Buffer.from('aaa');
      const b = Buffer.from('bbb');
      const c = Buffer.from('ccc');

      const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Remove one',
        body: 'body',
        attachments: [
          { contentBase64: a.toString('base64'), filename: 'a.txt', mimeType: 'text/plain' },
          { contentBase64: b.toString('base64'), filename: 'b.txt', mimeType: 'text/plain' },
          { contentBase64: c.toString('base64'), filename: 'c.txt', mimeType: 'text/plain' },
        ],
      });

      const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, original.id, {
        mailbox: original.mailbox,
        attachmentsRemove: ['b.txt'],
      });

      const fetched = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        updated.id,
        updated.mailbox,
      );
      expect(fetched.email.attachments.map((a2) => a2.filename).sort()).toEqual(['a.txt', 'c.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // updateDraft — carry attachments from another message
  // ---------------------------------------------------------------------------

  describe('updateDraft carries attachments from another message', () => {
    it('moves attachments from a source draft into a target draft via message-reference', async () => {
      const pdf1 = Buffer.from('%PDF source one');
      const pdf2 = Buffer.from('%PDF source two');

      const source = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: [],
        subject: 'Source draft holding PDFs',
        body: 'PDFs to carry forward',
        attachments: [
          {
            contentBase64: pdf1.toString('base64'),
            filename: 'src-one.pdf',
            mimeType: 'application/pdf',
          },
          {
            contentBase64: pdf2.toString('base64'),
            filename: 'src-two.pdf',
            mimeType: 'application/pdf',
          },
        ],
      });

      const target = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['kentucky-dor@localhost'],
        subject: 'Clean rewrite',
        body: 'the clean version of the body',
      });

      const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, target.id, {
        mailbox: target.mailbox,
        attachmentsAdd: [
          {
            sourceEmailId: String(source.id),
            sourceMailbox: source.mailbox,
            filename: 'src-one.pdf',
          },
          {
            sourceEmailId: String(source.id),
            sourceMailbox: source.mailbox,
            filename: 'src-two.pdf',
          },
        ],
      });

      const fetched = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        updated.id,
        updated.mailbox,
      );
      expect(fetched.email.attachments.map((a) => a.filename).sort()).toEqual([
        'src-one.pdf',
        'src-two.pdf',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateDraft failure semantics
  // ---------------------------------------------------------------------------

  describe('updateDraft failure leaves the old draft intact', () => {
    it('does not delete the old draft when an attachments_add reference cannot be resolved', async () => {
      const buf = Buffer.from('original attachment');

      const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Survive failure',
        body: 'original body',
        attachments: [
          {
            contentBase64: buf.toString('base64'),
            filename: 'survivor.txt',
            mimeType: 'text/plain',
          },
        ],
      });

      await expect(
        services.imapService.updateDraft(TEST_ACCOUNT_NAME, original.id, {
          mailbox: original.mailbox,
          body: 'attempted rewrite',
          attachmentsAdd: [
            {
              sourceEmailId: '99999999',
              sourceMailbox: original.mailbox,
              filename: 'does-not-exist.pdf',
            },
          ],
        }),
      ).rejects.toThrow();

      // The original draft must still be intact, addressable by its old UID.
      const stillThere = await services.imapService.fetchDraft(
        TEST_ACCOUNT_NAME,
        original.id,
        original.mailbox,
      );
      expect(stillThere.email.subject).toBe('Survive failure');
      expect(stillThere.email.attachments.map((a) => a.filename)).toEqual(['survivor.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // updateDraft cid: warning surface
  // ---------------------------------------------------------------------------

  describe('updateDraft surfaces cid: warnings', () => {
    it('reports a warning when the new HTML body references cid: parts', async () => {
      const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: [],
        subject: 'HTML draft',
        body: '<p>original</p>',
        html: true,
      });

      const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, original.id, {
        mailbox: original.mailbox,
        html: true,
        body: '<p>new body with <img src="cid:logo@example"/> and <img src="cid:sig@example"/></p>',
      });

      expect(updated.warnings.some((w) => /cid:/i.test(w))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------

  describe('sendDraft', () => {
    it('should send a saved draft and remove it', async () => {
      // First save a draft
      const draft = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft to send',
        body: 'This draft will be sent.',
      });

      // Send the draft
      const result = await services.smtpService.sendDraft(
        TEST_ACCOUNT_NAME,
        draft.id,
        draft.mailbox,
      );

      expect(result.messageId).toBeTruthy();

      await waitForDelivery();
    });

    it('preserves attachments and strips Bcc in the Sent copy', async () => {
      // GreenMail does not auto-create a Sent folder; create it by the
      // canonical name so resolveSentFolder (and the sendDraft append path)
      // can find it.
      const sentFolder = 'Sent';
      try {
        await services.imapService.createMailbox(TEST_ACCOUNT_NAME, sentFolder);
      } catch {
        // Already exists, ignore.
      }

      const pdf = Buffer.from('%PDF-1.4 send-draft attachment bytes');
      const subject = `Draft w/ attachment ${Date.now()}`;

      // Save a draft WITH a base64 attachment AND a bcc recipient.
      const draft = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        bcc: ['secret@localhost'],
        subject,
        body: 'This draft carries an attachment and a blind copy.',
        attachments: [
          {
            contentBase64: pdf.toString('base64'),
            filename: 'sendme.pdf',
            mimeType: 'application/pdf',
          },
        ],
      });

      // Send it via the SmtpService.sendDraft path.
      const result = await services.smtpService.sendDraft(
        TEST_ACCOUNT_NAME,
        draft.id,
        draft.mailbox,
      );
      expect(result.messageId).toBeTruthy();

      await waitForDelivery();

      // Locate the message we just stored in Sent.
      const listed = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        mailbox: sentFolder,
        pageSize: 50,
        subject,
      });
      const match = listed.items.find((m) => m.subject === subject);
      expect(match, 'sent copy should exist in the Sent folder').toBeDefined();

      // Fetch the full Sent copy and assert attachment present + Bcc absent.
      const sent = await services.imapService.getEmail(
        TEST_ACCOUNT_NAME,
        String(match?.id),
        sentFolder,
      );

      // (a) The attachment survived (filename matches).
      expect(sent.attachments.map((a) => a.filename)).toContain('sendme.pdf');

      // (b) The Bcc header is NOT present in the Sent copy.
      expect(Object.keys(sent.headers ?? {})).not.toContain('bcc');
    });
  });
});
