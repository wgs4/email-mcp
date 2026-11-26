import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MaildirConfig } from '../../types/index.js';
import { MaildirInputError } from './errors.js';
import MaildirService from './maildir.service.js';
import type { RemoteRunner, RemoteRunOptions, RemoteRunResult, RemoteTool } from './remote.js';
import { buildRemoteCommand, REMOTE_TOOLS } from './remote.js';

const ROOT = '/var/vmail';

const config: MaildirConfig = {
  enabled: true,
  sshHost: 'mailserver',
  root: ROOT,
  sudoUser: 'vmail',
  allowedDomains: [],
  excludedDomains: [],
  allowedUsers: [],
  excludedUsers: [],
  connectTimeoutSeconds: 10,
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 120,
  maxResults: 100,
  maxOutputBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxBodyChars: 5000,
  concurrency: 2,
};

const DIRS = [
  'wgsusa.com/justin/Maildir/cur',
  'wgsusa.com/justin/Maildir/new',
  'wgsusa.com/justin/Maildir/.Archive/cur',
  'wgsusa.com/lisa/Maildir/cur',
  'wgsusa.com/lisa/Maildir/.spam/cur',
  'wgsusa.com/jesse/Maildir/jesse/cur', // odd non-Dovecot dir: ignored
  'allpedal.com/info/Maildir/cur',
];

const JUSTIN_HIT = `${ROOT}/wgsusa.com/justin/Maildir/cur/1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,RSa`;
const JUSTIN_FOLDED = `${ROOT}/wgsusa.com/justin/Maildir/.Archive/cur/1742000000.M1P1.server-5.wgsusa.com,S=1000:2,S`;
const JUSTIN_FALSE = `${ROOT}/wgsusa.com/justin/Maildir/cur/1741000000.M2P2.server-5.wgsusa.com,S=900:2,S`;
const LISA_HIT = `${ROOT}/wgsusa.com/lisa/Maildir/cur/1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,S`;

const HEADERS: Record<string, string[]> = {
  [JUSTIN_HIT]: [
    'From: Rita  <sales1hongyuan@163.com>',
    'To: "Lisa Hall" <lisa@wgsusa.com>',
    'Message-ID: <333998fb@163.com>',
    'Date: Wed, 19 Mar 2025 13:28:28 +0800 (CST)',
    'Subject:  ***SPAM***  Re:PO208780-WGS Paypal  invoice   Mar 19th 2025',
    '',
  ],
  [LISA_HIT]: [
    'From: Rita  <sales1hongyuan@163.com>',
    'Subject:  ***SPAM***  Re:PO208780-WGS Paypal  invoice   Mar 19th 2025',
    '',
  ],
  [JUSTIN_FOLDED]: [
    'From: x@y.com',
    'Subject: a long subject that is folded',
    '\tonto PO208780 here',
    '',
  ],
  // Continuation hit inside a Received header only — must be dropped.
  [JUSTIN_FALSE]: ['Received: from a', '\tby PO208780.example', 'Subject: unrelated', ''],
};

const NAME_LINES: Record<string, string[]> = {
  [JUSTIN_HIT]: [
    '\tname="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
    ' filename="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
  ],
};

function res(stdout: Buffer | string, extra: Partial<RemoteRunResult> = {}): RemoteRunResult {
  return {
    stdout: typeof stdout === 'string' ? Buffer.from(stdout, 'latin1') : stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
    ...extra,
  };
}

function nulLines(map: Record<string, string[]>, paths: string[]): string {
  return paths
    .filter((p) => map[p])
    .map((p) => map[p].map((l) => `${p}\u0000${l}\n`).join(''))
    .join('');
}

const GBK_MESSAGE = [
  'From: Rita <sales1hongyuan@163.com>',
  'To: Lisa <lisa@wgsusa.com>',
  'Subject: Re:PO208780-WGS',
  'Message-ID: <333998fb@163.com>',
  'Date: Wed, 19 Mar 2025 13:28:28 +0800',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello Lisa, drawing attached.',
  '--B',
  'Content-Type: application/pdf;',
  '\tname="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
  'Content-Disposition: attachment;',
  ' filename="=?GBK?Q?RV9110NO-FB12.5A7.0_=CD=E2=D0=CE=CD=BC.pdf?="',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--B--',
  '',
].join('\r\n');

