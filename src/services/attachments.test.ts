/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUniquePath, sanitizeFilename } from './file-paths.js';
import { extractAttachmentMeta } from './imap.service.js';

// ---------------------------------------------------------------------------
// Fixtures — shapes mirror imapflow's parsed bodyStructure (type as
// "maintype/subtype", childNodes array, disposition / dispositionParameters).
// ---------------------------------------------------------------------------

const multipartMixedWithPdf = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'text/plain',
      size: 100,
      parameters: { charset: 'utf-8' },
    },
    {
      type: 'application/pdf',
      size: 204800,
      disposition: 'attachment',
      dispositionParameters: { filename: 'lease_agreement_v7.pdf' },
    },
  ],
};

const multipartAlternativeNoAttach = {
  type: 'multipart/alternative',
  childNodes: [
    { type: 'text/plain', size: 100 },
    { type: 'text/html', size: 300 },
  ],
};

const multipartMixedWithInlineImage = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', size: 100 },
        {
          type: 'multipart/related',
          childNodes: [
            { type: 'text/html', size: 400 },
            {
              type: 'image/png',
              size: 8000,
              id: '<logo@example.com>',
              disposition: 'inline',
              dispositionParameters: { filename: 'logo.png' },
            },
          ],
        },
      ],
    },
  ],
};

const nestedPdfTwoLevels = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/alternative',
      childNodes: [
        {
          type: 'multipart/mixed',
          childNodes: [
            { type: 'text/plain', size: 100 },
            {
              type: 'application/pdf',
              size: 102400,
              disposition: 'attachment',
              dispositionParameters: { filename: 'signed_addendum.pdf' },
            },
          ],
        },
      ],
    },
  ],
};

