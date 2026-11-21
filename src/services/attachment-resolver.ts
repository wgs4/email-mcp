/**
 * Attachment resolver — turns the polymorphic AttachmentInput shape accepted
 * by save_draft / update_draft / send_email into the {filename, content,
 * contentType} triple that nodemailer's MailComposer expects. A contentId
 * also sets `cid` and `contentDisposition: 'inline'` so the part is placed
 * in multipart/related.
 *
 * Three input variants are supported:
 *
 *   1. { path }            — read bytes from a local file
 *   2. { contentBase64 }   — bytes already in memory, base64-encoded
 *   3. { sourceEmailId }   — download bytes from an existing message via IMAP
 *
 * The resolver never sends binary content back through the MCP wire — bytes
 * stay in this process between fetch and the eventual IMAP APPEND.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type ImapService from './imap.service.js';

/** Default per-attachment cap when fetching from IMAP for draft rebuild. */
export const REBUILD_ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

export type AttachmentInput =
  | { path: string; filename?: string; mimeType?: string; contentId?: string }
  | { contentBase64: string; filename: string; mimeType?: string; contentId?: string }
  | {
      sourceEmailId: string;
      sourceMailbox: string;
      filename: string;
      contentId?: string;
    };

export interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /** Set when contentId was provided. MailComposer writes Content-ID: <cid>. */
  cid?: string;
  /** 'inline' when cid is set. Omitted on ordinary attachments. */
  contentDisposition?: 'inline';
}

/** Content-ID length cap after one surrounding pair of angle brackets is removed. */
const CONTENT_ID_MAX_LENGTH = 200;