const LONG_HTML = `<html><body>${'x'.repeat(50_000)}</body></html>`;

function htmlMessage(html: string): string {
  return [
    'From: UPS <billing@ups.com>',
    'To: Lisa <lisa@wgsusa.com>',
    'Subject: Invoice Now Available',
    'Message-ID: <ups-invoice@example.com>',
    'Date: Wed, 19 Mar 2025 13:28:28 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="HTMLB"',
    '',
    '--HTMLB',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Invoice available.',
    '--HTMLB',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--HTMLB--',
    '',
  ].join('\r\n');
}

const HTML_MESSAGE = htmlMessage(LONG_HTML);

const PLAIN_MESSAGE = [
  'From: UPS <billing@ups.com>',
  'To: Lisa <lisa@wgsusa.com>',
  'Subject: Plain notice',
  'Date: Wed, 19 Mar 2025 13:28:28 +0800',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'No HTML here.',
  '',
].join('\r\n');

interface Call {
  tool: RemoteTool;
  args: string[];
}

class FakeRunner implements RemoteRunner {
  calls: Call[] = [];

  // eslint-disable-next-line class-methods-use-this
  primary: (args: string[]) => RemoteRunResult = (args) => {
    const paths = args.filter((a) => a.startsWith(`${ROOT}/`));
    const out: string[] = [];
    if (paths.some((p) => p.includes('/justin/'))) {
      out.push(`${JUSTIN_HIT}\u0000Subject:  ***SPAM***  Re:PO208780\n`);
      out.push(`${JUSTIN_FOLDED}\u0000\tonto PO208780\n`);
      out.push(`${JUSTIN_FALSE}\u0000\tby PO208780\n`);
    }
    if (paths.some((p) => p.includes('/lisa/'))) {
      out.push(`${LISA_HIT}\u0000Subject:  ***SPAM***  Re:PO208780\n`);
      // Output for a file outside this mailbox must be ignored.
      out.push(`${JUSTIN_HIT}\u0000Subject: injected\n`);
      out.push('/etc/passwd\u0000Subject: x\n');
    }
    return res(out.join(''));
  };

  message = GBK_MESSAGE;

  run = async (tool: RemoteTool, args: string[], _o: RemoteRunOptions) => {
    // Every call must build a valid, allow-listed, fully quoted command.
    expect(REMOTE_TOOLS).toContain(tool);
    expect(() => buildRemoteCommand('vmail', tool, args)).not.toThrow();
    this.calls.push({ tool, args });
    if (tool === 'find' && args.includes('-prune')) {
      return res(DIRS.map((d) => `${ROOT}/${d}\u0000`).join(''));
    }
    if (tool === 'find' && args.includes('-exec')) return this.primary(args);
    if (tool === 'find' && args.includes('-print0')) {
      const base = args[args.indexOf('-name') + 1].replace(/\\/g, '');
      const hit = [JUSTIN_HIT, LISA_HIT].find((p) => p.split('/').pop()?.startsWith(base));
      return res(hit ? `${hit}\u0000` : '');
    }
    if (tool === 'grep' && args.includes('-B')) return res(nulLines(HEADERS, args));
    if (tool === 'grep' && args.includes('-m') && args.includes('400')) {
      return res(nulLines(NAME_LINES, args));
    }
    if (tool === 'grep' && args.includes('-l')) {
      // secondary attachment filter, or full-text confirmation of index candidates
      return res(args.includes(JUSTIN_HIT) ? `${JUSTIN_HIT}\u0000` : '');
    }
    if (tool === 'grep' && args.includes('-o')) {
      // Header confirmation. A Received-only continuation is not a real hit.
      const paths = args.filter((a) => HEADERS[a] && a !== JUSTIN_FALSE);
      return res(paths.map((p) => `${p}\u0000Subject: confirmed\n`).join(''));
    }
    if (tool === 'head') return res(Buffer.from(this.message, 'utf-8'));
    throw new Error(`unexpected call ${tool} ${args.join(' ')}`);
  };
}

function make(runner = new FakeRunner(), cfg: Partial<MaildirConfig> = {}) {
  const auditLog = vi.fn(async () => {});
  const svc = new MaildirService({ ...config, ...cfg }, runner, auditLog);
  return { svc, runner, auditLog };
}

