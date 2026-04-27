import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

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

      expect(imapService.appendToSent).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('Subject: Re: Original Subject'),
      );
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
    function createDraftMocks() {
      const mockDraft = {
        email: {
          id: '1',
          subject: 'Draft Subject',
          from: { address: 'test@example.com' },
          to: [{ address: 'recipient@example.com' }],
          cc: [],
          bodyText: 'Draft body',
          bodyHtml: undefined,
          messageId: '<draft@example.com>',
          inReplyTo: undefined,
          references: [],
          date: '2025-01-01',
          seen: false,
          flagged: false,
          answered: false,
          hasAttachments: false,
          labels: [],
          attachments: [],
          headers: {},
        },
        mailbox: 'Drafts',
      };

      const imapServiceWithDraft = {
        appendToSent: vi.fn().mockResolvedValue(undefined),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        getEmail: vi.fn().mockResolvedValue(createMockEmail()),
        fetchDraft: vi.fn().mockResolvedValue(mockDraft),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImapService;

      return { mockDraft, imapServiceWithDraft };
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

    it('calls appendToSent with draft content', async () => {
      const { imapServiceWithDraft } = createDraftMocks();
      service = new SmtpService(connections, rateLimiter, imapServiceWithDraft);

      await service.sendDraft('test', 1);

      expect(imapServiceWithDraft.appendToSent).toHaveBeenCalledWith(
        'test',
        expect.stringContaining('Subject: Draft Subject'),
      );
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
});
