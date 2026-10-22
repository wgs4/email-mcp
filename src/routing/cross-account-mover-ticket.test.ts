/**
 * CrossAccountMover.moveOne — osTicket Subject tagging, end to end.
 *
 * Stubbed imapflow clients + stubbed repository, same shape as
 * cross-account-copy.test.ts: no live IMAP, no Postgres. These tests pin the
 * move contract around the rewrite — the APPEND carries the tagged bytes and
 * the untouched Message-ID, a conflicting tag aborts before APPEND, and
 * Message-ID dedup still wins.
 */

import type ConnectionManager from '../connections/manager.js';
import { CrossAccountMover } from './cross-account-mover.js';
import { ERROR_KIND } from './error-kinds.js';
import type { MoveLogEntry, MoveLogRepository } from './log-repository.js';

const MESSAGE_ID = '<order-2026-10@example.com>';
const RAW = Buffer.from(
  'Message-ID: <order-2026-10@example.com>\r\n' +
    'From: Shop <shop@example.com>\r\n' +
    'Subject: Your order is out for delivery\r\n' +
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

function stubRepo(claims: MoveLogEntry[]): MoveLogRepository {
  return {
    claim: async (entry: MoveLogEntry) => {
      claims.push(entry);
      return { ok: true, id: 1 };
    },
    recordSourceCleanup: async () => {},
  } as unknown as MoveLogRepository;
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

  function build(raw = RAW): CrossAccountMover {
    source = createFakeClient(raw);
    dest = createFakeClient(raw);
    claims = [];
    return new CrossAccountMover(
      fakeConnections({ 'wgs-usa': source, 'support-wgs': dest }),
      stubRepo(claims),
    );
  }

  it('APPENDs the rewritten subject while preserving everything else', async () => {
    const mover = build();
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe('success');
      expect(result.subject_rewritten).toBe(true);
      expect(result.ticket_tag).toBe('31775');
      expect(result.subject).toBe('Your order is out for delivery [#31775]');
      expect(result.message_id).toBe(MESSAGE_ID);
    }
    expect(dest.append).toHaveBeenCalledTimes(1);
    const [mailbox, raw, flags, internalDate] = dest.append.mock.calls[0];
    expect(mailbox).toBe('INBOX');
    expect(raw.toString('binary')).toContain(
      'Subject: Your order is out for delivery [#31775]\r\n',
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

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.subject_rewritten).toBe(false);
      expect(result.ticket_tag).toBeNull();
    }
    expect(dest.append.mock.calls[0][1].equals(RAW)).toBe(true);
    expect(claims[0]).toEqual(
      expect.objectContaining({ subject_rewritten: false, ticket_tag: null }),
    );
  });

  it('does not append or move when the subject already belongs to another ticket', async () => {
    const conflicting = Buffer.from(
      'Message-ID: <order-2026-10@example.com>\r\n' +
        'Subject: Re: Your order [#99999]\r\n\r\nbody',
      'binary',
    );
    const mover = build(conflicting);
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

  it('dedups on the unchanged Message-ID, so a repeated tagged move cannot make a second copy', async () => {
    const mover = build();
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
    // The duplicate is not appended again, but the caller did ask to move the
    // source message, so the saga still completes its source cleanup.
    expect(source.messageMove).toHaveBeenCalledTimes(1);
    expect(claims[0]).toEqual(
      expect.objectContaining({
        status: 'duplicate_skipped',
        subject_rewritten: false,
        ticket_tag: '31775',
      }),
    );
  });

  it('treats an already-tagged same subject as a no-op rewrite', async () => {
    const alreadyTagged = Buffer.from(
      'Message-ID: <order-2026-10@example.com>\r\n' +
        'Subject: Your order is out for delivery [#31775]\r\n\r\nbody',
      'binary',
    );
    const mover = build(alreadyTagged);
    const result = await mover.moveOne({ ...base, ticketNumber: '31775' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.subject_rewritten).toBe(false);
      expect(result.ticket_tag).toBe('31775');
    }
    expect(dest.append.mock.calls[0][1].equals(alreadyTagged)).toBe(true);
    expect(claims[0]).toEqual(
      expect.objectContaining({ subject_rewritten: false, ticket_tag: '31775' }),
    );
  });
});
