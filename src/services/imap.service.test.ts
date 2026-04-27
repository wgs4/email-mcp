/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
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
    append: vi.fn().mockResolvedValue({ uid: 42 }),
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
  // resolveSentFolder
  // -----------------------------------------------------------------------

  describe('resolveSentFolder', () => {
    it('returns account config sentFolder override when set', async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'test@example.com',
        username: 'test@example.com',
        sentFolder: 'My Sent',
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });

      const result = await service.resolveSentFolder('test');

      expect(result).toBe('My Sent');
      // Should not call client.list() when override is set
      expect(client.list).not.toHaveBeenCalled();
    });

    it('finds Sent folder via SPECIAL-USE attribute', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent Messages', path: 'Sent Messages', specialUse: '\\Sent' },
      ]);

      const result = await service.resolveSentFolder('test');

      expect(result).toBe('Sent Messages');
    });

    it('falls back to common folder names', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent Items', path: 'Sent Items' },
      ]);

      const result = await service.resolveSentFolder('test');

      expect(result).toBe('Sent Items');
    });

    it('throws when no Sent folder can be resolved', async () => {
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await expect(service.resolveSentFolder('test')).rejects.toThrow(
        'Cannot resolve Sent folder for "test"',
      );
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
  // appendToSent
  // -----------------------------------------------------------------------

  describe('appendToSent', () => {
    it('appends message to resolved Sent folder with \\Seen flag', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent', specialUse: '\\Sent' }]);

      const rawMessage = 'From: test@example.com\r\nTo: a@b.com\r\n\r\nHello';

      await service.appendToSent('test', rawMessage);

      expect(client.append).toHaveBeenCalledWith('Sent', Buffer.from(rawMessage), ['\\Seen']);
    });

    it('uses custom flags when provided', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent', specialUse: '\\Sent' }]);

      await service.appendToSent('test', 'raw msg', ['\\Seen', '\\Flagged']);

      expect(client.append).toHaveBeenCalledWith('Sent', Buffer.from('raw msg'), [
        '\\Seen',
        '\\Flagged',
      ]);
    });

    it('retries append after creating mailbox on TRYCREATE error', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent', specialUse: '\\Sent' }]);
      client.append
        .mockRejectedValueOnce(new Error('[TRYCREATE] Mailbox does not exist'))
        .mockResolvedValueOnce({ uid: 42 });
      (client as Record<string, unknown>).mailboxCreate = vi.fn().mockResolvedValue({});

      await service.appendToSent('test', 'raw msg');

      expect((client as Record<string, unknown>).mailboxCreate).toHaveBeenCalledWith('Sent');
      expect(client.append).toHaveBeenCalledTimes(2);
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

    // -------------------------------------------------------------------------
    // Auto-remap via SPECIAL-USE (Phase 3 follow-on)
    // -------------------------------------------------------------------------

    it('auto-remaps mailbox per account via SPECIAL-USE flags and emits ℹ️ notice', async () => {
      // Account A has INBOX.Archive literally; account B only has
      // [Gmail]/All Mail with the \All flag. Fan-out with mailbox=INBOX.Archive
      // should search both: A on INBOX.Archive, B on [Gmail]/All Mail, with a
      // remap notice for B.
      const clientA = createMockImapClient();
      const clientB = createMockImapClient();
      clientA.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Archive', path: 'INBOX.Archive', specialUse: '\\Archive' },
      ]);
      clientB.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]);

      clientA.search.mockResolvedValue([10]);
      clientB.search.mockResolvedValue([20]);
      clientA.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(10, 'A archive hit', '2024-05-01T00:00:00Z', 'a@example.com')]),
      );
      clientB.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(20, 'B all-mail hit', '2024-06-01T00:00:00Z', 'b@example.com')]),
      );

      const localConnections = {
        getAccount: vi.fn().mockImplementation((name: string) => ({
          name,
          email: `${name}@example.com`,
          username: name,
          imap: {
            host: 'imap.example.com',
            port: 993,
            tls: true,
            starttls: false,
            verifySsl: true,
          },
          smtp: {
            host: 'smtp.example.com',
            port: 465,
            tls: true,
            starttls: false,
            verifySsl: true,
          },
        })),
        getAccountNames: vi.fn().mockReturnValue(['account-a', 'account-b']),
        getImapClient: vi.fn().mockImplementation(async (name: string) => {
          if (name === 'account-a') return clientA;
          if (name === 'account-b') return clientB;
          throw new Error(`unknown account ${name}`);
        }),
        getSmtpTransport: vi.fn(),
        closeAll: vi.fn(),
      } satisfies IConnectionManager;

      const localService = new ImapService(localConnections);
      const result = await localService.searchAcrossAccounts(['account-a', 'account-b'], '', {
        mailbox: 'INBOX.Archive',
        pageSize: 10,
      });

      // Both accounts participated; their items merged (B sorts ahead of A by date).
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.account)).toEqual(['account-b', 'account-a']);

      // Remap notice surfaces on the ℹ️-prefixed channel inside warnings[].
      expect(result.warnings).toBeDefined();
      const notice = result.warnings?.find((w) => w.account === 'account-b');
      expect(notice).toBeDefined();
      expect(notice?.error).toMatch(/^ℹ️/);
      expect(notice?.error).toMatch(/Remapped "INBOX\.Archive" → "\[Gmail\]\/All Mail"/);
      expect(notice?.error).toMatch(/\\All/);

      // Account A was a literal match — no notice for it.
      expect(result.warnings?.find((w) => w.account === 'account-a')).toBeUndefined();
    });

    it('skips accounts with no literal match AND no SPECIAL-USE equivalent', async () => {
      // Account A: no match at all (has only INBOX). Account B: real \All match.
      const clientA = createMockImapClient();
      const clientB = createMockImapClient();
      clientA.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);
      clientB.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]);

      clientB.search.mockResolvedValue([7]);
      clientB.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(7, 'B hit', '2024-07-01T00:00:00Z', 'b@example.com')]),
      );

      const localConnections = {
        getAccount: vi.fn().mockImplementation((name: string) => ({
          name,
          email: `${name}@example.com`,
          username: name,
          imap: {
            host: 'imap.example.com',
            port: 993,
            tls: true,
            starttls: false,
            verifySsl: true,
          },
          smtp: {
            host: 'smtp.example.com',
            port: 465,
            tls: true,
            starttls: false,
            verifySsl: true,
          },
        })),
        getAccountNames: vi.fn().mockReturnValue(['account-a', 'account-b']),
        getImapClient: vi.fn().mockImplementation(async (name: string) => {
          if (name === 'account-a') return clientA;
          if (name === 'account-b') return clientB;
          throw new Error(`unknown account ${name}`);
        }),
        getSmtpTransport: vi.fn(),
        closeAll: vi.fn(),
      } satisfies IConnectionManager;

      const localService = new ImapService(localConnections);
      const result = await localService.searchAcrossAccounts(['account-a', 'account-b'], '', {
        mailbox: 'INBOX.Archive',
        pageSize: 10,
      });

      // Only account B's item surfaces.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].account).toBe('account-b');

      // Account A appears in warnings[] with a hard-skip message (no ℹ️ prefix).
      expect(result.warnings).toBeDefined();
      const skip = result.warnings?.find((w) => w.account === 'account-a');
      expect(skip).toBeDefined();
      expect(skip?.error).not.toMatch(/^ℹ️/);
      expect(skip?.error).toMatch(/not found on this account/);
    });

    it('skips remap preflight entirely when mailbox is INBOX', async () => {
      // With mailbox=INBOX, the preflight is short-circuited — client.list()
      // should not be called as part of remap resolution. (searchEmails'
      // own internal paths may list; the key signal is that no remap notice
      // appears and no preflight warning leaks through.)
      client.search.mockResolvedValue([1]);
      client.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(1, 'x', '2024-01-01T00:00:00Z', 'x@example.com')]),
      );
      const result = await service.searchAcrossAccounts(['account-a'], '', {
        mailbox: 'INBOX',
        pageSize: 10,
      });
      // No ℹ️-prefixed remap notices should exist — the preflight never ran.
      expect(result.warnings?.some((w) => w.error.startsWith('ℹ️')) ?? false).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // saveAttachmentToDisk — direct-to-disk, no base64 hop (PR 4)
  // -----------------------------------------------------------------------

  describe('saveAttachmentToDisk', () => {
    // Minimal bodyStructure with one attachment part — mirrors the shape
    // imapflow produces.
    const attachmentBodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', size: 50 },
        {
          type: 'application/pdf',
          size: 2048,
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'lease.pdf' },
        },
      ],
    };

    async function* asyncFrom(chunks: Buffer[]): AsyncGenerator<Buffer> {
      for (const c of chunks) yield c;
    }

    // Set up the client mock used by every case below.
    function primeClientForDownload(
      tmpClient: ReturnType<typeof createMockImapClient>,
      payload = Buffer.from('PDF-BYTES'),
    ) {
      const withMethods = tmpClient as unknown as {
        fetchOne: ReturnType<typeof vi.fn>;
        download: ReturnType<typeof vi.fn>;
      };
      withMethods.fetchOne = vi.fn().mockResolvedValue({
        uid: 42,
        bodyStructure: attachmentBodyStructure,
      });
      withMethods.download = vi.fn().mockResolvedValue({
        content: asyncFrom([payload]),
      });
    }

    it('writes an attachment to a tmp-dir path and returns {path, size, mimeType}', async () => {
      const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tmp = mkdtempSync(join(tmpdir(), 'save-att-'));
      try {
        primeClientForDownload(client, Buffer.from('PDF-PAYLOAD'));

        const result = await service.saveAttachmentToDisk(
          'test',
          '42',
          'INBOX',
          'lease.pdf',
          tmp, // directory — filename is appended
        );

        expect(result.path).toBe(join(tmp, 'lease.pdf'));
        expect(result.mimeType).toBe('application/pdf');
        expect(result.size).toBe('PDF-PAYLOAD'.length);
        expect(readFileSync(result.path, 'utf-8')).toBe('PDF-PAYLOAD');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('auto-suffixes when target exists and overwrite=false', async () => {
      const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tmp = mkdtempSync(join(tmpdir(), 'save-att-'));
      try {
        // Pre-seed a conflict
        writeFileSync(join(tmp, 'lease.pdf'), 'EXISTING');
        primeClientForDownload(client, Buffer.from('NEW-BYTES'));

        const result = await service.saveAttachmentToDisk('test', '42', 'INBOX', 'lease.pdf', tmp);

        expect(result.path).toBe(join(tmp, 'lease-1.pdf'));
        expect(readFileSync(join(tmp, 'lease.pdf'), 'utf-8')).toBe('EXISTING');
        expect(readFileSync(result.path, 'utf-8')).toBe('NEW-BYTES');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('rejects /etc/passwd-style destinations outside $HOME and /tmp', async () => {
      primeClientForDownload(client);
      await expect(
        service.saveAttachmentToDisk('test', '42', 'INBOX', 'lease.pdf', '/etc/passwd'),
      ).rejects.toThrow(/outside the user's home directory/);
    });

    it('rejects destinations containing `..` traversal', async () => {
      primeClientForDownload(client);
      // Literal `..` segment kept in the string (not normalized by path.join).
      // Even when the resolved path would end up inside a safe dir, we reject
      // on the raw `..` segment first.
      await expect(
        service.saveAttachmentToDisk(
          'test',
          '42',
          'INBOX',
          'lease.pdf',
          '/Users/someone/Downloads/../../../etc/evil.pdf',
        ),
      ).rejects.toThrow(/must not contain ".." traversal segments/);
    });

    it('rejects non-absolute paths', async () => {
      primeClientForDownload(client);
      await expect(
        service.saveAttachmentToDisk('test', '42', 'INBOX', 'lease.pdf', 'relative/path.pdf'),
      ).rejects.toThrow(/absolute path/);
    });

    it('throws when the attachment filename is not found on the email', async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tmp = mkdtempSync(join(tmpdir(), 'save-att-'));
      try {
        primeClientForDownload(client);
        await expect(
          service.saveAttachmentToDisk('test', '42', 'INBOX', 'not-there.pdf', tmp),
        ).rejects.toThrow(/Attachment "not-there.pdf" not found/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
