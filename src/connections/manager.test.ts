import type { EventEmitter } from 'node:events';
import { mcpLog } from '../logging.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

// Mock imapflow with a *real* EventEmitter base: Node's EventEmitter throws on
// emit('error', …) when there is no 'error' listener — exactly the F2 process
// crash R1c/D6 must prevent. Each `new ImapFlow()` is a fresh instance, so a
// reconnect yields a different object. The factory imports node:events itself
// (an async factory, hoisted above imports) so it never closes over the
// type-only EventEmitter import (which would TDZ when hoisted).
vi.mock('imapflow', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  class MockImapFlow extends NodeEventEmitter {
    usable = true;
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();
    logout = vi.fn().mockResolvedValue(undefined);
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const account = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'pw',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
} as AccountConfig;

describe('ConnectionManager.getImapClient — R1c default error handler (F2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches a default error listener so an IMAP "error" event cannot crash the process', async () => {
    const manager = new ConnectionManager([account]);
    const client = await manager.getImapClient('test');

    // No listener ⇒ EventEmitter rethrows. A default handler must be attached.
    expect(() =>
      (client as unknown as EventEmitter).emit('error', new Error('socket timeout')),
    ).not.toThrow();
    expect(mcpLog).toHaveBeenCalledWith('error', 'imap', expect.stringContaining('socket timeout'));
  });

  it('drops the errored client so the next getImapClient reconnects (D6)', async () => {
    const manager = new ConnectionManager([account]);
    const client1 = await manager.getImapClient('test');

    (client1 as unknown as EventEmitter).emit('error', new Error('boom'));

    const client2 = await manager.getImapClient('test');
    expect(client2).not.toBe(client1);
  });
});

describe('ConnectionManager.createEphemeralImapClient (D3 — bounded deep search)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a connected client that is NOT the cached shared client', async () => {
    const manager = new ConnectionManager([account]);
    const shared = await manager.getImapClient('test');

    const ephemeral = await manager.createEphemeralImapClient('test');

    expect(ephemeral).not.toBe(shared);
    expect(
      (ephemeral as unknown as { connect: ReturnType<typeof vi.fn> }).connect,
    ).toHaveBeenCalled();

    // It is NOT cached: getImapClient still returns the original shared client,
    // and a second ephemeral is yet another distinct instance.
    expect(await manager.getImapClient('test')).toBe(shared);
    const ephemeral2 = await manager.createEphemeralImapClient('test');
    expect(ephemeral2).not.toBe(ephemeral);
  });

  it('an ephemeral client error cannot crash the process and does not evict the shared client', async () => {
    const manager = new ConnectionManager([account]);
    const shared = await manager.getImapClient('test');
    const ephemeral = await manager.createEphemeralImapClient('test');

    expect(() =>
      (ephemeral as unknown as EventEmitter).emit('error', new Error('ephemeral boom')),
    ).not.toThrow();
    expect(mcpLog).toHaveBeenCalledWith('error', 'imap', expect.stringContaining('ephemeral boom'));

    // D3: the ephemeral connection must never poison the shared one.
    expect(await manager.getImapClient('test')).toBe(shared);
  });
});

describe('ConnectionManager — error logs redact secrets ([P2] codex)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const secretAccount = {
    name: 'sec',
    email: 'sec@example.com',
    username: 'sec@example.com',
    password: 'SuperSecretPw_8843',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  } as AccountConfig;

  function loggedImapErrorMessages(): string[] {
    return (vi.mocked(mcpLog).mock.calls as unknown[][])
      .filter((c) => c[0] === 'error' && c[1] === 'imap')
      .map((c) => String(c[2]));
  }

  it('shared client error log does not leak the account password or a bearer token', async () => {
    const manager = new ConnectionManager([secretAccount]);
    const client = await manager.getImapClient('sec');

    (client as unknown as EventEmitter).emit(
      'error',
      new Error(
        'LOGIN failed for sec@example.com using SuperSecretPw_8843; Authorization: Bearer abc123tok456xyz',
      ),
    );

    const msgs = loggedImapErrorMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const joined = msgs.join(' | ');
    expect(joined).not.toContain('SuperSecretPw_8843');
    expect(joined).not.toContain('abc123tok456xyz');
    expect(joined).toContain('sec'); // still a useful, attributable message
  });

  it('ephemeral client error log does not leak the account password', async () => {
    const manager = new ConnectionManager([secretAccount]);
    const ephemeral = await manager.createEphemeralImapClient('sec');

    (ephemeral as unknown as EventEmitter).emit(
      'error',
      new Error('socket closed mid-auth: password=SuperSecretPw_8843 rejected'),
    );

    const joined = loggedImapErrorMessages().join(' | ');
    expect(joined).not.toContain('SuperSecretPw_8843');
    expect(joined).toMatch(/ephemeral/i);
  });
});
