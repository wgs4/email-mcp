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

  // -----------------------------------------------------------------------
  // searchAcrossAccounts — Power Search Phase D
  // -----------------------------------------------------------------------

  describe('searchAcrossAccounts (cross-account fan-out)', () => {
    function makeMessage(uid: number, subject: string, dateISO: string, fromAddr: string) {
      return {
        uid,
        envelope: { subject, from: [{ address: fromAddr }], to: [], date: dateISO },
        flags: new Set<string>(),
        bodyStructure: { type: 'text', subtype: 'plain' },
        source: Buffer.from(''),
      };
    }

    /** Build an async-iterable that yields the given messages, avoiding IIFEs. */
    async function* makeAsyncGen<T>(items: T[]): AsyncGenerator<T> {
      for (const item of items) yield item;
    }

    it('merges results from two accounts, stamps .account, sorts by date desc', async () => {
      // Two accounts → two underlying searches. `searchEmails` acquires a lock
      // per account; in our mock all accounts share the same fake client, so
      // the two fan-out calls queue sequentially (each UID set is queued up).
      client.search
        .mockResolvedValueOnce([10, 11]) // account-a uids
        .mockResolvedValueOnce([20, 21]); // account-b uids

      client.fetch
        .mockReturnValueOnce(
          makeAsyncGen([
            makeMessage(11, 'A2', '2024-01-05T00:00:00Z', 'a2@example.com'),
            makeMessage(10, 'A1', '2024-01-01T00:00:00Z', 'a1@example.com'),
          ]),
        )
        .mockReturnValueOnce(
          makeAsyncGen([
            makeMessage(21, 'B2', '2024-01-10T00:00:00Z', 'b2@example.com'),
            makeMessage(20, 'B1', '2024-01-03T00:00:00Z', 'b1@example.com'),
          ]),
        );

      connections.getAccount.mockImplementation((name: string) => ({
        name,
        email: `${name}@example.com`,
        username: name,
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      }));

      const result = await service.searchAcrossAccounts(['account-a', 'account-b'], '', {
        pageSize: 10,
      });

      // 4 items merged — two from each account
      expect(result.items).toHaveLength(4);

      // Date-desc order: B2 (Jan 10) > A2 (Jan 5) > B1 (Jan 3) > A1 (Jan 1)
      expect(result.items.map((i) => i.subject)).toEqual(['B2', 'A2', 'B1', 'A1']);

      // Each item must carry the originating account name.
      expect(result.items[0].account).toBe('account-b');
      expect(result.items[1].account).toBe('account-a');
      expect(result.items[2].account).toBe('account-b');
      expect(result.items[3].account).toBe('account-a');

      // Total is the sum of per-account totals (2 + 2).
      expect(result.total).toBe(4);

      // No partial-failure warnings expected.
      expect(result.warnings).toBeUndefined();
    });

    it('surfaces partial-success warnings when one account fails', async () => {
      // account-a succeeds with one message; account-b rejects on the first
      // IMAP call. `searchEmails` acquires a lock BEFORE searching so the
      // second (failing) account's getMailboxLock is what we need to fail.
      client.search.mockResolvedValueOnce([1]);
      client.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(1, 'Only A', '2024-02-01T00:00:00Z', 'a@example.com')]),
      );

      let call = 0;
      client.getMailboxLock.mockImplementation(async () => {
        call += 1;
        if (call === 2) {
          throw new Error('authentication timeout');
        }
        return { release: vi.fn() };
      });

      const result = await service.searchAcrossAccounts(['account-a', 'account-b'], '', {
        pageSize: 10,
      });

      // Partial success — only account-a's item should surface.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].account).toBe('account-a');

      // The failing account must appear in warnings[] with its error.
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0].account).toBe('account-b');
      expect(result.warnings?.[0].error).toMatch(/authentication timeout/);

      // Human-readable warning summary should mention the failed account.
      expect(result.warning).toMatch(/account-b/);
    });

    it('throws when every account fails', async () => {
      client.getMailboxLock.mockRejectedValue(new Error('boom'));

      await expect(service.searchAcrossAccounts(['a', 'b'], '', { pageSize: 5 })).rejects.toThrow(
        /All 2 accounts failed/,
      );
    });

    it('unions facets across accounts and re-keys mailbox facet by account', async () => {
      // Both fan-out searchEmails calls run concurrently through the same
      // shared mock client, so we can't rely on fetch call order. Instead,
      // route fetch results based on the UID string requested so each account
      // gets the expected messages regardless of interleaving.
      client.search.mockResolvedValueOnce([100]).mockResolvedValueOnce([200]);

      client.fetch.mockImplementation((range: string) => {
        // Account A's UID = 100, account B's UID = 200. Every fetch for a
        // given account (page body + facet envelope) hits the same range
        // string, so we can route on that. Use mid-year dates so the
        // year-bucket math doesn't depend on the local timezone.
        if (range === '100') {
          return makeAsyncGen([makeMessage(100, 'A', '2024-06-15T12:00:00Z', 'x@a.example')]);
        }
        if (range === '200') {
          return makeAsyncGen([makeMessage(200, 'B', '2023-06-15T12:00:00Z', 'y@b.example')]);
        }
        return makeAsyncGen<ReturnType<typeof makeMessage>>([]);
      });

      const result = await service.searchAcrossAccounts(['acc-a', 'acc-b'], '', {
        pageSize: 10,
        facets: ['sender', 'year', 'mailbox'],
      });

      // Sender facet is a union of both accounts' sender buckets.
      expect(result.facets?.sender).toEqual({
        'x@a.example': 1,
        'y@b.example': 1,
      });

      // Year facet union.
      expect(result.facets?.year).toEqual({
        2024: 1,
        2023: 1,
      });

      // Mailbox facet is re-keyed by account name, not by the single 'INBOX'.
      expect(result.facets?.mailbox).toEqual({
        'acc-a': 1,
        'acc-b': 1,
      });
    });

    it('throws when accountNames is empty', async () => {
      await expect(service.searchAcrossAccounts([], '', {})).rejects.toThrow(
        /at least one account/,
      );
    });
  });
});
