import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService, { stripBccHeader } from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(
  mockTransport: ReturnType<typeof createMockTransport>,
  accountOverrides: Record<string, unknown> = {},
) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      ...accountOverrides,
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    createEphemeralImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    subject: 'Original Subject',
    from: { name: 'Sender', address: 'sender@example.com' },
    to: [{ name: 'Test User', address: 'test@example.com' }],
    cc: [],
    bodyText: 'Original body',
    bodyHtml: undefined,
    messageId: '<original@example.com>',
    inReplyTo: undefined,
    references: [],
    date: '2025-01-01',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    attachments: [],
    headers: {},
    ...overrides,
  };
}

function createMockImapService() {
  return {
    appendToSent: vi.fn().mockResolvedValue(undefined),
    resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
    getEmail: vi.fn().mockResolvedValue(createMockEmail()),
  } as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imapService: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imapService = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imapService as unknown as ImapService);
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, imapService as unknown as ImapService);

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });

    it('calls appendToSent after successful send', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('Subject: Hello'),
      );
    });

    it('skips appendToSent for Gmail accounts', async () => {
      connections = createMockConnectionManager(transport, {
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });
      service = new SmtpService(connections, rateLimiter, imapService as unknown as ImapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).not.toHaveBeenCalled();
    });

    it('skips appendToSent when saveToSent is false', async () => {
      connections = createMockConnectionManager(transport, { saveToSent: false });
      service = new SmtpService(connections, rateLimiter, imapService as unknown as ImapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).not.toHaveBeenCalled();
    });

    it('does not throw when appendToSent fails', async () => {
      vi.mocked(imapService.appendToSent).mockRejectedValue(new Error('IMAP connection lost'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save to Sent folder'),
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });

    it('forces appendToSent for Gmail when gmailAutoSave is false', async () => {
      connections = createMockConnectionManager(transport, {
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
        gmailAutoSave: false,
      });
      service = new SmtpService(connections, rateLimiter, imapService as unknown as ImapService);

      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imapService.appendToSent).toHaveBeenCalled();
    });
  });

  describe('replyToEmail', () => {
    it('calls appendToSent after successful reply', async () => {
      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
      });

      expect(imapService.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, rawMsg]] = vi.mocked(imapService.appendToSent).mock.calls;
      expect((rawMsg as Buffer).toString()).toContain('Subject: Re: Original Subject');
    });

    // Regression: a raw-only sendMail({ raw }) gives nodemailer an empty SMTP
    // envelope ("No recipients defined"). The envelope must be passed explicitly
    // and must carry the original sender as a recipient.
    it('sends with an explicit, non-empty envelope addressed to the original sender', async () => {
      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.raw).toBeInstanceOf(Buffer);
      expect(call.envelope).toBeDefined();
      expect(call.envelope.from).toBe('test@example.com');
      expect(call.envelope.to).toEqual(['sender@example.com']);
    });

    it('includes To and Cc recipients (minus self) in the envelope on replyAll', async () => {
      imapService.getEmail = vi.fn().mockResolvedValue(
        createMockEmail({
          to: [
            { name: 'Test User', address: 'test@example.com' }, // us — must be dropped
            { name: 'Other', address: 'other@example.com' },
          ],
          cc: [{ name: 'CC One', address: 'cc1@example.com' }],
        }),
      );

      await service.replyToEmail('test', {
        emailId: '42',
        body: 'Reply body',
        replyAll: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.envelope.to).toEqual([
        'sender@example.com',
        'other@example.com',
        'cc1@example.com',
      ]);
      expect(call.envelope.to).not.toContain('test@example.com');
    });
  });

  describe('forwardEmail', () => {
    it('calls appendToSent after successful forward', async () => {
      await service.forwardEmail('test', {
        emailId: '42',
        to: ['forward@example.com'],
        body: 'FYI',
      });

      expect(imapService.appendToSent).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('Subject: Fwd: Original Subject'),
      );
    });
  });

  describe('sendDraft', () => {
    // A full MIME draft (multipart/mixed) carrying a Bcc header AND a PDF
    // attachment. send_draft must transmit these RAW bytes (minus the Bcc
    // header) so attachments survive — recomposing from the parsed Email loses
    // the binary parts.
    const ATTACHMENT_FILENAME = 'invoice.pdf';
    function buildRawDraftWithAttachmentAndBcc(): Buffer {
      const raw = [
        'From: "Test User" <test@example.com>',
        'To: recipient@example.com',
        'Cc: cc1@example.com',
        'Bcc: secret@example.com',
        'Subject: Draft Subject',
        'Message-ID: <draft@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="BOUNDARY42"',
        '',
        '--BOUNDARY42',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Draft body',
        '--BOUNDARY42',
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${ATTACHMENT_FILENAME}"`,
        '',
        Buffer.from('%PDF-1.4 fake invoice bytes').toString('base64'),
        '--BOUNDARY42--',
        '',
      ].join('\r\n');
      return Buffer.from(raw);
    }

    function createDraftMocks() {
      const mockDraft = {
        email: {
          id: '1',
          subject: 'Draft Subject',
          from: { address: 'test@example.com' },
          to: [{ address: 'recipient@example.com' }],
          cc: [{ address: 'cc1@example.com' }],
          bcc: [{ address: 'secret@example.com' }],
          bodyText: 'Draft body',
          bodyHtml: undefined,
          messageId: '<draft@example.com>',
          inReplyTo: undefined,
          references: [],
          date: '2025-01-01',
          seen: false,
          flagged: false,
          answered: false,
          hasAttachments: true,
          labels: [],
          attachments: [],
          headers: {},
        },
        mailbox: 'Drafts',
      };

      const rawDraft = buildRawDraftWithAttachmentAndBcc();

      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(mockDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;

      return { mockDraft, rawDraft, imapServiceWithDraft };
    }

    it('appends to Sent before deleting draft', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      // Verify order: appendToSent called before deleteDraft
      const appendCall = vi.mocked(imapServiceWithDraft.appendToSent).mock.invocationCallOrder[0];
      const deleteCall = vi.mocked(imapServiceWithDraft.deleteDraft).mock.invocationCallOrder[0];
      expect(appendCall).toBeLessThan(deleteCall);
    });

    it('sends the raw draft bytes (preserving the attachment) with an explicit envelope', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      const call = transport.sendMail.mock.calls[0][0];
      // Raw passthrough — not a recomposed text/html message.
      expect(call.raw).toBeInstanceOf(Buffer);
      const rawStr = (call.raw as Buffer).toString('utf-8');
      // The attachment part / filename must survive.
      expect(rawStr).toContain(ATTACHMENT_FILENAME);
      // The Bcc header must NOT leak into the transmitted message.
      expect(rawStr).not.toMatch(/^Bcc:/im);
      // Envelope is explicit and includes To + Cc + Bcc recipients.
      expect(call.envelope).toBeDefined();
      expect(call.envelope.from).toBe('test@example.com');
      expect(call.envelope.to).toEqual([
        'recipient@example.com',
        'cc1@example.com',
        'secret@example.com',
      ]);
    });

    it('appends the SAME sanitized raw bytes to Sent (attachment kept, Bcc stripped)', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      expect(imapServiceWithDraft.appendToSent).toHaveBeenCalledWith('test', expect.any(Buffer));
      const [[, appended]] = vi.mocked(imapServiceWithDraft.appendToSent).mock.calls;
      const appendedStr = (appended as Buffer).toString('utf-8');
      expect(appendedStr).toContain(ATTACHMENT_FILENAME);
      expect(appendedStr).not.toMatch(/^Bcc:/im);

      // The bytes sent and the bytes stored must be identical.
      const sent = transport.sendMail.mock.calls[0][0].raw as Buffer;
      expect((appended as Buffer).equals(sent)).toBe(true);
    });

    it('throws before calling SMTP when the draft has no recipients', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const noRecipientDraft = {
        ...mockDraft,
        email: { ...mockDraft.email, to: [], cc: [], bcc: [] },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(noRecipientDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await expect(service.sendDraft('test', 1)).rejects.toThrow(/no recipients/i);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('de-dupes the envelope recipients case-insensitively (To + Cc + case-variant → one RCPT)', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const dupDraft = {
        ...mockDraft,
        email: {
          ...mockDraft.email,
          // Same address in To and Cc, plus a case-variant — must collapse to ONE.
          to: [{ address: 'dup@example.com' }, { address: 'other@example.com' }],
          cc: [{ address: 'DUP@example.com' }],
          bcc: [],
        },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(dupDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      const call = transport.sendMail.mock.calls[0][0];
      // First-seen order preserved, original casing of the first occurrence kept.
      expect(call.envelope.to).toEqual(['dup@example.com', 'other@example.com']);
    });

    it('throws (before SMTP) when the only recipient is a blank address', async () => {
      const { mockDraft, rawDraft } = createDraftMocks();
      const blankDraft = {
        ...mockDraft,
        email: {
          ...mockDraft.email,
          // A parsed-but-empty address must NOT count as a recipient.
          to: [{ address: '' }],
          cc: [{ address: '   ' }],
          bcc: [],
        },
      };
      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(blankDraft),
        fetchDraftRaw: vi.fn().mockResolvedValue(rawDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await expect(service.sendDraft('test', 1)).rejects.toThrow(/no recipients/i);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('still deletes draft when appendToSent fails', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      vi.mocked(imapServiceWithDraft.appendToSent).mockRejectedValue(new Error('IMAP error'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      // appendToSentFolder swallows errors, so deleteDraft should still be called
      expect(imapServiceWithDraft.deleteDraft).toHaveBeenCalledWith('test', 1, 'Drafts');
      warnSpy.mockRestore();
    });
  });

  describe('stripBccHeader', () => {
    it('removes a simple Bcc header', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/^Bcc:/im);
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('removes a folded Bcc header including its continuation lines', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'Bcc: one@example.com,',
          '\ttwo@example.com,',
          ' three@example.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/bcc/i);
      expect(out).not.toContain('two@example.com');
      expect(out).not.toContain('three@example.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('is a no-op when there is no Bcc header', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Subject: Hi', '', 'Body line one', 'Body line two'].join('\r\n'),
      );
      const out = stripBccHeader(raw);
      expect(out.equals(raw)).toBe(true);
    });

    it('does not disturb other headers or the body', () => {
      const raw = Buffer.from(
        [
          'From: f@example.com',
          'To: a@example.com',
          'Bcc: secret@example.com',
          'Cc: c@example.com',
          'Subject: Keep me',
          'Content-Type: text/plain',
          '',
          'Bcc: this is body text, not a header — keep it',
          'second body line',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).toContain('From: f@example.com');
      expect(out).toContain('Cc: c@example.com');
      expect(out).toContain('Subject: Keep me');
      expect(out).toContain('Content-Type: text/plain');
      // Header Bcc gone…
      expect(out).not.toMatch(/^Bcc: secret@example\.com/im);
      // …but the body line that happens to start with "Bcc:" is preserved.
      expect(out).toContain('Bcc: this is body text, not a header — keep it');
      expect(out).toContain('second body line');
    });

    it('handles both CRLF and LF line endings', () => {
      const crlf = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const lf = Buffer.from(
        ['To: a@example.com', 'Bcc: secret@example.com', 'Subject: Hi', '', 'Body'].join('\n'),
      );

      const crlfOut = stripBccHeader(crlf).toString('utf-8');
      const lfOut = stripBccHeader(lf).toString('utf-8');

      expect(crlfOut).not.toMatch(/^Bcc:/im);
      expect(lfOut).not.toMatch(/^Bcc:/im);
      // Original line endings preserved.
      expect(crlfOut).toContain('\r\n');
      expect(lfOut).not.toContain('\r\n');
      expect(lfOut).toContain('To: a@example.com\nSubject: Hi');
    });

    it('removes a Resent-Bcc header (RFC 5322 blind-recipient leak)', () => {
      const raw = Buffer.from(
        ['To: a@example.com', 'Resent-Bcc: secret@x.com', 'Subject: Hi', '', 'Body'].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/^Resent-Bcc:/im);
      expect(out).not.toContain('secret@x.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('removes a folded Resent-Bcc header including its continuation lines', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'Resent-Bcc: one@x.com,',
          '\ttwo@x.com,',
          ' three@x.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      expect(out).not.toMatch(/resent-bcc/i);
      expect(out).not.toContain('one@x.com');
      expect(out).not.toContain('two@x.com');
      expect(out).not.toContain('three@x.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('does NOT strip unrelated headers like X-Original-Bcc', () => {
      const raw = Buffer.from(
        [
          'To: a@example.com',
          'X-Original-Bcc: archived@example.com',
          'Subject: Hi',
          '',
          'Body',
        ].join('\r\n'),
      );
      const out = stripBccHeader(raw).toString('utf-8');
      // The X-Original-Bcc header (not a real Bcc) must be retained verbatim.
      expect(out).toContain('X-Original-Bcc: archived@example.com');
      expect(out).toContain('To: a@example.com');
      expect(out).toContain('Subject: Hi');
      expect(out).toContain('Body');
    });

    it('returns the buffer unchanged when there is no header/body separator', () => {
      // A degenerate message with NO blank-line boundary. A later line happens
      // to start with "Bcc:" — but without a boundary we must NOT treat the
      // whole thing as headers and delete body content. Return byte-identical.
      const raw = Buffer.from(
        ['To: a@example.com', 'Subject: Hi', 'Bcc: looks-like-a-header@example.com'].join('\r\n'),
      );
      const out = stripBccHeader(raw);
      expect(out.equals(raw)).toBe(true);
    });
  });
});
