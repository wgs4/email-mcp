import { adaptAttachmentInput, attachmentInputSchema } from './attachment-input.js';

describe('attachment content_id schema', () => {
  it('describes content_id as an inline cid part on every variant', () => {
    for (const option of attachmentInputSchema.options) {
      expect(option.shape.content_id.description).toMatch(/inline part/);
      expect(option.shape.content_id.description).toContain('<img src="cid:VALUE">');
      expect(option.shape.content_id.description).toMatch(/printable ASCII/);
    }
  });

  it('maps content_id to contentId on path, base64, and source-message inputs', () => {
    const path = attachmentInputSchema.parse({
      path: '/tmp/chart.png',
      filename: 'chart.png',
      mime_type: 'image/png',
      content_id: 'chart1',
    });
    expect(adaptAttachmentInput(path)).toEqual({
      path: '/tmp/chart.png',
      filename: 'chart.png',
      mimeType: 'image/png',
      contentId: 'chart1',
    });

    const base64 = attachmentInputSchema.parse({
      content_base64: 'aGVsbG8=',
      filename: 'chart.png',
      content_id: '<chart1>',
    });
    expect(adaptAttachmentInput(base64)).toEqual({
      contentBase64: 'aGVsbG8=',
      filename: 'chart.png',
      mimeType: undefined,
      contentId: '<chart1>',
    });

    const source = attachmentInputSchema.parse({
      source_email_id: '42',
      source_mailbox: 'INBOX',
      filename: 'chart.png',
      content_id: 'chart1',
    });
    expect(adaptAttachmentInput(source)).toEqual({
      sourceEmailId: '42',
      sourceMailbox: 'INBOX',
      filename: 'chart.png',
      contentId: 'chart1',
    });
  });

  it('omits contentId when content_id is absent', () => {
    const parsed = attachmentInputSchema.parse({ path: '/tmp/notes.pdf' });
    expect(adaptAttachmentInput(parsed)).toEqual({
      path: '/tmp/notes.pdf',
      filename: undefined,
      mimeType: undefined,
    });
  });
});
