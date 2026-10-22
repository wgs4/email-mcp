/**
 * cross_account_move — ticketNumber plumbing.
 *
 * The MCP SDK validates the schema before the handler runs, so this test drives
 * the registered handler directly and checks the two seams that matter: the
 * ticket number reaches the mover, and the schema refuses anything that is not
 * a 3–10 digit ticket number.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { MoveResult } from '../routing/cross-account-mover.js';
import { CrossAccountMover } from '../routing/cross-account-mover.js';
import audit from '../safety/audit.js';
import type { AppConfig } from '../types/index.js';
import registerCrossAccountMoveTool from './cross-account-move.tool.js';

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  }>;
}

function fakeServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodType>,
      _annotations: unknown,
      handler: CapturedTool['handler'],
    ) => {
      tools.push({ name, description, schema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const config = { database: undefined } as unknown as AppConfig;
const connections = {} as unknown as ConnectionManager;

function successResult(
  overrides: Partial<Extract<MoveResult, { success: true }>> = {},
): MoveResult {
  return {
    success: true,
    status: 'success',
    source_account: 'wgs-usa',
    source_mailbox: 'INBOX',
    source_uid: 123,
    dest_account: 'support-wgs',
    dest_mailbox: 'INBOX',
    dest_uid: 456,
    message_id: '<m@example.com>',
    subject: 'Your order is out for delivery [#31775]',
    from: 'Shop <shop@example.com>',
    size_bytes: 1024,
    source_cleanup: 'moved_to_trash',
    move_log_id: 7,
    subject_rewritten: true,
    ticket_tag: '31775',
    warnings: [],
    ...overrides,
  };
}

describe('cross_account_move ticketNumber', () => {
  let auditLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Never write synthetic test activity to ~/.local/share/email-mcp/audit.log.
    auditLog = vi.spyOn(audit, 'log').mockResolvedValue(undefined);
  });

  it('passes ticketNumber through to the mover and summarizes the tag', async () => {
    const { server, tools } = fakeServer();
    registerCrossAccountMoveTool(server, connections, config);
    const [tool] = tools;

    const moveMany = vi
      .spyOn(CrossAccountMover.prototype, 'moveMany')
      .mockResolvedValue([successResult()]);

    const result = await tool.handler({
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      emailId: '123',
      destAccount: 'support-wgs',
      destMailbox: 'INBOX',
      ticketNumber: '31775',
    });

    expect(moveMany).toHaveBeenCalledTimes(1);
    expect(moveMany).toHaveBeenCalledWith([
      {
        sourceAccount: 'wgs-usa',
        sourceMailbox: 'INBOX',
        emailId: '123',
        destAccount: 'support-wgs',
        destMailbox: 'INBOX',
        ticketNumber: '31775',
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('ticket [#31775] subject rewritten');
    const json = result.content[0].text.slice(result.content[0].text.indexOf('\n\n[') + 2);
    expect(JSON.parse(json)).toEqual([
      expect.objectContaining({ subject_rewritten: true, ticket_tag: '31775' }),
    ]);
    expect(auditLog).toHaveBeenCalledWith(
      'cross_account_move',
      'wgs-usa',
      expect.objectContaining({ ticketNumber: '31775' }),
      'ok',
      undefined,
    );
  });

  it('omits ticketNumber when the caller does not supply one', async () => {
    const { server, tools } = fakeServer();
    registerCrossAccountMoveTool(server, connections, config);
    const [tool] = tools;

    const moveMany = vi
      .spyOn(CrossAccountMover.prototype, 'moveMany')
      .mockResolvedValue([successResult({ subject_rewritten: false, ticket_tag: null })]);

    await tool.handler({
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      emailId: '123',
      destAccount: 'support-wgs',
      destMailbox: 'INBOX',
    });

    const args = moveMany.mock.calls[0][0];
    expect(args[0].ticketNumber).toBeUndefined();
  });

  it.each([
    '12',
    '12345678901',
    'abc',
    '',
    '12a',
    ' 123',
    '123 ',
  ])('rejects invalid ticketNumber %j', (ticketNumber) => {
    const { server, tools } = fakeServer();
    registerCrossAccountMoveTool(server, connections, config);
    const [tool] = tools;
    const schema = z.object(tool.schema);

    const parsed = schema.safeParse({
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      emailId: '123',
      destAccount: 'support-wgs',
      destMailbox: 'INBOX',
      ticketNumber,
    });
    expect(parsed.success).toBe(false);
  });

  it.each(['123', '31775', '1234567890'])('accepts valid ticketNumber %j', (ticketNumber) => {
    const { server, tools } = fakeServer();
    registerCrossAccountMoveTool(server, connections, config);
    const [tool] = tools;
    const schema = z.object(tool.schema);

    const parsed = schema.safeParse({
      sourceAccount: 'wgs-usa',
      sourceMailbox: 'INBOX',
      emailId: '123',
      destAccount: 'support-wgs',
      destMailbox: 'INBOX',
      ticketNumber,
    });
    expect(parsed.success).toBe(true);
  });

  it('tells the calling AI how ticketNumber works', () => {
    const { server, tools } = fakeServer();
    registerCrossAccountMoveTool(server, connections, config);
    const [tool] = tools;

    expect(tool.description).toContain(
      'Pass ticketNumber to attach this email to an existing osTicket ticket',
    );
    expect(tool.description).toContain('findMergeCandidates');
    expect(tool.description).toContain('must be UNREAD');
  });
});
