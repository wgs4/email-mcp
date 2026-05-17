import type { EmailMeta, PaginatedResult } from '../types/index.js';
import { formatSearchResult } from './emails.tool.js';

// R4 / Codex-critical: formatSearchResult suppressed all headers when
// items.length === 0, so a *failed* search (searchFailed:true, 0 items) still
// rendered the plain "No emails found" empty message — the silent
// false-negative reproduced at the presentation layer. A first-class failure
// branch must run BEFORE the zero-items path.
describe('formatSearchResult — R4 first-class failure branch', () => {
  it('a searchFailed result renders a flagged failure, NOT "No emails found"', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
      searchFailed: true,
      searchStatus: {
        kind: 'search_failed',
        message: 'IMAP SEARCH did not complete — the server returned no result set.',
        suggestion: 'Narrow the search: add a date filter or use subject:/from:.',
      },
      warning:
        'IMAP SEARCH did not complete — the server returned no result set.; ' +
        'Narrow the search: add a date filter or use subject:/from:.',
    };

    const text = formatSearchResult(
      result,
      '🔍 [INBOX] 0 result(s)\n',
      'No emails found matching "x".',
    );

    expect(text).not.toContain('No emails found');
    expect(text).toMatch(/fail/i);
    expect(text).toContain('IMAP SEARCH did not complete');
    expect(text).toContain('Narrow the search: add a date filter or use subject:/from:.');
  });

  it('a genuine empty result still renders the empty message (NOT flagged)', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    };

    const text = formatSearchResult(
      result,
      '🔍 header\n',
      'No emails found matching the specified filters.',
    );

    expect(text).toContain('No emails found matching the specified filters.');
  });

  it('a normal non-empty result is unaffected by the failure branch', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [
        {
          id: '1',
          subject: 'Hello',
          from: { name: 'Alice', address: 'alice@example.com' },
          to: [{ address: 'bob@example.com' }],
          date: '2024-03-15T12:00:00.000Z',
          seen: true,
          flagged: false,
          answered: false,
          hasAttachments: false,
          labels: [],
          attachments: [],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    };

    const text = formatSearchResult(result, '🔍 [INBOX] 1 result\n', 'No emails found.');
    expect(text).toContain('Hello');
    expect(text).not.toMatch(/SEARCH did not complete/);
  });
});
