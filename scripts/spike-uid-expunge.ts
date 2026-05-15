/**
 * D4 Capability Spike — UID EXPUNGE feasibility check.
 *
 * For each configured IMAP account:
 *   1. Connect and log CAPABILITY (looking for UIDPLUS, APPENDUID).
 *   2. If --apply, run a non-destructive round-trip in a temp mailbox:
 *        a. Create temp mailbox __email-mcp-spike-<ts>
 *        b. APPEND message A (the test target)
 *        c. APPEND message B (the scoping witness)
 *        d. STORE \Deleted on message B
 *        e. messageDelete on message A with uid:true
 *        f. SEARCH the mailbox — message A must be gone, message B must remain
 *        g. Cleanup: delete temp mailbox (which removes B too)
 *
 * The scoping check (step f) is the actual proof: if UID EXPUNGE worked, only A
 * is gone. If full EXPUNGE was issued, B is also gone — and the design's safety
 * premise is wrong for this server.
 *
 * Run modes:
 *   pnpm spike                      — CAPABILITY-only (no mutations)
 *   pnpm spike --apply              — full round-trip on every configured account
 *   pnpm spike --apply --account X  — only that account
 *
 * Safe to re-run. Stale __email-mcp-spike-* mailboxes from prior runs are
 * deleted at startup.
 */

import { ImapFlow } from 'imapflow';

import { loadConfig } from '../src/config/loader.js';
import type { AccountConfig } from '../src/types/index.js';

type SpikeResult = {
  account: string;
  host: string;
  reachable: boolean;
  uidplus: boolean;
  appenduid: boolean;
  capabilities: string[];
  roundtrip?: {
    attempted: boolean;
    appendUidA?: number;
    appendUidB?: number;
    deleteOk: boolean;
    scopeOk: boolean; // true if B survived after A's delete
    error?: string;
  };
  error?: string;
};

const SPIKE_PREFIX = '__email-mcp-spike-';

