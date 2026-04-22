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

  it('handles malformed input gracefully', () => {
    expect(extractAttachmentMeta(null)).toEqual([]);
    expect(extractAttachmentMeta('not an object')).toEqual([]);
    expect(extractAttachmentMeta({})).toEqual([]);
  });
});