const pdfWithNameParamOnly = {
  // Common mailer quirk — filename only on Content-Type parameters, no
  // Content-Disposition header at all.
  type: 'multipart/mixed',
  childNodes: [
    { type: 'text/plain', size: 100 },
    {
      type: 'application/pdf',
      size: 4096,
      parameters: { name: 'invoice.pdf' },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractAttachmentMeta', () => {
  it('returns [] for undefined bodyStructure', () => {
    expect(extractAttachmentMeta(undefined)).toEqual([]);
  });

  it('returns [] when body has no attachments (text/plain + text/html alternative)', () => {
    expect(extractAttachmentMeta(multipartAlternativeNoAttach)).toEqual([]);
  });

  it('extracts a top-level PDF attachment with filename/mimeType/size', () => {
    const result = extractAttachmentMeta(multipartMixedWithPdf);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filename: 'lease_agreement_v7.pdf',
      mimeType: 'application/pdf',
      size: 204800,
    });
  });

  it('skips inline images (disposition=inline + content-id)', () => {
    const result = extractAttachmentMeta(multipartMixedWithInlineImage);
    expect(result).toEqual([]);
  });

  it('finds a PDF buried two multipart levels deep', () => {
    const result = extractAttachmentMeta(nestedPdfTwoLevels);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('signed_addendum.pdf');
    expect(result[0].mimeType).toBe('application/pdf');
    expect(result[0].size).toBe(102400);
  });

  it('detects PDFs advertised via Content-Type name= (no Content-Disposition)', () => {
    const result = extractAttachmentMeta(pdfWithNameParamOnly);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('invoice.pdf');
    expect(result[0].mimeType).toBe('application/pdf');
  });

  it('does not treat a plain text part with a name= param as an attachment', () => {
    // Avoid false positives for legitimate inline text bodies.
    const struct = {
      type: 'multipart/mixed',
      childNodes: [{ type: 'text/plain', size: 100, parameters: { name: 'body.txt' } }],
    };
    expect(extractAttachmentMeta(struct)).toEqual([]);
  });

  // Regression: PR 2 regression — inline image WITHOUT Content-ID must be
  // treated as an attachment (not skipped). The has_attachment boolean must
  // agree with the attachments array.
  it('inline image with NO content-id is treated as an attachment (regression for has_attachment filter)', () => {
    const inlineNoCid = {
      type: 'multipart/related',
      childNodes: [
        { type: 'text/html', size: 200 },
        {
          type: 'image/gif',
          size: 3000,
          disposition: 'inline',
          // Intentionally no 'id' field — no Content-ID header
          dispositionParameters: { filename: 'banner.gif' },
        },
      ],
    };
    const attachments = extractAttachmentMeta(inlineNoCid);
    // The inline image has no CID, so it must surface as an attachment.
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('banner.gif');
    expect(attachments[0].mimeType).toBe('image/gif');
    // Semantic alignment: hasAttachments boolean must agree.
    const hasAtt = attachments.length > 0;
    expect(hasAtt).toBe(true);
  });

  it('handles malformed input gracefully', () => {
    expect(extractAttachmentMeta(null)).toEqual([]);
    expect(extractAttachmentMeta('not an object')).toEqual([]);
    expect(extractAttachmentMeta({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFilename — strips path separators + reserved characters (PR 4)
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  it('strips forward-slashes and backslashes', () => {
    expect(sanitizeFilename('some/path/lease.pdf')).toBe('some_path_lease.pdf');
    expect(sanitizeFilename('some\\path\\lease.pdf')).toBe('some_path_lease.pdf');
  });

  it('replaces Windows-reserved and shell-special chars with underscore', () => {
    expect(sanitizeFilename('foo<bar>.pdf')).toBe('foo_bar_.pdf');
    expect(sanitizeFilename('a"b|c?d*e.pdf')).toBe('a_b_c_d_e.pdf');
  });

  it('collapses consecutive underscores from multi-char replacements', () => {
    expect(sanitizeFilename('a////b.pdf')).toBe('a_b.pdf');
  });

  it('strips leading dots to prevent hidden-file surprises', () => {
    expect(sanitizeFilename('...hidden.txt')).toBe('hidden.txt');
  });

  it('strips trailing dots and whitespace', () => {
    expect(sanitizeFilename('lease.pdf...  ')).toBe('lease.pdf');
  });

  it("neutralizes '..' traversal — reduces to 'unnamed' after strip passes", () => {
    expect(sanitizeFilename('..')).toBe('unnamed');
  });

  it('returns "unnamed" for empty / whitespace-only / dot-only inputs', () => {
    expect(sanitizeFilename('')).toBe('unnamed');
    expect(sanitizeFilename('   ')).toBe('unnamed');
    expect(sanitizeFilename('.')).toBe('unnamed');
  });

  it('preserves a normal filename untouched', () => {
    expect(sanitizeFilename('quarterly_report_v7.pdf')).toBe('quarterly_report_v7.pdf');
  });
});

// ---------------------------------------------------------------------------
// resolveUniquePath — collision auto-suffix (PR 4)
// ---------------------------------------------------------------------------

describe('resolveUniquePath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pr4-collide-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the desired path unchanged when nothing exists there', async () => {
    const p = join(tmp, 'lease.pdf');
    await expect(resolveUniquePath(p, false)).resolves.toBe(p);
  });

  it('returns the desired path unchanged when overwrite=true (even if the file exists)', async () => {
    const p = join(tmp, 'lease.pdf');
    writeFileSync(p, 'old');
    await expect(resolveUniquePath(p, true)).resolves.toBe(p);
  });

  it('auto-suffixes lease.pdf -> lease-1.pdf when the target exists', async () => {
    const p = join(tmp, 'lease.pdf');
    writeFileSync(p, 'original');
    await expect(resolveUniquePath(p, false)).resolves.toBe(join(tmp, 'lease-1.pdf'));
  });

  it('increments the suffix until a free slot is found', async () => {
    writeFileSync(join(tmp, 'lease.pdf'), 'x');
    writeFileSync(join(tmp, 'lease-1.pdf'), 'x');
    writeFileSync(join(tmp, 'lease-2.pdf'), 'x');
    await expect(resolveUniquePath(join(tmp, 'lease.pdf'), false)).resolves.toBe(
      join(tmp, 'lease-3.pdf'),
    );
  });

  it('keeps the original extension intact across suffixing', async () => {
    writeFileSync(join(tmp, 'archive.tar.gz'), 'x');
    // basename(filename, '.gz') -> 'archive.tar' so suffix appends before .gz
    await expect(resolveUniquePath(join(tmp, 'archive.tar.gz'), false)).resolves.toBe(
      join(tmp, 'archive.tar-1.gz'),
    );
  });

  it('suffixes files without an extension', async () => {
    writeFileSync(join(tmp, 'README'), 'x');
    await expect(resolveUniquePath(join(tmp, 'README'), false)).resolves.toBe(
      join(tmp, 'README-1'),
    );
  });
});
