/**
 * Attachment resolver — turns the polymorphic AttachmentInput shape accepted
 * by save_draft / update_draft into the {filename, content, contentType}
 * triple that nodemailer's MailComposer expects.
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
  | { path: string; filename?: string; mimeType?: string }
  | { contentBase64: string; filename: string; mimeType?: string }
  | { sourceEmailId: string; sourceMailbox: string; filename: string };

export interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
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
    return {
      filename,
      content,
      contentType: input.mimeType ?? guessMimeType(filename),
    };
  }

  if ('contentBase64' in input) {
    const content = Buffer.from(input.contentBase64, 'base64');
    if (content.length > maxSizeBytes) {
      throw new Error(
        `Attachment "${input.filename}" is ${Math.round(content.length / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
      );
    }
    return {
      filename: input.filename,
      content,
      contentType: input.mimeType ?? guessMimeType(input.filename),
    };
  }

  // sourceEmailId — fetch from IMAP without round-tripping through MCP
  const downloaded = await imapService.downloadAttachment(
    accountName,
    input.sourceEmailId,
    input.sourceMailbox,
    input.filename,
    maxSizeBytes,
  );
  return {
    filename: downloaded.filename,
    content: Buffer.from(downloaded.contentBase64, 'base64'),
    contentType: downloaded.mimeType,
  };
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
