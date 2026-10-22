/**
 * CrossAccountMover.moveOne — osTicket Subject tagging and dedup safety.
 *
 * Stubbed imapflow clients + stubbed repository, same shape as
 * cross-account-copy.test.ts: no live IMAP, no Postgres. The destination client
 * owns its own raw bytes so dedup verification is tested against the copy that
 * actually exists there, not against the source fixture.
 */

import type ConnectionManager from '../connections/manager.js';
import { CrossAccountMover } from './cross-account-mover.js';
import { ERROR_KIND, MoveError } from './error-kinds.js';
import type { ClaimResult, MoveLogEntry, MoveLogRepository } from './log-repository.js';

const MESSAGE_ID = '<order-2026-10@example.com>';
const SOURCE_RAW = Buffer.from(
  'Message-ID: <order-2026-10@example.com>\r\n' +
    'From: Shop <shop@example.com>\r\n' +
    'Subject: Your order is out for delivery\r\n' +
    '\r\n' +
    'body bytes',
  'binary',
);
const TAGGED_RAW = Buffer.from(
  'Message-ID: <order-2026-10@example.com>\r\n' +
    'From: Shop <shop@example.com>\r\n' +
    'Subject: [#31775] Your order is out for delivery\r\n' +
    '\r\n' +
    'body bytes',
  'binary',
);
const OTHER_TAGGED_RAW = Buffer.from(
  'Message-ID: <order-2026-10@example.com>\r\n' +
    'From: Shop <shop@example.com>\r\n' +
    'Subject: [#99999] Your order is out for delivery\r\n' +
    '\r\n' +
    'body bytes',
  'binary',
);
const INTERNAL_DATE = new Date('2026-10-20T12:00:00.000Z');

function createFakeClient(raw: Buffer) {
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
      source: raw,
      headers: raw,
      flags: new Set(['\\Seen']),
      internalDate: INTERNAL_DATE,
      envelope: {
        messageId: MESSAGE_ID,
        subject: 'Your order is out for delivery',
        from: [{ name: 'Shop', address: 'shop@example.com' }],
      },
    }),
    messageMove: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
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

interface StubOptions {
  claimResult?: ClaimResult;
  ensureTicketTagColumns?: () => Promise<void>;
}

function stubRepo(
  claims: MoveLogEntry[],
  options: StubOptions = {},
): MoveLogRepository & { ensureCalls: number } {
  const repo = {
    ensureCalls: 0,
    claim: async (entry: MoveLogEntry) => {
      claims.push(entry);
      return options.claimResult ?? { ok: true, id: 1 };
    },
    recordSourceCleanup: async () => {},
    ensureTicketTagColumns: async () => {
      repo.ensureCalls += 1;
      await options.ensureTicketTagColumns?.();
    },
  };
  return repo as unknown as MoveLogRepository & { ensureCalls: number };
}

const base = {
  sourceAccount: 'wgs-usa',
  sourceMailbox: 'INBOX',
  emailId: '5',
  destAccount: 'support-wgs',
  destMailbox: 'INBOX',
};

