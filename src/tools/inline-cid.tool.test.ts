vi.mock('../safety/audit.js', () => ({
  default: { log: vi.fn().mockResolvedValue(undefined) },
}));

import type { IConnectionManager } from '../connections/types.js';
import ImapService from '../services/imap.service.js';
import registerDraftTools from './drafts.tool.js';
import registerSendTools from './send.tool.js';

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type ToolRegistrar = (...args: unknown[]) => void;

function captureTools(register: ToolRegistrar, ...rest: unknown[]): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, ...toolRest: unknown[]) => {
      const handler = toolRest.at(-1);
      if (typeof handler === 'function') {
        handlers.set(name, handler as ToolHandler);
      }
    },
  };
  register(server, ...rest);
  return handlers;
}

function requireHandler(handlers: Map<string, ToolHandler>, name: string): ToolHandler {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing tool ${name}`);
  return handler;
}

describe('inline cid tool results', () => {
  it('save_draft adapts content_id and prints resolver warnings', async () => {
    const imap = {
      saveDraftWithAttachments: vi.fn().mockResolvedValue({
        id: 7,
        mailbox: 'Drafts',
        warnings: ['Body references cid:missing but no attachment has content_id "missing".'],
      }),
    };
    const handlers = captureTools(registerDraftTools as unknown as ToolRegistrar, imap, {});
    const result = await requireHandler(
      handlers,
      'save_draft',
    )({
      account: 'acct',
      to: ['a@example.com'],
      subject: 'Chart',
      body: '<img src="cid:missing">',
      html: true,
      attachments: [{ content_base64: 'aGVsbG8=', filename: 'notes.pdf', content_id: 'chart1' }],
    });

    expect(imap.saveDraftWithAttachments).toHaveBeenCalledWith(
      'acct',
      expect.objectContaining({
        html: true,
        attachments: [
          expect.objectContaining({
            contentBase64: 'aGVsbG8=',
            filename: 'notes.pdf',
            contentId: 'chart1',
          }),
        ],
      }),
    );
    expect(result.content[0].text).toContain('Draft saved');
    expect(result.content[0].text).toContain(
      'Body references cid:missing but no attachment has content_id "missing".',
    );
  });

  it('update_draft attachments_add adapts content_id', async () => {
    const imap = {
      updateDraft: vi.fn().mockResolvedValue({
        id: 9,
        mailbox: 'Drafts',
        oldId: 3,
        oldDraftDeleted: true,
        warnings: [],
      }),
    };
    const handlers = captureTools(registerDraftTools as unknown as ToolRegistrar, imap, {});
    const result = await requireHandler(
      handlers,
      'update_draft',
    )({
      account: 'acct',
      draft_id: 3,
      attachments_add: [{ path: '/tmp/chart.png', content_id: 'chart1' }],
    });

    expect(imap.updateDraft).toHaveBeenCalledWith(
      'acct',
      3,
      expect.objectContaining({
        attachmentsAdd: [expect.objectContaining({ path: '/tmp/chart.png', contentId: 'chart1' })],
      }),
    );
    expect(result.content[0].text).not.toContain('Warnings:');
  });

  it('send_email warns when content_id is set but html is false', async () => {
    const resolved = [
      {
        filename: 'chart.png',
        content: Buffer.from('png'),
        contentType: 'image/png',
        cid: 'chart1',
        contentDisposition: 'inline' as const,
      },
    ];
    const imap = {
      resolveAttachmentsForSend: vi.fn().mockResolvedValue(resolved),
    };
    const smtp = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: '<m@example.com>', status: 'sent' }),
    };
    const handlers = captureTools(registerSendTools as unknown as ToolRegistrar, smtp, imap);
    const result = await requireHandler(
      handlers,
      'send_email',
    )({
      account: 'acct',
      to: ['a@example.com'],
      subject: 'Chart',
      body: 'plain',
      html: false,
      attachments: [{ content_base64: 'cG5n', filename: 'chart.png', content_id: 'chart1' }],
    });

    expect(imap.resolveAttachmentsForSend).toHaveBeenCalledWith('acct', [
      expect.objectContaining({ contentId: 'chart1', filename: 'chart.png' }),
    ]);
    expect(smtp.sendEmail).toHaveBeenCalledWith(
      'acct',
      expect.objectContaining({ html: false, attachments: resolved }),
    );
    expect(result.content[0].text).toContain('Email sent successfully');
    expect(result.content[0].text).toContain(
      'Attachment "chart.png" has content_id "chart1" but html is false; it is still attached.',
    );
  });

  it('send_email stays quiet when the cid reference matches', async () => {
    const imap = {
      resolveAttachmentsForSend: vi.fn().mockResolvedValue([
        {
          filename: 'chart.png',
          content: Buffer.from('png'),
          contentType: 'image/png',
          cid: 'chart1',
          contentDisposition: 'inline' as const,
        },
      ]),
    };
    const smtp = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: '<m@example.com>', status: 'sent' }),
    };
    const handlers = captureTools(registerSendTools as unknown as ToolRegistrar, smtp, imap);
    const result = await requireHandler(
      handlers,
      'send_email',
    )({
      account: 'acct',
      to: ['a@example.com'],
      subject: 'Chart',
      body: '<img src="cid:chart1">',
      html: true,
      attachments: [{ path: '/tmp/chart.png', content_id: 'chart1' }],
    });

    expect(result.content[0].text).not.toContain('Warnings:');
  });

  it('send_email rejects a non-ASCII content_id before SMTP', async () => {
    const imap = new ImapService({
      getAccount: vi.fn(),
      getAccountNames: vi.fn(),
      getImapClient: vi.fn(),
      createEphemeralImapClient: vi.fn(),
      getSmtpTransport: vi.fn(),
      closeAll: vi.fn(),
    } as unknown as IConnectionManager);
    const smtp = {
      sendEmail: vi.fn().mockResolvedValue({ messageId: '<m@example.com>', status: 'sent' }),
    };
    const handlers = captureTools(registerSendTools as unknown as ToolRegistrar, smtp, imap);
    const result = await requireHandler(
      handlers,
      'send_email',
    )({
      account: 'acct',
      to: ['a@example.com'],
      subject: 'Chart',
      body: '<img src="cid:café">',
      html: true,
      attachments: [{ content_base64: 'cG5n', filename: 'chart.png', content_id: 'café' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/printable ASCII/);
    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });
});
