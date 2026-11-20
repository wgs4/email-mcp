/**
 * Read-only remote command runner for the raw Maildir store.
 *
 * Safety model (see docs/maildir-search.md):
 * - The ONLY remote command shape is
 *     LC_ALL=C sudo -n -u <sudo_user> /usr/bin/<tool> <args...>
 *   where <tool> is one of REMOTE_TOOLS (find, grep, head) — a strict subset of
 *   the server's sudoers rule. No pipes, redirects, `;`, `&&` or subshells.
 * - The remote side runs a shell (sshd hands the command string to the login
 *   shell), so EVERY argument is single-quoted with `'\''` escaping. Arguments
 *   holding NUL, CR or LF are refused before anything is sent.
 * - ssh runs without a local shell (`spawn`, argv array), with BatchMode (no
 *   password prompts), stdin closed, `--` before the host, a connect timeout,
 *   a wall-clock timeout and a stdout byte cap. Hitting either limit kills the
 *   ssh process and is reported to the caller as `timedOut` / `truncated`, so
 *   a cut-short command is never mistaken for an empty result.
 */

import { spawn } from 'node:child_process';

import type { MaildirConfig } from '../../types/index.js';
import { MaildirRemoteError } from './errors.js';

export { MaildirRemoteError } from './errors.js';

/** Remote binaries this code is allowed to run (all under /usr/bin). */
export const REMOTE_TOOLS = ['find', 'grep', 'head'] as const;
export type RemoteTool = (typeof REMOTE_TOOLS)[number];

export interface RemoteRunOptions {
  /** Wall-clock budget for this command, in milliseconds. */
  timeoutMs: number;
  /** Stop reading (and kill ssh) after this many stdout bytes. */
  maxBytes: number;
}

export interface RemoteRunResult {
  stdout: Buffer;
  /** First 64 KiB of stderr, decoded as UTF-8. */
  stderr: string;
  /** Remote exit code (ssh's own errors are 255); null when killed. */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout exceeded maxBytes; `stdout` holds only the first maxBytes. */
  truncated: boolean;
}

/** The narrow surface the Maildir service depends on (mocked in tests). */
export interface RemoteRunner {
  run: (tool: RemoteTool, args: string[], options: RemoteRunOptions) => Promise<RemoteRunResult>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — refuse NUL/CR/LF
const UNSAFE_ARG_RE = /[\u0000\r\n]/; // eslint-disable-line no-control-regex

const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 2000;

/**
 * Throw unless `arg` is safe to place inside single quotes on the remote
 * shell command line. Single quotes neutralise every shell metacharacter
 * except the quote itself (escaped by shQuote); NUL/CR/LF are refused
 * outright because they end or corrupt the command line.
 */
export function assertSafeArg(arg: string): void {
  if (UNSAFE_ARG_RE.test(arg)) {
    throw new MaildirRemoteError(
      'Refusing to send an argument that contains NUL, CR or LF to the mail server.',
      'unsafe_argument',
    );
  }
}

/** POSIX single-quote one argument: `it's` → `'it'\''s'`. */
export function shQuote(arg: string): string {
  assertSafeArg(arg);
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the exact remote command line. Pure — exported for tests and for the
 * technical documentation's examples.
 */
export function buildRemoteCommand(sudoUser: string, tool: RemoteTool, args: string[]): string {
  if (!(REMOTE_TOOLS as readonly string[]).includes(tool)) {
    throw new MaildirRemoteError(
      `Remote tool "${String(tool)}" is not allowed.`,
      'unsafe_argument',
    );
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sudoUser)) {
    throw new MaildirRemoteError('Invalid sudo user.', 'unsafe_argument');
  }
  const quoted = args.map(shQuote).join(' ');
  return `LC_ALL=C sudo -n -u ${shQuote(sudoUser)} ${shQuote(`/usr/bin/${tool}`)}${quoted ? ` ${quoted}` : ''}`;
}

/** ssh argv (without the `ssh` binary itself). Pure — exported for tests. */
export function buildSshArgs(
  config: Pick<MaildirConfig, 'sshHost' | 'connectTimeoutSeconds'>,
  remoteCommand: string,
): string[] {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,252}$/.test(config.sshHost)) {
    throw new MaildirRemoteError('Invalid maildir.ssh_host.', 'unsafe_argument');
  }
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${String(config.connectTimeoutSeconds)}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'RequestTTY=no',
    '--',
    config.sshHost,
    remoteCommand,
  ];
}

export function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 300);
}

/** Classify a finished command; throws for transport / sudo failures. */
export function assertRemoteOk(result: RemoteRunResult): void {
  if (result.timedOut) return; // caller reports partial results
  if (/^sudo: /m.test(result.stderr)) {
    throw new MaildirRemoteError(
      'The mail server refused the sudo command (the read-only sudo rule may be missing or ' +
        `changed): ${firstLine(result.stderr)}`,
      'sudo_denied',
    );
  }
  if (result.exitCode === 255) {
    throw new MaildirRemoteError(
      `SSH to the mail server failed: ${firstLine(result.stderr) || 'exit 255'}`,
      'ssh_failed',
    );
  }
}

/** Real runner: spawns the local `ssh` client. */
export class SshRemoteRunner implements RemoteRunner {
  constructor(
    private readonly config: Pick<MaildirConfig, 'sshHost' | 'connectTimeoutSeconds' | 'sudoUser'>,
    private readonly sshBinary = 'ssh',
  ) {}

  async run(tool: RemoteTool, args: string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    const command = buildRemoteCommand(this.config.sudoUser, tool, args);
    const sshArgs = buildSshArgs(this.config, command);

    return new Promise((resolve, reject) => {
      const child = spawn(this.sshBinary, sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let stderr = '';
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const kill = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      };

      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        Math.max(1, options.timeoutMs),
      );
      timer.unref();

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = options.maxBytes - bytes;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, Math.max(0, room)));
          bytes += Math.max(0, room);
          truncated = true;
          kill();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) {
          stderr += chunk.toString('utf-8').slice(0, STDERR_CAP - stderr.length);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(new MaildirRemoteError(`Could not start ssh: ${err.message}`, 'ssh_failed'));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          stdout: Buffer.concat(chunks, bytes),
          stderr,
          exitCode: code,
          timedOut,
          truncated,
        });
      });
    });
  }
}
