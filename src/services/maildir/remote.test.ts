import {
  assertRemoteOk,
  assertSafeArg,
  buildRemoteCommand,
  buildSshArgs,
  MaildirRemoteError,
  REMOTE_TOOLS,
  shQuote,
} from './remote.js';

const ok = { stdout: Buffer.alloc(0), stderr: '', exitCode: 0, timedOut: false, truncated: false };

describe('shQuote', () => {
  it('wraps plain text in single quotes', () => {
    expect(shQuote('abc')).toBe("'abc'");
  });

  it('escapes embedded single quotes', () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises every shell metacharacter', () => {
    const nasty = '$(touch /tmp/x); `id` | rm -rf / && echo $HOME > f < g * ? ~ # !';
    const q = shQuote(nasty);
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
    // Only quote characters may break the quoting, and there are none.
    expect(q.slice(1, -1)).toBe(nasty);
  });

  it.each(['a\nb', 'a\rb', 'a\u0000b'])('refuses control characters (%j)', (arg) => {
    expect(() => shQuote(arg)).toThrow(MaildirRemoteError);
    expect(() => assertSafeArg(arg)).toThrow(/NUL, CR or LF/);
  });
});

describe('buildRemoteCommand', () => {
  it('builds the only allowed shape', () => {
    expect(buildRemoteCommand('vmail', 'grep', ['-l', 'x y', '--', '/var/vmail/a'])).toBe(
      "LC_ALL=C sudo -n -u 'vmail' '/usr/bin/grep' '-l' 'x y' '--' '/var/vmail/a'",
    );
  });

  it('allows only find, grep and head', () => {
    expect([...REMOTE_TOOLS]).toEqual(['find', 'grep', 'head']);
    expect(() => buildRemoteCommand('vmail', 'rm' as never, [])).toThrow(/not allowed/);
    expect(() => buildRemoteCommand('vmail', 'cat' as never, [])).toThrow(/not allowed/);
  });

  it('refuses a strange sudo user', () => {
    expect(() => buildRemoteCommand('root; id', 'grep', [])).toThrow(/sudo user/);
  });

  it('keeps an injection attempt inside one quoted argument', () => {
    const cmd = buildRemoteCommand('vmail', 'grep', ["x'; touch /tmp/pwn; echo '"]);
    expect(cmd).toBe(
      "LC_ALL=C sudo -n -u 'vmail' '/usr/bin/grep' 'x'\\''; touch /tmp/pwn; echo '\\'''",
    );
  });
});

describe('buildSshArgs', () => {
  const cfg = { sshHost: 'mailserver', connectTimeoutSeconds: 10 };

  it('uses BatchMode, no TTY, and -- before the host', () => {
    const args = buildSshArgs(cfg, 'CMD');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('-T');
    expect(args.slice(-3)).toEqual(['--', 'mailserver', 'CMD']);
  });

  it.each(['-oProxyCommand=id', 'host name', 'a;b', ''])('refuses host %j', (host) => {
    expect(() => buildSshArgs({ ...cfg, sshHost: host }, 'x')).toThrow(/ssh_host/);
  });
});

describe('assertRemoteOk', () => {
  it('passes a normal result', () => {
    expect(() => assertRemoteOk(ok)).not.toThrow();
  });

  it('flags ssh failures (exit 255)', () => {
    expect(() =>
      assertRemoteOk({ ...ok, exitCode: 255, stderr: 'ssh: connect to host x: refused' }),
    ).toThrow(/SSH to the mail server failed/);
  });

  it('flags sudo refusals', () => {
    expect(() =>
      assertRemoteOk({ ...ok, exitCode: 1, stderr: 'sudo: a password is required\n' }),
    ).toThrow(/refused the sudo command/);
  });

  it('lets a timed-out result through for partial reporting', () => {
    expect(() => assertRemoteOk({ ...ok, exitCode: null, timedOut: true })).not.toThrow();
  });
});
