/**
 * Unit tests for the cross-account COPY path.
 *
 * The copy is steps 1-3 of the move saga with steps 6-9 deleted, so the tests
 * that matter are the ones that pin down what it must NOT do: never write to
 * the source client, never set $Routed, never delete anything at the
 * destination, and never let a Postgres problem block the operation (David's
 * live config has no [database] section at all).
 *
 * Stubbed imapflow clients + stubbed repository — no live IMAP, no Postgres.
 */

import type ConnectionManager from '../connections/manager.js';
import { CrossAccountMover } from './cross-account-mover.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogRepository } from './log-repository.js';
import { MoveLogRepository as RealMoveLogRepository } from './log-repository.js';

const MESSAGE_ID = '<michelle-2026-08@example.com>';
const RAW = Buffer.from(
  'Message-ID: <michelle-2026-08@example.com>\r\n' +
    'From: Michelle <michelle@example.com>\r\n' +
    'Subject: Guardianship hearing\r\n\r\nbody',
);
const INTERNAL_DATE = new Date('2026-08-01T12:00:00.000Z');

/**
 * A stub imapflow client. Every method the two sagas can reach is present as a
 * spy so "was never called" is a meaningful assertion rather than a typo.
 */
function createFakeClient() {
  const release = vi.fn();
  return {
    mailbox: { uidValidity: 7n, permanentFlags: new Set<string>(['\\*']) },
    capabilities: new Set<string>(['MOVE']),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    list: vi.fn().mockResolvedValue([{ path: 'Trash', specialUse: '\\Trash' }]),
    search: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue({ uid: 77 }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 5,
      source: RAW,
      flags: new Set(['\\Seen']),
      internalDate: INTERNAL_DATE,
      envelope: {
        messageId: MESSAGE_ID,
        subject: 'Guardianship hearing',
        from: [{ name: 'Michelle', address: 'michelle@example.com' }],
      },
    }),
    messageMove: vi.fn().mockResolvedValue(true),
    messageCopy: vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'INBOX' }),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    expunge: vi.fn().mockResolvedValue(true),
    _release: release,
  };
}

type FakeClient = ReturnType<typeof createFakeClient>;

function fakeConnections(clients: Record<string, FakeClient>): ConnectionManager {
  return {
    getAccountNames: () => Object.keys(clients),
    getImapClient: async (name: string) => clients[name],
  } as unknown as ConnectionManager;
}

/** claim() belongs to the move contract; a copy must never reach it. */
function stubRepo(logCopy: MoveLogRepository['logCopy']): MoveLogRepository {
  return {
    logCopy,
    claim: () => {
      throw new Error('copy must not use the move claim() contract');
    },
    recordSourceCleanup: () => {
      throw new Error('copy must not record a source cleanup');
    },
  } as unknown as MoveLogRepository;
}

/** Every write verb the source client exposes must stay untouched by a copy. */
function expectSourceUntouched(source: FakeClient): void {
  expect(source.messageMove).not.toHaveBeenCalled();
  expect(source.messageCopy).not.toHaveBeenCalled();
  expect(source.messageDelete).not.toHaveBeenCalled();
  expect(source.messageFlagsAdd).not.toHaveBeenCalled();
  expect(source.messageFlagsRemove).not.toHaveBeenCalled();
  expect(source.expunge).not.toHaveBeenCalled();
  // Step 7 (resolve the source \Trash via SPECIAL-USE) is deleted too.
  expect(source.list).not.toHaveBeenCalled();
}

