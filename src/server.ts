/**
 * MCP Server factory.
 *
 * Creates and configures the McpServer instance with capabilities.
 */

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const esmRequire = createRequire(import.meta.url);
const pkg = esmRequire('../package.json') as { version: string };

export const PKG_NAME = 'email-mcp';
export const PKG_VERSION = pkg.version;

export default function createServer(): McpServer {
  return new McpServer(
    {
      name: PKG_NAME,
      version: PKG_VERSION,
    },
    {
      instructions:
        'Email is split across mailbox folders per account. INBOX holds recent/unhandled mail; long-term mail lives in the Archive folder (e.g. INBOX.Archive on IMAP servers, or [Gmail]/All Mail). If a search of INBOX comes up empty, you should usually retry against the Archive — most accounts keep tens of thousands of messages there (the wgs-usa account has 78,000+ archived). Because archives are large, ALWAYS pass a date filter (since/before/on, or relative tokens like "30d" / "yesterday") and a reasonable pageSize when querying them — unfiltered archive scans are slow and may be truncated at the 5000-UID cap. Use list_mailboxes to discover the archive folder name for each account before searching.',
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
    },
  );
}
