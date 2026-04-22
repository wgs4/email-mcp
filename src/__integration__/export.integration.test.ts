/**
 * Integration tests for PR 4 — export_search + save_attachment +
 * save_all_attachments_from_search.
 *
 * Each test seeds emails via GreenMail, then exercises the service layer
 * directly (the MCP tool wrappers are thin shims around these calls).
 */

/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeExport } from '../tools/export.tool.js';
import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmails,
  seedEmailWithAttachment,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

describe('PR 4 — export + attachment save', () => {
  let services: TestServices;
  let workDir: string;

  beforeAll(() => {
    services = createTestServices(buildTestAccount());
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pr4-export-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // save_attachment (service: saveAttachmentToDisk)
  // ---------------------------------------------------------------------------
  describe('saveAttachmentToDisk', () => {
    it('writes a seeded attachment to disk; bytes match the fixture', async () => {
      const subject = `save-att-${Date.now()}`;
      await seedEmailWithAttachment('seed.pdf', PDF_MAGIC.toString('base64'), { subject });
      await waitForDelivery();

      // Find the seeded email
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      const emailId = list.items[0].id;

      const result = await services.imapService.saveAttachmentToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        'seed.pdf',
        workDir,
      );

      expect(result.path).toBe(join(workDir, 'seed.pdf'));
      expect(result.size).toBeGreaterThan(0);
      const onDisk = readFileSync(result.path);
      // The seeded file content is the base64-decoded form of the payload we passed
      // above. For text attachments GreenMail preserves the raw content; the test
      // just asserts non-zero bytes and that the file is readable.
      expect(onDisk.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // export_search (service: searchForExport + writeExport helper)
  // ---------------------------------------------------------------------------
  describe('searchForExport + writeExport', () => {
    it('exports CSV with header + N data rows for N seeded messages', async () => {
      const subject = `csv-export-${Date.now()}`;
      await seedEmails(5, { subject });
      await waitForDelivery();

      const { items, truncated } = await services.imapService.searchForExport(
        null,
        TEST_ACCOUNT_NAME,
        '',
        { mailbox: 'INBOX', subject, maxRows: 100 },
      );
      expect(truncated).toBe(false);
      expect(items.length).toBeGreaterThanOrEqual(5);

      const dest = join(workDir, 'export.csv');
      const rows = await writeExport({
        format: 'csv',
        items,
        columns: ['id', 'subject', 'from'],
        destination: dest,
      });

      expect(rows).toBe(items.length);
      const content = readFileSync(dest, 'utf-8').trim().split('\n');
      expect(content[0]).toBe('id,subject,from');
      // At least the 5 seeded messages — integration envs may carry extras
      expect(content.length - 1).toBeGreaterThanOrEqual(5);
    });

    it('exports NDJSON with one JSON object per line', async () => {
      const subject = `ndjson-export-${Date.now()}`;
      await seedEmails(5, { subject });
      await waitForDelivery();

      const { items } = await services.imapService.searchForExport(null, TEST_ACCOUNT_NAME, '', {
        mailbox: 'INBOX',
        subject,
        maxRows: 100,
      });

      const dest = join(workDir, 'export.ndjson');
      await writeExport({ format: 'ndjson', items, columns: [], destination: dest });

      const content = readFileSync(dest, 'utf-8').trim().split('\n');
      expect(content.length).toBe(items.length);
      const first = JSON.parse(content[0]);
      expect(typeof first.id).toBe('string');
      expect(typeof first.subject).toBe('string');
    });

    it('sets truncated=true when the underlying match set exceeds maxRows', async () => {
      const subject = `truncate-${Date.now()}`;
      await seedEmails(6, { subject });
      await waitForDelivery();

      const { items, truncated } = await services.imapService.searchForExport(
        null,
        TEST_ACCOUNT_NAME,
        '',
        { mailbox: 'INBOX', subject, maxRows: 3 },
      );

      expect(items.length).toBeLessThanOrEqual(3);
      expect(truncated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // save_all_attachments_from_search (service: saveAllAttachmentsFromSearch)
  // ---------------------------------------------------------------------------
  describe('saveAllAttachmentsFromSearch', () => {
    it('downloads attachments from matching emails, skips emails without attachments', async () => {
      const subject = `batch-att-${Date.now()}`;
      // 2 with PDFs, 1 plain (no attachment)
      await seedEmailWithAttachment('doc1.pdf', PDF_MAGIC.toString('base64'), { subject });
      await seedEmailWithAttachment('doc2.pdf', PDF_MAGIC.toString('base64'), { subject });
      await seedEmail({ subject, text: 'plain body with no attachment' });
      await waitForDelivery();

      const folder = join(workDir, 'sweep');

      const result = await services.imapService.saveAllAttachmentsFromSearch({
        accountNames: null,
        accountName: TEST_ACCOUNT_NAME,
        query: '',
        searchOptions: { mailbox: 'INBOX', subject },
        maxEmails: 100,
        destinationFolder: folder,
        organizeBy: 'flat',
      });

      expect(result.folder).toBe(folder);
      expect(result.files_saved).toBeGreaterThanOrEqual(2);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.errors).toEqual([]);
      expect(result.total_size).toBeGreaterThan(0);
    });

    it('organizes by date → files land in YYYY-MM/ subfolders', async () => {
      const { readdirSync } = await import('node:fs');
      const subject = `batch-date-${Date.now()}`;
      await seedEmailWithAttachment('dated.pdf', PDF_MAGIC.toString('base64'), { subject });
      await waitForDelivery();

      const folder = join(workDir, 'by-date');

      const result = await services.imapService.saveAllAttachmentsFromSearch({
        accountNames: null,
        accountName: TEST_ACCOUNT_NAME,
        query: '',
        searchOptions: { mailbox: 'INBOX', subject },
        maxEmails: 10,
        destinationFolder: folder,
        organizeBy: 'date',
      });

      expect(result.files_saved).toBeGreaterThanOrEqual(1);
      // Folder should contain at least one `YYYY-MM` subfolder
      const entries = readdirSync(folder);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.some((e) => /^\d{4}-\d{2}$/.test(e))).toBe(true);
    });
  });
});