describe('CrossAccountMover.copyOne', () => {
  const base = {
    sourceAccount: 'wgs-usa',
    sourceMailbox: 'INBOX',
    emailId: '5',
    destAccount: 'khara',
    destMailbox: 'INBOX',
  };

  let source: FakeClient;
  let dest: FakeClient;
  let logCopy: ReturnType<typeof vi.fn>;
  let copier: CrossAccountMover;

  beforeEach(() => {
    source = createFakeClient();
    dest = createFakeClient();
    logCopy = vi.fn().mockResolvedValue(1234);
    copier = new CrossAccountMover(
      fakeConnections({ 'wgs-usa': source, khara: dest }),
      stubRepo(logCopy as unknown as MoveLogRepository['logCopy']),
    );
  });

  it('appends to the destination and leaves the source completely untouched', async () => {
    const r = await copier.copyOne(base);

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.status).toBe('success');
      expect(r.dest_uid).toBe(77);
      expect(r.message_id).toBe(MESSAGE_ID);
      expect(r.from).toBe('Michelle <michelle@example.com>');
      // Explicitly null: there is no cleanup to report.
      expect(r.source_cleanup).toBeNull();
      expect(r.copy_log_id).toBe(1234);
      expect(r.warnings).toEqual([]);
    }
    expect(dest.append).toHaveBeenCalledTimes(1);
    expectSourceUntouched(source);
  });

  it('preserves flags and INTERNALDATE on the APPEND', async () => {
    await copier.copyOne(base);

    expect(dest.append).toHaveBeenCalledWith('INBOX', RAW, ['\\Seen'], INTERNAL_DATE);
  });

  it('does NOT set the $Routed keyword (a copy is not a routing event)', async () => {
    await copier.copyOne(base);

    expect(dest.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('succeeds with NO database configured, warning instead of failing', async () => {
    // The real repository with no URL — exactly David's config.toml, which has
    // no [database] section, and the case that makes cross_account_move
    // inoperable today.
    const noDb = new RealMoveLogRepository(undefined);
    const dbless = new CrossAccountMover(fakeConnections({ 'wgs-usa': source, khara: dest }), noDb);

    const r = await dbless.copyOne(base);

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.status).toBe('success');
      expect(r.dest_uid).toBe(77);
      expect(r.copy_log_id).toBeNull();
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0].kind).toBe(WARNING_KIND.AUDIT_LOG_SKIPPED);
      expect(r.warnings[0].message).toMatch(/database/i);
    }
    expect(dest.append).toHaveBeenCalledTimes(1);
    expectSourceUntouched(source);
  });

  it('degrades a failed audit INSERT to a warning and still reports success', async () => {
    logCopy.mockRejectedValue(
      new MoveError(ERROR_KIND.DATABASE_UNAVAILABLE, 'Postgres unreachable (ECONNREFUSED)'),
    );

    const r = await copier.copyOne(base);

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.copy_log_id).toBeNull();
      expect(r.warnings.map((w) => w.kind)).toEqual([WARNING_KIND.AUDIT_LOG_SKIPPED]);
      expect(r.warnings[0].message).toContain('ECONNREFUSED');
    }
    expect(dest.append).toHaveBeenCalledTimes(1);
    expectSourceUntouched(source);
  });

  it('reports duplicate_skipped on a Message-ID hit without appending twice', async () => {
    dest.search.mockResolvedValue([91]);

    const r = await copier.copyOne(base);

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.status).toBe('duplicate_skipped');
      expect(r.dest_uid).toBe(91);
    }
    expect(dest.search).toHaveBeenCalledWith(
      { header: { 'message-id': MESSAGE_ID } },
      { uid: true },
    );
    expect(dest.append).not.toHaveBeenCalled();
    // No DB claim to lose a race against → nothing at the destination is ever
    // discarded, and the source is still untouched.
    expect(dest.messageMove).not.toHaveBeenCalled();
    expect(dest.messageDelete).not.toHaveBeenCalled();
    expectSourceUntouched(source);
  });

  it('still audit-logs a deduped copy best-effort', async () => {
    dest.search.mockResolvedValue([91]);

    await copier.copyOne(base);

    expect(logCopy).toHaveBeenCalledTimes(1);
    expect(logCopy.mock.calls[0][0]).toMatchObject({
      status: 'duplicate_skipped',
      dest_uid: 91,
      message_id: MESSAGE_ID,
    });
  });

  it('refuses a same-account copy and points at copy_email', async () => {
    const r = await copier.copyOne({ ...base, destAccount: 'wgs-usa' });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.SAME_ACCOUNT_COPY);
      expect(r.error_message).toContain('copy_email');
    }
    expect(dest.append).not.toHaveBeenCalled();
    expectSourceUntouched(source);
  });

  it('rejects a non-numeric email_id before touching either account', async () => {
    const r = await copier.copyOne({ ...base, emailId: 'abc' });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
      expect(r.source_uid).toBeNull();
    }
    expect(source.fetchOne).not.toHaveBeenCalled();
    expect(dest.append).not.toHaveBeenCalled();
  });

  it('rejects unknown source and destination accounts', async () => {
    const bad = await copier.copyOne({ ...base, sourceAccount: 'nope' });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error_kind).toBe(ERROR_KIND.SOURCE_NOT_FOUND);
    }

    const badDest = await copier.copyOne({ ...base, destAccount: 'nope' });
    expect(badDest.success).toBe(false);
    if (!badDest.success) {
      expect(badDest.error_kind).toBe(ERROR_KIND.DEST_ACCOUNT_INVALID);
    }
  });

  it('reports source_not_found without appending when the UID is gone', async () => {
    source.fetchOne.mockResolvedValue(null);

    const r = await copier.copyOne(base);

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.SOURCE_NOT_FOUND);
    }
    expect(dest.append).not.toHaveBeenCalled();
    expectSourceUntouched(source);
  });

  it('maps a rejected APPEND to append_failed and still leaves the source alone', async () => {
    dest.append.mockResolvedValue(false);

    const r = await copier.copyOne(base);

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.APPEND_FAILED);
    }
    expect(logCopy).not.toHaveBeenCalled();
    expectSourceUntouched(source);
  });

  it('releases both mailbox locks', async () => {
    await copier.copyOne(base);

    expect(source._release).toHaveBeenCalledTimes(1);
    expect(dest._release).toHaveBeenCalledTimes(1);
  });
});

describe('CrossAccountMover.copyMany', () => {
  it('returns one result per input, preserving order', async () => {
    const source = createFakeClient();
    const dest = createFakeClient();
    const copier = new CrossAccountMover(
      fakeConnections({ 'wgs-usa': source, khara: dest }),
      stubRepo(vi.fn().mockResolvedValue(1) as unknown as MoveLogRepository['logCopy']),
    );
    const base = {
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      destAccount: 'khara',
      destMailbox: 'INBOX',
    };

    const results = await copier.copyMany([
      { ...base, emailId: '5' },
      { ...base, emailId: 'x' },
      { ...base, emailId: '6' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(true);
    expect(results.map((r) => r.source_uid)).toEqual([5, null, 6]);
    expectSourceUntouched(source);
  });
});

describe('CrossAccountMover.moveOne (unchanged siblings)', () => {
  it('still points a same-account move at move_email', async () => {
    const client = createFakeClient();
    const mover = new CrossAccountMover(
      fakeConnections({ 'wgs-usa': client }),
      stubRepo(vi.fn() as unknown as MoveLogRepository['logCopy']),
    );

    const r = await mover.moveOne({
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      emailId: '5',
      destAccount: 'wgs-usa',
      destMailbox: 'INBOX',
    });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.SAME_ACCOUNT_MOVE);
      expect(r.error_message).toContain('move_email');
    }
  });
});
