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

  it('R8: renders the opened folder size when present (truncation/timeout-risk hint)', () => {
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
      folderSize: 18127,
    };

    const text = formatSearchResult(result, '🔍 [INBOX.osTicket] 1 result\n', 'No emails found.');
    expect(text).toContain('18127');
    expect(text).toMatch(/folder/i);
  });

  it('R8: renders the folder size on an empty (non-failed) result too', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
      folderSize: 79000,
    };

    const text = formatSearchResult(result, 'hdr', 'No emails found matching the filters.');
    expect(text).toContain('No emails found matching the filters.');
    expect(text).toContain('79000');
  });
});

// R6: the windowed fallback has two renderings and both must be honest — a
// partial success shows the rows AND says which range produced them; a
// windowed retry that failed still renders as a failure.
describe('formatSearchResult — R6 windowed fallback', () => {
  const windowedStatus = {
    kind: 'timeout' as const,
    message: 'IMAP SEARCH exceeded the 20000ms bounded-wait budget.',
    suggestion: 'Narrow the search: add a date filter or use subject:/from:.',
    windowed: { applied: true as const, sinceDays: 90 },
  };

  it('a windowed PARTIAL SUCCESS renders the rows and states the window', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [
        {
          id: '1',
          subject: 'Re: Order #29804 confirmed',
          from: { name: 'Adam Green', address: 'green.jonadam@gmail.com' },
          to: [{ address: 'support@wgsusa.com' }],
          date: '2026-05-14T12:00:00.000Z',
          seen: false,
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
      totalApprox: true,
      searchStatus: windowedStatus,
      warning:
        'PARTIAL RESULTS — the full-range search did not complete (timeout); automatically ' +
        'retried with a 90-day recency window and these results come from that window only.',
      folderSize: 18127,
    };

    const text = formatSearchResult(result, '🔍 [INBOX.osTicket] ~1 result(s)\n', 'No emails.');

    // The rows are served — R6 exists so the caller gets SOMETHING usable.
    expect(text).toContain('Re: Order #29804 confirmed');
    // ...and the provenance is impossible to miss.
    expect(text).toContain('PARTIAL RESULTS');
    expect(text).toContain('90-day recency window');
    // A partial success is NOT a failure: it must not render the failure banner.
    expect(text).not.toContain('SEARCH FAILED');
  });

  it('a windowed retry that still failed renders the failure AND notes the retry was tried', () => {
    const result: PaginatedResult<EmailMeta> = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
      searchFailed: true,
      searchStatus: windowedStatus,
      warning: 'A 90-day windowed retry was attempted automatically and did not produce results.',
    };

    const text = formatSearchResult(result, 'hdr', 'No emails found matching "x".');

    expect(text).not.toContain('No emails found');
    expect(text).toContain('SEARCH FAILED');
    expect(text).toContain('90-day windowed retry was applied');
  });
});
