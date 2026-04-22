/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailMeta } from '../types/index.js';
import { writeExport } from './export.tool.js';

function sampleEmail(partial: Partial<EmailMeta> = {}): EmailMeta {
  return {
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
    preview: 'preview text',
    attachments: [],
    ...partial,
  };
}

describe('writeExport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'export-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a CSV with a header row and one data row per email (default columns)', async () => {
    const dest = join(tmpDir, 'out.csv');
    const items = [
      sampleEmail({ id: '1', subject: 'Hello' }),
      sampleEmail({ id: '2', subject: 'World' }),
    ];
    const columns = [
      'id',
      'account',
      'date',
      'from',
      'subject',
      'labels',
      'attachments',
      'has_attachments',
      'seen',
      'flagged',
    ] as const;

    const rows = await writeExport({
      format: 'csv',
      items,
      columns: [...columns],
      destination: dest,
    });

    expect(rows).toBe(2);
    const content = readFileSync(dest, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe(
      'id,account,date,from,subject,labels,attachments,has_attachments,seen,flagged',
    );
    expect(lines[1]).toBe(
      '1,,2024-03-15T12:00:00.000Z,Alice <alice@example.com>,Hello,,,false,true,false',
    );
    expect(lines[2]).toBe(
      '2,,2024-03-15T12:00:00.000Z,Alice <alice@example.com>,World,,,false,true,false',
    );
  });

  it('honors a custom column selection (only chosen columns rendered)', async () => {
    const dest = join(tmpDir, 'custom.csv');
    const items = [sampleEmail({ id: '42', subject: 'Custom' })];

    await writeExport({
      format: 'csv',
      items,
      columns: ['id', 'subject'],
      destination: dest,
    });

    const content = readFileSync(dest, 'utf-8').trim().split('\n');
    expect(content[0]).toBe('id,subject');
    expect(content[1]).toBe('42,Custom');
  });

  it('escapes CSV subject fields with commas and quotes', async () => {
    const dest = join(tmpDir, 'escaped.csv');
    const items = [sampleEmail({ id: '1', subject: 'Has "quotes", and commas' })];

    await writeExport({ format: 'csv', items, columns: ['id', 'subject'], destination: dest });
    const content = readFileSync(dest, 'utf-8').trim().split('\n');
    expect(content[1]).toBe('1,"Has ""quotes"", and commas"');
  });

  it('writes NDJSON with one JSON object per line (full EmailMeta)', async () => {
    const dest = join(tmpDir, 'out.ndjson');
    const items = [sampleEmail({ id: '1', subject: 'A' }), sampleEmail({ id: '2', subject: 'B' })];

    const rows = await writeExport({
      format: 'ndjson',
      items,
      columns: [],
      destination: dest,
    });

    expect(rows).toBe(2);
    const content = readFileSync(dest, 'utf-8').trim().split('\n');
    expect(content).toHaveLength(2);
    const first = JSON.parse(content[0]) as EmailMeta;
    const second = JSON.parse(content[1]) as EmailMeta;
    expect(first.id).toBe('1');
    expect(first.subject).toBe('A');
    // Full EmailMeta is dumped — attachments and labels array are present
    expect(Array.isArray(first.attachments)).toBe(true);
    expect(second.id).toBe('2');
  });

  it('serializes attachments as pipe-delimited filenames in CSV', async () => {
    const dest = join(tmpDir, 'att.csv');
    const items = [
      sampleEmail({
        id: '1',
        attachments: [
          { filename: 'a.pdf', mimeType: 'application/pdf', size: 100 },
          { filename: 'b.png', mimeType: 'image/png', size: 200 },
        ],
        hasAttachments: true,
      }),
    ];

    await writeExport({
      format: 'csv',
      items,
      columns: ['id', 'attachments', 'has_attachments'],
      destination: dest,
    });

    const content = readFileSync(dest, 'utf-8').trim().split('\n');
    expect(content[0]).toBe('id,attachments,has_attachments');
    expect(content[1]).toBe('1,a.pdf|b.png,true');
  });

  it('handles zero items — CSV gets just a header, NDJSON is empty', async () => {
    const csv = join(tmpDir, 'empty.csv');
    await writeExport({ format: 'csv', items: [], columns: ['id', 'subject'], destination: csv });
    expect(readFileSync(csv, 'utf-8')).toBe('id,subject\n');

    const ndjson = join(tmpDir, 'empty.ndjson');
    await writeExport({ format: 'ndjson', items: [], columns: [], destination: ndjson });
    expect(readFileSync(ndjson, 'utf-8')).toBe('');
  });

  it('rowsWritten counts data rows only (excludes CSV header)', async () => {
    const dest = join(tmpDir, 'count.csv');
    const items = [sampleEmail({ id: '1' }), sampleEmail({ id: '2' }), sampleEmail({ id: '3' })];
    const rows = await writeExport({
      format: 'csv',
      items,
      columns: ['id'],
      destination: dest,
    });
    expect(rows).toBe(3);
  });
});
