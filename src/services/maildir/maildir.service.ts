/**
 * MaildirService — read-only search and read of the raw Dovecot Maildir store
 * on the mail server, over SSH (see docs/maildir-search.md).
 *
 * Search pipeline:
 *   1. Discover folder dirs (`find -prune`), cached 5 min; filter by the
 *      config allow/deny lists and the caller's domain/user/folder scope.
 *   2. Primary pass, one ssh call per mailbox (bounded concurrency):
 *        find <dirs> -maxdepth 1 -type f [-newermt A] [! -newermt B]
 *             -exec grep ... {} +
 *   3. Sort candidates newest first (file-name delivery time).
 *   4. In batches: secondary remote filters (`grep -l` on the batch), then a
 *      header fetch (`grep -m1 -B1000 '^\r?$'`) for local verification and
 *      display, until max_results verified hits.
 *   5. Cache the verified rows (10 min) so paging does not re-scan.
 *   6. Attachment names for the returned page only.
 *
 * Every remote call has a deadline and a byte cap. Anything cut short is
 * reported in `partial_reasons` and `complete: false` — never as "no hits".
 */

import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { simpleParser } from 'mailparser';

import audit from '../../safety/audit.js';
import type { MaildirConfig } from '../../types/index.js';
import { assertSafeDestination, resolveUniquePath, sanitizeFilename } from '../file-paths.js';
import { MaildirInputError, MaildirRemoteError } from './errors.js';
import type { HeaderMap } from './mime.js';
import {
  attachmentNamesFromLines,
  bytesToText,
  decodedHeader,
  decodeMimeWords,
  NAME_LINE_PCRE,
  parseHeaderBlock,
} from './mime.js';
import type { MaildirDir, MaildirFile } from './paths.js';
import {
  escapeFindGlob,
  fromAbsolute,
  globToRegExp,
  isMailboxAllowed,
  parseDir,
  parseFile,
  toAbsolute,
  validateMessageId,
} from './paths.js';
import type { HeaderField } from './patterns.js';
import {
  attachmentNamePcre,
  DEFAULT_HEADER_FIELDS,
  headerSearchPcre,
  makeLocalMatcher,
  termPcre,
} from './patterns.js';
import type { RemoteRunner, RemoteRunResult } from './remote.js';
import { assertRemoteOk, firstLine, SshRemoteRunner } from './remote.js';

export { MaildirInputError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MaildirSearchInput {
  query?: string;
  mode?: 'headers' | 'full_text';
  fields?: HeaderField[];
  regex?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  attachment_name?: string;
  domains?: string[];
  users?: string[];
  folders?: string[];
  exclude_folders?: string[];
  since?: string;
  before?: string;
  offset?: number;
  limit?: number;
  max_results?: number;
  timeout_seconds?: number;
}

export interface MaildirHit {
  id: string;
  mailbox: string;
  folder: string;
  /** Delivery time from the Maildir file name (ISO, UTC). */
  saved_at: string | null;
  /** Date header as written by the sender. */
  date: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  message_id: string | null;
  size: number | null;
  flags: string;
  /** Decoded attachment names (best effort), null if they could not be read. */
  attachments: string[] | null;
}

export interface MaildirSearchResult {
  complete: boolean;
  partial_reasons: string[];
  warnings: string[];
  total_hits: number;
  offset: number;
  limit: number;
  returned: number;
  next_offset: number | null;
  from_cache: boolean;
  elapsed_ms: number;
  scope: {
    mailboxes: number;
    mailboxes_searched: number;
    mailboxes_not_searched: string[];
    folders: number;
    since: string | null;
    before: string | null;
  };
  criteria: Record<string, unknown>;
  notes: string[];
  results: MaildirHit[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;
const RESULT_CACHE_MAX = 10;
const VERIFY_BATCH = 150;
const SECONDARY_BATCH = 400;
const PAGE_FETCH_TIMEOUT_MS = 90_000;
const NAME_LINES_PER_FILE = 400;
const DEFAULT_MAX_HTML_CHARS = 500_000;
const HARD_MAX_HTML_CHARS = 2_000_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
const DOMAIN_INPUT_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const USER_INPUT_RE = /^[a-z0-9._+-]{1,64}(?:@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)?$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — refuse NUL/CR/LF
const UNSAFE_TERM_RE = /[\u0000\r\n]/; // eslint-disable-line no-control-regex

type MatchKind = 'field' | 'continuation' | 'file';

interface Candidate {
  file: MaildirFile;
  kind: MatchKind;
}

interface Row extends Omit<MaildirHit, 'attachments'> {
  attachments: string[] | null | undefined;
}

interface CacheEntry {
  createdAt: number;
  rows: Row[];
  complete: boolean;
  partialReasons: string[];
  warnings: string[];
  scope: MaildirSearchResult['scope'];
  criteria: Record<string, unknown>;
}

interface Pass {
  kind: 'headers' | 'full_text' | 'attachment';
  term: string;
  fields: HeaderField[];
}

function validateDate(label: string, value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value.replace(' ', 'T')))) {
    throw new MaildirInputError(`${label} must be YYYY-MM-DD (optionally with HH:MM[:SS]).`);
  }
  return value.replace('T', ' ');
}

function validateTerm(label: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (UNSAFE_TERM_RE.test(value)) {
    throw new MaildirInputError(`${label} must not contain NUL, CR or LF.`);
  }
  if (value.length > 500) throw new MaildirInputError(`${label} is too long (max 500).`);
  return value;
}

