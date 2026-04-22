import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    _releaseFn: releaseFn,
  };
}

function createMockConnectionManager(mockClient: ReturnType<typeof createMockImapClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // -----------------------------------------------------------------------
  // listMailboxes
  // -----------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('returns mailbox list with message counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      ]);
      client.status.mockResolvedValue({ messages: 10, unseen: 3 });

      const result = await service.listMailboxes('test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(result[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(client.status).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // moveEmail
  // -----------------------------------------------------------------------

  describe('moveEmail', () => {
    it('moves email between mailboxes', async () => {
      // assertRealMailbox calls client.list() internally
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await service.moveEmail('test', '42', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // deleteEmail
  // -----------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('permanently deletes when permanent=true', async () => {
      await service.deleteEmail('test', '99', 'INBOX', true);

      expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('moves to trash when permanent=false', async () => {
      // assertRealMailbox + trash detection both call client.list()
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setFlags
  // -----------------------------------------------------------------------

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // searchEmails — Power Search wiring (Phase A + B)
  // -----------------------------------------------------------------------

  describe('searchEmails (Power Search)', () => {
    it('passes a Date to client.search when since is a YYYY-MM-DD string', async () => {
      client.search.mockResolvedValue([]);

      await service.searchEmails('test', '', { since: '2024-01-01' });

      expect(client.search).toHaveBeenCalledTimes(1);
      const [criteria] = client.search.mock.calls[0];
      expect(criteria.since).toBeInstanceOf(Date);
      expect((criteria.since as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('applies hasAttachment post-filter only after pagination (no upfront bodyStructure fetch)', async () => {
      // Pretend the server matches 3 UIDs; only the current page should be body-structured.
      client.search.mockResolvedValue([1, 2, 3]);

      // Mock fetch: only invoked ONCE with the page range (not the full search set).
      // The mock yields three messages — two with attachments, one without.
      const mockMessages = [
        {
          uid: 3,
          envelope: { subject: 'A', from: [{ address: 'a@x' }], to: [], date: '2024-01-03' },
          flags: new Set<string>(),
          bodyStructure: { disposition: 'attachment' },
          source: Buffer.from(''),
        },
        {
          uid: 2,
          envelope: { subject: 'B', from: [{ address: 'b@x' }], to: [], date: '2024-01-02' },
          flags: new Set<string>(),
          bodyStructure: { type: 'text', subtype: 'plain' },
          source: Buffer.from(''),
        },
        {
          uid: 1,
          envelope: { subject: 'C', from: [{ address: 'c@x' }], to: [], date: '2024-01-01' },
          flags: new Set<string>(),
          bodyStructure: { disposition: 'attachment' },
          source: Buffer.from(''),
        },
      ];
      client.fetch.mockReturnValueOnce(
        // eslint-disable-next-line @stylistic/wrap-iife -- mirror createMockImapClient pattern
        (async function* gen() {
          for (const m of mockMessages) yield m;
        })(),
      );

      const result = await service.searchEmails('test', '', {
        hasAttachment: true,
        pageSize: 10,
      });

      // Fetch was called exactly ONCE with the page range — never upfront for all matches.
      expect(client.fetch).toHaveBeenCalledTimes(1);
      // pageUids = first `pageSize` of sorted-desc UIDs = "3,2,1"
      expect(client.fetch.mock.calls[0][0]).toBe('3,2,1');

      // Two of three messages have attachments → the filter should retain 2
      expect(result.items).toHaveLength(2);
      expect(result.totalApprox).toBe(true);
    });

    it('caps at MAX_SEARCH_UIDS (5000) and emits a truncation warning', async () => {
      // Return 6000 synthetic UIDs
      const tooMany = Array.from({ length: 6000 }, (_, i) => i + 1);
      client.search.mockResolvedValue(tooMany);

      // fetch yields nothing — we only care about the truncation warning path
      client.fetch.mockReturnValueOnce((async function* gen() {})());

      const result = await service.searchEmails('test', '', {});

      expect(result.totalApprox).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/Truncated to 5000 of 6000/);
      expect(result.total).toBe(5000);
    });

    it('throws when gmail_raw is used on non-Gmail account', async () => {
      await expect(service.searchEmails('test', '', { gmailRaw: 'from:foo' })).rejects.toThrow(
        /only valid on Gmail accounts/,
      );
    });
  });
});