/** Whitespace, angle brackets, or a double quote. Control characters are checked by code point. */
const INVALID_CONTENT_ID_CHARS = /[\s<>"]/;

function hasIllegalContentIdChar(cid: string): boolean {
  if (INVALID_CONTENT_ID_CHARS.test(cid)) return true;
  return Array.from(cid).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * Strip one surrounding `<` `>` pair, then reject an empty, overlong, or
 * illegal Content-ID. Callers fail the whole operation when this returns
 * an error. A bad content_id is not a partial-success case.
 */
function normalizeContentId(
  raw: string,
): { ok: true; cid: string } | { ok: false; reason: string } {
  let cid = raw;
  if (cid.startsWith('<') && cid.endsWith('>') && cid.length >= 2) {
    cid = cid.slice(1, -1);
  }
  if (cid.length === 0) {
    return { ok: false, reason: 'content_id is empty' };
  }
  if (cid.length > CONTENT_ID_MAX_LENGTH) {
    return { ok: false, reason: `content_id exceeds ${CONTENT_ID_MAX_LENGTH} characters` };
  }
  if (hasIllegalContentIdChar(cid)) {
    return {
      ok: false,
      reason:
        'content_id must not contain whitespace, angle brackets, quotes, or control characters',
    };
  }
  return { ok: true, cid };
}

export interface AttachmentFailure {
  /** Best-effort label for the input, e.g. the filename or path. */
  label: string;
  reason: string;
}

export interface ResolveResult {
  resolved: ResolvedAttachment[];
  failures: AttachmentFailure[];
}

/** Coarse MIME guess from extension — used only when the caller didn't supply one. */
function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}

function inputLabel(input: AttachmentInput): string {
  if ('path' in input) return input.filename ?? path.basename(input.path);
  if ('contentBase64' in input) return input.filename;
  return input.filename;
}

/**
 * Invalid or duplicate content_id values. Returned as resolver failures so
 * save/send abort the whole operation with the same strict-failure message
 * they already use for unreadable attachments. Checked before any I/O.
 */
function collectContentIdFailures(inputs: AttachmentInput[]): AttachmentFailure[] {
  const failures: AttachmentFailure[] = [];
  const seen = new Map<string, string>();

  inputs.forEach((input) => {
    if (input.contentId === undefined) return;
    const normalized = normalizeContentId(input.contentId);
    if (!normalized.ok) {
      failures.push({ label: inputLabel(input), reason: normalized.reason });
      return;
    }
    const previous = seen.get(normalized.cid);
    if (previous !== undefined) {
      failures.push({
        label: inputLabel(input),
        reason: `duplicate content_id "${normalized.cid}" (also used by "${previous}")`,
      });
      return;
    }
    seen.set(normalized.cid, inputLabel(input));
  });

  return failures;
}

/** Attach cid + inline disposition when the caller set contentId. */
function stampInline(
  input: AttachmentInput,
  resolved: { filename: string; content: Buffer; contentType: string },
): ResolvedAttachment {
  if (input.contentId === undefined) return resolved;
  const normalized = normalizeContentId(input.contentId);
  // collectContentIdFailures already rejected bad ids. This throw is a
  // backstop so a stamped part can never carry a Content-ID we would refuse.
  if (!normalized.ok) throw new Error(normalized.reason);
  return {
    ...resolved,
    cid: normalized.cid,
    contentDisposition: 'inline',
  };
}

async function resolveOne(
  imapService: ImapService,
  accountName: string,
  input: AttachmentInput,
  maxSizeBytes: number,
): Promise<ResolvedAttachment> {
  if ('path' in input) {
    const absolute = path.resolve(input.path);
    const content = await fs.readFile(absolute);
    if (content.length > maxSizeBytes) {
      throw new Error(
        `Attachment "${absolute}" is ${Math.round(content.length / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
      );
    }
    const filename = input.filename ?? path.basename(absolute);
    return stampInline(input, {
      filename,
      content,
      contentType: input.mimeType ?? guessMimeType(filename),
    });
  }

  if ('contentBase64' in input) {
    const content = Buffer.from(input.contentBase64, 'base64');
    if (content.length > maxSizeBytes) {
      throw new Error(
        `Attachment "${input.filename}" is ${Math.round(content.length / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
      );
    }
    return stampInline(input, {
      filename: input.filename,
      content,
      contentType: input.mimeType ?? guessMimeType(input.filename),
    });
  }

  // sourceEmailId — fetch from IMAP without round-tripping through MCP
  const downloaded = await imapService.downloadAttachment(
    accountName,
    input.sourceEmailId,
    input.sourceMailbox,
    input.filename,
    maxSizeBytes,
  );
  return stampInline(input, {
    filename: downloaded.filename,
    content: Buffer.from(downloaded.contentBase64, 'base64'),
    contentType: downloaded.mimeType,
  });
}

/**
 * Resolve every input in parallel. Per-input failures are collected rather
 * than thrown — callers decide whether to continue with a partial set or
 * abort the operation entirely.
 */
export async function resolveAttachments(
  imapService: ImapService,
  accountName: string,
  inputs: AttachmentInput[],
  maxSizeBytes: number = REBUILD_ATTACHMENT_CAP_BYTES,
): Promise<ResolveResult> {
  if (inputs.length === 0) return { resolved: [], failures: [] };

  const cidFailures = collectContentIdFailures(inputs);
  if (cidFailures.length > 0) {
    return { resolved: [], failures: cidFailures };
  }

  const settled = await Promise.allSettled(
    inputs.map(async (input) => resolveOne(imapService, accountName, input, maxSizeBytes)),
  );

  const resolved: ResolvedAttachment[] = [];
  const failures: AttachmentFailure[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      resolved.push(result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ label: inputLabel(inputs[i]), reason });
    }
  });

  return { resolved, failures };
}

/**
 * Fetch a subset of an existing message's attachments by filename.
 * Convenience wrapper used by update_draft when copying its own existing
 * attachments forward.
 */
export async function fetchAttachmentBinaries(
  imapService: ImapService,
  accountName: string,
  emailId: string,
  mailbox: string,
  filenames: string[],
  maxSizeBytes: number = REBUILD_ATTACHMENT_CAP_BYTES,
): Promise<ResolveResult> {
  const inputs: AttachmentInput[] = filenames.map((filename) => ({
    sourceEmailId: emailId,
    sourceMailbox: mailbox,
    filename,
  }));
  return resolveAttachments(imapService, accountName, inputs, maxSizeBytes);
}
