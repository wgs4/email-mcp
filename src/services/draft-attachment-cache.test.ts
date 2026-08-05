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
    expect(c.find(ref({ uuid: 'U1' }), 'PO-1.pdf')?.origin).toEqual({
      kind: 'path',
      path: '/x/PO-1.pdf',
    });
    // subject changed but same uuid still matches
    expect(c.find(ref({ subjectNorm: 'edited', uuid: 'U1' }), 'PO-1.pdf')).toBeDefined();
    // different From never matches
    expect(c.find(ref({ from: 'other@x.com', uuid: 'U1' }), 'PO-1.pdf')).toBeUndefined();
  });

  it('excludes intentionally-removed filenames (acceptance #3)', () => {
    const c = new DraftAttachmentCache();
    c.record(
      ref(),
      'keep.pdf',
      { kind: 'bytes', content: Buffer.from('a'), contentType: 'application/pdf' },
      1,
    );
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
