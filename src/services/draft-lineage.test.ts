import { describe, expect, it } from 'vitest';
import type { AttachmentMeta } from '../types/index.js';
import type { DraftRow } from './draft-lineage.js';
import {
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
    expect(
      sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'new wgs orders', uuid: 'U2' }, anchor),
    ).toBe(true);
  });
  it('matches on same uuid even when subject changed', () => {
    expect(
      sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'edited subject', uuid: 'U1' }, anchor),
    ).toBe(true);
  });
  it('does NOT match a different From even with same subject (acceptance #4)', () => {
    expect(sameLineage({ from: 'someone@else.com', subjectNorm: 'new wgs orders' }, anchor)).toBe(
      false,
    );
  });
  it('does NOT match a different subject when neither shares a uuid', () => {
    expect(sameLineage({ from: 'david@wgsusa.com', subjectNorm: 'unrelated' }, anchor)).toBe(false);
  });
});

describe('orderByInternalDate + diffMissingAttachments', () => {
  it('newest is last; reports files on ancestors missing from current', () => {
    const a = row({
      uid: 59874,
      internalDate: new Date('2026-07-16T20:00:00Z'),
      attachments: [att('PO-1.pdf'), att('PO-2.pdf')],
    });
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
