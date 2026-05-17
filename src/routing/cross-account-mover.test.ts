/**
 * Unit tests for CrossAccountMover input-validation guards (D2/D8).
 * These early-return paths are pure: they never touch IMAP or Postgres, so a
 * tiny fake ConnectionManager is enough. The IMAP/DB saga is exercised by the
 * live validation move, not mocked here.
 */

import type ConnectionManager from '../connections/manager.js';
import { CrossAccountMover } from './cross-account-mover.js';
import { ERROR_KIND } from './error-kinds.js';
import type { MoveLogRepository } from './log-repository.js';

function fakeConnections(accountNames: string[]): ConnectionManager {
  return {
    getAccountNames: () => accountNames,
  } as unknown as ConnectionManager;
}

// Should never be reached by guard tests — throws if a guard lets through.
const explodingRepo = {
  claim: () => {
    throw new Error('repo must not be touched by validation guards');
  },
} as unknown as MoveLogRepository;

describe('CrossAccountMover guards', () => {
  const mover = new CrossAccountMover(fakeConnections(['wgs-usa', 'support-wgs']), explodingRepo);

  const base = {
    sourceAccount: 'wgs-usa',
    sourceMailbox: 'INBOX',
    emailId: '123',
    destAccount: 'support-wgs',
    destMailbox: 'INBOX',
  };

  it('rejects a non-numeric email_id', async () => {
    const r = await mover.moveOne({ ...base, emailId: 'abc' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
      expect(r.source_uid).toBeNull();
    }
  });

  it('rejects a non-positive email_id', async () => {
    const r = await mover.moveOne({ ...base, emailId: '0' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.INVALID_EMAIL_ID);
    }
  });

  it('rejects an unknown source account', async () => {
    const r = await mover.moveOne({ ...base, sourceAccount: 'nope' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.SOURCE_NOT_FOUND);
    }
  });

  it('rejects an unknown destination account', async () => {
    const r = await mover.moveOne({ ...base, destAccount: 'nope' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.DEST_ACCOUNT_INVALID);
    }
  });

  it('rejects a same-account move (use move_email instead)', async () => {
    const r = await mover.moveOne({ ...base, destAccount: 'wgs-usa' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error_kind).toBe(ERROR_KIND.SAME_ACCOUNT_MOVE);
    }
  });

  it('moveMany returns one result per input, preserving order', async () => {
    const results = await mover.moveMany([
      { ...base, emailId: 'x' },
      { ...base, emailId: '0' },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
  });
});