describe('CrossAccountMover.moveOne — ticketNumber', () => {
  let source: FakeClient;
  let dest: FakeClient;
  let claims: MoveLogEntry[];
  let repo: ReturnType<typeof stubRepo>;

  function build(sourceRaw = SOURCE_RAW, destRaw = SOURCE_RAW, options: StubOptions = {}) {
    source = createFakeClient(sourceRaw);
    dest = createFakeClient(destRaw);
    claims = [];
    repo = stubRepo(claims, options);
    return new CrossAccountMover(fakeConnections({ 'wgs-usa': source, 'support-wgs': dest }), repo);
  }

  it('APPENDs the tag as the first subject token while preserving everything else', async () => {
    const mover = build();
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(repo.ensureCalls).toBe(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe('success');
      expect(result.subject_rewritten).toBe(true);
      expect(result.ticket_tag).toBe('31775');
      expect(result.message_id).toBe(MESSAGE_ID);
    }
    expect(dest.append).toHaveBeenCalledTimes(1);
    const [mailbox, raw, flags, internalDate] = dest.append.mock.calls[0];
    expect(mailbox).toBe('INBOX');
    expect(raw.toString('binary')).toContain(
      'Subject: [#31775] Your order is out for delivery\r\n',
    );
    expect(raw.toString('binary')).toContain(`Message-ID: ${MESSAGE_ID}`);
    expect(raw.toString('binary')).toContain('body bytes');
    expect(flags).toEqual(['\\Seen']);
    expect(internalDate).toBe(INTERNAL_DATE);
    expect(claims[0]).toEqual(
      expect.objectContaining({ subject_rewritten: true, ticket_tag: '31775' }),
    );
  });

  it('leaves the raw message alone when no ticketNumber is supplied', async () => {
    const mover = build();
    const result = await mover.moveOne(base);

    expect(repo.ensureCalls).toBe(0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.subject_rewritten).toBe(false);
      expect(result.ticket_tag).toBeNull();
    }
    expect(dest.append.mock.calls[0][1].equals(SOURCE_RAW)).toBe(true);
    expect(claims[0]).toEqual(
      expect.objectContaining({ subject_rewritten: false, ticket_tag: null }),
    );
  });

  it('does not append or move when the subject already belongs to another ticket', async () => {
    const mover = build(OTHER_TAGGED_RAW);
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.TICKET_TAG_CONFLICT);
      expect(result.error_message).toContain('[#99999]');
    }
    expect(dest.append).not.toHaveBeenCalled();
    expect(source.messageMove).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('does not append when the message has duplicate Subject headers', async () => {
    const duplicate = Buffer.from(
      'Message-ID: <order-2026-10@example.com>\r\n' +
        'Subject: first\r\n' +
        'Subject: second [#31775]\r\n\r\nbody',
      'binary',
    );
    const mover = build(duplicate);
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.DUPLICATE_SUBJECT_HEADER);
    }
    expect(dest.append).not.toHaveBeenCalled();
    expect(source.messageMove).not.toHaveBeenCalled();
  });

  it('fails with migration_required before APPEND/FETCH when migration 003 is missing', async () => {
    const mover = build(SOURCE_RAW, SOURCE_RAW, {
      ensureTicketTagColumns: async () => {
        throw new MoveError(
          ERROR_KIND.MIGRATION_REQUIRED,
          'email_move_log is missing subject_rewritten/ticket_tag',
        );
      },
    });
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.MIGRATION_REQUIRED);
    }
    expect(source.fetchOne).not.toHaveBeenCalled();
    expect(dest.append).not.toHaveBeenCalled();
  });

  it('rejects an untagged destination copy instead of cleaning up the source', async () => {
    const mover = build(SOURCE_RAW, SOURCE_RAW);
    dest.search.mockResolvedValue([77]);

    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.DEDUP_TAG_MISMATCH);
      expect(result.error_message).toContain('[#31775]');
    }
    expect(dest.append).not.toHaveBeenCalled();
    expect(source.messageMove).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('rejects a destination copy tagged for another ticket', async () => {
    const mover = build(SOURCE_RAW, OTHER_TAGGED_RAW);
    dest.search.mockResolvedValue([77]);

    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.DEDUP_TAG_MISMATCH);
      expect(result.error_message).toContain('#99999');
    }
    expect(source.messageMove).not.toHaveBeenCalled();
  });

  it('accepts dedup when the destination copy already has the right first token', async () => {
    const mover = build(SOURCE_RAW, TAGGED_RAW);
    dest.search.mockResolvedValue([77]);

    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe('duplicate_skipped');
      expect(result.dest_uid).toBe(77);
      expect(result.subject_rewritten).toBe(false);
      expect(result.ticket_tag).toBe('31775');
    }
    expect(dest.append).not.toHaveBeenCalled();
    // The caller asked to move the source, so cleanup still runs.
    expect(source.messageMove).toHaveBeenCalledTimes(1);
    expect(claims[0]).toEqual(
      expect.objectContaining({
        status: 'duplicate_skipped',
        subject_rewritten: false,
        ticket_tag: '31775',
      }),
    );
  });

  it('verifies the audit-race winner instead of trusting its row', async () => {
    const mover = build(SOURCE_RAW, SOURCE_RAW, {
      claimResult: { ok: false, existing: { id: 9, dest_uid: 55, status: 'success' } },
    });

    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error_kind).toBe(ERROR_KIND.DEDUP_TAG_MISMATCH);
    }
    expect(source.messageMove).not.toHaveBeenCalled();
  });

  it('accepts the audit-race winner when its destination copy is tagged', async () => {
    const mover = build(SOURCE_RAW, TAGGED_RAW, {
      claimResult: { ok: false, existing: { id: 9, dest_uid: 55, status: 'success' } },
    });

    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe('duplicate_skipped');
      expect(result.move_log_id).toBe(9);
    }
    // The audit-race branch leaves the source untouched (existing semantics).
    expect(source.messageMove).not.toHaveBeenCalled();
  });

  it('treats an already-tagged same subject as a no-op rewrite', async () => {
    const mover = build(TAGGED_RAW);
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.subject_rewritten).toBe(false);
      expect(result.ticket_tag).toBe('31775');
    }
    expect(dest.append.mock.calls[0][1].equals(TAGGED_RAW)).toBe(true);
    expect(claims[0]).toEqual(
      expect.objectContaining({ subject_rewritten: false, ticket_tag: '31775' }),
    );
  });
});