function tinyMessage(label: 'A' | 'B'): string {
  // Minimal RFC 5322 — Greatmail and friends accept this shape.
  const now = new Date().toUTCString();
  const messageId = `<spike-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@email-mcp.local>`;
  return [
    `Date: ${now}`,
    `From: spike@email-mcp.local`,
    `To: spike@email-mcp.local`,
    `Subject: [email-mcp spike] safe to ignore (${label})`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Capability spike test message ${label}. Auto-generated; auto-cleaned.`,
    ``,
  ].join('\r\n');
}

async function cleanupStaleMailboxes(client: ImapFlow): Promise<number> {
  const mailboxes = await client.list();
  let deleted = 0;
  for (const mb of mailboxes) {
    if (mb.path.includes(SPIKE_PREFIX)) {
      try {
        await client.mailboxDelete(mb.path);
        deleted += 1;
      } catch {
        // Ignore; a stale mailbox not deletable is the operator's problem.
      }
    }
  }
  return deleted;
}

async function runOnAccount(account: AccountConfig, apply: boolean): Promise<SpikeResult> {
  const result: SpikeResult = {
    account: account.name,
    host: `${account.imap.host}:${account.imap.port}`,
    reachable: false,
    uidplus: false,
    appenduid: false,
    capabilities: [],
  };

  if (!account.password) {
    // OAuth-only spike support is out of scope — flag and skip.
    result.error = 'Skipped: OAuth2 accounts not supported by the spike script';
    return result;
  }

  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    tls: { rejectUnauthorized: account.imap.verifySsl },
    auth: { user: account.username ?? account.email, pass: account.password },
    logger: false,
  });

  try {
    await client.connect();
    result.reachable = true;

    const caps =
      client.capabilities instanceof Set
        ? [...client.capabilities]
        : Object.keys(client.capabilities ?? {});
    result.capabilities = caps;
    result.uidplus = caps.some((c) => c.toUpperCase() === 'UIDPLUS');
    result.appenduid = caps.some((c) => c.toUpperCase() === 'APPENDUID') || result.uidplus;

    if (!apply) {
      await client.logout();
      return result;
    }

    // Apply mode — full round-trip in a temp mailbox.
    await cleanupStaleMailboxes(client);

    const tempName = `${SPIKE_PREFIX}${Date.now()}`;
    result.roundtrip = { attempted: true, deleteOk: false, scopeOk: false };

    try {
      await client.mailboxCreate(tempName);

      const lock = await client.getMailboxLock(tempName);
      try {
        const appendA = await client.append(tempName, tinyMessage('A'), [], new Date());
        const appendB = await client.append(tempName, tinyMessage('B'), [], new Date());
        if (appendA === false || appendB === false) {
          throw new Error('APPEND command failed (returned false)');
        }
        const uidA = appendA.uid;
        const uidB = appendB.uid;
        result.roundtrip.appendUidA = uidA;
        result.roundtrip.appendUidB = uidB;

        if (typeof uidA !== 'number' || typeof uidB !== 'number') {
          throw new Error('APPEND did not return a UID — APPENDUID likely unsupported');
        }

        // Mark B as \Deleted (witness for scoping).
        await client.messageFlagsAdd(String(uidB), ['\\Deleted'], { uid: true });

        // The actual test: UID-scoped delete on A only.
        await client.messageDelete(String(uidA), { uid: true });
        result.roundtrip.deleteOk = true;

        // Verify scope: A must be gone, B must still be present (just \Deleted).
        const searchResult = await client.search({ all: true }, { uid: true });
        const remainingUids: number[] = searchResult === false ? [] : (searchResult ?? []);
        const aGone = !remainingUids.includes(uidA);
        const bSurvived = remainingUids.includes(uidB);
        result.roundtrip.scopeOk = aGone && bSurvived;

        if (!aGone) {
          result.roundtrip.error = `UID ${uidA} (test message A) is still present after messageDelete — UID EXPUNGE did not remove the target`;
        } else if (!bSurvived) {
          result.roundtrip.error = `UID ${uidB} (witness B) was also expunged — server issued mailbox-wide EXPUNGE despite uid:true. DESIGN PREMISE FAILS for this account`;
        }
      } finally {
        lock.release();
      }
    } finally {
      // Cleanup: delete the temp mailbox even if the round-trip threw.
      try {
        await client.mailboxDelete(tempName);
      } catch {
        // Ignore; mailbox will be cleaned on the next spike run.
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }

  return result;
}

function formatReport(results: SpikeResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== D4 Capability Spike Report ===');
  lines.push('');
  let allOk = true;
  for (const r of results) {
    lines.push(`[${r.account}] ${r.host}`);
    if (r.error && !r.reachable) {
      lines.push(`  ERROR: ${r.error}`);
      allOk = false;
      continue;
    }
    if (r.error) {
      lines.push(`  WARN: ${r.error}`);
    }
    lines.push(`  reachable: ${r.reachable}`);
    lines.push(`  UIDPLUS:   ${r.uidplus ? 'yes' : 'NO  *** safety premise broken ***'}`);
    lines.push(`  APPENDUID: ${r.appenduid ? 'yes' : 'NO  *** dest_uid capture broken ***'}`);
    if (r.roundtrip?.attempted) {
      lines.push(`  roundtrip: attempted`);
      lines.push(`    APPEND A uid: ${r.roundtrip.appendUidA ?? '(none)'}`);
      lines.push(`    APPEND B uid: ${r.roundtrip.appendUidB ?? '(none)'}`);
      lines.push(`    messageDelete A ok: ${r.roundtrip.deleteOk}`);
      lines.push(`    scope ok (A gone, B survived): ${r.roundtrip.scopeOk}`);
      if (r.roundtrip.error) {
        lines.push(`    ERROR: ${r.roundtrip.error}`);
        allOk = false;
      }
    }
    if (!r.uidplus || !r.appenduid) {
      allOk = false;
    }
  }
  lines.push('');
  lines.push(
    `VERDICT: ${allOk ? 'PASS — design D4 premise holds for all accounts' : 'FAIL — see errors above; design needs revision before migration lands'}`,
  );
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const accountFilter = (() => {
    const idx = args.indexOf('--account');
    return idx >= 0 ? args[idx + 1] : null;
  })();

  const config = await loadConfig();
  const accounts = accountFilter
    ? config.accounts.filter((a) => a.name === accountFilter)
    : config.accounts;

  if (accounts.length === 0) {
    console.error(`No accounts matched${accountFilter ? ` --account ${accountFilter}` : ''}`);
    process.exit(2);
  }

  console.log(
    `Running spike on ${accounts.length} account(s): ${accounts.map((a) => a.name).join(', ')}`,
  );
  console.log(
    `Mode: ${apply ? 'APPLY (creates + deletes temp mailboxes)' : 'CAPABILITY-only (no mutations)'}`,
  );

  const results: SpikeResult[] = [];
  for (const account of accounts) {
    process.stdout.write(`  ${account.name}... `);
    try {
      const r = await runOnAccount(account, apply);
      results.push(r);
      console.log(r.reachable ? 'done' : `failed: ${r.error ?? 'unknown'}`);
    } catch (err) {
      results.push({
        account: account.name,
        host: `${account.imap.host}:${account.imap.port}`,
        reachable: false,
        uidplus: false,
        appenduid: false,
        capabilities: [],
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(formatReport(results));

  // Exit nonzero if any account failed, so CI / git hooks notice.
  const anyFail = results.some(
    (r) => !r.reachable || !r.uidplus || !r.appenduid || r.roundtrip?.error,
  );
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(2);
});
