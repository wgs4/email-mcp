/**
 * In-memory, server-process-lifetime session cache backing draft attachment
 * resync (design §5). Keyed by the lineage predicate (not a flat string) so a
 * changed subject or a Mail-rewritten UUID still resolves. No disk persistence
 * in v1. Load-bearing: Apple Mail expunges the ancestor UID on re-save, so the
 * ancestor bytes are usually gone by the time resync runs.
 */
import type { LineageRef } from './draft-lineage.js';
import { sameLineage } from './draft-lineage.js';

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