function isoFromUnix(seconds: number | null): string | null {
  if (seconds === null) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Split `<path>\0<rest>` lines; keeps the bytes after the first NUL. */
function splitNulLines(stdout: Buffer): { path: string; rest: Buffer }[] {
  const out: { path: string; rest: Buffer }[] = [];
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(0x0a, start);
    if (end === -1) end = stdout.length;
    const line = stdout.subarray(start, end);
    const nul = line.indexOf(0x00);
    if (nul > 0) {
      out.push({ path: line.subarray(0, nul).toString('utf-8'), rest: line.subarray(nul + 1) });
    }
    start = end + 1;
  }
  return out;
}

/** Split `-Z -l` output (`path\0path\0...`). */
function splitNulList(stdout: Buffer): string[] {
  return stdout
    .toString('utf-8')
    .split('\u0000')
    .filter((p) => p.length > 0);
}

/** Bounded-concurrency map that stops starting new work after the deadline. */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  deadline: number,
  worker: (item: T) => Promise<R>,
): Promise<{ done: Map<T, R>; skipped: T[] }> {
  const done = new Map<T, R>();
  const skipped: T[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (Date.now() >= deadline - 500) {
        skipped.push(item);
      } else {
        // eslint-disable-next-line no-await-in-loop
        done.set(item, await worker(item));
      }
    }
  });
  await Promise.all(lanes);
  return { done, skipped };
}

const TOOL_ERROR_LINE = /^(?:\/usr\/bin\/)?(?:find|grep|head): /;

/**
 * Classify remote stderr. `find:`/`grep:` lines are real errors (files not
 * read), except "No such file or directory" (a message renamed or moved by a
 * flag change while we searched). Other lines (ssh notices, login banners)
 * are kept as notes only. `missing` holds the absolute paths that vanished.
 */
function grepStderrIssues(stderr: string): {
  vanished: number;
  missing: Set<string>;
  other: string[];
  notes: string[];
} {
  let vanished = 0;
  const missing = new Set<string>();
  const other: string[] = [];
  const notes: string[] = [];
  stderr.split('\n').forEach((line) => {
    const l = line.trim();
    if (!l) return;
    if (!TOOL_ERROR_LINE.test(l)) {
      notes.push(l.slice(0, 300));
    } else if (l.endsWith(': No such file or directory')) {
      vanished += 1;
      const m =
        /^(?:\/usr\/bin\/)?(?:find|grep|head): (?:‘|')?(.*?)(?:’|')?: No such file or directory$/.exec(
          l,
        );
      if (m) missing.add(m[1]);
    } else {
      other.push(l.slice(0, 300));
    }
  });
  return { vanished, missing, other, notes };
}

/**
 * A remote command that ended without our kill and with an exit code that
 * find/grep/head never use for "no match" (0/1, grep error 2) was killed or
 * crashed on the server (signal, OOM): its output may be incomplete.
 */
function abnormalExit(res: RemoteRunResult): string | null {
  if (res.timedOut || res.truncated) return null;
  if (res.exitCode === null) return 'the remote command was killed';
  if (res.exitCode > 2) return `the remote command ended abnormally (exit ${String(res.exitCode)})`;
  return null;
}

/**
 * find(1) ends `-exec` at an argument that is exactly ";" or "{}" followed by
 * "+", and substitutes "{}". A pattern argument must never be one of those.
 */
function assertExecSafe(args: string[]): void {
  args.forEach((a) => {
    if (a === ';' || a === '+' || a.includes('{}')) {
      throw new MaildirInputError(
        'The search pattern contains "{}" or is ";" / "+", which find -exec cannot pass safely. ' +
          'Rephrase it (in a regex write \\{\\} for literal braces).',
      );
    }
  });
}

function headerMatches(h: HeaderMap, field: HeaderField, match: (v: string) => boolean): boolean {
  const values = h.raw.get(field) ?? [];
  return values.some((v) => match(v) || match(decodeMimeWords(v)));
}

function toRow(file: MaildirFile, h: HeaderMap | undefined): Row {
  const get = (n: string): string | null => (h ? (decodedHeader(h, n) ?? null) : null);
  return {
    id: file.rel,
    mailbox: file.mailbox,
    folder: file.folder,
    saved_at: isoFromUnix(file.savedAt),
    date: get('date'),
    from: get('from'),
    to: get('to'),
    cc: get('cc'),
    subject: get('subject'),
    message_id: get('message-id'),
    size: file.size,
    flags: file.flags,
    attachments: undefined,
  };
}

