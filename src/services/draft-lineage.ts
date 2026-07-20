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
  const line = headers
    .toString('utf8')
    .split(/\r\n|\n/)
    .find((l) => {
      const idx = l.indexOf(':');
      return idx >= 0 && l.slice(0, idx).trim().toLowerCase() === 'x-universally-unique-identifier';
    });
  if (!line) return undefined;
  const value = line.slice(line.indexOf(':') + 1).trim();
  return value.length > 0 ? value : undefined;
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
  orderByInternalDate(ancestors).forEach((anc) => {
    anc.attachments.forEach((a) => {
      if (!have.has(a.filename)) {
        byName.set(a.filename, { filename: a.filename, size: a.size, lastSeenOnUid: anc.uid });
      }
    });
  });
  return [...byName.values()];
}
