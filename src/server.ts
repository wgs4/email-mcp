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
        'Email is split across mailbox folders per account. INBOX holds recent/unhandled mail; long-term mail lives in the Archive folder (e.g. INBOX.Archive on IMAP servers, or [Gmail]/All Mail). If a search of INBOX comes up empty, you should usually retry against the Archive — most accounts keep tens of thousands of messages there (the wgs-usa account has 78,000+ archived). Because archives are large, ALWAYS pass a date filter (since/before/on, or relative tokens like "30d" / "yesterday") and a reasonable pageSize when querying them — unfiltered archive scans are slow and may be truncated at the 5000-UID cap. Use list_mailboxes to discover the archive folder name for each account before searching. Read the result shape before concluding anything: an empty page is only a real zero-match when it is NOT flagged. A search that could not complete comes back explicitly flagged (searchFailed + a "SEARCH FAILED" warning) — the mail may well exist, so narrow and retry rather than reporting it missing. If an un-dated search does not complete it is retried automatically over the last 90 days and labelled PARTIAL RESULTS (searchStatus.windowed); those rows cover only that window, so re-run with an explicit since:/before: range to look further back. Free-text query searches the message body by default, which is what makes it expensive on huge folders — pass deep=false for a cheap header-only (subject/from/to) query when you know the token is in the subject or sender.',
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
    },
  );
}