async function assertRealPathSafe(target: string): Promise<void> {
  const realDir = await realpath(dirname(target));
  const roots = await Promise.all(
    [homedir(), tmpdir()].map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  if (!roots.some((r) => realDir === r || realDir.startsWith(`${r}${sep}`))) {
    throw new MaildirInputError(
      `Destination directory resolves to "${realDir}", outside the home and tmp directories — refusing to write.`,
    );
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new MaildirInputError(
        `Destination "${basename(target)}" is a symbolic link — refusing to write.`,
      );
    }
  } catch (err) {
    if (err instanceof MaildirInputError) throw err;
    // ENOENT: does not exist yet — fine.
  }
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class MaildirService {
  private discovery: { at: number; dirs: MaildirDir[] } | null = null;

  private readonly cache = new Map<string, CacheEntry>();

  private readonly runner: RemoteRunner;

  constructor(
    private readonly config: MaildirConfig,
    runner?: RemoteRunner,
    private readonly auditLog: typeof audit.log = audit.log,
  ) {
    this.runner = runner ?? new SshRemoteRunner(config);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** All allowed cur/new dirs on the server (cached). */
  async listDirs(deadline: number): Promise<MaildirDir[]> {
    if (this.discovery && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) {
      return this.discovery.dirs;
    }
    const res = await this.runner.run(
      'find',
      [
        this.config.root,
        '-mindepth',
        '4',
        '-maxdepth',
        '5',
        '-type',
        'd',
        '(',
        '-name',
        'cur',
        '-o',
        '-name',
        'new',
        ')',
        '-prune',
        '-printf',
        '%p\\0',
      ],
      { timeoutMs: Math.max(1000, deadline - Date.now()), maxBytes: this.config.maxOutputBytes },
    );
    assertRemoteOk(res);
    if (res.timedOut || res.truncated) {
      throw new MaildirRemoteError(
        'Listing the mail folders did not finish (timeout or output cap). Nothing was searched.',
        'ssh_failed',
      );
    }
    const dirs: MaildirDir[] = [];
    splitNulList(res.stdout).forEach((abs) => {
      const rel = fromAbsolute(this.config.root, abs);
      const d = rel === null ? null : parseDir(rel);
      if (d && isMailboxAllowed(this.config, d.domain, d.user)) dirs.push(d);
    });
    if (dirs.length === 0) {
      const why = res.stderr ? ` (${firstLine(res.stderr)})` : '';
      throw new MaildirRemoteError(
        `No mail folders found under ${this.config.root}${why}. Nothing was searched.`,
        'ssh_failed',
      );
    }
    this.discovery = { at: Date.now(), dirs };
    return dirs;
  }

  private static scopeDirs(dirs: MaildirDir[], input: MaildirSearchInput): MaildirDir[] {
    const domains = (input.domains ?? []).map((d) => d.toLowerCase());
    domains.forEach((d) => {
      if (!DOMAIN_INPUT_RE.test(d)) throw new MaildirInputError(`Invalid domain "${d}".`);
    });
    const users = (input.users ?? []).map((u) => u.toLowerCase());
    users.forEach((u) => {
      if (!USER_INPUT_RE.test(u)) throw new MaildirInputError(`Invalid user "${u}".`);
    });
    const include = (input.folders ?? []).map(globToRegExp);
    const exclude = (input.exclude_folders ?? []).map(globToRegExp);
    return dirs.filter((d) => {
      if (domains.length > 0 && !domains.includes(d.domain)) return false;
      if (
        users.length > 0 &&
        !users.some((u) => (u.includes('@') ? u === d.mailbox : u === d.user.toLowerCase()))
      ) {
        return false;
      }
      if (include.length > 0 && !include.some((re) => re.test(d.folder))) return false;
      if (exclude.some((re) => re.test(d.folder))) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(input: MaildirSearchInput): Promise<MaildirSearchResult> {
    const started = Date.now();
    const query = validateTerm('query', input.query);
    const from = validateTerm('from', input.from);
    const to = validateTerm('to', input.to);
    const subject = validateTerm('subject', input.subject);
    const attachment = validateTerm('attachment_name', input.attachment_name);
    const since = validateDate('since', input.since);
    const before = validateDate('before', input.before);
    const mode = input.mode ?? 'headers';
    const regex = input.regex ?? false;
    const fields = input.fields && input.fields.length > 0 ? input.fields : DEFAULT_HEADER_FIELDS;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const maxResults = Math.min(
      input.max_results ?? this.config.maxResults,
      this.config.maxResults,
    );
    const timeoutSec = Math.min(
      input.timeout_seconds ?? this.config.defaultTimeoutSeconds,
      this.config.maxTimeoutSeconds,
    );

    if (!query && !from && !to && !subject && !attachment) {
      throw new MaildirInputError(
        'Give at least one of: query, from, to, subject, attachment_name.',
      );
    }
    if (regex) {
      [query, from, to, subject, attachment].forEach((t) => {
        if (t === undefined) return;
        try {
          // Local verification uses JS; refuse patterns JS cannot compile.
          makeLocalMatcher(t, true);
        } catch (err) {
          throw new MaildirInputError(
            `Invalid regex "${t}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    const criteria: Record<string, unknown> = {
      query: query ?? null,
      mode,
      fields: query && mode === 'headers' ? fields : undefined,
      regex,
      from: from ?? null,
      to: to ?? null,
      subject: subject ?? null,
      attachment_name: attachment ?? null,
      domains: input.domains ?? [],
      users: input.users ?? [],
      folders: input.folders ?? [],
      exclude_folders: input.exclude_folders ?? [],
      since,
      before,
      max_results: maxResults,
    };
    const cacheKey = JSON.stringify(criteria);

    let entry = this.cachedEntry(cacheKey);
    const fromCache = entry !== null;
    if (!entry) {
      const deadline = started + timeoutSec * 1000;
      entry = await this.runSearch({
        input,
        query,
        mode,
        regex,
        fields,
        from,
        to,
        subject,
        attachment,
        since,
        before,
        maxResults,
        deadline,
        criteria,
      }).catch(async (err: unknown) => {
        await this.safeAudit(
          'maildir_search',
          { who: safeUser(), criteria, elapsed_ms: Date.now() - started },
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      });
      this.storeEntry(cacheKey, entry);
    }

    const pageRows = entry.rows.slice(offset, offset + limit);
    const pageWarnings: string[] = [];
    await this.fillAttachmentNames(pageRows, pageWarnings);

    const result: MaildirSearchResult = {
      complete: entry.complete,
      partial_reasons: entry.partialReasons,
      warnings: [...entry.warnings, ...pageWarnings],
      total_hits: entry.rows.length,
      offset,
      limit,
      returned: pageRows.length,
      next_offset: offset + limit < entry.rows.length ? offset + limit : null,
      from_cache: fromCache,
      elapsed_ms: Date.now() - started,
      scope: entry.scope,
      criteria: entry.criteria,
      notes: [
        'Matching is on raw message bytes. Plain-text and Q-encoded/%-encoded forms are found; ' +
          'words inside base64 (B-encoded headers, base64 bodies) are not.',
        'Header search reads only the header block of each message. Full-text search reads whole files.',
        'id = path under the Maildir root; pass it to maildir_get_email / maildir_save_attachment.',
        'The same message can appear in several mailboxes; group by message_id.',
      ],
      results: pageRows.map((r) => ({ ...r, attachments: r.attachments ?? null })),
    };

    await this.safeAudit('maildir_search', {
      who: safeUser(),
      criteria: entry.criteria,
      hits: entry.rows.length,
      complete: entry.complete,
      from_cache: fromCache,
      mailboxes_searched: entry.scope.mailboxes_searched,
      elapsed_ms: result.elapsed_ms,
    });
    return result;
  }

  private cachedEntry(key: string): CacheEntry | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.createdAt > RESULT_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return e;
  }

  private storeEntry(key: string, entry: CacheEntry): void {
    // Partial results are not cached: a retry must search again.
    if (!entry.complete) return;
    this.cache.set(key, entry);
    while (this.cache.size > RESULT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async runSearch(p: {
    input: MaildirSearchInput;
    query: string | undefined;
    mode: 'headers' | 'full_text';
    regex: boolean;
    fields: HeaderField[];
    from: string | undefined;
    to: string | undefined;
    subject: string | undefined;
    attachment: string | undefined;
    since: string | null;
    before: string | null;
    maxResults: number;
    deadline: number;
    criteria: Record<string, unknown>;
  }): Promise<CacheEntry> {
    const partialReasons: string[] = [];
    const warnings: string[] = [];

    // ---- plan the passes -------------------------------------------------
    const headerFilters: { field: HeaderField; term: string }[] = [];
    if (p.from) headerFilters.push({ field: 'from', term: p.from });
    if (p.to) headerFilters.push({ field: 'to', term: p.to });
    if (p.subject) headerFilters.push({ field: 'subject', term: p.subject });

    let primary: Pass;
    const secondary: Pass[] = [];
    let primaryHeaderFields: HeaderField[] = [];
    if (p.query) {
      primary =
        p.mode === 'headers'
          ? { kind: 'headers', term: p.query, fields: p.fields }
          : { kind: 'full_text', term: p.query, fields: [] };
      if (p.mode === 'headers') primaryHeaderFields = p.fields;
    } else if (headerFilters.length > 0) {
      const first = headerFilters.shift();
      if (!first) throw new MaildirInputError('No search criteria.');
      primary = { kind: 'headers', term: first.term, fields: [first.field] };
      primaryHeaderFields = [first.field];
    } else if (p.attachment) {
      primary = { kind: 'attachment', term: p.attachment, fields: [] };
    } else {
      throw new MaildirInputError('No search criteria.');
    }
    // Input problem → refuse before anything is scanned (not a per-mailbox failure).
    assertExecSafe(MaildirService.grepArgs(primary, p.regex));
    if (p.attachment && primary.kind !== 'attachment') {
      secondary.push({ kind: 'attachment', term: p.attachment, fields: [] });
    }

    // ---- scope -------------------------------------------------------------
    const allDirs = await this.listDirs(p.deadline);
    const dirs = MaildirService.scopeDirs(allDirs, p.input);
    if (dirs.length === 0) {
      throw new MaildirInputError(
        'No mailbox folder matches this scope (domains/users/folders), or it is excluded by the ' +
          '[maildir] config. Nothing was searched.',
      );
    }
    const byMailbox = new Map<string, MaildirDir[]>();
    dirs.forEach((d) => {
      const list = byMailbox.get(d.mailbox) ?? [];
      list.push(d);
      byMailbox.set(d.mailbox, list);
    });
    const folderCount = new Set(dirs.map((d) => `${d.mailbox}/${d.folderDir}`)).size;

    // ---- primary pass, per mailbox ----------------------------------------
    const mailboxes = [...byMailbox.keys()].sort();
    const notSearched: string[] = [];
    let indexedMailboxes = 0;
    let vanished = 0;
    const { done, skipped } = await pool(
      mailboxes,
      this.config.concurrency,
      p.deadline,
      async (mailbox) => {
        const mdirs = byMailbox.get(mailbox) ?? [];
        try {
          const res = await this.runPrimary(mdirs, primary, p.regex, p.since, p.before, p.deadline);
          return { mailbox, res, error: null };
        } catch (err) {
          // One failing mailbox must not hide the others' results — or be
          // silently dropped: it is reported as not searched.
          return { mailbox, res: null, error: err instanceof Error ? err.message : String(err) };
        }
      },
    );
    notSearched.push(...skipped);

    const candidates = new Map<string, Candidate>();
    mailboxes.forEach((mailbox) => {
      const item = done.get(mailbox);
      if (!item) return;
      const { res, error } = item;
      if (!res) {
        notSearched.push(mailbox);
        partialReasons.push(`${mailbox}: not searched: ${error ?? 'unknown error'}`);
        return;
      }
      if (res.backend === 'index') indexedMailboxes += 1;
      const abnormal = abnormalExit(res);
      if (abnormal) partialReasons.push(`${mailbox}: ${abnormal}; results may be incomplete.`);
      if (res.timedOut) {
        notSearched.push(mailbox);
        partialReasons.push(`${mailbox}: timed out before the search finished.`);
      }
      if (res.truncated) {
        partialReasons.push(
          `${mailbox}: too many matches (output cap reached); narrow the search.`,
        );
      }
      const issues = grepStderrIssues(res.stderr);
      vanished += issues.vanished;
      if (issues.other.length > 0) {
        partialReasons.push(`${mailbox}: server reported errors: ${issues.other[0]}`);
      }
      issues.notes.forEach((n) => {
        if (!warnings.includes(`Server said: ${n}`)) warnings.push(`Server said: ${n}`);
      });
      this.collectCandidates(res, primary, mailbox, candidates);
    });
    if (skipped.length > 0) {
      partialReasons.push(
        `Time limit reached: ${String(skipped.length)} mailbox(es) were not searched: ` +
          `${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ', ...' : ''}.`,
      );
    }

    // ---- verify + secondary filters, newest first -------------------------
    const sorted = [...candidates.values()].sort(
      (a, b) =>
        (b.file.savedAt ?? 0) - (a.file.savedAt ?? 0) || a.file.rel.localeCompare(b.file.rel),
    );
    const rows: Row[] = [];
    const primaryMatcher =
      primary.kind === 'headers' ? makeLocalMatcher(primary.term, p.regex) : null;
    const filterMatchers = headerFilters.map((f) => ({
      field: f.field,
      match: makeLocalMatcher(f.term, p.regex),
    }));

    let index = 0;
    let stoppedAtCap = false;
    const counters = { unverifiable: 0, overflow: 0 };
    while (index < sorted.length) {
      if (rows.length >= p.maxResults) {
        stoppedAtCap = true;
        break;
      }
      if (Date.now() >= p.deadline - 500) {
        partialReasons.push(
          `Time limit reached while checking matches: ${String(sorted.length - index)} candidate(s) ` +
            'were not checked.',
        );
        break;
      }
      const batch = sorted.slice(index, index + VERIFY_BATCH);
      index += batch.length;

      // eslint-disable-next-line no-await-in-loop
      let kept = await this.applySecondary(batch, secondary, p.regex, p.deadline, partialReasons);
      // eslint-disable-next-line no-await-in-loop
      const headers = await this.fetchHeaders(
        kept.map((c) => c.file),
        p.deadline,
        partialReasons,
        indexedMailboxes > 0,
      );
      kept = kept.filter((c) => {
        const h = headers.get(c.file.rel);
        if (!h) {
          // Could not read the header block (renamed meanwhile, or no blank line).
          if (c.kind === 'continuation' || filterMatchers.length > 0) {
            counters.unverifiable += 1;
            return false;
          }
          return true;
        }
        if (c.kind === 'continuation' && primaryMatcher) {
          if (!primaryHeaderFields.some((f) => headerMatches(h, f, primaryMatcher))) return false;
        }
        return filterMatchers.every((f) => headerMatches(h, f.field, f.match));
      });
      kept.forEach((c) => {
        if (rows.length < p.maxResults) rows.push(toRow(c.file, headers.get(c.file.rel)));
        else counters.overflow += 1;
      });
    }
    if (stoppedAtCap || counters.overflow > 0) {
      partialReasons.push(
        `Result cap reached (max_results=${String(p.maxResults)}); more messages may match. ` +
          'Narrow the search (dates, users, folders) or raise max_results.',
      );
    }
    if (vanished > 0) {
      warnings.push(
        `${String(vanished)} message file(s) were renamed or moved during the search (flag change ` +
          'or folder move) and may be missing from the results. Run the search again to include them.',
      );
    }
    if (counters.unverifiable > 0) {
      warnings.push(
        `${String(counters.unverifiable)} candidate(s) could not be checked (header block unreadable) and were left out.`,
      );
    }

    return {
      createdAt: Date.now(),
      rows,
      complete: partialReasons.length === 0,
      partialReasons,
      warnings,
      scope: {
        mailboxes: mailboxes.length,
        mailboxes_searched: mailboxes.length - notSearched.length,
        mailboxes_not_searched: notSearched,
        folders: folderCount,
        since: p.since,
        before: p.before,
      },
      criteria: { ...p.criteria, indexed_mailboxes: indexedMailboxes },
    };
  }

  /** Try the fixed index reader with a bounded portion of the mailbox budget. */
  private async indexedSweep(
    dirs: MaildirDir[],
    since: string,
    before: string | null,
    deadline: number,
  ) {
    const remaining = deadline - Date.now();
    if (remaining < 4000 || this.config.root !== '/var/vmail') return null;
    try {
      const result = await this.runner.run(
        'maildir-index-sweep',
        [dirs[0].mailbox, since, before ?? '', ...dirs.map((d) => d.rel)],
        {
          timeoutMs: Math.min(28000, Math.floor(remaining / 3)),
          maxBytes: this.config.maxOutputBytes,
        },
      );
      const failed = result.exitCode !== 0 || result.stderr || result.timedOut || result.truncated;
      if (failed) return null;
      const records = result.stdout.toString('utf8').split('\0');
      if (records.pop() !== '' || records.pop() !== 'maildir-index-v1-complete') return null;
      const allowed = new Set(dirs.map((d) => d.rel));
      const inScope = records.every((path) => {
        const rel = fromAbsolute(this.config.root, path);
        return !!rel && !!parseFile(rel) && allowed.has(rel.slice(0, rel.lastIndexOf('/')));
      });
      if (!inScope) return null;
      // A folded candidate requires positive verification against the selected
      // headers by the existing header reader. Metadata alone cannot establish a hit.
      return { ...result, stdout: Buffer.from(records.map((p) => `${p}\0\tindexed\n`).join('')) };
    } catch {
      return null;
    }
  }

  /** find + grep over one mailbox's dirs. */
  private async runPrimary(
    dirs: MaildirDir[],
    pass: Pass,
    regex: boolean,
    since: string | null,
    before: string | null,
    deadline: number,
  ): Promise<RemoteRunResult & { backend?: 'index' }> {
    if (
      this.config.indexedSweep &&
      pass.kind === 'headers' &&
      regex &&
      pass.term === '.*' &&
      since?.length === 10 &&
      (!before || before.length === 10)
    ) {
      const indexed = await this.indexedSweep(dirs, since, before, deadline);
      if (indexed) return { ...indexed, backend: 'index' };
    }
    const args: string[] = dirs.map((d) => toAbsolute(this.config.root, d.rel));
    args.push('-maxdepth', '1', '-type', 'f');
    if (since) args.push('-newermt', since);
    if (before) args.push('!', '-newermt', before);
    const grepArgs = MaildirService.grepArgs(pass, regex);
    assertExecSafe(grepArgs);
    args.push('-exec', '/usr/bin/grep', ...grepArgs, '{}', '+');
    const res = await this.runner.run('find', args, {
      timeoutMs: Math.max(1000, deadline - Date.now()),
      maxBytes: this.config.maxOutputBytes,
    });
    assertRemoteOk(res);
    return res;
  }

  /** grep options + pattern(s) for a pass, ending with `--`. */
  static grepArgs(pass: Pass, regex: boolean): string[] {
    if (pass.kind === 'headers') {
      return [
        '-a',
        '-P',
        '-i',
        '-o',
        '-H',
        '-Z',
        '-m',
        '1',
        '-e',
        headerSearchPcre(pass.fields, pass.term, regex),
        '--',
      ];
    }
    if (pass.kind === 'full_text') {
      // Fixed terms are byte-escaped PCRE (never ";", "+" or "{}" — safe in find -exec).
      return ['-a', '-P', '-i', '-l', '-Z', '-e', termPcre(pass.term, regex), '--'];
    }
    return [
      '-a',
      '-P',
      '-i',
      '-l',
      '-Z',
      '-e',
      attachmentNamePcre(NAME_LINE_PCRE, pass.term, regex),
      '--',
    ];
  }

  private collectCandidates(
    res: RemoteRunResult,
    pass: Pass,
    mailbox: string,
    into: Map<string, Candidate>,
  ): void {
    const add = (abs: string, kind: MatchKind): void => {
      const rel = fromAbsolute(this.config.root, abs);
      const file = rel === null ? null : parseFile(rel);
      // Drop anything that is not a message of THIS mailbox.
      if (file?.mailbox !== mailbox) return;
      const prev = into.get(file.rel);
      if (!prev || (prev.kind === 'continuation' && kind !== 'continuation')) {
        into.set(file.rel, { file, kind });
      }
    };
    if (pass.kind === 'headers') {
      splitNulLines(res.stdout).forEach(({ path, rest }) => {
        if (rest.length === 0) return; // defensive: empty match = header end
        const first = rest[0];
        add(path, first === 0x20 || first === 0x09 ? 'continuation' : 'field');
      });
    } else {
      splitNulList(res.stdout).forEach((path) => {
        add(path, 'file');
      });
    }
  }

  /** Remote `grep -l` filters on a candidate batch (AND). */
  private async applySecondary(
    batch: Candidate[],
    passes: Pass[],
    regex: boolean,
    deadline: number,
    partialReasons: string[],
  ): Promise<Candidate[]> {
    let kept = batch;
    /* eslint-disable no-restricted-syntax, no-await-in-loop -- filters run in order, one batch at a time */
    for (const pass of passes) {
      if (kept.length === 0) break;
      const keep = new Set<string>();
      for (let i = 0; i < kept.length; i += SECONDARY_BATCH) {
        const chunk = kept.slice(i, i + SECONDARY_BATCH);
        const res = await this.runner.run(
          'grep',
          [
            ...MaildirService.grepArgs(pass, regex),
            ...chunk.map((c) => toAbsolute(this.config.root, c.file.rel)),
          ],
          {
            timeoutMs: Math.max(1000, deadline - Date.now()),
            maxBytes: this.config.maxOutputBytes,
          },
        );
        assertRemoteOk(res);
        if (res.timedOut || res.truncated) {
          partialReasons.push(
            `The ${pass.kind === 'attachment' ? 'attachment_name' : 'full-text'} filter did not ` +
              'finish (time or output limit); some matches may be missing.',
          );
        }
        const issues = grepStderrIssues(res.stderr);
        if (issues.other.length > 0) {
          partialReasons.push(`Filter step: server reported errors: ${issues.other[0]}`);
        }
        const abnormal = abnormalExit(res);
        if (abnormal) partialReasons.push(`Filter step: ${abnormal}; some matches may be missing.`);
        splitNulList(res.stdout).forEach((abs) => {
          const rel = fromAbsolute(this.config.root, abs);
          if (rel) keep.add(rel);
        });
      }
      kept = kept.filter((c) => keep.has(c.file.rel));
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */
    return kept;
  }

  /** Header block of each file (lines before the first blank line). */
  private async fetchHeaders(
    files: MaildirFile[],
    deadline: number,
    partialReasons: string[],
    checkingIndex = false,
  ): Promise<Map<string, HeaderMap>> {
    const out = new Map<string, HeaderMap>();
    if (files.length === 0) return out;
    const res = await this.runner.run(
      'grep',
      [
        '-a',
        '-H',
        '-Z',
        '--no-group-separator',
        '-m',
        '1',
        '-B',
        '1000',
        '-P',
        '-e',
        '^\\r?$',
        '--',
        ...files.map((f) => toAbsolute(this.config.root, f.rel)),
      ],
      { timeoutMs: Math.max(1000, deadline - Date.now()), maxBytes: this.config.maxOutputBytes },
    );
    assertRemoteOk(res);
    if (res.timedOut || res.truncated) {
      partialReasons.push('Reading message headers did not finish (time or output limit).');
    }
    const lines = new Map<string, string[]>();
    const wanted = new Set(files.map((f) => toAbsolute(this.config.root, f.rel)));
    splitNulLines(res.stdout).forEach(({ path, rest }) => {
      if (!wanted.has(path)) return;
      const list = lines.get(path) ?? [];
      list.push(bytesToText(rest));
      lines.set(path, list);
    });
    if (checkingIndex && [...lines.values()].some((ls) => ls.length >= 1001)) {
      partialReasons.push(
        'A message reached the header-line limit during indexed header verification.',
      );
    }
    lines.forEach((ls, abs) => {
      const rel = fromAbsolute(this.config.root, abs);
      if (rel) out.set(rel, parseHeaderBlock(ls));
    });
    return out;
  }

  /** Attachment names for the page rows that do not have them yet. */
  private async fillAttachmentNames(rows: Row[], warnings: string[]): Promise<void> {
    const need = rows.filter((r) => r.attachments === undefined);
    if (need.length === 0) return;
    try {
      const res = await this.runner.run(
        'grep',
        [
          '-a',
          '-H',
          '-Z',
          '-i',
          '-P',
          '-m',
          String(NAME_LINES_PER_FILE),
          '-e',
          NAME_LINE_PCRE,
          '--',
          ...need.map((r) => toAbsolute(this.config.root, r.id)),
        ],
        { timeoutMs: PAGE_FETCH_TIMEOUT_MS, maxBytes: this.config.maxOutputBytes },
      );
      assertRemoteOk(res);
      const byPath = new Map<string, string[]>();
      splitNulLines(res.stdout).forEach(({ path, rest }) => {
        const list = byPath.get(path) ?? [];
        list.push(bytesToText(rest));
        byPath.set(path, list);
      });
      const failed = res.timedOut || res.truncated || abnormalExit(res) !== null;
      const { missing } = grepStderrIssues(res.stderr);
      if (failed) {
        warnings.push('Attachment names could not be read for every result on this page.');
      }
      need.forEach((r) => {
        const abs = toAbsolute(this.config.root, r.id);
        const ls = byPath.get(abs);
        let names: string[] | null = [];
        if (ls) names = attachmentNamesFromLines(ls);
        else if (failed || missing.has(abs)) names = null; // unknown, not "none"
        // eslint-disable-next-line no-param-reassign
        r.attachments = names;
      });
    } catch (err) {
      warnings.push(
        `Attachment names unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      need.forEach((r) => {
        // eslint-disable-next-line no-param-reassign
        r.attachments = null;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Read one message
  // -------------------------------------------------------------------------

  /** Resolve an id to the file's CURRENT name (flags may have changed). */
  private async resolve(id: string): Promise<MaildirFile> {
    const file = validateMessageId(this.config, id);
    const folderBase = `${file.domain}/${file.user}/Maildir${file.folderDir ? `/${file.folderDir}` : ''}`;
    const dirsAbs = ['cur', 'new'].map((s) => toAbsolute(this.config.root, `${folderBase}/${s}`));
    const base = escapeFindGlob(file.base);
    const res = await this.runner.run(
      'find',
      [
        ...dirsAbs,
        '-maxdepth',
        '1',
        '-type',
        'f',
        '(',
        '-name',
        base,
        '-o',
        '-name',
        `${base}:*`,
        ')',
        '-print0',
      ],
      { timeoutMs: 60_000, maxBytes: 64 * 1024 },
    );
    assertRemoteOk(res);
    const found = splitNulList(res.stdout)
      .map((abs) => fromAbsolute(this.config.root, abs))
      .map((rel) => (rel ? parseFile(rel) : null))
      .filter((f): f is MaildirFile => f !== null && f.base === file.base);
    if (found.length === 0) {
      throw new MaildirInputError(
        `Message not found: ${id}. It may have been deleted or moved to another folder; ` +
          'run maildir_search again to get a fresh id.',
      );
    }
    return found.find((f) => f.rel === file.rel) ?? found[0];
  }

  private async readMessage(file: MaildirFile): Promise<{ raw: Buffer; truncated: boolean }> {
    const cap = this.config.maxMessageBytes;
    const res = await this.runner.run(
      'head',
      ['-c', String(cap + 1), '--', toAbsolute(this.config.root, file.rel)],
      { timeoutMs: 120_000, maxBytes: cap + 1 },
    );
    assertRemoteOk(res);
    if (res.timedOut) throw new MaildirRemoteError('Reading the message timed out.', 'ssh_failed');
    if (res.exitCode !== 0) {
      throw new MaildirRemoteError(
        `Could not read the message: ${firstLine(res.stderr) || `exit ${String(res.exitCode)}`}`,
        'ssh_failed',
      );
    }
    const truncated = res.stdout.length > cap || res.truncated;
    return { raw: truncated ? res.stdout.subarray(0, cap) : res.stdout, truncated };
  }

  async getEmail(
    id: string,
    options: {
      maxBodyChars?: number;
      includeHeaders?: boolean;
      includeHtml?: boolean;
      maxHtmlChars?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const file = await this.resolve(id);
    const { raw, truncated } = await this.readMessage(file);
    const parsed = await simpleParser(raw, { skipImageLinks: true });
    const maxChars = Math.min(
      options.maxBodyChars ?? this.config.maxBodyChars,
      this.config.maxBodyChars,
    );
    const text = parsed.text ?? '';
    const addr = (a: typeof parsed.from | typeof parsed.to): string | null => {
      if (!a) return null;
      return (Array.isArray(a) ? a : [a]).map((x) => x.text).join(', ');
    };
    const result: Record<string, unknown> = {
      id: file.rel,
      mailbox: file.mailbox,
      folder: file.folder,
      flags: file.flags,
      saved_at: isoFromUnix(file.savedAt),
      size: file.size ?? raw.length,
      message_truncated: truncated,
      headers: {
        from: addr(parsed.from),
        to: addr(parsed.to),
        cc: addr(parsed.cc),
        bcc: addr(parsed.bcc),
        reply_to: addr(parsed.replyTo),
        subject: parsed.subject ?? null,
        date: parsed.date ? parsed.date.toISOString() : null,
        message_id: parsed.messageId ?? null,
        in_reply_to: parsed.inReplyTo ?? null,
      },
      text: text.slice(0, maxChars),
      text_truncated: text.length > maxChars,
      text_length: text.length,
      has_html: Boolean(parsed.html),
      attachments: parsed.attachments.map((a, i) => ({
        index: i,
        filename: a.filename ?? null,
        content_type: a.contentType,
        size: a.size,
        inline: a.contentDisposition === 'inline',
        content_id: a.cid ?? null,
      })),
    };
    if (truncated) {
      result.warning =
        `The message is larger than max_message_bytes (${String(this.config.maxMessageBytes)}); ` +
        'only the first part was parsed, so the body and attachment list may be incomplete.';
    }
    if (options.includeHeaders) {
      const lines = parsed.headerLines.map((h) => h.line);
      result.raw_headers = lines.join('\n').slice(0, 64 * 1024);
    }
    if (options.includeHtml) {
      const maxHtmlChars = Math.min(
        Math.max(options.maxHtmlChars ?? DEFAULT_MAX_HTML_CHARS, 100),
        HARD_MAX_HTML_CHARS,
      );
      const html = typeof parsed.html === 'string' ? parsed.html : null;
      result.html = html !== null ? html.slice(0, maxHtmlChars) : null;
      result.html_truncated = html !== null ? html.length > maxHtmlChars : false;
      result.html_length = html !== null ? html.length : 0;
    }
    await this.safeAudit('maildir_get_email', { who: safeUser(), id: file.rel });
    return result;
  }

  async saveAttachment(params: {
    id: string;
    filename?: string;
    index?: number;
    destination?: string;
    overwrite?: boolean;
  }): Promise<Record<string, unknown>> {
    if (params.filename === undefined && params.index === undefined) {
      throw new MaildirInputError('Give filename or index (from maildir_get_email).');
    }
    const target0 = params.destination ?? join(homedir(), 'Downloads');
    assertSafeDestination(target0);

    const file = await this.resolve(params.id);
    const { raw, truncated } = await this.readMessage(file);
    if (truncated) {
      throw new MaildirInputError(
        `The message is larger than max_message_bytes (${String(this.config.maxMessageBytes)}); ` +
          'raise [maildir] max_message_bytes to save its attachments.',
      );
    }
    const parsed = await simpleParser(raw, { skipImageLinks: true });
    const list = parsed.attachments;
    let att: (typeof list)[number] | undefined;
    if (params.index !== undefined) {
      att = list[params.index];
      if (att && params.filename !== undefined && att.filename !== params.filename) {
        throw new MaildirInputError(
          `Attachment ${String(params.index)} is "${att.filename ?? '(no name)'}", not "${params.filename}".`,
        );
      }
    } else {
      att = list.find((a) => a.filename === params.filename);
    }
    if (!att) {
      throw new MaildirInputError(
        `Attachment not found. Available: ${
          list.map((a, i) => `[${String(i)}] ${a.filename ?? '(no name)'}`).join(', ') || 'none'
        }`,
      );
    }

    const leaf = sanitizeFilename(att.filename ?? `attachment-${String(list.indexOf(att))}`);
    let targetPath = target0;
    try {
      if ((await stat(target0)).isDirectory()) targetPath = join(target0, leaf);
    } catch {
      // does not exist yet — treat as a file path
    }
    assertSafeDestination(targetPath);
    const finalPath = await resolveUniquePath(targetPath, params.overwrite ?? false);
    assertSafeDestination(finalPath);
    await mkdir(dirname(finalPath), { recursive: true });
    // assertSafeDestination works on the path text; a symlinked directory
    // (e.g. ~/link -> /etc) would still escape. Check the real directory and
    // refuse to write through a symlink at the target itself.
    await assertRealPathSafe(finalPath);
    await writeFile(finalPath, att.content, { flag: params.overwrite ? 'w' : 'wx' });

    await this.safeAudit('maildir_save_attachment', {
      who: safeUser(),
      id: file.rel,
      attachment: att.filename ?? null,
      path: finalPath,
      size: att.size,
    });
    return {
      path: finalPath,
      filename: att.filename ?? null,
      size: att.content.length,
      content_type: att.contentType,
      from_message: file.rel,
    };
  }

  private async safeAudit(
    tool: string,
    params: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    try {
      await this.auditLog(tool, 'maildir', params, error ? 'error' : 'ok', error?.slice(0, 300));
    } catch {
      // Audit failures never break a read.
    }
  }
}