describe('MaildirService.search', () => {
  it('finds the known message in justin and lisa, verifies folded hits, drops false ones', async () => {
    const { svc, auditLog } = make();
    const r = await svc.search({ query: 'PO208780' });
    expect(r.complete).toBe(true);
    expect(r.partial_reasons).toEqual([]);
    const ids = r.results.map((x) => x.id);
    expect(ids).toEqual([
      // newest first (file-name time), then path order
      JUSTIN_HIT.slice(ROOT.length + 1),
      LISA_HIT.slice(ROOT.length + 1),
      JUSTIN_FOLDED.slice(ROOT.length + 1),
    ]);
    expect(ids).not.toContain(JUSTIN_FALSE.slice(ROOT.length + 1));
    const top = r.results[0];
    expect(top).toMatchObject({
      mailbox: 'justin@wgsusa.com',
      folder: 'INBOX',
      from: 'Rita  <sales1hongyuan@163.com>',
      message_id: '<333998fb@163.com>',
      saved_at: '2025-03-19T05:31:12.000Z',
      attachments: ['RV9110NO-FB12.5A7.0 外形图.pdf'],
    });
    expect(r.scope.mailboxes).toBe(3); // justin, lisa, info (jesse has only the odd dir)
    expect(auditLog).toHaveBeenCalledWith(
      'maildir_search',
      'maildir',
      expect.objectContaining({ hits: 3, complete: true }),
      'ok',
      undefined,
    );
  });

  it('builds a header-only grep that stops at the blank line', async () => {
    const { svc, runner } = make();
    await svc.search({
      query: 'PO208780',
      users: ['justin'],
      since: '2025-03-01',
      before: '2025-04-01',
    });
    const primary = runner.calls.find((c) => c.args.includes('-exec'));
    expect(primary?.args).toEqual(
      expect.arrayContaining([
        '-newermt',
        '2025-03-01',
        '!',
        '-newermt',
        '2025-04-01',
        '-m',
        '1',
        '-o',
      ]),
    );
    expect(
      primary?.args.filter((a) => a.startsWith(ROOT)).every((a) => a.includes('/justin/')),
    ).toBe(true);
  });

  it('applies attachment_name as a remote filter', async () => {
    const { svc } = make();
    const r = await svc.search({ query: 'PO208780', attachment_name: 'RV9110NO' });
    expect(r.results.map((x) => x.mailbox)).toEqual(['justin@wgsusa.com']);
  });

  it('pages from the cache without re-scanning', async () => {
    const { svc, runner } = make();
    const p1 = await svc.search({ query: 'PO208780', limit: 2 });
    expect(p1.next_offset).toBe(2);
    const scans = runner.calls.filter((c) => c.args.includes('-exec')).length;
    const p2 = await svc.search({ query: 'PO208780', limit: 2, offset: 2 });
    expect(p2.from_cache).toBe(true);
    expect(p2.returned).toBe(1);
    expect(p2.next_offset).toBeNull();
    expect(runner.calls.filter((c) => c.args.includes('-exec')).length).toBe(scans);
  });

  it('reports a timed-out mailbox as partial, never as complete', async () => {
    const runner = new FakeRunner();
    runner.primary = (args) =>
      args.some((a) => a.includes('/lisa/'))
        ? res('', { timedOut: true, exitCode: null })
        : res('');
    const { svc } = make(runner);
    const r = await svc.search({ query: 'nothing-here' });
    expect(r.complete).toBe(false);
    expect(r.total_hits).toBe(0);
    expect(r.partial_reasons.join(' ')).toMatch(/lisa@wgsusa.com: timed out/);
    expect(r.scope.mailboxes_not_searched).toContain('lisa@wgsusa.com');
  });

  it('reports a truncated output as partial', async () => {
    const runner = new FakeRunner();
    const orig = runner.primary;
    runner.primary = (args) => ({ ...orig(args), truncated: true });
    const { svc } = make(runner);
    const r = await svc.search({ query: 'PO208780' });
    expect(r.complete).toBe(false);
    expect(r.partial_reasons.join(' ')).toMatch(/output cap/);
  });

  it('reports the result cap as partial', async () => {
    const { svc } = make(undefined, { maxResults: 1 });
    const r = await svc.search({ query: 'PO208780' });
    expect(r.total_hits).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.partial_reasons.join(' ')).toMatch(/Result cap reached/);
  });

  it('marks grep errors as partial but renamed files only as a warning', async () => {
    const runner = new FakeRunner();
    runner.primary = (args) =>
      args.some((a) => a.includes('/lisa/'))
        ? res('', { stderr: '/usr/bin/grep: /var/vmail/x: No such file or directory\n' })
        : res('', { stderr: '/usr/bin/grep: /var/vmail/y: Permission denied\n' });
    const { svc } = make(runner);
    const r = await svc.search({ query: 'x' });
    expect(r.complete).toBe(false);
    expect(r.partial_reasons.join(' ')).toMatch(/Permission denied/);
    expect(r.warnings.join(' ')).toMatch(/renamed or moved/);
  });

  it('does not cache partial results', async () => {
    const runner = new FakeRunner();
    runner.primary = () => res('', { timedOut: true, exitCode: null });
    const { svc } = make(runner);
    await svc.search({ query: 'x' });
    const r2 = await svc.search({ query: 'x' });
    expect(r2.from_cache).toBe(false);
  });

  it('scopes by domain, user and folder globs, and honours config exclusions', async () => {
    const { svc, runner } = make(undefined, { excludedUsers: ['justin@wgsusa.com'] });
    await svc.search({ query: 'x', domains: ['wgsusa.com'], folders: ['INBOX', 'sp*'] });
    const scanned = runner.calls
      .filter((c) => c.args.includes('-exec'))
      .flatMap((c) => c.args.filter((a) => a.startsWith(ROOT)));
    expect(scanned.sort()).toEqual([
      `${ROOT}/wgsusa.com/lisa/Maildir/.spam/cur`,
      `${ROOT}/wgsusa.com/lisa/Maildir/cur`,
    ]);
  });

  it('refuses an empty scope instead of returning zero hits', async () => {
    const { svc } = make();
    await expect(svc.search({ query: 'x', users: ['nobody'] })).rejects.toThrow(
      /Nothing was searched/,
    );
  });

  it.each([
    [{}, /at least one/],
    [{ query: 'a\nb' }, /NUL, CR or LF/],
    [{ query: 'x', since: '2025-13-45' }, /YYYY-MM-DD/],
    [{ query: 'x', since: "2025-01-01'; id" }, /YYYY-MM-DD/],
    [{ query: '(', regex: true }, /Invalid regex/],
    [{ query: 'x', domains: ['../etc'] }, /Invalid domain/],
    [{ query: 'x', users: ["a';id"] }, /Invalid user/],
  ])('rejects bad input %j', async (input, msg) => {
    const { svc } = make();
    await expect(svc.search(input)).rejects.toThrow(msg);
    await expect(svc.search(input)).rejects.toBeInstanceOf(MaildirInputError);
  });

  it('full_text uses a byte-escaped PCRE with every term variant', async () => {
    const { svc, runner } = make();
    await svc.search({ query: '外形图', mode: 'full_text', users: ['lisa'] });
    const primary = runner.calls.find((c) => c.args.includes('-exec'));
    expect(primary?.args).toEqual(expect.arrayContaining(['-P', '-l']));
    const pattern = primary?.args[primary.args.indexOf('-e') + 1] ?? '';
    expect(pattern).toContain('\\xe5\\xa4\\x96'); // raw UTF-8
    expect(pattern).toContain('\\x3dE5\\x3dA4\\x3d96'); // Q-encoded
    expect(pattern).toContain('\\x25E5\\x25A4\\x2596'); // %-encoded
  });

  it.each([
    ';',
    '+',
    '{}',
    'a{}b',
  ])('never lets a fixed term end or alter find -exec (%j)', async (term) => {
    const { svc, runner } = make();
    await svc.search({ query: term, mode: 'full_text', users: ['lisa'] });
    const primary = runner.calls.find((c) => c.args.includes('-exec'));
    const execArgs = primary?.args.slice(primary.args.indexOf('-exec') + 1) ?? [];
    // Only the final placeholder may be "{}" and only the last arg "+".
    expect(execArgs.slice(-2)).toEqual(['{}', '+']);
    expect(execArgs.slice(0, -2).some((a) => a === ';' || a === '+' || a.includes('{}'))).toBe(
      false,
    );
  });

  it('refuses a regex that would put "{}" into find -exec', async () => {
    const { svc } = make();
    await expect(
      svc.search({ query: 'a{}', regex: true, mode: 'full_text', users: ['lisa'] }),
    ).rejects.toThrow(/find -exec/);
  });

  it('a failing mailbox is reported as not searched; the others still return', async () => {
    const runner = new FakeRunner();
    const orig = runner.primary;
    runner.primary = (args) =>
      args.some((a) => a.includes('/lisa/'))
        ? res('', { exitCode: 255, stderr: 'ssh: Connection reset' })
        : orig(args);
    const { svc } = make(runner);
    const r = await svc.search({ query: 'PO208780' });
    expect(r.complete).toBe(false);
    expect(r.scope.mailboxes_not_searched).toEqual(['lisa@wgsusa.com']);
    expect(r.partial_reasons.join(' ')).toMatch(/lisa@wgsusa.com: not searched: SSH/);
    expect(r.results.map((x) => x.mailbox)).toContain('justin@wgsusa.com');
  });

  it('a remote command killed on the server makes the result partial', async () => {
    const runner = new FakeRunner();
    runner.primary = () => res('', { exitCode: 137 });
    const { svc } = make(runner);
    const r = await svc.search({ query: 'x' });
    expect(r.complete).toBe(false);
    expect(r.partial_reasons.join(' ')).toMatch(/abnormally \(exit 137\)/);
  });

  it('login banners on stderr are warnings, not partial results', async () => {
    const runner = new FakeRunner();
    const orig = runner.primary;
    runner.primary = (args) => ({ ...orig(args), stderr: 'Authorized use only\n' });
    const { svc } = make(runner);
    const r = await svc.search({ query: 'PO208780' });
    expect(r.complete).toBe(true);
    expect(r.warnings).toContain('Server said: Authorized use only');
  });

  it('attachment names are null (unknown), not [], for a file that vanished', async () => {
    const runner = new FakeRunner();
    const origRun = runner.run;
    runner.run = async (tool, args, o) => {
      if (tool === 'grep' && args.includes('400')) {
        return res('', {
          exitCode: 2,
          stderr: `/usr/bin/grep: ${LISA_HIT}: No such file or directory\n`,
        });
      }
      return origRun(tool, args, o);
    };
    const { svc } = make(runner);
    const r = await svc.search({ query: 'PO208780', users: ['lisa'] });
    expect(r.results[0].attachments).toBeNull();
  });

  it('audits a failed search as an error', async () => {
    const { svc, auditLog } = make();
    await expect(svc.search({ query: 'x', users: ['nobody'] })).rejects.toThrow();
    expect(auditLog).toHaveBeenCalledWith(
      'maildir_search',
      'maildir',
      expect.anything(),
      'error',
      expect.stringMatching(/Nothing was searched/),
    );
  });
});

