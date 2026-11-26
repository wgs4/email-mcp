#!/usr/bin/env node
/**
 * Compare raw and indexed maildir searches.
 *
 *   node scripts/benchmark-maildir-index.mjs --self-test
 *   node scripts/benchmark-maildir-index.mjs --run-live \
 *     --normal-since 2025-03-01 --normal-before 2025-03-02 \
 *     --busy-since 2025-03-19 --busy-before 2025-03-20 \
 *     --archive-since 2024-01-01 --archive-before 2024-02-01
 *
 * --self-test uses an in-process runner and does not open SSH.
 * A live run requires --run-live plus all six date bounds.
 */

import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

const ROOT = '/var/vmail';
const DAVID = `${ROOT}/wgsusa.com/david/Maildir/cur/1742362272.M1P1.host,S=100:2,S`;
const KAYLA = `${ROOT}/wgsusa.com/kayla/Maildir/.Archive/cur/1742000000.M2P2.host,S=80:2,S`;

const MESSAGES = [
  {
    path: DAVID,
    relDir: 'wgsusa.com/david/Maildir/cur',
    headers: [
      'From: David <david@wgsusa.com>',
      'To: Kayla <kayla@wgsusa.com>',
      'Subject: Invoice 590550',
      'Message-ID: <invoice-590550@wgsusa.com>',
      '',
    ],
    body: 'Amount 590550 is due. invoice attached.',
  },
  {
    path: KAYLA,
    relDir: 'wgsusa.com/kayla/Maildir/.Archive/cur',
    headers: [
      'From: Kayla <kayla@wgsusa.com>',
      'To: David <david@wgsusa.com>',
      'Subject: Archive note',
      'Message-ID: <archive-note@wgsusa.com>',
      '',
    ],
    body: 'No payment in this note.',
  },
];

