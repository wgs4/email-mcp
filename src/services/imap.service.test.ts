/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import type { IConnectionManager } from '../connections/types.js';
import { applyBodyFormat } from '../utils/body-format.js';
import ImapService from './imap.service.js';
import { SearchFailedError } from './search-status.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    // imapflow sets `mailbox` to the selected-folder object after a lock;
    // `.exists` = message count (R5/R8 read it FREE under the lock). Default
    // small so existing tests are never "at-risk" (shared path unchanged).
    mailbox: { exists: 5 },
    // imapflow exposes capabilities as a Map post-connect. Empty = no FTS.
    capabilities: new Map<string, boolean>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    // `fetchOne`/`download` default to null (not absent). Absent methods
    // throw "is not a function" which the OLD silent `catch {}` in
    // messageToEmail swallowed — making a missing mock a false-positive
    // green test. A null default makes "not primed" an explicit, visible
    // outcome instead.
    fetchOne: vi.fn().mockResolvedValue(null),
    download: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    append: vi.fn().mockResolvedValue({ uid: 42 }),
    close: vi.fn(),
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
    // Default ephemeral = same mock client; PR-2 tests override per-case to
    // assert the bounded-wait / close-on-timeout / no-poisoning behavior.
    createEphemeralImapClient: vi.fn().mockResolvedValue(mockClient),
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
  // search false-negatives — R1: a failed SEARCH must never be a silent zero
  // -----------------------------------------------------------------------

  describe('search false-negatives (R1 — failed search ≠ clean zero)', () => {
    it('searchEmails: client.search → false is flagged searchFailed, not a clean total:0', async () => {
      // imapflow collapses a server NO / swallowed socket-timeout / local
      // command failure all into `false` (never a reject). The pre-fix code
      // did `Array.isArray(false) ? r : []` → a clean, indistinguishable zero.
      client.search.mockResolvedValueOnce(false as unknown as number[]);

      const result = await service.searchEmails('test', 'Order #29804', {});

      expect(result.searchFailed).toBe(true);
      expect(result.searchStatus?.kind).toBe('search_failed');
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      // Must be distinguishable from a genuine empty match — a warning surfaces.
      expect(result.warning).toBeDefined();
    });

    it('searchEmails: a genuine empty match ([]) is NOT flagged as failed', async () => {
      client.search.mockResolvedValueOnce([]);

      const result = await service.searchEmails('test', 'nothing-matches', {});

      expect(result.searchFailed).toBeUndefined();
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('searchEmails: a rejected client.search is classified connection_error (AC1)', async () => {
      client.search.mockRejectedValueOnce(new Error('socket hang up'));

      const result = await service.searchEmails('test', 'anything', {});

      expect(result.searchFailed).toBe(true);
      expect(result.searchStatus?.kind).toBe('connection_error');
      expect(result.searchStatus?.message).toMatch(/socket hang up/);
      expect(result.total).toBe(0);
    });

    it('listEmails: client.search → false is flagged searchFailed, not a clean zero', async () => {
      client.search.mockResolvedValueOnce(false as unknown as number[]);

      const result = await service.listEmails('test', { pageSize: 10 });

      expect(result.searchFailed).toBe(true);
      expect(result.searchStatus?.kind).toBe('search_failed');
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.warning).toBeDefined();
    });

    it('extractContacts: a failed search throws SearchFailedError (batch UX, no carrier)', async () => {
      client.search.mockResolvedValueOnce(false as unknown as number[]);

      const err = await service.extractContacts('test', {}).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SearchFailedError);
      expect((err as SearchFailedError).status.kind).toBe('search_failed');
    });

    it('extractContacts: a genuine empty mailbox still returns [] (not flagged)', async () => {
      client.search.mockResolvedValueOnce([]);

      await expect(service.extractContacts('test', {})).resolves.toEqual([]);
    });

    it('searchForExport: a failed search throws SearchFailedError (D2 REFINED — isError UX)', async () => {
      client.search.mockResolvedValueOnce(false as unknown as number[]);

      const err = await service
        .searchForExport(null, 'test', '', { maxRows: 100 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SearchFailedError);
      expect((err as SearchFailedError).status.kind).toBe('search_failed');
    });

    it('searchForExport: a genuine empty match still returns { items: [], truncated: false }', async () => {
      client.search.mockResolvedValueOnce([]);

      await expect(service.searchForExport(null, 'test', '', { maxRows: 100 })).resolves.toEqual({
        items: [],
        truncated: false,
      });
    });

    // AC5 — MANDATORY REGRESSION RULE. The R1 refactor edits the same lines as
    // the MAX_SEARCH_UIDS cap. A regression that retains the OLDEST instead of
    // the NEWEST UIDs would silently drop fresh mail — the worst possible
    // outcome of this fix. This test fails if the cap's descending sort is
    // flipped to ascending or removed.
    it('AC5 (regression): MAX_SEARCH_UIDS cap retains the NEWEST UIDs, served newest-first', async () => {
      // 6000 UIDs in ASCENDING order; the cap keeps 5000. Correct behavior
      // keeps the highest (newest) 5000 and serves page 1 newest-first.
      const ascending = Array.from({ length: 6000 }, (_, i) => i + 1); // 1..6000
      client.search.mockResolvedValueOnce(ascending);
      client.fetch.mockReturnValueOnce((async function* gen() {})());

      const result = await service.searchEmails('test', '', { pageSize: 5 });

      expect(result.total).toBe(5000);
      expect(result.totalApprox).toBe(true);
      // Page 1 must be the 5 NEWEST UIDs, descending. An ascending-sort or
      // no-sort regression would retain/serve 1..5000 (the oldest) instead.
      expect(client.fetch).toHaveBeenCalledTimes(1);
      expect(client.fetch.mock.calls[0][0]).toBe('6000,5999,5998,5997,5996');
    });
  });

  // -----------------------------------------------------------------------
  // PR-2 — bounded deep search: R5 (FTS/size gate) + R3/D3 (ephemeral
  // bounded wait) + R8 (folder-size hint). Body is deep-by-default again;
  // these make the big-folder body scan safe instead of disabling it.
  // -----------------------------------------------------------------------

  describe('searchEmails — PR-2 bounded deep search (R3/R5/R8)', () => {
    function hit(uid: number, subject: string) {
      return {
        uid,
        envelope: { subject, from: [{ address: 'a@x' }], to: [], date: '2024-01-01T00:00:00Z' },
        flags: new Set<string>(),
        bodyStructure: { type: 'text', subtype: 'plain' },
        source: Buffer.from(''),
      };
    }

    it('R8: result carries folderSize from the opened mailbox', async () => {
      client.mailbox = { exists: 1234 };
      client.search.mockResolvedValueOnce([]);

      // header-only ⇒ not at-risk ⇒ shared path
      const result = await service.searchEmails('test', '', { from: 'x@y.com' });

      expect(result.folderSize).toBe(1234);
    });

    it('R5: a body scan on a large non-FTS folder attaches a cost warning', async () => {
      client.mailbox = { exists: 50_000 };

      const result = await service.searchEmails('test', 'invoice', {});

      expect(result.warning).toMatch(/large|slow|bounded|narrow/i);
      expect(result.folderSize).toBe(50_000);
    });

    it('R5: an FTS-capable server is NOT at-risk — shared path, no cost warning', async () => {
      client.mailbox = { exists: 50_000 };
      client.capabilities = new Map([['SEARCH=FUZZY', true]]);
      client.search.mockResolvedValueOnce([]);

      const result = await service.searchEmails('test', 'invoice', {});

      expect(result.warning).toBeUndefined();
      expect(client.search).toHaveBeenCalled();
      expect(connections.createEphemeralImapClient).not.toHaveBeenCalled();
    });

    it('R5: a header-only query on a huge folder is NOT at-risk (no body scan)', async () => {
      client.mailbox = { exists: 50_000 };
      client.search.mockResolvedValueOnce([]);

      const result = await service.searchEmails('test', '', { from: 'a@b.com' });

      expect(result.warning).toBeUndefined();
      expect(client.search).toHaveBeenCalled();
      expect(connections.createEphemeralImapClient).not.toHaveBeenCalled();
    });

    it('R3: an at-risk search runs on the EPHEMERAL connection and returns results', async () => {
      client.mailbox = { exists: 50_000 };
      const ephemeral = createMockImapClient();
      ephemeral.search.mockResolvedValue([7]);
      connections.createEphemeralImapClient.mockResolvedValue(ephemeral);
      // page fetch happens on the SHARED client after re-acquiring its lock
      client.fetch.mockReturnValueOnce(
        // eslint-disable-next-line @stylistic/wrap-iife -- mirror createMockImapClient pattern
        (async function* gen() {
          yield hit(7, 'DeepHit');
        })(),
      );

      const result = await service.searchEmails('test', 'needle', { pageSize: 10 });

      expect(ephemeral.search).toHaveBeenCalled();
      expect(ephemeral.getMailboxLock).toHaveBeenCalled(); // D3(a): ephemeral SELECTs its own mailbox
      expect(result.searchFailed).toBeUndefined();
      expect(result.items.map((i) => i.subject)).toEqual(['DeepHit']);
      expect(result.warning).toMatch(/large|slow|bounded|narrow/i);
      expect(result.folderSize).toBe(50_000);
    });

    it('R3/D3: a bounded-wait timeout flags kind=timeout, closes the ephemeral conn, never touches the shared client', async () => {
      vi.useFakeTimers();
      try {
        client.mailbox = { exists: 50_000 };
        const ephemeral = createMockImapClient();
        // The ephemeral SEARCH hangs forever ⇒ the bounded wait must fire.
        ephemeral.search.mockReturnValue(new Promise(() => {}));
        connections.createEphemeralImapClient.mockResolvedValue(ephemeral);

        const p = service.searchEmails('test', 'needle', {});
        await vi.advanceTimersByTimeAsync(120_000); // well past the budget
        const result = await p;

        expect(result.searchFailed).toBe(true);
        expect(result.searchStatus?.kind).toBe('timeout');
        expect(ephemeral.close).toHaveBeenCalled(); // D3(c): close() not logout()
        // D3(b)/(d): the shared client is never used for the deep scan.
        expect(client.search).not.toHaveBeenCalled();
        expect(client._releaseFn).toHaveBeenCalled(); // shared lock released before slow search
        expect(result.folderSize).toBe(50_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('R3/D3 [P1]: a stalled ephemeral CONNECT is bounded too (not only the SEARCH)', async () => {
      vi.useFakeTimers();
      try {
        client.mailbox = { exists: 50_000 };
        // createEphemeralImapClient never resolves — connect/login stalls.
        // The bounded wait must cover connect, not just the SEARCH.
        connections.createEphemeralImapClient.mockReturnValue(new Promise(() => {}));

        const p = service.searchEmails('test', 'needle', {});
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await p;

        expect(result.searchFailed).toBe(true);
        expect(result.searchStatus?.kind).toBe('timeout');
        expect(client.search).not.toHaveBeenCalled();
        // shared lock was released before the (stalled) ephemeral op
        expect(client._releaseFn).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('R3/D3 [P1]: a stalled ephemeral SELECT (getMailboxLock) is bounded too', async () => {
      vi.useFakeTimers();
      try {
        client.mailbox = { exists: 50_000 };
        const ephemeral = createMockImapClient();
        // SELECT on a huge folder stalls — exactly the PR-2 target case.
        ephemeral.getMailboxLock.mockReturnValue(new Promise(() => {}));
        connections.createEphemeralImapClient.mockResolvedValue(ephemeral);

        const p = service.searchEmails('test', 'needle', {});
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await p;

        expect(result.searchFailed).toBe(true);
        expect(result.searchStatus?.kind).toBe('timeout');
        // orphan guard: the ephemeral conn that opened post-timeout is closed
        expect(ephemeral.close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('R5 [P2]: FTS is NOT cached when capabilities are absent — re-checked once available', async () => {
      client.mailbox = { exists: 50_000 };

      // First call: capabilities not yet populated → treated as no-FTS →
      // at-risk → ephemeral bounded path.
      client.search.mockResolvedValueOnce([]);
      await service.searchEmails('test', 'invoice', {});
      const afterFirst = connections.createEphemeralImapClient.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // Server now advertises FTS (capabilities populated, e.g. after a
      // reconnect). A poisoned cache would keep treating it as no-FTS.
      client.capabilities = new Map([['SEARCH=FUZZY', true]]);
      client.search.mockResolvedValueOnce([]);
      await service.searchEmails('test', 'invoice', {});

      // FTS now detected → shared path, NO new ephemeral connection.
      expect(connections.createEphemeralImapClient.mock.calls.length).toBe(afterFirst);
    });

    it('R3/D3 [P2]: a search resolving AFTER the timeout — no unhandled rejection, conn closed', async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown): void => {
        unhandled.push(e);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        client.mailbox = { exists: 50_000 };
        const ephemeral = createMockImapClient();
        let resolveSearch: (v: number[]) => void = () => {};
        ephemeral.search.mockReturnValue(
          new Promise<number[]>((res) => {
            resolveSearch = res;
          }),
        );
        connections.createEphemeralImapClient.mockResolvedValue(ephemeral);

        const p = service.searchEmails('test', 'needle', {});
        await vi.advanceTimersByTimeAsync(120_000); // timeout wins the race
        const result = await p;
        expect(result.searchStatus?.kind).toBe('timeout');

        // The abandoned search settles LATE — orphan guard must still close
        // the ephemeral conn and the late settle must not be unhandled.
        resolveSearch([1, 2, 3]);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();

        expect(ephemeral.close).toHaveBeenCalled();
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        vi.useRealTimers();
      }
    });

    it('R3/D3 [P1]: a CONNECT resolving after timeout, then a stalled SELECT, still closes the orphan', async () => {
      vi.useFakeTimers();
      try {
        client.mailbox = { exists: 50_000 };
        const ephemeral = createMockImapClient();
        // SELECT stalls forever — so `work` would NEVER settle on its own.
        ephemeral.getMailboxLock.mockReturnValue(new Promise(() => {}));
        // Connect resolves only when we say so — AFTER the bounded timeout.
        let resolveConnect: () => void = () => {};
        connections.createEphemeralImapClient.mockReturnValue(
          new Promise((res) => {
            resolveConnect = () => res(ephemeral);
          }),
        );

        const p = service.searchEmails('test', 'needle', {});
        await vi.advanceTimersByTimeAsync(120_000); // timeout fires; caller returns
        const result = await p;
        expect(result.searchStatus?.kind).toBe('timeout');

        // Connect now completes LATE. The late connection must be closed
        // immediately (timedOut already true) — NOT left open while a SELECT
        // it can never complete stalls forever (the leak codex flagged).
        resolveConnect();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ephemeral.close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // listEmails — malformed envelope dates (regression)
  // -----------------------------------------------------------------------

  describe('listEmails (malformed envelope dates)', () => {
    it('does not throw when an envelope.date is malformed; falls back to internalDate', async () => {
      // Three UIDs; the middle one carries a garbage Date header that would
      // crash `new Date(...).toISOString()` if left unguarded. The poison
      // message also carries internalDate, which the helper should prefer.
      client.search.mockResolvedValue([1, 2, 3]);

      const mockMessages = [
        {
          uid: 3,
          envelope: { subject: 'good', from: [{ address: 'a@x' }], to: [], date: '2024-01-03' },
          flags: new Set<string>(),
          bodyStructure: { type: 'text', subtype: 'plain' },
          source: Buffer.from(''),
        },
        {
          uid: 2,
          envelope: {
            subject: 'poison',
            from: [{ address: 'b@x' }],
            to: [],
            date: 'Tue, 32 Notamonth 9999 99:99:99',
          },
          flags: new Set<string>(),
          bodyStructure: { type: 'text', subtype: 'plain' },
          source: Buffer.from(''),
          internalDate: new Date('2024-01-02'),
        },
        {
          uid: 1,
          envelope: {
            subject: 'also good',
            from: [{ address: 'c@x' }],
            to: [],
            date: '2024-01-01',
          },
          flags: new Set<string>(),
          bodyStructure: { type: 'text', subtype: 'plain' },
          source: Buffer.from(''),
        },
      ];
      client.fetch.mockReturnValueOnce(
        // eslint-disable-next-line @stylistic/wrap-iife -- mirror createMockImapClient pattern
        (async function* gen() {
          for (const m of mockMessages) yield m;
        })(),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX.spam', pageSize: 10 });

      expect(result.items).toHaveLength(3);
      const poison = result.items.find((m) => m.subject === 'poison');
      expect(poison?.date).toBe('2024-01-02T00:00:00.000Z');
    });

    it('does not throw when envelope.date is missing entirely; produces a valid ISO string', async () => {
      client.search.mockResolvedValue([1]);

      const mockMessages = [
        {
          uid: 1,
          envelope: { subject: 'no-date', from: [{ address: 'a@x' }], to: [], date: null },
          flags: new Set<string>(),
          bodyStructure: { type: 'text', subtype: 'plain' },
          source: Buffer.from(''),
        },
      ];
      client.fetch.mockReturnValueOnce(
        // eslint-disable-next-line @stylistic/wrap-iife -- mirror createMockImapClient pattern
        (async function* gen() {
          for (const m of mockMessages) yield m;
        })(),
      );

      const result = await service.listEmails('test', { mailbox: 'INBOX', pageSize: 10 });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(typeof item.date).toBe('string');
      expect(item.date.length).toBeGreaterThan(0);
      expect(new Date(item.date).toString()).not.toBe('Invalid Date');
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

    it('R1b: a per-account searchFailed surfaces as a loud warning, not a clean zero (F1/D4)', async () => {
      // account-a: a genuine hit. account-b: client.search → false (failed).
      // Pre-fix the fan-out only treated REJECTED promises as failures, so a
      // fulfilled { searchFailed:true, total:0 } silently counted as a clean
      // zero participant (F1 one layer up).
      client.search
        .mockResolvedValueOnce([10]) // account-a uids
        .mockResolvedValueOnce(false as unknown as number[]); // account-b FAILED
      client.fetch.mockReturnValueOnce(
        makeAsyncGen([makeMessage(10, 'A1', '2024-01-01T00:00:00Z', 'a@example.com')]),
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

      // Healthy account still merges — one bad folder cannot nuke the search.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].account).toBe('account-a');
      expect(result.total).toBe(1);

      // The failed account is surfaced LOUDLY in per-account warnings — it is
      // NOT silently counted as a zero-result participant.
      expect(result.warnings).toBeDefined();
      const bWarn = result.warnings?.find((w) => w.account === 'account-b');
      expect(bWarn).toBeDefined();
      expect(bWarn?.error).toMatch(/SEARCH did not complete|not a zero-match/i);
      // Human-readable summary mentions the failed account.
      expect(result.warning).toMatch(/account-b/);
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
        createEphemeralImapClient: vi.fn().mockImplementation(async (name: string) => {
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
        createEphemeralImapClient: vi.fn().mockImplementation(async (name: string) => {
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

  // -------------------------------------------------------------------------
  // messageToEmail body extraction — the empty-body-multipart fix.
  //
  // Every case here returns EMPTY on pre-fix `main` (top-level Content-Type
  // sniff + hardcoded download('1') clobber + `??`-vs-"" defect). The fix is
  // a single MIME-aware simpleParser walk of the already-fetched source.
  // -------------------------------------------------------------------------

  describe('messageToEmail body extraction (multipart/Gmail/forwarded)', () => {
    const CRLF = '\r\n';
    /** Joins lines with CRLF (RFC822 wire format mailparser expects). */
    const mime = (lines: string[]): Buffer => Buffer.from(lines.join(CRLF), 'utf-8');

    /** Primes client.fetchOne (the getEmail path) with a raw source + optional bodyStructure. */
    function primeEmail(source: Buffer, bodyStructure?: unknown): void {
      (client as unknown as { fetchOne: ReturnType<typeof vi.fn> }).fetchOne = vi
        .fn()
        .mockResolvedValue({
          uid: 21557,
          envelope: { subject: 'International Order', from: [], to: [] },
          flags: [],
          ...(bodyStructure !== undefined ? { bodyStructure } : {}),
          source,
        });
    }

    it('multipart/alternative with EMPTY text/plain → body comes from HTML (exact repro)', async () => {
      primeEmail(
        mime([
          'Subject: International Order',
          'Message-ID: <CAFvpQ=repro@mail.gmail.com>',
          'MIME-Version: 1.0',
          'Content-Type: multipart/alternative; boundary="b1"',
          '',
          '--b1',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          '',
          '--b1',
          'Content-Type: text/html; charset="UTF-8"',
          '',
          '<div>Hello, I would like to place an <b>International Order</b>.</div>',
          '--b1--',
          '',
        ]),
      );

      const email = await service.getEmail('test', '21557', 'INBOX');

      expect(email.bodyText).toBeUndefined();
      expect(email.bodyHtml).toContain('International Order');
      // Pre-fix main returns '' here for all three formats.
      expect(applyBodyFormat(email, 'full')).toContain('International Order');
      expect(applyBodyFormat(email, 'text')).toContain('International Order');
      expect(applyBodyFormat(email, 'stripped')).toContain('International Order');
    });

    it('single-part text/plain still renders (no regression)', async () => {
      primeEmail(
        mime([
          'Subject: Plain',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Just a plain body line.',
          '',
        ]),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toContain('Just a plain body line.');
      expect(applyBodyFormat(email, 'text')).toContain('Just a plain body line.');
    });

    it('top-level text/html still renders (no regression)', async () => {
      primeEmail(
        mime(['Content-Type: text/html; charset=utf-8', '', '<p>HTML <i>only</i> body</p>', '']),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyHtml).toContain('HTML');
      expect(applyBodyFormat(email, 'text')).toMatch(/HTML.*only.*body/s);
    });

    it('multipart/mixed + nested alternative + PDF: body AND attachment (no #14 regression)', async () => {
      const bodyStructure = {
        type: 'multipart/mixed',
        childNodes: [
          {
            type: 'multipart/alternative',
            childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
          },
          {
            type: 'application/pdf',
            part: '2',
            size: 1234,
            disposition: 'attachment',
            dispositionParameters: { filename: 'lease.pdf' },
          },
        ],
      };
      primeEmail(
        mime([
          'Content-Type: multipart/mixed; boundary="m1"',
          '',
          '--m1',
          'Content-Type: multipart/alternative; boundary="a1"',
          '',
          '--a1',
          'Content-Type: text/plain',
          '',
          'Mixed body text here.',
          '--a1',
          'Content-Type: text/html',
          '',
          '<p>Mixed body text here.</p>',
          '--a1--',
          '--m1',
          'Content-Type: application/pdf; name="lease.pdf"',
          'Content-Disposition: attachment; filename="lease.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          'JVBERi0xLjQK',
          '--m1--',
          '',
        ]),
        bodyStructure,
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toContain('Mixed body text here.');
      expect(email.attachments.map((a) => a.filename)).toContain('lease.pdf');
    });

    it('quoted-printable is decoded', async () => {
      primeEmail(
        mime([
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: quoted-printable',
          '',
          'Caf=C3=A9 m=C3=BCnchen line=',
          ' continued',
          '',
        ]),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toContain('Café münchen line continued');
    });

    it('base64 is decoded', async () => {
      primeEmail(
        mime([
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          'SGVsbG8gQmFzZTY0IGJvZHk=',
          '',
        ]),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toContain('Hello Base64 body');
    });

    it('non-UTF-8 charset (ISO-8859-1) is transcoded', async () => {
      const header = Buffer.from(
        ['Content-Type: text/plain; charset=ISO-8859-1', '', ''].join(CRLF),
        'ascii',
      );
      // 0xE9 = é, 0xFC = ü in Latin-1 (invalid as UTF-8 — proves transcoding).
      const body = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6d, 0xfc, 0x6e]); // "Café mün"
      primeEmail(Buffer.concat([header, body]));
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toContain('Café mün');
    });

    it('forwarded message/rfc822 returns the forwarded body', async () => {
      primeEmail(
        mime([
          'Content-Type: multipart/mixed; boundary="f1"',
          '',
          '--f1',
          'Content-Type: text/plain',
          '',
          '',
          '--f1',
          'Content-Type: message/rfc822',
          '',
          'Subject: Fwd inner',
          'Content-Type: text/plain',
          '',
          'This is the forwarded inner body.',
          '--f1--',
          '',
        ]),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      const rendered = `${email.bodyText ?? ''}${email.bodyHtml ?? ''}${applyBodyFormat(
        email,
        'full',
      )}`;
      expect(rendered).toContain('This is the forwarded inner body.');
    });

    it('whitespace-only body → undefined + raw fallback + visible marker (never silent)', async () => {
      primeEmail(mime(['Content-Type: text/plain; charset=utf-8', '', '   ', ' ', '\t', '']));
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toBeUndefined();
      expect(email.bodyHtml).toBeUndefined();
      expect(email.raw).toBeDefined();
      expect(email.bodyWarning).toBe('no decodable text or HTML part');
      expect(applyBodyFormat(email, 'full')).toContain('⚠️ body extraction failed');
      expect(applyBodyFormat(email, 'full')).toContain('--- Raw source ---');
      expect(applyBodyFormat(email, 'text')).toContain('⚠️ body extraction failed');
      expect(applyBodyFormat(email, 'text')).not.toContain('--- Raw source ---');
    });

    it('oversized source skips the parse, caps raw, and warns', async () => {
      const header = Buffer.from(
        ['Content-Type: text/plain; charset=utf-8', '', ''].join(CRLF),
        'ascii',
      );
      // 26 MB > MAX_PARSE_SOURCE_BYTES (25 MB).
      const huge = Buffer.concat([header, Buffer.alloc(26 * 1024 * 1024, 0x61)]);
      primeEmail(huge);
      const email = await service.getEmail('test', '21557', 'INBOX');
      expect(email.bodyText).toBeUndefined();
      expect(email.bodyWarning).toMatch(/source too large/);
      expect(email.raw).toBeDefined();
      // Hard cap: never dump the 26 MB blob.
      expect((email.raw ?? '').length).toBeLessThanOrEqual(256 * 1024);
      expect(applyBodyFormat(email, 'full')).toMatch(/body extraction failed/);
    });

    it('malformed MIME is never a silent empty body', async () => {
      // Declared boundary that never closes — mailparser is lenient; assert
      // we surface SOMETHING (content or marker), never a blank.
      primeEmail(
        mime([
          'Content-Type: multipart/alternative; boundary="never-closed"',
          '',
          '--never-closed',
          'Content-Type: text/plain',
          '',
          'salvageable text',
        ]),
      );
      const email = await service.getEmail('test', '21557', 'INBOX');
      const full = applyBodyFormat(email, 'full');
      expect(full.length).toBeGreaterThan(0);
      expect(full).not.toBe('(no content)');
    });

    it('get_thread path renders the body via the same extractor (repro fixture)', async () => {
      const src = mime([
        'Subject: International Order',
        'Message-ID: <thread-repro@mail.gmail.com>',
        'Content-Type: multipart/alternative; boundary="t1"',
        '',
        '--t1',
        'Content-Type: text/plain',
        '',
        '',
        '--t1',
        'Content-Type: text/html',
        '',
        '<div>Thread body: <b>International Order</b></div>',
        '--t1--',
        '',
      ]);
      client.search.mockResolvedValue([7]);
      (client as unknown as { fetchOne: ReturnType<typeof vi.fn> }).fetchOne = vi
        .fn()
        .mockResolvedValue({ uid: 7, envelope: { subject: 'International Order' }, source: src });
      client.fetch.mockReturnValue(
        // eslint-disable-next-line @stylistic/wrap-iife -- mirror createMockImapClient pattern
        (async function* gen() {
          yield {
            uid: 7,
            envelope: { subject: 'International Order', from: [], to: [] },
            flags: [],
            source: src,
          };
        })(),
      );

      const thread = await service.getThread('test', '<thread-repro@mail.gmail.com>', 'INBOX');

      expect(thread.messageCount).toBeGreaterThan(0);
      expect(thread.messages[0].bodyText).toBeUndefined();
      expect(thread.messages[0].bodyHtml).toContain('International Order');
    });
  });
});