describe('MaildirService.getEmail / saveAttachment', () => {
  const ID = JUSTIN_HIT.slice(ROOT.length + 1);

  it('reads, parses and size-caps one message', async () => {
    const { svc, runner } = make();
    const r = await svc.getEmail(ID, { maxBodyChars: 100 });
    expect(r).toMatchObject({
      id: ID,
      mailbox: 'justin@wgsusa.com',
      message_truncated: false,
      headers: { subject: 'Re:PO208780-WGS', message_id: '<333998fb@163.com>' },
      attachments: [
        { index: 0, filename: 'RV9110NO-FB12.5A7.0 外形图.pdf', content_type: 'application/pdf' },
      ],
    });
    expect(String(r.text)).toContain('drawing attached');
    const head = runner.calls.find((c) => c.tool === 'head');
    expect(head?.args).toEqual(['-c', String(config.maxMessageBytes + 1), '--', JUSTIN_HIT]);
  });

  it('follows a flag rename via the stable base name', async () => {
    const { svc } = make();
    const stale = ID.replace(':2,RSa', ':2,S');
    const r = await svc.getEmail(stale);
    expect(r.id).toBe(ID);
  });

  it('refuses ids outside the root before any remote call', async () => {
    const { svc, runner } = make();
    await expect(svc.getEmail('/etc/passwd')).rejects.toThrow(/outside/);
    await expect(svc.getEmail('wgsusa.com/justin/Maildir/cur/../../x')).rejects.toThrow();
    expect(runner.calls).toHaveLength(0);
  });

  it('saves an attachment under tmp, never overwriting by default', async () => {
    const { svc } = make();
    const dir = await mkdtemp(join(tmpdir(), 'maildir-save-'));
    const a = await svc.saveAttachment({
      id: ID,
      filename: 'RV9110NO-FB12.5A7.0 外形图.pdf',
      destination: dir,
    });
    expect(a.path).toBe(join(dir, 'RV9110NO-FB12.5A7.0 外形图.pdf'));
    expect(await readFile(String(a.path), 'utf-8')).toBe('%PDF-1.4 fake');
    const b = await svc.saveAttachment({ id: ID, index: 0, destination: dir });
    expect(b.path).toBe(join(dir, 'RV9110NO-FB12.5A7.0 外形图-1.pdf'));
  });

  it('refuses to write through a symlinked directory or file', async () => {
    const { svc } = make();
    const dir = await mkdtemp(join(tmpdir(), 'maildir-link-'));
    await symlink('/etc', join(dir, 'etc-link'));
    await expect(
      svc.saveAttachment({ id: ID, index: 0, destination: join(dir, 'etc-link', 'x.pdf') }),
    ).rejects.toThrow(/outside the home and tmp/);
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'keep');
    await symlink(victim, join(dir, 'a.pdf'));
    await expect(
      svc.saveAttachment({ id: ID, index: 0, destination: join(dir, 'a.pdf'), overwrite: true }),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(victim, 'utf-8')).toBe('keep');
  });

  it('refuses destinations outside home/tmp', async () => {
    const { svc } = make();
    await expect(
      svc.saveAttachment({ id: ID, index: 0, destination: '/etc/x.pdf' }),
    ).rejects.toThrow(/outside the user's home/);
  });

  it('refuses a message larger than max_message_bytes', async () => {
    const runner = new FakeRunner();
    runner.message = `${GBK_MESSAGE}${'x'.repeat(70 * 1024)}`;
    const { svc } = make(runner, { maxMessageBytes: 64 * 1024 });
    await expect(svc.saveAttachment({ id: ID, index: 0, destination: tmpdir() })).rejects.toThrow(
      /larger than max_message_bytes/,
    );
  });

  it('omits html fields by default but still reports has_html', async () => {
    const runner = new FakeRunner();
    runner.message = HTML_MESSAGE;
    const { svc } = make(runner);
    const omitted = await svc.getEmail(ID);
    const explicit = await svc.getEmail(ID, { includeHtml: false });
    [omitted, explicit].forEach((r) => {
      expect(r.has_html).toBe(true);
      expect(r).not.toHaveProperty('html');
      expect(r).not.toHaveProperty('html_truncated');
      expect(r).not.toHaveProperty('html_length');
    });
  });

  it('returns the exact original HTML even when longer than 20,000 chars', async () => {
    const runner = new FakeRunner();
    runner.message = HTML_MESSAGE;
    const { svc } = make(runner);
    expect(LONG_HTML.length).toBeGreaterThan(20_000);
    const r = await svc.getEmail(ID, { includeHtml: true });
    expect(r.html).toBe(LONG_HTML);
    expect(r.html_truncated).toBe(false);
    expect(r.html_length).toBe(LONG_HTML.length);
    expect(r.has_html).toBe(true);
  });

  it('caps returned HTML at maxHtmlChars and keeps the full length', async () => {
    const runner = new FakeRunner();
    runner.message = HTML_MESSAGE;
    const { svc } = make(runner);
    const r = await svc.getEmail(ID, { includeHtml: true, maxHtmlChars: 120 });
    expect(r.html).toBe(LONG_HTML.slice(0, 120));
    expect(r.html_truncated).toBe(true);
    expect(r.html_length).toBe(LONG_HTML.length);
  });

  it('returns null html for a plain-text-only message', async () => {
    const runner = new FakeRunner();
    runner.message = PLAIN_MESSAGE;
    const { svc } = make(runner);
    const r = await svc.getEmail(ID, { includeHtml: true });
    expect(r).toMatchObject({
      html: null,
      html_truncated: false,
      html_length: 0,
      has_html: false,
    });
  });
});

