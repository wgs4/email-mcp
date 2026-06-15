import type { TestServices } from './helpers/index.js';
import {
  buildSecondTestAccount,
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Send Operations', () => {
  let services: TestServices;
  const account = buildTestAccount();
  const account2 = buildSecondTestAccount();

  beforeAll(async () => {
    services = createTestServices(account, account2);
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------

  describe('sendEmail', () => {
    it('should send a plain text email', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Plain text test',
        body: 'Hello Bob, this is a test.',
      });

      expect(result).toBeDefined();
      expect(result.messageId).toBeTruthy();
    });

    it('should send an HTML email', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'HTML test',
        body: '<h1>Hello</h1><p>HTML email</p>',
        html: true,
      });

      expect(result.messageId).toBeTruthy();
    });

    it('should send with CC recipients', async () => {
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        cc: ['alice@localhost'],
        subject: 'CC test',
        body: 'Email with CC',
      });

      expect(result.messageId).toBeTruthy();
    });

    it('should deliver email to recipient inbox', async () => {
      await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Delivery verification test',
        body: 'This should appear in Bob inbox',
      });

      await waitForDelivery();

      const result = await services.imapService.listEmails('integration-2', {
        subject: 'Delivery verification test',
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });

    it('sends a base64 attachment + bcc: attachment delivered, Bcc header absent', async () => {
      // GreenMail does not auto-create a Sent folder — create it by the
      // canonical name so the appendToSent path can find it.
      const sentFolder = 'Sent';
      try {
        await services.imapService.createMailbox(TEST_ACCOUNT_NAME, sentFolder);
      } catch {
        // Already exists, ignore.
      }

      const pdf = Buffer.from('%PDF-1.4 send_email attachment bytes');
      const subject = `send_email w/ attachment ${Date.now()}`;

      // To = the sending account (test@localhost / `integration`); Bcc = the
      // SECOND test account (bob@localhost / `integration-2`). bob appears ONLY
      // in the Bcc — nowhere in To/Cc — and the harness owns an IMAP connection
      // for `integration-2`, so we can fetch bob's own INBOX and prove the blind
      // copy actually landed. (The previous version bcc'd alice@localhost, for
      // whom no account/IMAP connection exists, then fetched bob's mailbox — so
      // it never verified Bcc delivery at all.)
      const result = await services.smtpService.sendEmail(TEST_ACCOUNT_NAME, {
        to: ['test@localhost'],
        bcc: ['bob@localhost'],
        subject,
        body: 'This email carries an attachment and a blind copy.',
        attachments: await services.imapService.resolveAttachmentsForSend(TEST_ACCOUNT_NAME, [
          {
            contentBase64: pdf.toString('base64'),
            filename: 'sendme.pdf',
            mimeType: 'application/pdf',
          },
        ]),
      });
      expect(result.messageId).toBeTruthy();

      await waitForDelivery();

      // (1) The Bcc recipient (bob) actually RECEIVED the message. bob is only a
      //     blind recipient, so a non-empty hit in bob's own INBOX proves the
      //     Bcc address was carried in the SMTP envelope (RCPT TO) and delivered.
      //     If Bcc delivery were broken, bob's INBOX would be empty here.
      const bccInbox = await services.imapService.listEmails('integration-2', {
        mailbox: 'INBOX',
        pageSize: 50,
        subject,
      });
      const bccMatch = bccInbox.items.find((m) => m.subject === subject);
      expect(bccMatch, 'bcc recipient (bob) should have received the message').toBeDefined();

      // (1b) The copy DELIVERED to the Bcc recipient must not leak the `Bcc:`
      //      header either — blind recipients stay blind to each other.
      const delivered = await services.imapService.getEmail(
        'integration-2',
        String(bccMatch?.id),
        'INBOX',
      );
      expect(Object.keys(delivered.headers ?? {})).not.toContain('bcc');

      // (2) The Sent copy: attachment present, Bcc header absent.
      const listed = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        mailbox: sentFolder,
        pageSize: 50,
        subject,
      });
      const match = listed.items.find((m) => m.subject === subject);
      expect(match, 'sent copy should exist in the Sent folder').toBeDefined();

      const sent = await services.imapService.getEmail(
        TEST_ACCOUNT_NAME,
        String(match?.id),
        sentFolder,
      );
      expect(sent.attachments.map((a) => a.filename)).toContain('sendme.pdf');
      expect(Object.keys(sent.headers ?? {})).not.toContain('bcc');
    });
  });

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------

  describe('replyToEmail', () => {
    it('should reply to an email with proper threading', async () => {
      // Send original email from bob to test
      await services.smtpService.sendEmail('integration-2', {
        to: ['test@localhost'],
        subject: 'Reply test original',
        body: 'Please reply to this.',
      });

      await waitForDelivery();

      // Find the email in test's inbox
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Reply test original',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);

      const emailId = list.items[0].id;

      // Reply
      const reply = await services.smtpService.replyToEmail(TEST_ACCOUNT_NAME, {
        emailId,
        body: 'This is my reply.',
      });

      expect(reply.messageId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------

  describe('forwardEmail', () => {
    it('should forward an email to new recipients', async () => {
      // Send original
      await services.smtpService.sendEmail('integration-2', {
        to: ['test@localhost'],
        subject: 'Forward test original',
        body: 'Please forward this.',
      });

      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Forward test original',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);

      const emailId = list.items[0].id;

      // Forward
      const fwd = await services.smtpService.forwardEmail(TEST_ACCOUNT_NAME, {
        emailId,
        to: ['alice@localhost'],
        body: 'FYI, see below.',
      });

      expect(fwd.messageId).toBeTruthy();
    });
  });
});
