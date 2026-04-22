/**
 * MCP tool: run_preset — executes a saved-search preset defined in
 * config.toml under `[[searches]]`. Cross-account aware: uses
 * `searchAcrossAccounts` when the preset defines `accounts[]`, otherwise
 * falls back to single-account `searchEmails`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';
import type { SearchOptions } from '../services/imap.service.js';
import type { SearchPresetRegistry } from '../services/search-presets.js';
import type { SearchPreset } from '../types/index.js';
import { formatSearchResult } from './emails.tool.js';

/** Translate a preset (camelCase) into the SearchOptions shape. */
function presetToSearchOptions(
  preset: SearchPreset,
  page: number,
  pageSize: number,
): SearchOptions {
  return {
    mailbox: preset.mailbox,
    page,
    pageSize,
    to: preset.to,
    from: preset.from,
    subject: preset.subject,
    cc: preset.cc,
    bcc: preset.bcc,
    text: preset.text,
    body: preset.body,
    since: preset.since,
    before: preset.before,
    on: preset.on,
    sentSince: preset.sentSince,
    sentBefore: preset.sentBefore,
    seen: preset.seen,
    flagged: preset.flagged,
    answered: preset.answered,
    draft: preset.draft,
    deleted: preset.deleted,
    keyword: preset.keyword,
    notKeyword: preset.notKeyword,
    header: preset.header,
    hasAttachment: preset.hasAttachment,
    largerThan: preset.largerThan,
    smallerThan: preset.smallerThan,
    attachmentFilename: preset.attachmentFilename,
    attachmentMimetype: preset.attachmentMimetype,
    facets: preset.facets,
    gmailRaw: preset.gmailRaw,
  };
}

export default function registerSavedSearchesTools(
  server: McpServer,
  imapService: ImapService,
  connections: ConnectionManager,
  registry: SearchPresetRegistry,
): void {
  server.tool(
    'run_preset',
    'Run a saved search preset defined in config.toml under [[searches]]. ' +
      'Presets bundle a named filter combination you can reuse. ' +
      'Use list_presets to see available search presets. ' +
      'Pass pagination to page through large result sets.',
    {
      name: z.string().describe('Preset name from config.toml [[searches]] or list_presets'),
      page: z.number().int().min(1).default(1).optional(),
      pageSize: z.number().int().min(1).max(100).default(20).optional(),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ name, page, pageSize }) => {
      const resolvedPage = page ?? 1;
      const resolvedPageSize = pageSize ?? 20;

      const preset = registry.get(name);
      if (!preset) {
        const available = registry.list().map((p) => p.name);
        const availableHint =
          available.length > 0
            ? ` Available: ${available.join(', ')}`
            : ' (no saved searches defined in config.toml)';
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Search preset "${name}" not found.${availableHint}`,
            },
          ],
        };
      }

      try {
        const options = presetToSearchOptions(preset, resolvedPage, resolvedPageSize);
        const query = preset.query ?? '';

        const presetAccounts = preset.accounts ?? [];
        const isCrossAccount = presetAccounts.length > 0;
        const result = isCrossAccount
          ? await imapService.searchAcrossAccounts(presetAccounts, query, options)
          : await (async () => {
              const account = preset.account ?? connections.getAccountNames()[0];
              if (!account) {
                throw new Error(
                  'No accounts configured — cannot run preset without an account target.',
                );
              }
              return imapService.searchEmails(account, query, options);
            })();

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const queryLabel = query ? `"${query}"` : 'filters';
        const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;

        const scopeLabel = isCrossAccount
          ? `${presetAccounts.length} account(s) · ${preset.mailbox ?? 'INBOX'}`
          : `${preset.account ?? connections.getAccountNames()[0]} · ${preset.mailbox ?? 'INBOX'}`;

        const descLine = preset.description ? `\n   ${preset.description}` : '';
        const header =
          `📋 Preset "${preset.name}"${descLine}\n` +
          `🔍 [${scopeLabel}] ${totalDisplay} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${totalPages})\n`;

        const emptyMsg = `No emails found for preset "${preset.name}".`;

        return {
          content: [
            {
              type: 'text' as const,
              text: formatSearchResult(result, header, emptyMsg),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to run preset "${name}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