function parseArgs(argv) {
  const flags = {
    sshHost: 'mailreader@mailserver',
    root: '/var/vmail',
    sudoUser: 'vmail',
    users: [],
    domains: [],
    normalSince: '2025-03-01',
    normalBefore: '2025-04-01',
    busySince: '2025-03-15',
    busyBefore: '2025-03-20',
    archiveSince: '2025-01-01',
    archiveBefore: '2025-06-01',
    amount: '590550',
    word: 'invoice',
    iterations: 3,
    jsonOut: '',
    selfTest: false,
    runLive: false,
    datesSet: new Set(),
  };
  const take = {
    '--ssh-host': 'sshHost',
    '--root': 'root',
    '--sudo-user': 'sudoUser',
    '--normal-since': 'normalSince',
    '--normal-before': 'normalBefore',
    '--busy-since': 'busySince',
    '--busy-before': 'busyBefore',
    '--archive-since': 'archiveSince',
    '--archive-before': 'archiveBefore',
    '--amount': 'amount',
    '--word': 'word',
    '--json-out': 'jsonOut',
  };
  const dateFlags = new Set([
    '--normal-since',
    '--normal-before',
    '--busy-since',
    '--busy-before',
    '--archive-since',
    '--archive-before',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') flags.selfTest = true;
    else if (arg === '--run-live') flags.runLive = true;
    else if (arg === '--users' || arg === '--domains') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      const key = arg === '--users' ? 'users' : 'domains';
      flags[key] = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      i += 1;
    } else if (arg === '--iterations') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--iterations must be a positive integer');
      flags.iterations = value;
      i += 1;
    } else if (take[arg]) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      flags[take[arg]] = value;
      if (dateFlags.has(arg)) flags.datesSet.add(arg);
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return flags;
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function baseName(id) {
  const file = id.split('/').pop() ?? id;
  const cut = file.indexOf(':2,');
  return cut >= 0 ? file.slice(0, cut) : file;
}

function fingerprint(result) {
  return {
    complete: result.complete,
    total_hits: result.total_hits,
    ids: result.results.map((row) => baseName(row.id)),
    headers: result.results.map((row) => ({
      from: row.from,
      to: row.to,
      subject: row.subject,
      message_id: row.message_id,
      saved_at: row.saved_at,
    })),
  };
}

function backendsAre(result, expected) {
  const backends = result.scope?.mailbox_backends ?? {};
  const values = Object.values(backends);
  return values.length > 0 && values.every((value) => value === expected);
}

function ok(stdout) {
  return {
    stdout: Buffer.from(stdout),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
  };
}

function messageText(message, full) {
  const headers = message.headers.join('\n');
  return full ? `${headers}\n${message.body}` : headers;
}

function matches(message, args, flags) {
  const full = args.includes('-l') && !args.includes('-o');
  const blob = messageText(message, full).toLowerCase();
  // Header patterns always contain `.*?`. Only the broad date census wraps
  // the user term as `(?:.*)`.
  if (args.some((arg) => arg === '.*' || arg.includes('(?:.*)'))) return true;
  const needles = [flags.word, flags.amount].filter((term) =>
    args.some((arg) => arg.toLowerCase().includes(term.toLowerCase())),
  );
  if (needles.length === 0) return false;
  return needles.every((term) => blob.includes(term.toLowerCase()));
}

function createSyntheticRunner(flags) {
  const calls = [];
  return {
    calls,
    async run(tool, args) {
      calls.push({ tool, args: [...args] });
      if (tool === 'find' && args.includes('-prune')) {
        return ok(MESSAGES.map((message) => `${ROOT}/${message.relDir}\0`).join(''));
      }
      if (tool === 'find' && args.includes('-exec')) {
        const dirs = args.filter((arg) => arg.startsWith(`${ROOT}/`));
        const hits = MESSAGES.filter(
          (message) =>
            dirs.some((dir) => message.path.startsWith(`${dir}/`)) && matches(message, args, flags),
        );
        if (args.includes('-o')) return ok(hits.map((message) => `${message.path}\0Subject: hit\n`).join(''));
        return ok(hits.map((message) => `${message.path}\0`).join(''));
      }
      if (tool === 'maildir-index-sweep') {
        const fts = args[0] === '--fts';
        const rels = args.filter((arg) => arg.includes('/Maildir/'));
        let hits = MESSAGES.filter((message) => rels.includes(message.relDir));
        if (fts) {
          const tokens = String(args[3] ?? '')
            .split(',')
            .filter((token) => token.length > 0);
          const full = args[1] === 'full_text';
          hits = hits.filter((message) =>
            tokens.every((token) => messageText(message, full).toLowerCase().includes(token)),
          );
        }
        const body = hits.map((message) => message.path).join('\0');
        return ok(`${body}${body ? '\0' : ''}maildir-index-v1-complete\0`);
      }
      if (tool === 'grep' && args.includes('-B')) {
        const lines = [];
        MESSAGES.forEach((message) => {
          if (!args.includes(message.path)) return;
          message.headers.forEach((line) => {
            lines.push(`${message.path}\0${line}\n`);
          });
        });
        return ok(lines.join(''));
      }
      if (tool === 'grep' && args.includes('-m') && args.includes('400')) return ok('');
      if (tool === 'grep') {
        const hits = MESSAGES.filter(
          (message) => args.includes(message.path) && matches(message, args, flags),
        );
        if (args.includes('-l')) return ok(hits.map((message) => `${message.path}\0`).join(''));
        return ok(hits.map((message) => `${message.path}\0Subject: hit\n`).join(''));
      }
      throw new Error(`unexpected synthetic call ${tool}`);
    },
  };
}

function serviceConfig(flags, indexedSweep) {
  return {
    enabled: true,
    sshHost: flags.sshHost,
    root: flags.root,
    sudoUser: flags.sudoUser,
    allowedDomains: [],
    excludedDomains: [],
    allowedUsers: [],
    excludedUsers: [],
    connectTimeoutSeconds: 10,
    defaultTimeoutSeconds: 120,
    maxTimeoutSeconds: 300,
    maxResults: 2000,
    maxOutputBytes: 16 * 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxBodyChars: 5000,
    concurrency: 2,
    indexedSweep,
  };
}

function shapes(flags) {
  const scope = {};
  if (flags.users.length > 0) scope.users = flags.users;
  if (flags.domains.length > 0) scope.domains = flags.domains;
  const census = (name, since, before, extra = {}) => ({
    name,
    mode: 'headers',
    input: {
      ...scope,
      ...extra,
      query: '.*',
      regex: true,
      mode: 'headers',
      since,
      before,
      limit: 50,
    },
    fts: false,
  });
  const term = (name, mode, query) => ({
    name,
    mode,
    input: { ...scope, query, regex: false, mode, limit: 50 },
    fts: true,
  });
  return [
    census('normal_day', flags.normalSince, flags.normalBefore),
    census('busy_day', flags.busySince, flags.busyBefore),
    census('big_archive', flags.archiveSince, flags.archiveBefore, { folders: ['Archive*'] }),
    term('amount_search:headers', 'headers', flags.amount),
    term('amount_search:full_text', 'full_text', flags.amount),
    term('word_search:headers', 'headers', flags.word),
    term('word_search:full_text', 'full_text', flags.word),
  ];
}

async function runOnce(MaildirService, flags, indexedSweep, input, runner) {
  const service = new MaildirService(
    serviceConfig(flags, indexedSweep),
    runner,
    async () => {},
  );
  const started = performance.now();
  const result = await service.search(input);
  return { result, elapsed: result.elapsed_ms ?? performance.now() - started };
}

function assertIndexedProof(shape, calls) {
  const sweeps = calls.filter((call) => call.tool === 'maildir-index-sweep');
  if (sweeps.length === 0) throw new Error(`${shape.name}: indexed run did not call the helper`);
  const usedFts = sweeps.some((call) => call.args[0] === '--fts');
  if (usedFts !== shape.fts) {
    throw new Error(`${shape.name}: expected fts=${String(shape.fts)} but helper fts=${String(usedFts)}`);
  }
  if (!shape.fts) return;
  const confirming = calls.filter(
    (call) =>
      call.tool === 'grep' &&
      call.args.includes(DAVID) &&
      !call.args.includes('-B') &&
      !(call.args.includes('-m') && call.args.includes('400')),
  );
  if (confirming.length === 0) {
    throw new Error(`${shape.name}: indexed run did not grep the candidate file`);
  }
  if (calls.some((call) => call.args.includes('-exec'))) {
    throw new Error(`${shape.name}: indexed run fell back to find -exec`);
  }
}

async function measure(MaildirService, flags, makeRunner) {
  const rows = [];
  let failed = false;
  for (const shape of shapes(flags)) {
    const rawSamples = [];
    const indexedSamples = [];
    let rawResult;
    let indexedResult;
    for (let i = 0; i < flags.iterations; i += 1) {
      const rawRunner = makeRunner(false);
      const raw = await runOnce(MaildirService, flags, false, shape.input, rawRunner);
      rawSamples.push(raw.elapsed);
      rawResult = raw.result;
      const indexedRunner = makeRunner(true);
      const indexed = await runOnce(MaildirService, flags, true, shape.input, indexedRunner);
      indexedSamples.push(indexed.elapsed);
      indexedResult = indexed.result;
      if (flags.selfTest && i === 0) assertIndexedProof(shape, indexedRunner.calls);
    }
    const parity = JSON.stringify(fingerprint(rawResult)) === JSON.stringify(fingerprint(indexedResult));
    const backendOk = backendsAre(rawResult, 'raw') && backendsAre(indexedResult, 'index');
    const okRow = parity && backendOk;
    if (!okRow) failed = true;
    rows.push({
      shape: shape.name,
      mode: shape.mode,
      parity: okRow ? 'ok' : 'MISMATCH',
      raw_p50: quantile(rawSamples, 0.5),
      raw_p95: quantile(rawSamples, 0.95),
      raw_mean: mean(rawSamples),
      indexed_p50: quantile(indexedSamples, 0.5),
      indexed_p95: quantile(indexedSamples, 0.95),
      indexed_mean: mean(indexedSamples),
      indexed_mailboxes: indexedResult.scope?.indexed_mailboxes ?? null,
      raw_mailboxes: rawResult.scope?.raw_mailboxes ?? null,
      indexed_candidates: indexedResult.scope?.indexed_candidates ?? null,
      indexed_hits: indexedResult.scope?.indexed_hits ?? null,
      mailbox_backends: indexedResult.scope?.mailbox_backends ?? {},
      raw_ids: fingerprint(rawResult).ids,
      indexed_ids: fingerprint(indexedResult).ids,
    });
  }
  return { rows, failed };
}

function printTable(rows) {
  const header = [
    'shape',
    'mode',
    'raw_p50',
    'raw_p95',
    'raw_mean',
    'idx_p50',
    'idx_p95',
    'idx_mean',
    'idx_cand',
    'idx_hits',
    'parity',
  ];
  const body = rows.map((row) => [
    row.shape,
    row.mode,
    row.raw_p50.toFixed(1),
    row.raw_p95.toFixed(1),
    row.raw_mean.toFixed(1),
    row.indexed_p50.toFixed(1),
    row.indexed_p95.toFixed(1),
    row.indexed_mean.toFixed(1),
    String(row.indexed_candidates),
    String(row.indexed_hits),
    row.parity,
  ]);
  const widths = header.map((name, col) =>
    Math.max(name.length, ...body.map((line) => line[col].length)),
  );
  const format = (line) => line.map((cell, col) => cell.padEnd(widths[col])).join('  ');
  console.log(format(header));
  body.forEach((line) => console.log(format(line)));
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (!flags.selfTest && !flags.runLive) {
    console.error('Refusing to run. Pass --self-test, or --run-live to benchmark the mail server.');
    process.exit(2);
  }
  if (flags.runLive && !flags.selfTest && flags.datesSet.size !== 6) {
    console.error(
      'Live benchmark needs --normal-since, --normal-before, --busy-since, --busy-before, --archive-since and --archive-before.',
    );
    process.exit(2);
  }
  const { default: MaildirService } = await import('../dist/services/maildir/maildir.service.js');
  let makeRunner;
  if (flags.selfTest) {
    makeRunner = () => createSyntheticRunner(flags);
  } else {
    const { SshRemoteRunner } = await import('../dist/services/maildir/remote.js');
    makeRunner = (indexedSweep) => new SshRemoteRunner(serviceConfig(flags, indexedSweep));
  }
  const report = await measure(MaildirService, flags, makeRunner);
  printTable(report.rows);
  if (flags.jsonOut) {
    await writeFile(flags.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
