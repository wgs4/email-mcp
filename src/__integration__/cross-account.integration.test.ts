/**
 * Integration tests for cross-account search + saved-search presets.
 *
 * GreenMail ships with multiple pre-provisioned users (test, bob, alice),
 * so we can spin up a single ConnectionManager wired to two accounts and
 * exercise `searchAcrossAccounts` end-to-end.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import ImapService from '../services/imap.service.js';
import { SearchPresetRegistry } from '../services/search-presets.js';
import {
  buildSecondTestAccount,
  buildTestAccount,
  getGreenMailPorts,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

const SECOND_ACCOUNT_NAME = 'integration-2';

describe('Cross-account search + saved-search presets (integration)', () => {
  let connections: ConnectionManager;
  let imapService: ImapService;

  // Use a unique subject prefix per run so we don't collide with other
  // integration tests sharing the same GreenMail container.
  const MARKER = `xacct-${Date.now()}`;

  beforeAll(async () => {
    const accountA = buildTestAccount();
    const accountB = buildSecondTestAccount();
    connections = new ConnectionManager([accountA, accountB]);
    imapService = new ImapService(connections);

    // Seed into both mailboxes using the helper (helper derives the sender
    // username from the from address to pick the right GreenMail user).
    // test@localhost — account A recipient.
    await seedEmail({ to: 'test@localhost', subject: `${MARKER} alpha` });
    await seedEmail({ to: 'test@localhost', subject: `${MARKER} beta` });
    // bob@localhost — account B recipient.
    await seedEmail({ to: 'bob@localhost', subject: `${MARKER} alpha` });
    await seedEmail({ to: 'bob@localhost', subject: `${MARKER}-unique bob-only` });
    // Give GreenMail a bit longer for the two-mailbox fan-out to settle.
    await waitForDelivery(1500);
  });

  afterAll(async () => {
    await connections.closeAll();
  });

  // --------------------------------------------------------------------------
  // Auto-remap via SPECIAL-USE — Phase 3 follow-on
  // --------------------------------------------------------------------------

  describe('searchAcrossAccounts — SPECIAL-USE auto-remap', () => {
    // GreenMail's IMAP server does not natively honor SPECIAL-USE flags on
    // `CREATE` — mailboxes created with `specialUse: ['\\Archive']` come back
    // in LIST without any special-use marker. This integration test therefore
    // exercises only what GreenMail can demonstrate end-to-end: when account
    // B does NOT have a literal match for the requested mailbox and no
    // mailbox on that account carries an equivalent SPECIAL-USE flag, the
    // account is skipped with a hard warning (⚠️ path), and the good account
    // still returns its results.
    //
    // Unit coverage (see imap.service.test.ts + mailbox-resolver.test.ts)
    // exercises the happy remap path where a real \All flag is present.

    // Skipped: GreenMail's IMAP server does not honor SPECIAL-USE flags on
    // mailbox CREATE, so we cannot seed a `\All`-flagged folder to exercise
    // the happy remap path end-to-end. This behaviour is fully covered by
    // the unit tests in mailbox-resolver.test.ts + imap.service.test.ts.
    it.skip('remaps mailbox via \\All when literal is missing (requires SPECIAL-USE — GreenMail limitation)', async () => {
      // No-op; see rationale above.
    });

    it('all-accounts-skipped path: throws when no account has literal or remap match', async () => {
      await expect(
        imapService.searchAcrossAccounts([TEST_ACCOUNT_NAME, SECOND_ACCOUNT_NAME], '', {
          mailbox: 'INBOX.DefinitelyDoesNotExist',
          subject: MARKER,
          pageSize: 50,
        }),
      ).rejects.toThrow(/All 2 accounts failed/);
    });
  });

  // --------------------------------------------------------------------------
  // searchAcrossAccounts — happy path
  // --------------------------------------------------------------------------

  describe('searchAcrossAccounts — merged results', () => {
    it('returns a merged list with .account stamps from both accounts', async () => {
      const result = await imapService.searchAcrossAccounts(
        [TEST_ACCOUNT_NAME, SECOND_ACCOUNT_NAME],
        '',
        { subject: MARKER, pageSize: 50 },
      );

      // Both accounts should contribute to the merged set (3 of the 4 seeded
      // messages match the marker — 2 on test, 1 on bob).
      expect(result.items.length).toBeGreaterThanOrEqual(3);
      const accountsSeen = new Set(result.items.map((e) => e.account));
      expect(accountsSeen.has(TEST_ACCOUNT_NAME)).toBe(true);
      expect(accountsSeen.has(SECOND_ACCOUNT_NAME)).toBe(true);

      // No partial failures expected when both accounts are healthy.
      expect(result.warnings).toBeUndefined();
    });

    it('search targeting only bob returns bob-exclusive subjects', async () => {
      const result = await imapService.searchAcrossAccounts(
        [TEST_ACCOUNT_NAME, SECOND_ACCOUNT_NAME],
        '',
        { subject: `${MARKER}-unique`, pageSize: 50 },
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // Every matching item should come from the second account (bob's mailbox).
      for (const item of result.items) {
        expect(item.account).toBe(SECOND_ACCOUNT_NAME);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Partial-failure semantics
  // --------------------------------------------------------------------------

  describe('searchAcrossAccounts — partial failure', () => {
    let localConnections: ConnectionManager;
    let localImap: ImapService;

    beforeAll(() => {
      // Build a bogus second account with invalid credentials so the fan-out
      // hits a real auth failure on B while A still works.
      const { host, imapPort, smtpPort } = getGreenMailPorts();
      const goodAccount = buildTestAccount({ name: 'partial-good' });
      const badAccount = {
        name: 'partial-bad',
        email: 'nobody@localhost',
        fullName: 'Broken Account',
        username: 'does-not-exist',
        password: 'wrong-password',
        imap: { host, port: imapPort, tls: false, starttls: false, verifySsl: false },
        smtp: { host, port: smtpPort, tls: false, starttls: false, verifySsl: false },
      };
      localConnections = new ConnectionManager([goodAccount, badAccount]);
      localImap = new ImapService(localConnections);
    });

    afterAll(async () => {
      await localConnections.closeAll();
    });

    it('returns partial results plus warnings when one account fails auth', async () => {
      const result = await localImap.searchAcrossAccounts(['partial-good', 'partial-bad'], '', {
        subject: MARKER,
        pageSize: 50,
      });

      // Good account should still surface items.
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items.every((e) => e.account === 'partial-good')).toBe(true);

      // Bad account should appear as a warning entry, not a thrown error.
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.account === 'partial-bad')).toBe(true);

      // Human-readable warning summary should mention the failing account.
      expect(result.warning).toMatch(/partial-bad/);
    });
  });

  // --------------------------------------------------------------------------
  // Saved-search preset round-trip
  // --------------------------------------------------------------------------

  describe('run_preset round-trip via config loader', () => {
    let tmpDir: string;
    let registry: SearchPresetRegistry;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-preset-it-'));
      const { host, imapPort, smtpPort } = getGreenMailPorts();

      // Note: Zod's email validator rejects "test@localhost" (needs a TLD).
      // We use a well-formed placeholder email while keeping username/password
      // aligned with GreenMail's test user.
      const toml = `
[[accounts]]
name = "${TEST_ACCOUNT_NAME}"
email = "test@example.com"
username = "test"
password = "test"

[accounts.imap]
host = "${host}"
port = ${imapPort}
tls = false
verify_ssl = false

[accounts.smtp]
host = "${host}"
port = ${smtpPort}
tls = false
verify_ssl = false

[[searches]]
name = "alpha-marker"
description = "Marker preset round-trip"
account = "${TEST_ACCOUNT_NAME}"
subject = "${MARKER}"
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);
      expect(config.searches).toHaveLength(1);
      expect(config.searches[0].name).toBe('alpha-marker');
      expect(config.searches[0].subject).toBe(MARKER);

      registry = new SearchPresetRegistry(config.searches);
    });

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('preset loaded from TOML can be executed via searchEmails', async () => {
      const preset = registry.get('alpha-marker');
      if (!preset) throw new Error('preset should have been registered in beforeAll');
      expect(preset.account).toBe(TEST_ACCOUNT_NAME);
      if (!preset.account) throw new Error('preset.account should be set in the TOML');

      // Run the preset's filters directly against searchEmails — same codepath
      // run_preset uses internally.
      const result = await imapService.searchEmails(preset.account, preset.query ?? '', {
        subject: preset.subject,
        pageSize: 50,
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.subject).toContain(MARKER);
      }
    });
  });
});
