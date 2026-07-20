# Draft Attachment Resync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `resync_draft_attachments` (report + re-apply the attachments Apple Mail silently drops when it re-saves an MCP draft) plus structured `draft_superseded` hints on `update_draft`/`send_draft`, with byte-preserving MIME surgery, an additive MCP-stamped lineage UUID, and an in-memory session attachment cache.

**Architecture:** Three pure, independently-testable modules (`draft-lineage.ts` grouping/diff, `draft-attachment-cache.ts` session state, `mime-splice.ts` byte-preserving injection + cid stripping) are orchestrated by new `ImapService` methods (`resolveDraftLineage`, `resyncDraftAttachments`, `findSupersession`) and surfaced by a new tool plus hints wired into the existing draft tools. On `apply`, the current draft's exact RFC822 (`fetchDraftRaw`) is wrapped in a new `multipart/mixed` — the original body part stays byte-for-byte — and recovered attachment parts are appended; the old UID is deleted only after APPEND (existing safety pattern).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, `imapflow`, `nodemailer` `MailComposer`, `mailparser` `simpleParser`, `zod`, `vitest` (unit + GreenMail testcontainer integration).

## Global Constraints

- **ESM imports:** every relative import ends in `.js` (e.g. `import { x } from './draft-lineage.js'`). Source is `.ts`.
- **Draft folder autodetect:** reuse the existing pattern — `mailboxes.find((mb) => mb.specialUse === '\\Drafts')?.path ?? 'Drafts'`; honor an explicit `mailbox` arg.
- **APPEND-then-delete:** never delete the old draft UID before the new APPEND succeeds.
- **Byte-preservation invariant (acceptance #5):** on the **no-strip** path the current draft's body bytes appear **verbatim** in the output. Only opt-in cid-stub stripping may alter the HTML part (decoded-content preservation for the rest).
- **Strict attachment resolution:** if a requested/recoverable attachment cannot be fetched at apply time, that filename is reported `recoverable:false`/`skipped` — never fail the whole call, never silently produce a wrong body.
- **Write-tool gating:** the new tool registers only when `!config.settings.readOnly` (in the existing write-tools block of `register.ts`).
- **Lineage rule:** same Drafts folder + same `normalizeFrom` + (**same non-empty `X-Universally-Unique-Identifier` OR same `normalizeSubject`**). UUID is additive-only (never splits a lineage).
- **UUID format:** `crypto.randomUUID().toUpperCase()` stamped as header `X-Universally-Unique-Identifier`.
- **Commands:** typecheck `pnpm typecheck`; lint `pnpm check`; unit tests `pnpm test <file>`; integration `pnpm test:integration <file>` (needs Docker/GreenMail). Pre-commit runs a full `tsc --noEmit`; keep it green.
- **Conventional commits:** `feat(drafts): …` / `test(drafts): …` / `docs(drafts): …`; footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/draft-lineage.ts` (new) | Pure: `normalizeFrom`, `normalizeSubject`, `parseUuidHeader`, `sameLineage`, `orderByInternalDate`, `diffMissingAttachments`, types. |
| `src/services/draft-lineage.test.ts` (new) | Unit tests (acceptance #4). |
| `src/services/draft-attachment-cache.ts` (new) | Pure: `DraftAttachmentCache` — entries, removed-set, uid→lineage map, predicate lookups. |
| `src/services/draft-attachment-cache.test.ts` (new) | Unit tests (acceptance #3). |
| `src/services/mime-splice.ts` (new) | Pure: `splitHeadersAndBody`, `partitionHeaders`, `buildWrappedMixed`, `findDanglingCids`, `stripDanglingCidsFromRaw`, `injectAttachments`. |
| `src/services/mime-splice.test.ts` (new) | Unit tests (acceptance #5). |
| `src/services/imap.service.ts` (modify) | Stamp/return UUID in `saveDraft`; record cache in `saveDraftWithAttachments`/`updateDraft`; add `listDraftLineageRaw`, `resolveDraftLineage`, `resyncDraftAttachments`, `findSupersession`, `appendRawDraft`; new `SupersededDraftError`. |
| `src/services/smtp.service.ts` (modify) | `sendDraft`: superseded not-found → `SupersededDraftError`; non-newest → warning in result. |
| `src/tools/drafts.tool.ts` (modify) | New `resync_draft_attachments` tool; render `draft_superseded` hint in `update_draft`/`send_draft`. |
| `src/tools/register.ts` (modify) | Register the new tool. |
| `src/__integration__/draft-resync.integration.test.ts` (new) | Replays PRD §2 fixture (acceptance #1, #2). |
| `README.md`, `CHANGELOG.md` (modify) | Document the tool + hints. |

---

## Task 1: Lineage primitives (`draft-lineage.ts`)

**Files:**
- Create: `src/services/draft-lineage.ts`
- Test: `src/services/draft-lineage.test.ts`

**Interfaces:**
- Produces:
  - `normalizeFrom(addr: string): string`
  - `normalizeSubject(subject: string): string`
  - `parseUuidHeader(headers: Buffer | undefined): string | undefined`
  - `interface LineageRef { account: string; from: string; subjectNorm: string; uuid?: string }`
  - `interface DraftRow { uid: number; from: string; subject: string; internalDate: Date; attachments: AttachmentMeta[]; uuid?: string }`
  - `sameLineage(row: { from: string; subjectNorm: string; uuid?: string }, anchor: { from: string; subjectNorm: string; uuid?: string }): boolean`
  - `orderByInternalDate(rows: DraftRow[]): DraftRow[]` (ascending; stable)
  - `diffMissingAttachments(current: DraftRow, ancestors: DraftRow[]): { filename: string; size: number; lastSeenOnUid: number }[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/draft-lineage.test.ts
import { describe, expect, it } from 'vitest';
import type { AttachmentMeta } from '../types/index.js';
import {
  type DraftRow,
  diffMissingAttachments,
  normalizeFrom,
  normalizeSubject,
  orderByInternalDate,
  parseUuidHeader,
  sameLineage,
} from './draft-lineage.js';

const att = (filename: string, size = 100): AttachmentMeta => ({
  filename,
  size,
  mimeType: 'application/pdf',
});
const row = (o: Partial<DraftRow> & { uid: number }): DraftRow => ({
  from: 'david@wgsusa.com',
  subject: 'New WGS orders',
  internalDate: new Date('2026-07-16T20:00:00Z'),
  attachments: [],
  ...o,
});

describe('normalizeFrom', () => {
  it('lowercases and strips the display name', () => {
    expect(normalizeFrom('David Young <David@WGSusa.com>')).toBe('david@wgsusa.com');
    expect(normalizeFrom('david@wgsusa.com')).toBe('david@wgsusa.com');
  });
});

describe('normalizeSubject', () => {
  it('strips Re/Fwd prefixes, collapses whitespace, casefolds', () => {
    expect(normalizeSubject('Re: Fwd:  New   WGS Orders ')).toBe('new wgs orders');
    expect(normalizeSubject('FW: Hello')).toBe('hello');
  });
});

describe('parseUuidHeader', () => {
  it('extracts the value case-insensitively; undefined when absent', () => {
    const buf = Buffer.from('X-Universally-Unique-Identifier: ABC-123\r\n', 'utf8');
    expect(parseUuidHeader(buf)).toBe('ABC-123');
    expect(parseUuidHeader(Buffer.from('X-Other: y\r\n'))).toBeUndefined();
    expect(parseUuidHeader(undefined)).toBeUndefined();
  });
});

describe('sameLineage', () => {
  const anchor = { from: 'david@wgsusa.com', subjectNorm: 'new wgs orders', uuid: 'U1' };
  it('matches on same subject even when uuid differs (additive, never splits)', () => {
    expect(sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'new wgs orders', uuid: 'U2' }, anchor)).toBe(true);
  });
  it('matches on same uuid even when subject changed', () => {
    expect(sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'edited subject', uuid: 'U1' }, anchor)).toBe(true);
  });
  it('does NOT match a different From even with same subject (acceptance #4)', () => {
    expect(sameLineage({ from: 'someone@else.com', subjectNorm: 'new wgs orders' }, anchor)).toBe(false);
  });
  it('does NOT match a different subject when neither shares a uuid', () => {
    expect(sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'unrelated' }, anchor)).toBe(false);
  });
});

