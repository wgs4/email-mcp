import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

async function ensureDrafts(s: TestServices): Promise<void> {
  try {
    await s.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
  } catch {
    // already exists
  }
}

describe('resync_draft_attachments (PRD §2 fixture)', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    await ensureDrafts(services);
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  it('reports + re-applies the PDFs Mail dropped, byte-preserving the user body', async () => {
    // 1) MCP saves a draft with 2 PDFs (populates the session cache).
    const original = await services.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
      to: ['andy@chk-electronics.com'],
      subject: 'New WGS orders - JK-1401',
      body: '<p>Andy, two POs attached.</p>',
      html: true,
      attachments: [
        {
          contentBase64: Buffer.from('%PDF one').toString('base64'),
          filename: 'PO-209464.pdf',
          mimeType: 'application/pdf',
        },
        {
          contentBase64: Buffer.from('%PDF two').toString('base64'),
          filename: 'PO-209465.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });

    // 2) Simulate Apple Mail's re-save: a NEWER, bare draft (same subject, no
    //    attachments, a dangling cid), then expunge the ancestor.
    const mailResave = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['andy@chk-electronics.com'],
      subject: 'New WGS orders - JK-1401',
      body: '<p>Andy, two POs attached.</p><img src="cid:sig@apple">',
      html: true,
    });
    await services.imapService.deleteDraft(TEST_ACCOUNT_NAME, original.id, original.mailbox);

    // 3) Report (apply=false) names both PDFs + the current UID.
    const { report } = await services.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: mailResave.id,
      apply: false,
      stripDanglingCids: true,
    });
    expect(report.currentUid).toBe(mailResave.id);
    expect(report.missing.map((m) => m.filename).sort()).toEqual([
      'PO-209464.pdf',
      'PO-209465.pdf',
    ]);
    expect(report.missing.every((m) => m.recoverable)).toBe(true);
    expect(report.danglingCids).toEqual(['sig@apple']);

    // 4) Apply: new draft has both PDFs, user text intact, cid stub gone, old UID replaced.
    const res = await services.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: mailResave.id,
      apply: true,
      stripDanglingCids: true,
    });
    const applied = res.applied;
    if (!applied) throw new Error('expected an apply result');
    expect(applied.restored.sort()).toEqual(['PO-209464.pdf', 'PO-209465.pdf']);
    expect(applied.oldUidReplaced).toBe(mailResave.id);
    expect(applied.strippedCids).toEqual(['sig@apple']);
    expect(applied.newUid).not.toBeNull();

    const restored = await services.imapService.getEmail(
      TEST_ACCOUNT_NAME,
      String(applied.newUid),
      applied.mailbox,
    );
    expect(restored.attachments.map((a) => a.filename).sort()).toEqual([
      'PO-209464.pdf',
      'PO-209465.pdf',
    ]);
    expect(restored.bodyHtml ?? '').toContain('Andy, two POs attached.');
    expect(restored.bodyHtml ?? '').not.toContain('cid:sig@apple');

    // Old UID is gone.
    await expect(
      services.imapService.getEmail(TEST_ACCOUNT_NAME, String(mailResave.id), applied.mailbox),
    ).rejects.toThrow();
  });
});

describe('supersession hints + removal exclusion', () => {
  let s: TestServices;

  beforeAll(async () => {
    s = createTestServices(buildTestAccount());
    await ensureDrafts(s);
  });

  afterAll(async () => {
    await s.connections.closeAll();
  });

  it('findSupersession points a dead UID at the newest lineage member (acceptance #2)', async () => {
    const first = await s.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'],
      subject: 'Superseded subj',
      body: 'a',
      html: true,
    });
    const second = await s.imapService.saveDraft(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'],
      subject: 'Superseded subj',
      body: 'b',
      html: true,
    });
    // Mail expunged the old UID.
    await s.imapService.deleteDraft(TEST_ACCOUNT_NAME, first.id, first.mailbox);
    const hint = await s.imapService.findSupersession(TEST_ACCOUNT_NAME, first.id, first.mailbox);
    expect(hint?.newestUid).toBe(second.id);
  });

  it('does NOT restore an attachment removed via attachments_remove (acceptance #3)', async () => {
    const saved = await s.imapService.saveDraftWithAttachments(TEST_ACCOUNT_NAME, {
      to: ['x@y.com'],
      subject: 'Removal test',
      body: 'hi',
      html: true,
      attachments: [
        {
          contentBase64: Buffer.from('X').toString('base64'),
          filename: 'drop.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });
    // Intentionally remove it via update_draft.
    const updated = await s.imapService.updateDraft(TEST_ACCOUNT_NAME, saved.id, {
      attachmentsRemove: ['drop.pdf'],
    });
    const { report } = await s.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: updated.id,
      apply: false,
      stripDanglingCids: true,
    });
    expect(report.missing.map((m) => m.filename)).not.toContain('drop.pdf');
    expect(report.intentionallyRemovedExcluded).toContain('drop.pdf');
    // Explicit allowlist overrides the exclusion.
    const explicit = await s.imapService.resyncDraftAttachments(TEST_ACCOUNT_NAME, {
      draftId: updated.id,
      apply: false,
      stripDanglingCids: true,
      attachments: ['drop.pdf'],
    });
    expect(explicit.report.missing.map((m) => m.filename)).toContain('drop.pdf');
  });
});