describe('indexed direct date sweep', () => {
  const broad = { query: '.*', regex: true, since: '2025-03-01', users: ['justin'], limit: 1 };
  function setup(reply: RemoteRunResult) {
    const runner = new FakeRunner();
    const raw = runner.run;
    const run = vi
      .spyOn(runner, 'run')
      .mockImplementation(async (tool, args, opts) =>
        tool === 'maildir-index-sweep' ? Promise.resolve(reply) : raw(tool, args, opts),
      );
    return { ...make(runner, { indexedSweep: true }), run };
  }

  it('verifies headers and reuses one index pass across pages', async () => {
    const { svc, run } = setup(
      res([JUSTIN_HIT, JUSTIN_FOLDED, 'maildir-index-v1-complete', ''].join('\0')),
    );
    const first = await svc.search(broad);
    const second = await svc.search({ ...broad, offset: 1 });
    expect(first.criteria.indexed_mailboxes).toBe(1);
    expect(first.complete && second.complete).toBe(true);
    expect(first.results[0].id).toBe(JUSTIN_HIT.slice(ROOT.length + 1));
    expect(second.results[0].id).toBe(JUSTIN_FOLDED.slice(ROOT.length + 1));
    expect(run.mock.calls.filter(([tool]) => tool === 'maildir-index-sweep')).toHaveLength(1);
    expect(run.mock.calls.some(([, args]) => args.includes('-exec'))).toBe(false);
  });

  it.each([
    res(''),
    res('', { exitCode: 75 }),
    res('', { truncated: true }),
    res('', { timedOut: true }),
    res([LISA_HIT, 'maildir-index-v1-complete', ''].join('\0')),
  ])('retries the raw scope when the index cannot establish coverage', async (reply) => {
    const { svc, run } = setup(reply);
    const result = await svc.search(broad);
    expect(result.criteria.indexed_mailboxes).toBe(0);
    expect(result.total_hits).toBeGreaterThan(0);
    expect(run.mock.calls.some(([, args]) => args.includes('-exec'))).toBe(true);
  });

  it.each([
    ['headers', 'invoice', 'invoice'],
    ['full_text', 'invoice', 'invoice'],
    ['headers', '590550', '590550'],
    ['full_text', '590550', '590550'],
    ['headers', '$590,550.00', '550,590'],
    ['full_text', '$590,550.00', '550,590'],
  ] as const)('confirms %s search %s on index candidates only', async (mode, query, tokens) => {
    const { svc, run } = setup(
      res([JUSTIN_HIT, JUSTIN_FALSE, 'maildir-index-v1-complete', ''].join('\0')),
    );
    const result = await svc.search({ ...broad, regex: false, mode, query });
    const sweeps = run.mock.calls.filter(([tool]) => tool === 'maildir-index-sweep');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0][1].slice(0, 5)).toEqual([
      '--fts',
      mode,
      mode === 'headers' ? 'from,to,cc,subject' : '',
      tokens,
      'justin@wgsusa.com',
    ]);
    const confirming = run.mock.calls.filter(
      ([tool, args]) =>
        tool === 'grep' &&
        args.includes(JUSTIN_HIT) &&
        !args.includes('-B') &&
        !(args.includes('-m') && args.includes('400')),
    );
    expect(confirming.length).toBeGreaterThan(0);
    expect(confirming.every(([, args]) => !args.includes('-exec'))).toBe(true);
    expect(run.mock.calls.some(([, args]) => args.includes('-exec'))).toBe(false);
    expect(result.results.map((row) => row.id)).toEqual([JUSTIN_HIT.slice(ROOT.length + 1)]);
    expect(result.criteria).toMatchObject({
      indexed_mailboxes: 1,
      raw_mailboxes: 0,
      indexed_candidates: 2,
      indexed_hits: 1,
      mailbox_backends: { 'justin@wgsusa.com': 'index' },
    });
    expect(result.scope.mailbox_backends).toEqual({ 'justin@wgsusa.com': 'index' });
    expect(result.scope.indexed_hits).toBe(1);
  });

  it('falls back to the raw scan when the index helper fails', async () => {
    const { svc, run } = setup(res('', { exitCode: 75 }));
    const result = await svc.search({ ...broad, regex: false, query: 'invoice' });
    expect(run.mock.calls.some(([tool]) => tool === 'maildir-index-sweep')).toBe(true);
    expect(run.mock.calls.some(([, args]) => args.includes('-exec'))).toBe(true);
    expect(result.total_hits).toBeGreaterThan(0);
    expect(result.criteria).toMatchObject({
      indexed_mailboxes: 0,
      raw_mailboxes: 1,
      mailbox_backends: { 'justin@wgsusa.com': 'raw' },
    });
  });

  it('keeps non-indexable terms on the raw route', async () => {
    const cases: {
      query: string;
      regex: boolean;
      fields?: 'delivered-to'[];
    }[] = [
      { query: '外形图', regex: false },
      { query: 'ab', regex: false },
      { query: 'invoice', regex: false, fields: ['delivered-to'] },
      { query: 'PO2087[0-9]{2}', regex: true },
    ];
    for (const extra of cases) {
      const { svc, run } = setup(res(''));
      // eslint-disable-next-line no-await-in-loop
      await svc.search({ ...broad, ...extra });
      expect(run.mock.calls.some(([tool]) => tool === 'maildir-index-sweep')).toBe(false);
      expect(run.mock.calls.some(([, args]) => args.includes('-exec'))).toBe(true);
    }
  });

  it('records index and raw backends for different mailboxes', async () => {
    const runner = new FakeRunner();
    const raw = runner.run.bind(runner);
    vi.spyOn(runner, 'run').mockImplementation(async (tool, args, opts) => {
      if (tool === 'maildir-index-sweep') {
        if (args[4] === 'lisa@wgsusa.com') return res('', { exitCode: 75 });
        return res([JUSTIN_HIT, 'maildir-index-v1-complete', ''].join('\0'));
      }
      return raw(tool, args, opts);
    });
    const svc = new MaildirService(
      { ...config, indexedSweep: true },
      runner,
      vi.fn(async () => {}),
    );
    const result = await svc.search({
      query: 'invoice',
      regex: false,
      since: '2025-03-01',
      users: ['justin', 'lisa'],
      limit: 10,
    });
    expect(result.scope.mailbox_backends).toEqual({
      'justin@wgsusa.com': 'index',
      'lisa@wgsusa.com': 'raw',
    });
    expect(result.criteria.indexed_mailboxes).toBe(1);
    expect(result.criteria.raw_mailboxes).toBe(1);
    expect(result.scope.indexed_mailboxes).toBe(1);
    expect(result.scope.raw_mailboxes).toBe(1);
    expect(result.results.some((row) => row.mailbox === 'justin@wgsusa.com')).toBe(true);
    expect(result.results.some((row) => row.mailbox === 'lisa@wgsusa.com')).toBe(true);
  });

  it('falls back when a candidate file vanishes during confirmation', async () => {
    const runner = new FakeRunner();
    const raw = runner.run.bind(runner);
    vi.spyOn(runner, 'run').mockImplementation(async (tool, args, opts) => {
      if (tool === 'maildir-index-sweep') {
        return res([JUSTIN_HIT, 'maildir-index-v1-complete', ''].join('\0'));
      }
      if (
        tool === 'grep' &&
        args.includes('-o') &&
        args.includes(JUSTIN_HIT) &&
        !args.includes('-B')
      ) {
        return res('', { exitCode: 2, stderr: 'grep: file: No such file or directory\n' });
      }
      return raw(tool, args, opts);
    });
    const svc = new MaildirService(
      { ...config, indexedSweep: true },
      runner,
      vi.fn(async () => {}),
    );
    const result = await svc.search({ ...broad, regex: false, query: 'invoice' });
    expect(result.complete).toBe(true);
    expect(result.total_hits).toBeGreaterThan(0);
    expect(result.scope.mailbox_backends).toEqual({ 'justin@wgsusa.com': 'raw' });
    expect(result.criteria.indexed_mailboxes).toBe(0);
    expect(result.criteria.raw_mailboxes).toBe(1);
  });
});
