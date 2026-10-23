/**
 * MoveLogRepository — deployment-safety split between legacy and tagged INSERTs.
 *
 * `postgres` is mocked: these tests assert the SQL shape (which columns the
 * INSERT names) and the migration-003 readiness check, not live database
 * behaviour. Untagged moves must keep working against schema 002; tagged moves
 * must be refused before APPEND when the columns are absent.
 */

import postgres from 'postgres';

import { ERROR_KIND } from './error-kinds.js';
import { MoveLogRepository } from './log-repository.js';

vi.mock('postgres', () => ({ default: vi.fn() }));

const postgresMock = postgres as unknown as ReturnType<typeof vi.fn>;

function queryText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    source_account: 'wgs-usa',
    source_mailbox: 'INBOX',
    source_uid: 5,
    dest_account: 'support-wgs',
    dest_mailbox: 'INBOX',
    dest_uid: 77,
    message_id: '<m@example.com>',
    subject: 'Hello',
    from_addr: 'Shop <shop@example.com>',
    email_date: null,
    size_bytes: 10,
    status: 'success' as const,
    manual: true,
    ...overrides,
  };
}

describe('MoveLogRepository claim()', () => {
  let sql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sql = vi.fn().mockResolvedValue([{ id: 1 }]);
    postgresMock.mockReturnValue(sql);
  });

  it('uses the legacy INSERT, naming no migration-003 columns, for an untagged move', async () => {
    const repo = new MoveLogRepository('postgres://email_mcp@example/db');

    await repo.claim(entry());

    const text = queryText(sql.mock.calls[0]);
    expect(text).toContain('INSERT INTO email_move_log');
    expect(text).not.toContain('subject_rewritten');
    expect(text).not.toContain('ticket_tag');
  });

  it('uses the tagged INSERT when a ticket number was requested', async () => {
    const repo = new MoveLogRepository('postgres://email_mcp@example/db');

    await repo.claim(entry({ ticket_tag: '31775', subject_rewritten: true }));

    const text = queryText(sql.mock.calls[0]);
    expect(text).toContain('subject_rewritten');
    expect(text).toContain('ticket_tag');
  });
});

describe('MoveLogRepository ensureTicketTagColumns()', () => {
  let sql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sql = vi.fn();
    postgresMock.mockReturnValue(sql);
  });

  it('resolves the unqualified relation via to_regclass and caches the positive answer', async () => {
    sql.mockResolvedValue([{ attname: 'subject_rewritten' }, { attname: 'ticket_tag' }]);
    const repo = new MoveLogRepository('postgres://email_mcp@example/db');

    await repo.ensureTicketTagColumns();
    await repo.ensureTicketTagColumns();

    expect(sql).toHaveBeenCalledTimes(1);
    const text = queryText(sql.mock.calls[0]);
    expect(text).toContain("to_regclass('email_move_log')");
    expect(text).toContain('pg_attribute');
    expect(text).toContain('NOT attisdropped');
    expect(text).not.toContain('information_schema');
  });

  it('fails with migration_required when a column is missing', async () => {
    sql.mockResolvedValue([{ attname: 'subject_rewritten' }]);
    const repo = new MoveLogRepository('postgres://email_mcp@example/db');

    await expect(repo.ensureTicketTagColumns()).rejects.toMatchObject({
      kind: ERROR_KIND.MIGRATION_REQUIRED,
    });
  });

  it('fails with migration_required when neither column exists (schema 002)', async () => {
    sql.mockResolvedValue([]);
    const repo = new MoveLogRepository('postgres://email_mcp@example/db');

    await expect(repo.ensureTicketTagColumns()).rejects.toMatchObject({
      kind: ERROR_KIND.MIGRATION_REQUIRED,
    });
  });
});
