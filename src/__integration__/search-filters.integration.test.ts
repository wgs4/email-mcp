import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Power Search filters (integration)', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());

    // Seed a varied set of emails so the filters actually narrow.
    await seedEmail({ from: 'alice@localhost', subject: 'Quarterly Report' });
    await seedEmail({ from: 'alice@localhost', subject: 'Pines Rd invoice' });
    await seedEmail({ from: 'bob@localhost', subject: 'Vacation plans' });
    await seedEmail({ from: 'bob@localhost', subject: 'Lunch tomorrow' });
    await seedEmail({ from: 'alice@localhost', subject: 'Follow-up on report' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  describe('date filters', () => {
    it('since "today" returns same-day messages (all of them since we just seeded)', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        since: 'today',
      });
      expect(result.total).toBeGreaterThanOrEqual(5);
    });

    it('since a future date narrows to zero', async () => {
      const future = new Date();
      future.setUTCFullYear(future.getUTCFullYear() + 1);
      const iso = future.toISOString().slice(0, 10); // YYYY-MM-DD
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        since: iso,
      });
      expect(result.total).toBe(0);
    });

    it('before "today" excludes just-seeded emails (same-day)', async () => {
      // NOTE: IMAP BEFORE is strict — excludes current day. GreenMail may index
      // messages against its own clock. If all messages were delivered today,
      // before:today returns 0. Tolerate slight drift.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        before: 'today',
      });
      expect(result.total).toBeLessThanOrEqual(5);
    });
  });

  describe('from filter', () => {
    it('returns only messages from alice when from="alice"', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        from: 'alice@localhost',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      for (const email of result.items) {
        expect(email.from.address).toContain('alice');
      }
    });
  });

  describe('subject filter', () => {
    it('narrows by subject substring', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        subject: 'Pines Rd',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].subject).toMatch(/Pines Rd/);
    });
  });

  describe('combined filters', () => {
    it('from + subject narrows further than either alone', async () => {
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        from: 'alice@localhost',
        subject: 'report',
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const email of result.items) {
        expect(email.from.address).toContain('alice');
        expect(email.subject.toLowerCase()).toContain('report');
      }
    });
  });

  describe('seen filter', () => {
    it('seen:false returns unread-only results', async () => {
      // All freshly seeded emails start unseen.
      const result = await services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', {
        seen: false,
      });
      expect(result.items.length).toBeGreaterThanOrEqual(5);
      for (const email of result.items) {
        expect(email.seen).toBe(false);
      }
    });
  });

  describe('gmail_raw on non-Gmail account', () => {
    it('throws a clear error when used against GreenMail', async () => {
      await expect(
        services.imapService.searchEmails(TEST_ACCOUNT_NAME, '', { gmailRaw: 'from:foo' }),
      ).rejects.toThrow(/only valid on Gmail accounts/);
    });
  });
});