describe('orderByInternalDate + diffMissingAttachments', () => {
  it('newest is last; reports files on ancestors missing from current', () => {
    const a = row({ uid: 59874, internalDate: new Date('2026-07-16T20:00:00Z'), attachments: [att('PO-1.pdf'), att('PO-2.pdf')] });
    const b = row({ uid: 59878, internalDate: new Date('2026-07-16T20:30:00Z'), attachments: [] });
    const ordered = orderByInternalDate([b, a]);
    expect(ordered.map((r) => r.uid)).toEqual([59874, 59878]);
    const current = ordered[ordered.length - 1];
    const ancestors = ordered.slice(0, -1);
    const missing = diffMissingAttachments(current, ancestors);
    expect(missing.map((m) => m.filename).sort()).toEqual(['PO-1.pdf', 'PO-2.pdf']);
    expect(missing[0].lastSeenOnUid).toBe(59874);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/draft-lineage.test.ts`
Expected: FAIL — `Cannot find module './draft-lineage.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/draft-lineage.ts
/**
 * Pure lineage primitives for draft attachment resync. No IMAP/IO — everything
 * here is deterministic and unit-tested in isolation. See
 * docs/superpowers/specs/2026-07-19-draft-attachment-resync-design.md §3.
 */
import type { AttachmentMeta } from '../types/index.js';

export interface LineageRef {
  account: string;
  from: string;
  subjectNorm: string;
  uuid?: string;
}

export interface DraftRow {
  uid: number;
  from: string;
  subject: string;
  internalDate: Date;
  attachments: AttachmentMeta[];
  uuid?: string;
}

const ANGLE = /<([^>]+)>/;
const REPLY_PREFIX = /^\s*(re|fwd?|aw|wg)\s*:\s*/i;

/** The bare email address, lowercased; display name ignored. */
export function normalizeFrom(addr: string): string {
  if (!addr) return '';
  const m = ANGLE.exec(addr);
  return (m ? m[1] : addr).trim().toLowerCase();
}

/** Trim, strip leading Re:/Fwd:/Fw: runs, collapse whitespace, casefold. */
export function normalizeSubject(subject: string): string {
  let s = (subject ?? '').trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(REPLY_PREFIX, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Extract the X-Universally-Unique-Identifier value from a raw header buffer. */
export function parseUuidHeader(headers: Buffer | undefined): string | undefined {
  if (!headers || headers.length === 0) return undefined;
  const text = headers.toString('utf8');
  for (const line of text.split(/\r\n|\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === 'x-universally-unique-identifier') {
      const value = line.slice(idx + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Lineage predicate (additive UUID edge — never splits). Two drafts (already
 * known to be in the same Drafts folder) are the same lineage iff same From AND
 * (same non-empty UUID OR same normalized Subject).
 */
export function sameLineage(
  row: { from: string; subjectNorm: string; uuid?: string },
  anchor: { from: string; subjectNorm: string; uuid?: string },
): boolean {
  if (row.from !== anchor.from) return false;
  if (row.subjectNorm === anchor.subjectNorm) return true;
  return !!row.uuid && !!anchor.uuid && row.uuid === anchor.uuid;
}

/** Ascending by INTERNALDATE; ties broken by ascending UID for determinism. */
export function orderByInternalDate(rows: DraftRow[]): DraftRow[] {
  return [...rows].sort((a, b) => {
    const d = a.internalDate.getTime() - b.internalDate.getTime();
    return d !== 0 ? d : a.uid - b.uid;
  });
}

/**
 * Filenames present on any ancestor but absent from the current draft. Each is
 * tagged with the newest ancestor UID that still carries it (server-side carry
 * source) and that ancestor's reported size.
 */
export function diffMissingAttachments(
  current: DraftRow,
  ancestors: DraftRow[],
): { filename: string; size: number; lastSeenOnUid: number }[] {
  const have = new Set(current.attachments.map((a) => a.filename));
  const byName = new Map<string, { filename: string; size: number; lastSeenOnUid: number }>();
  // Ancestors oldest→newest so the newest carrier wins the map slot.
  for (const anc of orderByInternalDate(ancestors)) {
    for (const a of anc.attachments) {
      if (have.has(a.filename)) continue;
      byName.set(a.filename, { filename: a.filename, size: a.size, lastSeenOnUid: anc.uid });
    }
  }
  return [...byName.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/services/draft-lineage.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/draft-lineage.ts src/services/draft-lineage.test.ts
git commit -m "feat(drafts): pure lineage primitives for draft resync

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Session attachment cache (`draft-attachment-cache.ts`)

**Files:**
- Create: `src/services/draft-attachment-cache.ts`
- Test: `src/services/draft-attachment-cache.test.ts`

**Interfaces:**
- Consumes: `sameLineage`, `LineageRef` from Task 1.
- Produces:
  - `type CachedOrigin = { kind: 'path'; path: string } | { kind: 'bytes'; content: Buffer; contentType: string }`
  - `interface CachedAttachment { filename: string; origin: CachedOrigin; size: number }`
  - `class DraftAttachmentCache` with:
    - `record(ref: LineageRef, filename: string, origin: CachedOrigin, size: number): void`
    - `recordRemoval(ref: LineageRef, filename: string): void`
    - `isRemoved(ref: LineageRef, filename: string): boolean`
    - `lookup(ref: LineageRef): CachedAttachment[]` (all cached files for the lineage)
    - `find(ref: LineageRef, filename: string): CachedAttachment | undefined`
    - `mapUid(uid: number, ref: LineageRef): void`
    - `lineageForUid(uid: number): LineageRef | undefined`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/draft-attachment-cache.test.ts
import { describe, expect, it } from 'vitest';
import { DraftAttachmentCache } from './draft-attachment-cache.js';
import type { LineageRef } from './draft-lineage.js';

const ref = (o: Partial<LineageRef> = {}): LineageRef => ({
  account: 'wgs',
  from: 'david@wgsusa.com',
  subjectNorm: 'new wgs orders',
  ...o,
});

describe('DraftAttachmentCache', () => {
  it('records and finds by lineage predicate (uuid rescues a changed subject)', () => {
    const c = new DraftAttachmentCache();
    c.record(ref({ uuid: 'U1' }), 'PO-1.pdf', { kind: 'path', path: '/x/PO-1.pdf' }, 10);
    expect(c.find(ref({ uuid: 'U1' }), 'PO-1.pdf')?.origin).toEqual({ kind: 'path', path: '/x/PO-1.pdf' });
    // subject changed but same uuid still matches
    expect(c.find(ref({ subjectNorm: 'edited', uuid: 'U1' }), 'PO-1.pdf')).toBeDefined();
    // different From never matches
    expect(c.find(ref({ from: 'other@x.com', uuid: 'U1' }), 'PO-1.pdf')).toBeUndefined();
  });

  it('excludes intentionally-removed filenames (acceptance #3)', () => {
    const c = new DraftAttachmentCache();
    c.record(ref(), 'keep.pdf', { kind: 'bytes', content: Buffer.from('a'), contentType: 'application/pdf' }, 1);
    c.recordRemoval(ref(), 'gone.pdf');
    expect(c.isRemoved(ref(), 'gone.pdf')).toBe(true);
    expect(c.isRemoved(ref(), 'keep.pdf')).toBe(false);
  });

  it('re-recording a filename replaces the prior origin', () => {
    const c = new DraftAttachmentCache();
    c.record(ref(), 'a.pdf', { kind: 'path', path: '/1' }, 1);
    c.record(ref(), 'a.pdf', { kind: 'path', path: '/2' }, 2);
    expect(c.lookup(ref()).filter((e) => e.filename === 'a.pdf')).toHaveLength(1);
    expect(c.find(ref(), 'a.pdf')?.origin).toEqual({ kind: 'path', path: '/2' });
  });

  it('maps UIDs to lineage refs', () => {
    const c = new DraftAttachmentCache();
    const r = ref({ uuid: 'U9' });
    c.mapUid(59876, r);
    expect(c.lineageForUid(59876)).toEqual(r);
    expect(c.lineageForUid(99999)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/draft-attachment-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/draft-attachment-cache.ts
/**
 * In-memory, server-process-lifetime session cache backing draft attachment
 * resync (design §5). Keyed by the lineage predicate (not a flat string) so a
 * changed subject or a Mail-rewritten UUID still resolves. No disk persistence
 * in v1. Load-bearing: Apple Mail expunges the ancestor UID on re-save, so the
 * ancestor bytes are usually gone by the time resync runs.
 */
import { type LineageRef, sameLineage } from './draft-lineage.js';

export type CachedOrigin =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; content: Buffer; contentType: string };

export interface CachedAttachment {
  filename: string;
  origin: CachedOrigin;
  size: number;
}

interface Entry extends CachedAttachment {
  ref: LineageRef;
}
interface Removal {
  ref: LineageRef;
  filename: string;
}

export class DraftAttachmentCache {
  private entries: Entry[] = [];
  private removals: Removal[] = [];
  private uidLineage = new Map<number, LineageRef>();

  record(ref: LineageRef, filename: string, origin: CachedOrigin, size: number): void {
    const existing = this.entries.find(
      (e) => e.ref.account === ref.account && sameLineage(e.ref, ref) && e.filename === filename,
    );
    if (existing) {
      existing.origin = origin;
      existing.size = size;
      existing.ref = ref;
      return;
    }
    this.entries.push({ ref, filename, origin, size });
  }

  recordRemoval(ref: LineageRef, filename: string): void {
    if (!this.isRemoved(ref, filename)) this.removals.push({ ref, filename });
  }

  isRemoved(ref: LineageRef, filename: string): boolean {
    return this.removals.some(
      (r) => r.ref.account === ref.account && sameLineage(r.ref, ref) && r.filename === filename,
    );
  }

  lookup(ref: LineageRef): CachedAttachment[] {
    return this.entries
      .filter((e) => e.ref.account === ref.account && sameLineage(e.ref, ref))
      .map(({ filename, origin, size }) => ({ filename, origin, size }));
  }

  find(ref: LineageRef, filename: string): CachedAttachment | undefined {
    return this.lookup(ref).find((e) => e.filename === filename);
  }

  mapUid(uid: number, ref: LineageRef): void {
    this.uidLineage.set(uid, ref);
  }

  lineageForUid(uid: number): LineageRef | undefined {
    return this.uidLineage.get(uid);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/services/draft-attachment-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/draft-attachment-cache.ts src/services/draft-attachment-cache.test.ts
git commit -m "feat(drafts): in-memory session attachment cache for resync

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Byte-preserving MIME splice (`mime-splice.ts`)

**Files:**
- Create: `src/services/mime-splice.ts`
- Test: `src/services/mime-splice.test.ts`

**Interfaces:**
- Consumes: `ResolvedAttachment` from `./attachment-resolver.js`; `extractCidReferences` from `./imap.service.js`.
- Produces:
  - `injectAttachments(raw: Buffer, attachments: ResolvedAttachment[], opts: { stripDanglingCids: boolean; ensureUuid?: boolean }): Promise<{ raw: Buffer; strippedCids: string[]; warnings: string[] }>`
  - `findDanglingCids(raw: Buffer): Promise<string[]>`
  - (internal, exported for tests) `splitHeadersAndBody`, `partitionHeaders`, `buildWrappedMixed`.

**Notes for the implementer:**
- The no-strip path MUST keep the original body bytes verbatim (assert with `Buffer.indexOf`).
- v1 **always wraps** the current entity as the first child of a fresh `multipart/mixed` (valid even if the original was already multipart; the motivating "bare draft" case is not multipart/mixed anyway). Do not attempt in-place boundary injection.
- Strip path re-encodes only the located `text/html` leaf as base64 (decoded content = original minus stubs); other parts stay verbatim. Locate the leaf for singlepart `text/html` and up to two multipart nesting levels; deeper/unknown → skip stripping + warn (body stays byte-identical).

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/mime-splice.test.ts
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { ResolvedAttachment } from './attachment-resolver.js';
import { findDanglingCids, injectAttachments } from './mime-splice.js';

async function compose(opts: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(opts).compile().build((err: Error | null, buf: Buffer) =>
      err ? reject(err) : resolve(buf),
    );
  });
}

const pdf = (name: string, body: string): ResolvedAttachment => ({
  filename: name,
  content: Buffer.from(body),
  contentType: 'application/pdf',
});

describe('injectAttachments — no-strip path', () => {
  it('appends attachments and keeps the original body bytes verbatim', async () => {
    const raw = await compose({
      from: 'David Young <david@wgsusa.com>',
      to: 'andy@chk-electronics.com',
      subject: 'New WGS orders',
      html: '<p>Andy, two POs attached.</p>',
    });
    // Locate the original HTML body bytes to prove verbatim survival.
    const parsedIn = await simpleParser(raw);
    const original = parsedIn.html as string;

    const out = await injectAttachments(raw, [pdf('PO-1.pdf', '%PDF one'), pdf('PO-2.pdf', '%PDF two')], {
      stripDanglingCids: true,
    });

    const parsed = await simpleParser(out.raw);
    expect(parsed.subject).toBe('New WGS orders');
    expect((parsed.to as { text: string }).text).toContain('andy@chk-electronics.com');
    expect(parsed.html).toBe(original); // user content untouched
    expect((parsed.attachments ?? []).map((a) => a.filename).sort()).toEqual(['PO-1.pdf', 'PO-2.pdf']);
    expect(out.strippedCids).toEqual([]);
  });
});

describe('findDanglingCids + strip path', () => {
  it('detects dangling cids and strips only those <img> tags, keeping user text + attachments', async () => {
    const raw = await compose({
      from: 'david@wgsusa.com',
      to: 'andy@chk-electronics.com',
      subject: 'CHK order',
      html: '<p>Hello Andy.</p><img src="cid:sig-logo@apple">',
    });
    expect(await findDanglingCids(raw)).toEqual(['sig-logo@apple']);

    const out = await injectAttachments(raw, [pdf('PO-9.pdf', '%PDF nine')], { stripDanglingCids: true });
    const parsed = await simpleParser(out.raw);
    expect(out.strippedCids).toEqual(['sig-logo@apple']);
    expect(parsed.html).toContain('Hello Andy.');
    expect(parsed.html).not.toContain('cid:sig-logo@apple');
    expect((parsed.attachments ?? []).map((a) => a.filename)).toEqual(['PO-9.pdf']);
  });

  it('does not strip a cid that has a matching inline part', async () => {
    const raw = await compose({
      from: 'david@wgsusa.com',
      subject: 'inline ok',
      html: '<p>hi</p><img src="cid:real@x">',
      attachments: [{ filename: 'i.png', content: Buffer.from('PNG'), cid: 'real@x' }],
    });
    expect(await findDanglingCids(raw)).toEqual([]);
    const out = await injectAttachments(raw, [], { stripDanglingCids: true });
    expect(out.strippedCids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/mime-splice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/mime-splice.ts
/**
 * Byte-preserving MIME surgery for draft attachment resync (design §2).
 *
 * The current draft's exact RFC822 is wrapped as the first child of a fresh
 * multipart/mixed; recovered attachment parts are appended. The original body
 * part's bytes are copied VERBATIM (acceptance #5). The single permitted body
 * mutation is opt-in dangling-cid stripping, which re-encodes only the located
 * text/html leaf.
 */
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { ResolvedAttachment } from './attachment-resolver.js';
import { extractCidReferences } from './imap.service.js';

const CRLF = '\r\n';

/** Split raw RFC822 into unfolded header lines + the verbatim body buffer. */
export function splitHeadersAndBody(raw: Buffer): { headerLines: string[]; body: Buffer } {
  let sepIdx = -1;
  let sepLen = 4;
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      sepIdx = i;
      sepLen = 4;
      break;
    }
  }
  if (sepIdx < 0) {
    for (let i = 0; i + 1 < raw.length; i++) {
      if (raw[i] === 10 && raw[i + 1] === 10) {
        sepIdx = i;
        sepLen = 2;
        break;
      }
    }
  }
  const headerBuf = sepIdx >= 0 ? raw.subarray(0, sepIdx) : raw;
  const body = sepIdx >= 0 ? raw.subarray(sepIdx + sepLen) : Buffer.alloc(0);
  const headerLines: string[] = [];
  for (const line of headerBuf.toString('utf8').split(/\r\n|\n/)) {
    if (/^[ \t]/.test(line) && headerLines.length > 0) {
      headerLines[headerLines.length - 1] += CRLF + line;
    } else {
      headerLines.push(line);
    }
  }
  return { headerLines, body };
}

function headerName(line: string): string {
  const i = line.indexOf(':');
  return i >= 0 ? line.slice(0, i).trim().toLowerCase() : '';
}

/**
 * Partition the original top-level headers: Content-* stay with the inner
 * entity; MIME-Version is regenerated on the outer; everything else (identity,
 * addressing, threading, X-Universally-Unique-Identifier) lifts to the outer.
 */
export function partitionHeaders(headerLines: string[]): { outer: string[]; inner: string[] } {
  const outer: string[] = [];
  const inner: string[] = [];
  for (const line of headerLines) {
    const name = headerName(line);
    if (!name) continue;
    if (name === 'mime-version') continue;
    if (name.startsWith('content-')) inner.push(line);
    else outer.push(line);
  }
  return { outer, inner };
}

function base64Wrapped(buf: Buffer): string {
  return buf.toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
}

/** Assemble a multipart/mixed: [inner content headers + body verbatim] + attachments. */
export function buildWrappedMixed(
  outer: string[],
  inner: string[],
  body: Buffer,
  attachments: ResolvedAttachment[],
  ensureUuid: boolean,
): Buffer {
  const boundary = `----=_wgsresync_${randomUUID()}`;
  const hasUuid = outer.some((l) => headerName(l) === 'x-universally-unique-identifier');
  const outerLines = [...outer];
  if (ensureUuid && !hasUuid) {
    outerLines.push(`X-Universally-Unique-Identifier: ${randomUUID().toUpperCase()}`);
  }
  const parts: Buffer[] = [];
  const push = (s: string): void => {
    parts.push(Buffer.from(s, 'utf8'));
  };

  push(outerLines.join(CRLF) + CRLF);
  push(`MIME-Version: 1.0${CRLF}`);
  push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}`);

  // First child: original entity, byte-for-byte.
  push(`--${boundary}${CRLF}`);
  push((inner.length > 0 ? inner.join(CRLF) + CRLF : '') + CRLF);
  parts.push(body);
  push(CRLF);

  for (const a of attachments) {
    push(`--${boundary}${CRLF}`);
    push(`Content-Type: ${a.contentType}; name="${a.filename}"${CRLF}`);
    push(`Content-Transfer-Encoding: base64${CRLF}`);
    push(`Content-Disposition: attachment; filename="${a.filename}"${CRLF}${CRLF}`);
    push(base64Wrapped(a.content) + CRLF);
  }
  push(`--${boundary}--${CRLF}`);
  return Buffer.concat(parts);
}

/** cids referenced by the HTML body that have no matching inline part anywhere. */
export async function findDanglingCids(raw: Buffer): Promise<string[]> {
  const parsed = await simpleParser(raw);
  const referenced = extractCidReferences(typeof parsed.html === 'string' ? parsed.html : '');
  if (referenced.length === 0) return [];
  const present = new Set<string>();
  for (const a of parsed.attachments ?? []) {
    const cid = (a as { cid?: string; contentId?: string }).cid;
    const contentId = (a as { contentId?: string }).contentId;
    if (cid) present.add(cid);
    if (contentId) present.add(contentId.replace(/^<|>$/g, ''));
  }
  return referenced.filter((cid) => !present.has(cid));
}

function stripCidTags(html: string, dangling: Set<string>): { html: string; stripped: string[] } {
  const stripped: string[] = [];
  const drop = (m: string, cid: string): string => {
    if (dangling.has(cid)) {
      stripped.push(cid);
      return '';
    }
    return m;
  };
  let out = html.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'>\s]+)[^>]*>/gi, drop);
  out = out.replace(/<object\b[^>]*?\bdata\s*=\s*["']?cid:([^"'>\s]+)[\s\S]*?<\/object>/gi, drop);
  return { html: out, stripped };
}

/**
 * Rebuild `raw` with dangling cid <img>/<object> tags removed from the html
 * leaf. Re-encodes ONLY that leaf (as base64); every other byte is preserved.
 * Returns the original raw unchanged (with a warning) when the html leaf cannot
 * be confidently located.
 */
async function applyCidStrip(
  raw: Buffer,
  dangling: string[],
): Promise<{ raw: Buffer; stripped: string[]; warnings: string[] }> {
  if (dangling.length === 0) return { raw, stripped: [], warnings: [] };
  const parsed = await simpleParser(raw);
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  if (!html) return { raw, stripped: [], warnings: [] };
  const { html: cleaned, stripped } = stripCidTags(html, new Set(dangling));
  if (stripped.length === 0) return { raw, stripped: [], warnings: [] };

  // Byte-surgery: locate the text/html leaf's encoded region and swap it.
  const region = locateHtmlLeaf(raw);
  if (!region) {
    return {
      raw,
      stripped: [],
      warnings: [
        `${dangling.length} dangling cid ref(s) left in place — draft structure too nested to strip safely.`,
      ],
    };
  }
  const replacement = Buffer.concat([
    Buffer.from(`Content-Type: text/html; charset=utf-8${CRLF}`, 'utf8'),
    Buffer.from(`Content-Transfer-Encoding: base64${CRLF}${CRLF}`, 'utf8'),
    Buffer.from(base64Wrapped(Buffer.from(cleaned, 'utf8')) + CRLF, 'utf8'),
  ]);
  const out = Buffer.concat([raw.subarray(0, region.start), replacement, raw.subarray(region.end)]);
  return { raw: out, stripped, warnings: [] };
}

/**
 * Locate the byte region [start,end) covering the text/html leaf's own headers
 * + encoded body, for singlepart html and up to two multipart nesting levels.
 * Returns null when the structure is deeper/unknown (caller then skips + warns).
 */
function locateHtmlLeaf(raw: Buffer): { start: number; end: number } | null {
  const text = raw.toString('latin1');
  const headerEnd = (() => {
    const i = text.indexOf('\r\n\r\n');
    return i >= 0 ? i + 4 : text.indexOf('\n\n') + 2;
  })();
  const topHeaders = text.slice(0, headerEnd);
  // Singlepart text/html: leaf region is [headerEnd, end).
  if (/content-type:\s*text\/html/i.test(topHeaders) && !/multipart\//i.test(topHeaders)) {
    return { start: 0, end: raw.length };
  }
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(topHeaders)?.[1];
  if (!boundary) return null;
  return findHtmlSegment(text, boundary, 0);
}

function findHtmlSegment(text: string, boundary: string, depth: number): { start: number; end: number } | null {
  if (depth > 1) return null; // ≤2 nesting levels total
  const delim = `--${boundary}`;
  let idx = text.indexOf(delim);
  while (idx >= 0) {
    const segStart = text.indexOf('\n', idx) + 1;
    const next = text.indexOf(delim, segStart);
    if (next < 0) break;
    const seg = text.slice(segStart, next);
    const segHdrEnd = seg.indexOf('\r\n\r\n') >= 0 ? seg.indexOf('\r\n\r\n') + 4 : seg.indexOf('\n\n') + 2;
    const segHeaders = seg.slice(0, segHdrEnd);
    if (/content-type:\s*text\/html/i.test(segHeaders)) {
      // Byte offsets: segStart..(next) but trim the trailing CRLF before delim.
      const end = next - (text[next - 2] === '\r' ? 2 : 1);
      return { start: segStart, end };
    }
    const nestedBoundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(segHeaders)?.[1];
    if (nestedBoundary) {
      const nested = findHtmlSegment(seg, nestedBoundary, depth + 1);
      if (nested) return { start: segStart + nested.start, end: segStart + nested.end };
    }
    idx = next;
  }
  return null;
}

/** Public entry: strip (opt-in) then wrap the current entity + append attachments. */
export async function injectAttachments(
  raw: Buffer,
  attachments: ResolvedAttachment[],
  opts: { stripDanglingCids: boolean; ensureUuid?: boolean },
): Promise<{ raw: Buffer; strippedCids: string[]; warnings: string[] }> {
  let working = raw;
  let strippedCids: string[] = [];
  const warnings: string[] = [];
  if (opts.stripDanglingCids) {
    const dangling = await findDanglingCids(raw);
    const res = await applyCidStrip(raw, dangling);
    working = res.raw;
    strippedCids = res.stripped;
    warnings.push(...res.warnings);
  }
  const { headerLines, body } = splitHeadersAndBody(working);
  const { outer, inner } = partitionHeaders(headerLines);
  const out = buildWrappedMixed(outer, inner, body, attachments, opts.ensureUuid ?? true);
  return { raw: out, strippedCids, warnings };
}
```

> **Implementer note:** `extractCidReferences` is already exported from `imap.service.ts` (line ~258). Importing `imap.service.js` from `mime-splice.ts` is safe — `mime-splice` is only imported by `imap.service` at call time, and `extractCidReferences` is a module-level pure function (no construction cycle at import). If Node/TS flags a real circular-init issue, copy `extractCidReferences` into `mime-splice.ts` and have `imap.service.ts` re-export it from there.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/services/mime-splice.test.ts`
Expected: PASS. If the strip test fails on leaf location, debug `locateHtmlLeaf` against the composed sample (MailComposer emits `multipart/alternative` for `html` with an auto text part, or singlepart when only `html`).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/mime-splice.ts src/services/mime-splice.test.ts
git commit -m "feat(drafts): byte-preserving MIME splice + dangling-cid strip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: UUID stamp + cache wiring in save/update paths

**Files:**
- Modify: `src/services/imap.service.ts` (`saveDraft` ~2167-2216, `saveDraftWithAttachments` ~2250-2284, `updateDraft` ~2363-2488; add cache field + import)
- Test: extend `src/__integration__/email-drafts.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 (`normalizeFrom`, `normalizeSubject`, `LineageRef`), Task 2 (`DraftAttachmentCache`).
- Produces (relied on by Tasks 5–6):
  - `ImapService.saveDraft(...)` now returns `{ id: number; mailbox: string; uuid: string }` and accepts `options.uuid?: string` (carry-forward) — stamps header `X-Universally-Unique-Identifier`.
  - `private draftCache: DraftAttachmentCache` field on `ImapService`.
  - `private lineageRefFor(account: string, from: string, subject: string, uuid?: string): LineageRef`.

- [ ] **Step 1: Write the failing test** (append to the existing draft integration suite)

```typescript
// add inside src/__integration__/email-drafts.integration.test.ts describe block
describe('UUID stamp + cache (resync enablers)', () => {
  it('save_draft stamps X-Universally-Unique-Identifier and returns it', async () => {
    const saved = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['bob@localhost'],
      subject: 'UUID stamp test',
      body: 'hi',
      html: true,
    });
    expect(saved.uuid).toMatch(/[0-9A-F-]{36}/);
    const full = await services.imapService.getEmail(TEST_ACCOUNT_NAME, String(saved.id), saved.mailbox);
    expect(full.headers['x-universally-unique-identifier']).toBe(saved.uuid);
  });

  it('update_draft carries the same UUID forward', async () => {
    const saved = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['bob@localhost'],
      subject: 'UUID carry test',
      body: 'v1',
      html: true,
    });
    const updated = await services.imapService.updateDraft(TEST_ACCOUNT_NAME, saved.id, { body: 'v2' });
    const full = await services.imapService.getEmail(TEST_ACCOUNT_NAME, String(updated.id), updated.mailbox);
    expect(full.headers['x-universally-unique-identifier']).toBe(saved.uuid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration src/__integration__/email-drafts.integration.test.ts`
Expected: FAIL — `saved.uuid` undefined / header absent.

- [ ] **Step 3: Implement — add imports, cache field, and stamp/return/carry/record**

At the top imports of `imap.service.ts` add:

```typescript
import { randomUUID } from 'node:crypto';
import { DraftAttachmentCache } from './draft-attachment-cache.js';
import { type LineageRef, normalizeFrom, normalizeSubject } from './draft-lineage.js';
```

Add the field just inside the class body (near other private fields):

```typescript
  /** Session-lifetime cache backing resync_draft_attachments (design §5). */
  readonly draftCache = new DraftAttachmentCache();

  private lineageRefFor(account: string, from: string, subject: string, uuid?: string): LineageRef {
    return { account, from: normalizeFrom(from), subjectNorm: normalizeSubject(subject), uuid };
  }
```

Change `saveDraft`'s signature/return and stamp the header. Replace the options type line and the `mailOptions`/return:

```typescript
  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      attachments?: ResolvedAttachment[];
      uuid?: string; // carry-forward; minted when absent
    },
  ): Promise<{ id: number; mailbox: string; uuid: string }> {
    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    const fromAddr = account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;
    const hasDraftAttachments = !!options.attachments && options.attachments.length > 0;
    const uuid = options.uuid ?? randomUUID().toUpperCase();

    const mailOptions = {
      from: fromAddr,
      to: options.to.length > 0 ? options.to.join(', ') : undefined,
      cc: options.cc?.length ? options.cc.join(', ') : undefined,
      bcc: options.bcc?.length ? options.bcc.join(', ') : undefined,
      subject: options.subject,
      inReplyTo: options.inReplyTo,
      date: new Date(),
      headers: { 'X-Universally-Unique-Identifier': uuid },
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(hasDraftAttachments ? { attachments: options.attachments } : {}),
    };

    const rawMessage = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(mailOptions).compile().build((err: Error | null, buf: Buffer) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });

    const appendResult = await client.append(draftsPath, rawMessage, ['\\Draft', '\\Seen']);
    return {
      id: (appendResult as unknown as { uid?: number }).uid ?? 0,
      mailbox: draftsPath,
      uuid,
    };
  }
```

In `saveDraftWithAttachments`, after the `saveDraft` call, record the cache + uid map. Replace its final `return this.saveDraft(...)` with:

```typescript
    const saved = await this.saveDraft(accountName, {
      to: options.to,
      subject: options.subject,
      body: options.body,
      cc: options.cc,
      bcc: options.bcc,
      html: options.html,
      inReplyTo: options.inReplyTo,
      attachments: resolved,
    });

    const account = this.connections.getAccount(accountName);
    const ref = this.lineageRefFor(accountName, account.email, options.subject, saved.uuid);
    this.draftCache.mapUid(saved.id, ref);
    this.recordAttachmentOrigins(ref, options.attachments ?? [], resolved);
    return saved;
```

Add the origin-recording helper (private method on the class):

```typescript
  /** Cache each saved attachment by its ORIGIN (path re-read at apply; else bytes). */
  private recordAttachmentOrigins(
    ref: LineageRef,
    inputs: AttachmentInput[],
    resolved: ResolvedAttachment[],
  ): void {
    for (const r of resolved) {
      const match = inputs.find(
        (i) => ('filename' in i && i.filename === r.filename) ||
          ('path' in i && !i.filename && i.path.endsWith(r.filename)),
      );
      if (match && 'path' in match) {
        this.draftCache.record(ref, r.filename, { kind: 'path', path: match.path }, r.content.length);
      } else {
        this.draftCache.record(
          ref,
          r.filename,
          { kind: 'bytes', content: r.content, contentType: r.contentType },
          r.content.length,
        );
      }
    }
  }
```

In `updateDraft`: (a) read the existing UUID and pass it forward; (b) record removals; (c) record cache + uid map for the new draft. Add near the top after `existing` is fetched:

```typescript
    const existingUuid = existing.headers['x-universally-unique-identifier'];
```

Record removals right after the `keepFilenames` removal filtering block:

```typescript
    const account = this.connections.getAccount(accountName);
    const ref = this.lineageRefFor(accountName, account.email, subject, existingUuid);
    if (options.attachmentsRemove) {
      for (const f of options.attachmentsRemove) this.draftCache.recordRemoval(ref, f);
    }
```

> Note: `subject` is computed lower in the method. Move the `const subject = options.subject ?? existing.subject;` line ABOVE this block (it only depends on `options`/`existing`), or inline `options.subject ?? existing.subject` here.

Pass the UUID into the `saveDraft` call and record after:

```typescript
    const newId = await this.saveDraft(accountName, {
      to, subject, body, cc, bcc, html, inReplyTo,
      attachments: allAttachments,
      uuid: existingUuid,
    });
    const newRef = this.lineageRefFor(accountName, account.email, subject, newId.uuid);
    this.draftCache.mapUid(newId.id, newRef);
    for (const a of allAttachments) {
      this.draftCache.record(
        newRef, a.filename, { kind: 'bytes', content: a.content, contentType: a.contentType }, a.content.length,
      );
    }
```

(The `updateDraft` return object already uses `newId.id`/`newId.mailbox`; those are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:integration src/__integration__/email-drafts.integration.test.ts`
Expected: PASS (UUID stamped/returned; carried forward). Also run `pnpm test:integration` broadly to confirm no regression in existing draft tests (the `saveDraft` return now has an extra `uuid` field — additive, non-breaking).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/imap.service.ts src/__integration__/email-drafts.integration.test.ts
git commit -m "feat(drafts): stamp lineage UUID and populate session cache on save/update

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Lineage resolution + `resyncDraftAttachments` orchestrator

**Files:**
- Modify: `src/services/imap.service.ts` (add methods near the draft section; add `SupersededDraftError`)
- Test: `src/__integration__/draft-resync.integration.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–4; `resolveAttachments`, `extractAttachmentMeta`, `fetchDraftRaw`, `deleteDraft`.
- Produces:
  - `interface ResyncMissing { filename: string; size?: number; source: 'ancestor' | 'cache' | 'none'; lastSeenOnUid?: number; recoverable: boolean }`
  - `interface ResyncReport { currentUid: number; mailbox: string; lineageUids: number[]; missing: ResyncMissing[]; intentionallyRemovedExcluded: string[]; danglingCids: string[] }`
  - `interface ResyncApplyResult { newUid: number | null; mailbox: string; restored: string[]; skippedUnrecoverable: string[]; oldUidReplaced: number | null; strippedCids: string[]; warnings: string[] }`
  - `ImapService.resolveDraftLineage(account, opts: { draftId?: number; subject?: string; mailbox?: string }): Promise<{ mailbox: string; current: DraftRow; ancestors: DraftRow[]; ref: LineageRef } | null>`
  - `ImapService.resyncDraftAttachments(account, opts: { draftId?: number; subject?: string; apply: boolean; attachments?: string[]; stripDanglingCids: boolean; mailbox?: string }): Promise<{ report: ResyncReport } | ({ report: ResyncReport } & { applied: ResyncApplyResult })>`
  - `class SupersededDraftError extends Error { hint: { newestUid: number; newestDate: string; attachmentDiff: { filename: string; presentOnNewest: boolean }[] } }`

- [ ] **Step 1: Write the failing test** (the PRD §2 fixture — acceptance #1)

```typescript
// src/services/draft-resync.integration.test.ts  →  place under src/__integration__/
import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

async function ensureDrafts(s: TestServices): Promise<string> {
  try {
    await s.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
  } catch {
    /* exists */
  }
  return 'Drafts';
}

describe('resync_draft_attachments (PRD §2 fixture)', () => {
  let services: TestServices;
  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    await ensureDrafts(services);
  });
  afterAll(async () => {
    await services.connections.closeAll();
  });

  it('reports + re-applies the PDFs Mail dropped, byte-preserving the user body', async () => {
    // 1) MCP saves a draft with 2 PDFs (populates the session cache).
    const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
      to: ['andy@chk-electronics.com'],
      subject: 'New WGS orders - JK-1401',
      body: '<p>Andy, two POs attached.</p>',
      html: true,
      attachments: [
        { contentBase64: Buffer.from('%PDF one').toString('base64'), filename: 'PO-209464.pdf', mimeType: 'application/pdf' },
        { contentBase64: Buffer.from('%PDF two').toString('base64'), filename: 'PO-209465.pdf', mimeType: 'application/pdf' },
      ],
    });

    // 2) Simulate Apple Mail's re-save: a NEWER, bare draft (same subject, no
    //    attachments, a dangling cid), then expunge the ancestor.
    const mailResave = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['andy@chk-electronics.com'],
      subject: 'New WGS orders - JK-1401',
      body: '<p>Andy, two POs attached.</p><img src="cid:sig@apple">',
      html: true,
    });
    await services.imapService.deleteDraft(TEST_ACCOUNT_NAME, original.id, original.mailbox);

    // 3) Report (apply=false) names both PDFs + the current UID.
    const { report } = await services.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: mailResave.id,
      apply: false,
      stripDanglingCids: true,
    });
    expect(report.currentUid).toBe(mailResave.id);
    expect(report.missing.map((m) => m.filename).sort()).toEqual(['PO-209464.pdf', 'PO-209465.pdf']);
    expect(report.missing.every((m) => m.recoverable)).toBe(true);
    expect(report.danglingCids).toEqual(['sig@apple']);

    // 4) Apply: new draft has both PDFs, user text intact, cid stub gone, old UID replaced.
    const applied = await services.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: mailResave.id,
      apply: true,
      stripDanglingCids: true,
    });
    expect(applied.applied.restored.sort()).toEqual(['PO-209464.pdf', 'PO-209465.pdf']);
    expect(applied.applied.oldUidReplaced).toBe(mailResave.id);
    expect(applied.applied.strippedCids).toEqual(['sig@apple']);

    const restored = await services.imapService.getEmail(
      TEST_ACCOUNT_NAME, String(applied.applied.newUid), applied.applied.mailbox,
    );
    expect(restored.attachments.map((a) => a.filename).sort()).toEqual(['PO-209464.pdf', 'PO-209465.pdf']);
    expect(restored.bodyHtml ?? '').toContain('Andy, two POs attached.');
    expect(restored.bodyHtml ?? '').not.toContain('cid:sig@apple');

    // Old UID is gone.
    await expect(
      services.imapService.getEmail(TEST_ACCOUNT_NAME, String(mailResave.id), applied.applied.mailbox),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration src/__integration__/draft-resync.integration.test.ts`
Expected: FAIL — `resyncDraftAttachments` not a function.

- [ ] **Step 3: Implement the methods** (add to `imap.service.ts`, draft section)

Add imports (top of file):

```typescript
import { injectAttachments, findDanglingCids } from './mime-splice.js';
import {
  type DraftRow,
  type LineageRef,
  diffMissingAttachments,
  orderByInternalDate,
  parseUuidHeader,
  sameLineage,
} from './draft-lineage.js';
```

Add the error class near the top-level exports (module scope, after the other exported helpers):

```typescript
export class SupersededDraftError extends Error {
  constructor(
    message: string,
    readonly hint: {
      newestUid: number;
      newestDate: string;
      attachmentDiff: { filename: string; presentOnNewest: boolean }[];
    },
  ) {
    super(message);
    this.name = 'SupersededDraftError';
  }
}
```

Add these methods to the class (place after `updateDraft`):

```typescript
  /** Resolve the Drafts folder path (autodetect unless overridden). */
  private async resolveDraftsPath(accountName: string, mailbox?: string): Promise<string> {
    if (mailbox) return mailbox;
    const client = await this.connections.getImapClient(accountName);
    const mailboxes = await client.list();
    return mailboxes.find((mb) => mb.specialUse === '\\Drafts')?.path ?? 'Drafts';
  }

  /** Fetch every draft row (uid/from/subject/internalDate/attachments/uuid). */
  private async listDraftLineageRaw(accountName: string, mailbox: string): Promise<DraftRow[]> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await client.getMailboxLock(mailbox);
    const rows: DraftRow[] = [];
    try {
      // Empty folder → fetch throws/does nothing; guard with status.
      const status = await client.status(mailbox, { messages: true });
      if (!status.messages || status.messages === 0) return rows;
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        '1:*',
        { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ['x-universally-unique-identifier'] },
        { uid: true },
      )) {
        const m = msg as unknown as Record<string, unknown>;
        const envelope = (m.envelope ?? {}) as Record<string, unknown>;
        const fromEntry = (envelope.from as Record<string, string>[] | undefined)?.[0];
        rows.push({
          uid: m.uid as number,
          from: fromEntry?.address ?? '',
          subject: (envelope.subject as string) ?? '',
          internalDate: m.internalDate ? new Date(m.internalDate as string) : new Date(0),
          attachments: extractAttachmentMeta(m.bodyStructure),
          uuid: parseUuidHeader(m.headers as Buffer | undefined),
        });
      }
    } finally {
      lock.release();
    }
    return rows;
  }

  async resolveDraftLineage(
    accountName: string,
    opts: { draftId?: number; subject?: string; mailbox?: string },
  ): Promise<{ mailbox: string; current: DraftRow; ancestors: DraftRow[]; ref: LineageRef } | null> {
    const mailbox = await this.resolveDraftsPath(accountName, opts.mailbox);
    const rows = await this.listDraftLineageRaw(accountName, mailbox);
    const account = this.connections.getAccount(accountName);

    // Determine the anchor lineage ref.
    let anchor: LineageRef | undefined;
    if (opts.draftId !== undefined) {
      const hit = rows.find((r) => r.uid === opts.draftId);
      anchor = hit
        ? { account: accountName, from: normalizeFrom(hit.from), subjectNorm: normalizeSubject(hit.subject), uuid: hit.uuid }
        : this.draftCache.lineageForUid(opts.draftId);
    } else if (opts.subject !== undefined) {
      anchor = {
        account: accountName,
        from: normalizeFrom(account.email),
        subjectNorm: normalizeSubject(opts.subject),
        uuid: undefined,
      };
    }
    if (!anchor) return null;

    const group = orderByInternalDate(
      rows.filter((r) => sameLineage({ from: normalizeFrom(r.from), subjectNorm: normalizeSubject(r.subject), uuid: r.uuid }, anchor)),
    );
    if (group.length === 0) return null;
    const current = group[group.length - 1];
    return { mailbox, current, ancestors: group.slice(0, -1), ref: { ...anchor, uuid: current.uuid ?? anchor.uuid } };
  }

  async resyncDraftAttachments(
    accountName: string,
    opts: { draftId?: number; subject?: string; apply: boolean; attachments?: string[]; stripDanglingCids: boolean; mailbox?: string },
  ): Promise<{ report: ResyncReport; applied?: ResyncApplyResult }> {
    const lineage = await this.resolveDraftLineage(accountName, opts);
    if (!lineage) {
      throw new Error('No draft lineage found for the given draft_id/subject in the Drafts folder.');
    }
    const { mailbox, current, ancestors, ref } = lineage;

    // Candidate missing = ancestor files + cached files, minus what's on current.
    const currentNames = new Set(current.attachments.map((a) => a.filename));
    const fromAncestors = diffMissingAttachments(current, ancestors); // {filename,size,lastSeenOnUid}
    const ancestorNames = new Set(fromAncestors.map((m) => m.filename));
    const cached = this.draftCache.lookup(ref).filter((c) => !currentNames.has(c.filename));

    const allNames = new Set<string>([...ancestorNames, ...cached.map((c) => c.filename)]);
    const allowlist = opts.attachments ? new Set(opts.attachments) : undefined;

    const intentionallyRemovedExcluded: string[] = [];
    const missing: ResyncMissing[] = [];
    for (const filename of allNames) {
      if (allowlist && !allowlist.has(filename)) continue;
      if (!allowlist && this.draftCache.isRemoved(ref, filename)) {
        intentionallyRemovedExcluded.push(filename);
        continue;
      }
      const anc = fromAncestors.find((m) => m.filename === filename);
      const cacheHit = cached.find((c) => c.filename === filename);
      if (anc) {
        missing.push({ filename, size: anc.size, source: 'ancestor', lastSeenOnUid: anc.lastSeenOnUid, recoverable: true });
      } else if (cacheHit) {
        missing.push({ filename, size: cacheHit.size, source: 'cache', recoverable: true });
      } else {
        missing.push({ filename, source: 'none', recoverable: false });
      }
    }

    const danglingCids = opts.stripDanglingCids || !opts.apply
      ? await this.danglingCidsForDraft(accountName, current.uid, mailbox)
      : [];

    const report: ResyncReport = {
      currentUid: current.uid,
      mailbox,
      lineageUids: [...ancestors.map((a) => a.uid), current.uid],
      missing,
      intentionallyRemovedExcluded,
      danglingCids,
    };

    if (!opts.apply) return { report };

    // ---- apply ----
    const recoverable = missing.filter((m) => m.recoverable);
    if (recoverable.length === 0 && danglingCids.length === 0) {
      return {
        report,
        applied: { newUid: null, mailbox, restored: [], skippedUnrecoverable: missing.filter((m) => !m.recoverable).map((m) => m.filename), oldUidReplaced: null, strippedCids: [], warnings: ['Nothing to restore.'] },
      };
    }

    const resolved: ResolvedAttachment[] = [];
    const restored: string[] = [];
    const skippedUnrecoverable = missing.filter((m) => !m.recoverable).map((m) => m.filename);
    const warnings: string[] = [];

    for (const m of recoverable) {
      try {
        if (m.source === 'ancestor' && m.lastSeenOnUid !== undefined) {
          const r = await resolveAttachments(this, accountName, [
            { sourceEmailId: String(m.lastSeenOnUid), sourceMailbox: mailbox, filename: m.filename },
          ]);
          if (r.failures.length > 0) throw new Error(r.failures[0].reason);
          resolved.push(...r.resolved);
        } else {
          const hit = this.draftCache.find(ref, m.filename);
          if (!hit) throw new Error('cache miss');
          if (hit.origin.kind === 'path') {
            const r = await resolveAttachments(this, accountName, [{ path: hit.origin.path, filename: m.filename }]);
            if (r.failures.length > 0) throw new Error(r.failures[0].reason);
            resolved.push(...r.resolved);
          } else {
            resolved.push({ filename: m.filename, content: hit.origin.content, contentType: hit.origin.contentType });
          }
        }
        restored.push(m.filename);
      } catch (err) {
        skippedUnrecoverable.push(m.filename);
        warnings.push(`Could not recover "${m.filename}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const rawCurrent = await this.fetchDraftRaw(accountName, current.uid, mailbox);
    const spliced = await injectAttachments(rawCurrent, resolved, {
      stripDanglingCids: opts.stripDanglingCids,
      ensureUuid: true,
    });
    warnings.push(...spliced.warnings);

    const newUid = await this.appendRawDraft(accountName, spliced.raw, mailbox);

    let oldUidReplaced: number | null = null;
    try {
      await this.deleteDraft(accountName, current.uid, mailbox);
      oldUidReplaced = current.uid;
    } catch (err) {
      warnings.push(`New draft ${newUid} saved but deleting old UID ${current.uid} failed: ${err instanceof Error ? err.message : String(err)}.`);
    }

    // Cache/uidMap for the new draft.
    this.draftCache.mapUid(newUid, ref);
    for (const a of resolved) {
      this.draftCache.record(ref, a.filename, { kind: 'bytes', content: a.content, contentType: a.contentType }, a.content.length);
    }

    return {
      report,
      applied: { newUid, mailbox, restored, skippedUnrecoverable, oldUidReplaced, strippedCids: spliced.strippedCids, warnings },
    };
  }

  private async danglingCidsForDraft(accountName: string, uid: number, mailbox: string): Promise<string[]> {
    try {
      const raw = await this.fetchDraftRaw(accountName, uid, mailbox);
      return await findDanglingCids(raw);
    } catch {
      return [];
    }
  }

  /** APPEND pre-built raw draft bytes; returns the new UID. */
  async appendRawDraft(accountName: string, raw: Buffer, mailbox: string): Promise<number> {
    const client = await this.connections.getImapClient(accountName);
    const appendResult = await client.append(mailbox, raw, ['\\Draft', '\\Seen']);
    return (appendResult as unknown as { uid?: number }).uid ?? 0;
  }

  /** Supersession lookup for a (possibly dead) UID via the session lineage map. */
  async findSupersession(
    accountName: string,
    deadUid: number,
    mailbox?: string,
  ): Promise<SupersededDraftError['hint'] | null> {
    const lineage = await this.resolveDraftLineage(accountName, { draftId: deadUid, mailbox });
    if (!lineage || lineage.current.uid === deadUid) return null;
    const presentNames = new Set(lineage.current.attachments.map((a) => a.filename));
    const names = new Set<string>([
      ...lineage.ancestors.flatMap((a) => a.attachments.map((x) => x.filename)),
      ...lineage.current.attachments.map((a) => a.filename),
      ...this.draftCache.lookup(lineage.ref).map((c) => c.filename),
    ]);
    return {
      newestUid: lineage.current.uid,
      newestDate: lineage.current.internalDate.toISOString(),
      attachmentDiff: [...names].map((filename) => ({ filename, presentOnNewest: presentNames.has(filename) })),
    };
  }
```

Add the result interfaces near the top-level type exports of the file (module scope):

```typescript
export interface ResyncMissing {
  filename: string;
  size?: number;
  source: 'ancestor' | 'cache' | 'none';
  lastSeenOnUid?: number;
  recoverable: boolean;
}
export interface ResyncReport {
  currentUid: number;
  mailbox: string;
  lineageUids: number[];
  missing: ResyncMissing[];
  intentionallyRemovedExcluded: string[];
  danglingCids: string[];
}
export interface ResyncApplyResult {
  newUid: number | null;
  mailbox: string;
  restored: string[];
  skippedUnrecoverable: string[];
  oldUidReplaced: number | null;
  strippedCids: string[];
  warnings: string[];
}
```

> **Implementer note:** confirm `client.status(mailbox, { messages: true })` exists in imapflow (it does — `status(path, query)`). If `1:*` fetch on a non-empty folder still errors on some servers, fall back to `client.search({ all: true })` for UIDs and fetch by the returned list.

- [ ] **Step 4: Run the fixture test**

Run: `pnpm test:integration src/__integration__/draft-resync.integration.test.ts`
Expected: PASS (report names both PDFs; apply restores them, strips the cid, replaces the old UID, preserves the user text).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/imap.service.ts src/__integration__/draft-resync.integration.test.ts
git commit -m "feat(drafts): resolveDraftLineage + resyncDraftAttachments orchestrator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `resync_draft_attachments` tool + supersession hints

**Files:**
- Modify: `src/tools/drafts.tool.ts` (new tool; hint rendering in `update_draft` + `send_draft`)
- Modify: `src/tools/register.ts` (register the tool)
- Modify: `src/services/smtp.service.ts` (`sendDraft`: superseded not-found → `SupersededDraftError`; non-newest → warning)
- Test: extend `src/__integration__/draft-resync.integration.test.ts` (acceptance #2, #3)

**Interfaces:**
- Consumes: Task 5 (`resyncDraftAttachments`, `findSupersession`, `SupersededDraftError`).
- Produces: MCP tool `resync_draft_attachments`; `draft_superseded` structured error text in `update_draft`/`send_draft`.

- [ ] **Step 1: Write the failing test** (append to the resync integration suite)

```typescript
describe('supersession hints + removal exclusion', () => {
  let s: TestServices;
  beforeAll(async () => {
    s = createTestServices(buildTestAccount());
    await ensureDrafts(s);
  });
  afterAll(async () => {
    await s.connections.closeAll();
  });

  it('findSupersession points a dead UID at the newest lineage member (acceptance #2)', async () => {
    const first = await s.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'], subject: 'Superseded subj', body: 'a', html: true,
    });
    const second = await s.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'], subject: 'Superseded subj', body: 'b', html: true,
    });
    await s.imapService.deleteDraft(TEST_ACCOUNT_NAME, first.id, first.mailbox); // Mail expunged the old UID
    const hint = await s.imapService.findSupersession(TEST_ACCOUNT_NAME, first.id, first.mailbox);
    expect(hint?.newestUid).toBe(second.id);
  });

  it('does NOT restore an attachment removed via attachments_remove (acceptance #3)', async () => {
    const saved = await s.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'], subject: 'Removal test', body: 'hi', html: true,
      attachments: [{ contentBase64: Buffer.from('X').toString('base64'), filename: 'drop.pdf', mimeType: 'application/pdf' }],
    });
    // Intentionally remove it via update_draft.
    const updated = await s.imapService.updateDraft(TEST_ACCOUNT_NAME, saved.id, { attachmentsRemove: ['drop.pdf'] });
    const { report } = await s.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: updated.id, apply: false, stripDanglingCids: true,
    });
    expect(report.missing.map((m) => m.filename)).not.toContain('drop.pdf');
    expect(report.intentionallyRemovedExcluded).toContain('drop.pdf');
    // Explicit allowlist overrides the exclusion.
    const explicit = await s.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: updated.id, apply: false, stripDanglingCids: true, attachments: ['drop.pdf'],
    });
    expect(explicit.report.missing.map((m) => m.filename)).toContain('drop.pdf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration src/__integration__/draft-resync.integration.test.ts`
Expected: FAIL — the new `describe` block references behavior already implemented in Task 5, so these should actually PASS at the service level. If they pass, that confirms Task 5; proceed to wire the tool (the tool itself has no separate integration harness — it's validated via the service). Treat any failure here as a Task 5 regression to fix first.

- [ ] **Step 3: Register the tool + wire hints**

In `src/tools/drafts.tool.ts`, import the error and add the tool inside `registerDraftTools` (after `update_draft`):

```typescript
import { SupersededDraftError } from '../services/imap.service.js';
```

```typescript
  // -------------------------------------------------------------------------
  // resync_draft_attachments
  // -------------------------------------------------------------------------
  server.tool(
    'resync_draft_attachments',
    'Detect and restore attachments that Apple Mail silently dropped when it re-saved an MCP ' +
      'draft. Resolves the draft lineage (same From + subject, or a shared Apple UUID), diffs ' +
      'attachments against ancestors and the session cache, and (with apply=true) APPENDs a new ' +
      "draft that carries the user's body BYTE-FOR-BYTE plus the recovered files. apply=false " +
      '(default) reports only. Pass draft_id (any UID in the lineage) OR subject.',
    {
      account: z.string().describe('Account name from list_accounts'),
      draft_id: z.number().int().optional().describe('UID of any draft in the lineage (ancestor or current)'),
      subject: z.string().optional().describe('Exact draft subject — use when the UID is unknown'),
      apply: z.boolean().default(false).describe('false = report only (no write); true = re-apply'),
      attachments: z.array(z.string()).optional().describe('Explicit filename allowlist to restore (overrides intentional-removal exclusion)'),
      strip_dangling_cids: z.boolean().default(true).describe('When applying, strip <img>/<object> whose cid: has no matching part'),
      mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, draft_id: draftId, subject, apply, attachments, strip_dangling_cids: strip, mailbox }) => {
      if ((draftId === undefined) === (subject === undefined)) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Provide exactly one of draft_id or subject.' }] };
      }
      try {
        const res = await imapService.resyncDraftAttachments(account, {
          draftId, subject, apply, attachments, stripDanglingCids: strip, mailbox,
        });
        await audit.log('resync_draft_attachments', account, { draftId, subject, apply }, 'ok');
        const r = res.report;
        if (!apply) {
          const lines = [
            `🔎 Resync report — current draft UID ${r.currentUid} (folder: ${r.mailbox}), lineage UIDs: ${r.lineageUids.join(', ')}.`,
            r.missing.length > 0
              ? `Missing: ${r.missing.map((m) => `${m.filename} [${m.recoverable ? m.source : 'UNRECOVERABLE'}]`).join(', ')}`
              : 'No missing attachments.',
            r.intentionallyRemovedExcluded.length > 0 ? `Excluded (intentionally removed): ${r.intentionallyRemovedExcluded.join(', ')}` : '',
            r.danglingCids.length > 0 ? `Dangling cids: ${r.danglingCids.join(', ')}` : '',
            'Run again with apply=true to restore.',
          ].filter(Boolean);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        const a = res.applied!;
        if (a.newUid === null) {
          return { content: [{ type: 'text' as const, text: `✅ Nothing to restore for draft UID ${r.currentUid}.` }] };
        }
        const warnBlock = a.warnings.length > 0 ? `\n\nWarnings:\n  - ${a.warnings.join('\n  - ')}` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `♻️ Resynced. New draft UID: ${a.newUid} (folder: ${a.mailbox}); restored: ${a.restored.join(', ') || 'none'}; ` +
              `old UID ${a.oldUidReplaced} replaced${a.strippedCids.length ? `; stripped cids: ${a.strippedCids.join(', ')}` : ''}` +
              `${a.skippedUnrecoverable.length ? `; UNRECOVERABLE: ${a.skippedUnrecoverable.join(', ')}` : ''}.${warnBlock}`,
          }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('resync_draft_attachments', account, { draftId, subject, apply }, 'error', errMsg);
        return { isError: true, content: [{ type: 'text' as const, text: `Failed to resync draft: ${errMsg}` }] };
      }
    },
  );
```

Wire the supersession hint into `update_draft`'s catch. Replace its `catch (err)` body with a superseded-aware branch:

```typescript
      } catch (err) {
        if (/not found in/i.test(err instanceof Error ? err.message : '')) {
          const hint = await imapService.findSupersession(account, draftId, mailbox).catch(() => null);
          if (hint) {
            await audit.log('update_draft', account, { draftId, mailbox }, 'error', 'draft_superseded');
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: `⚠️ draft_superseded: UID ${draftId} is gone; newest is UID ${hint.newestUid} (${hint.newestDate}). ` +
                  `Retry update_draft against ${hint.newestUid}, or run resync_draft_attachments(draft_id=${hint.newestUid}, apply=true) to restore attachments.`,
              }],
            };
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('update_draft', account, { draftId, mailbox }, 'error', errMsg);
        return { isError: true, content: [{ type: 'text' as const, text: `Failed to update draft: ${errMsg}` }] };
      }
```

In `src/tools/register.ts`, the draft tools are already registered via `registerDraftTools(server, imapService, smtpService)` — the new tool is inside that function, so **no change needed** beyond confirming it stays in the write-tools block. (Verify: `registerDraftTools` is called under `if (!readOnly)`.)

In `src/services/smtp.service.ts` `sendDraft`, wrap the initial `fetchDraft` and add the non-newest warning. Change the fetch block to:

```typescript
    let draft: Email;
    let draftsPath: string;
    try {
      const fetched = await this.imapService.fetchDraft(accountName, draftId, mailbox);
      draft = fetched.email;
      draftsPath = fetched.mailbox;
    } catch (err) {
      if (/not found in/i.test(err instanceof Error ? err.message : '')) {
        const hint = await this.imapService.findSupersession(accountName, draftId, mailbox).catch(() => null);
        if (hint) {
          throw new SupersededDraftError(
            `Draft ${draftId} was superseded; newest is UID ${hint.newestUid}. Send that instead (or resync first).`,
            hint,
          );
        }
      }
      throw err;
    }
```

Add the import at the top of `smtp.service.ts`:

```typescript
import { SupersededDraftError } from './imap.service.js';
import type { Email } from '../types/index.js';
```

After `draftsPath` is set, add the non-newest warn-only check (does not block the send):

```typescript
    const supersession = await this.imapService.findSupersession(accountName, draftId, draftsPath).catch(() => null);
    // supersession is non-null only when a NEWER lineage member exists.
```

Then include a warning in the returned result. Change the final `return` to thread a `warning`:

```typescript
    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      ...(supersession ? { warning: `A newer draft (UID ${supersession.newestUid}) exists in this lineage; you sent UID ${draftId}.` } : {}),
    };
```

> `SendResult` (types/index.ts) must allow an optional `warning?: string`. Add it:

```typescript
export interface SendResult {
  messageId: string;
  status: 'sent' | 'failed';
  warning?: string;
}
```

And in `drafts.tool.ts` `send_draft`, surface the warning + catch `SupersededDraftError`:

```typescript
      try {
        const result = await smtpService.sendDraft(account, id, mailbox);
        await audit.log('send_draft', account, { id, mailbox }, 'ok');
        const warn = result.warning ? `\n⚠️ ${result.warning}` : '';
        return { content: [{ type: 'text' as const, text: `✅ Draft sent (Message-ID: ${result.messageId}). Draft removed from folder.${warn}` }] };
      } catch (err) {
        if (err instanceof SupersededDraftError) {
          await audit.log('send_draft', account, { id, mailbox }, 'error', 'draft_superseded');
          return { isError: true, content: [{ type: 'text' as const, text: `⚠️ draft_superseded: ${err.message} (newest UID ${err.hint.newestUid}).` }] };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('send_draft', account, { id, mailbox }, 'error', errMsg);
        return { isError: true, content: [{ type: 'text' as const, text: `Failed to send draft: ${errMsg}` }] };
      }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test:integration src/__integration__/draft-resync.integration.test.ts` → PASS (supersession + removal exclusion).
Run: `pnpm typecheck` → clean. Run `pnpm check` → no new errors.
Also run: `pnpm test:integration src/__integration__/email-drafts.integration.test.ts` and any send-draft integration test to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add src/tools/drafts.tool.ts src/tools/register.ts src/services/smtp.service.ts src/services/imap.service.ts src/types/index.ts src/__integration__/draft-resync.integration.test.ts
git commit -m "feat(drafts): resync_draft_attachments tool + draft_superseded hints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Register-list test, docs, and full verification

**Files:**
- Modify: `src/tools/register.test.ts` (assert the tool is registered / skipped in read-only)
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Extend the register test**

Open `src/tools/register.test.ts`, find the assertion listing registered write-tool names, and add `'resync_draft_attachments'` to the expected set (and to the read-only "must NOT be registered" set if that pattern exists). Match the file's existing style exactly.

- [ ] **Step 2: Run it**

Run: `pnpm test src/tools/register.test.ts`
Expected: PASS.

- [ ] **Step 3: Document**

Add to `README.md` in the drafts/tools section (match surrounding table/prose style):

```markdown
- **`resync_draft_attachments`** — Restore attachments Apple Mail dropped when it re-saved an
  MCP draft. `apply=false` reports the lineage + missing files; `apply=true` re-appends them,
  preserving the user's body byte-for-byte and optionally stripping dangling `cid:` stubs.
  `update_draft`/`send_draft` now return a structured `draft_superseded` hint (with the newest
  UID) when the target draft has been superseded.
```

Add a `CHANGELOG.md` entry under the top/unreleased section (match existing format):

```markdown
### Added
- `resync_draft_attachments` tool: detect and re-apply attachments Apple Mail silently drops on
  draft re-save, with byte-preserving body surgery, an additive Apple-UUID lineage edge, an
  in-memory session attachment cache, and `draft_superseded` supersession hints on
  `update_draft`/`send_draft`.
```

- [ ] **Step 4: Full verification**

```bash
pnpm typecheck
pnpm check
pnpm test
pnpm test:integration
```

Expected: typecheck clean; `check` shows only the 3 pre-existing warnings (no new ones); all unit + integration tests green.

- [ ] **Step 5: Commit + open PR**

```bash
git add README.md CHANGELOG.md src/tools/register.test.ts
git commit -m "docs(drafts): document resync_draft_attachments + supersession hints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin wgs4/draft-attachment-resync
gh pr create --base main --title "feat(drafts): resync_draft_attachments + supersession hints" --body "Implements the draft-attachment-resync PRD. See docs/superpowers/specs/2026-07-19-draft-attachment-resync-design.md."
```

---

## Self-Review

**Spec coverage (design doc / PRD):**
- §3.1 new tool (report/apply, allowlist, strip_dangling_cids, mailbox) → Task 6 tool + Task 5 orchestrator. ✓
- §3.1 lineage resolution (Subject+From, INTERNALDATE order, ancestors + cache) → Tasks 1, 5. ✓
- §3.1 byte-preserved body via message-reference/cache, never wire round-trip → Task 3 (splice) + Task 5 (ancestor `sourceEmailId` carry / cache bytes). ✓
- §3.1 never force-add; intentional-removal exclusion; explicit allowlist overrides → Tasks 2, 5, 6 (+ acceptance #3 test). ✓
- §3.1 strip dangling cids → Task 3 + Task 5. ✓
- §3.2 supersession hints on update_draft + send_draft (warn-only) → Task 6. ✓
- §3.3 session cache (path/bytes origin, no sha256, no persistence, recoverable:false on miss) → Tasks 2, 4, 5. ✓
- §4 MCP UUID stamp (mint on save, carry on update/resync) → Task 4 + Task 3 `ensureUuid`. ✓
- Acceptance #1 (fixture replay) → Task 5 integration test. #2 → Task 6. #3 → Task 6. #4 → Task 1. #5 → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**Type consistency:** `saveDraft` returns `{id,mailbox,uuid}` (Task 4) consumed by Tasks 5–6; `LineageRef`/`DraftRow` defined in Task 1 used everywhere; `resyncDraftAttachments` return `{report, applied?}` matches tool usage in Task 6; `SupersededDraftError.hint` shape matches `findSupersession` return and both tool call-sites; `SendResult.warning?` added in Task 6 and read in the same task. ✓

**Known simplifications (documented, acceptance-safe):** always-wrap multipart/mixed (nesting cosmetics only); cid-strip limited to ≤2 nesting levels else skip+warn (body stays byte-identical); no sha256; no cross-restart persistence — all per design §5/§10.
