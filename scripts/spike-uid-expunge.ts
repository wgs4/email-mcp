/**
 * D4 Capability Spike — UID EXPUNGE and UID MOVE feasibility check.
 *
 * For each configured IMAP account:
 *   1. Connect and log CAPABILITY (looking for UIDPLUS, APPENDUID, MOVE).
 *   2. If --apply, run two non-destructive round-trips in temp mailboxes.
 *
 *      EXPUNGE round-trip (proves UID-scoped EXPUNGE):
 *        a. Create temp mailbox __email-mcp-spike-exp-<ts>
 *        b. APPEND message A (the test target)
 *        c. APPEND message B (the scoping witness)
 *        d. STORE \Deleted on message B
 *        e. messageDelete on message A with uid:true
 *        f. SEARCH the mailbox — message A must be gone, message B must remain
 *        g. Cleanup: delete temp mailbox
 *
 *      MOVE round-trip (proves UID-scoped MOVE, the preferred path for D4):
 *        a. Create temp source mailbox __email-mcp-spike-mv-src-<ts>
 *        b. Create temp destination mailbox __email-mcp-spike-mv-dst-<ts>
 *        c. APPEND message A and B to source
 *        d. messageMove on message A with uid:true into destination
 *        e. SEARCH source — only B must remain; SEARCH destination — A must be present
 *        f. Cleanup: delete both temp mailboxes
 *
 * The scoping check is the actual proof: if UID EXPUNGE/UID MOVE worked, only A
 * is touched. If full EXPUNGE was issued or MOVE took both messages, the design's
 * safety premise is wrong for this server and the operation type.
 *
 * Run modes:
 *   pnpm spike                      — CAPABILITY-only (no mutations)
 *   pnpm spike --apply              — full round-trips on every configured account
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
  move: boolean;
  capabilities: string[];
  expungeRoundtrip?: {
    attempted: boolean;
    appendUidA?: number;
    appendUidB?: number;
    deleteOk: boolean;
    scopeOk: boolean; // true if B survived after A's delete
    error?: string;
  };
  moveRoundtrip?: {
    attempted: boolean;
    appendUidA?: number;
    appendUidB?: number;
    destUidA?: number;
    moveOk: boolean;
    scopeOk: boolean; // true if A landed in dest AND B stayed in source AND A left source
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

async function runExpungeRoundtrip(
  client: ImapFlow,
): Promise<NonNullable<SpikeResult['expungeRoundtrip']>> {
  const rt: NonNullable<SpikeResult['expungeRoundtrip']> = {
    attempted: true,
    deleteOk: false,
    scopeOk: false,
  };
  const tempName = `${SPIKE_PREFIX}exp-${Date.now()}`;

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
      rt.appendUidA = uidA;
      rt.appendUidB = uidB;

      if (typeof uidA !== 'number' || typeof uidB !== 'number') {
        throw new Error('APPEND did not return a UID — APPENDUID likely unsupported');
      }

      // Mark B as \Deleted (witness for scoping).
      await client.messageFlagsAdd(String(uidB), ['\\Deleted'], { uid: true });

      // The actual test: UID-scoped delete on A only.
      await client.messageDelete(String(uidA), { uid: true });
      rt.deleteOk = true;

      // Verify scope: A must be gone, B must still be present (just \Deleted).
      const searchResult = await client.search({ all: true }, { uid: true });
      const remainingUids: number[] = searchResult === false ? [] : (searchResult ?? []);
      const aGone = !remainingUids.includes(uidA);
      const bSurvived = remainingUids.includes(uidB);
      rt.scopeOk = aGone && bSurvived;

      if (!aGone) {
        rt.error = `UID ${uidA} (test message A) is still present after messageDelete — UID EXPUNGE did not remove the target`;
      } else if (!bSurvived) {
        rt.error = `UID ${uidB} (witness B) was also expunged — server issued mailbox-wide EXPUNGE despite uid:true. DESIGN PREMISE FAILS for this account`;
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.mailboxDelete(tempName);
    } catch {
      // Ignore; mailbox will be cleaned on the next spike run.
    }
  }

  return rt;
}

async function runMoveRoundtrip(
  client: ImapFlow,
): Promise<NonNullable<SpikeResult['moveRoundtrip']>> {
  const rt: NonNullable<SpikeResult['moveRoundtrip']> = {
    attempted: true,
    moveOk: false,
    scopeOk: false,
  };

  if (!client.capabilities.has('MOVE')) {
    rt.error =
      'MOVE not advertised — messageMove would fall back to COPY+EXPUNGE, which hits the same UID-EXPUNGE quirks. Skipping MOVE round-trip.';
    return rt;
  }

  const srcName = `${SPIKE_PREFIX}mv-src-${Date.now()}`;
  const dstName = `${SPIKE_PREFIX}mv-dst-${Date.now()}`;

  try {
    await client.mailboxCreate(srcName);
    await client.mailboxCreate(dstName);

    const lock = await client.getMailboxLock(srcName);
    let uidA: number;
    let uidB: number;
    try {
      const appendA = await client.append(srcName, tinyMessage('A'), [], new Date());
      const appendB = await client.append(srcName, tinyMessage('B'), [], new Date());
      if (appendA === false || appendB === false) {
        throw new Error('APPEND command failed (returned false)');
      }
      if (typeof appendA.uid !== 'number' || typeof appendB.uid !== 'number') {
        throw new Error('APPEND did not return a UID — APPENDUID likely unsupported');
      }
      uidA = appendA.uid;
      uidB = appendB.uid;
      rt.appendUidA = uidA;
      rt.appendUidB = uidB;

      // UID MOVE A → dstName. Witness B stays in source untouched.
      const moveResult = await client.messageMove(String(uidA), dstName, { uid: true });
      if (moveResult === false || moveResult === undefined) {
        throw new Error('messageMove returned false/undefined');
      }
      if (typeof moveResult !== 'object' || !('uidMap' in moveResult)) {
        throw new Error('messageMove did not return a uidMap (MOVEUID/COPYUID missing)');
      }
      rt.destUidA = moveResult.uidMap?.get(uidA);
      rt.moveOk = true;

      // Source must contain only B now.
      const srcSearch = await client.search({ all: true }, { uid: true });
      const srcUids: number[] = srcSearch === false ? [] : (srcSearch ?? []);
      const aLeftSource = !srcUids.includes(uidA);
      const bStayedInSource = srcUids.includes(uidB);

      if (!aLeftSource) {
        rt.error = `UID ${uidA} still in source after UID MOVE — MOVE did not remove the source copy`;
        return rt;
      }
      if (!bStayedInSource) {
        rt.error = `Witness B (UID ${uidB}) disappeared from source after UID MOVE of A — MOVE was not UID-scoped. DESIGN PREMISE FAILS for this account`;
        return rt;
      }
    } finally {
      lock.release();
    }

    // Verify destination got exactly one message (A).
    const dstLock = await client.getMailboxLock(dstName);
    try {
      const dstSearch = await client.search({ all: true }, { uid: true });
      const dstUids: number[] = dstSearch === false ? [] : (dstSearch ?? []);
      const aLandedInDest = dstUids.length === 1;
      if (!aLandedInDest) {
        rt.error = `Destination contains ${dstUids.length} message(s) after UID MOVE of A — expected exactly 1`;
        return rt;
      }
      rt.scopeOk = true;
    } finally {
      dstLock.release();
    }
  } finally {
    for (const name of [srcName, dstName]) {
      try {
        await client.mailboxDelete(name);
      } catch {
        // Ignore; mailbox will be cleaned on the next spike run.
      }
    }
  }

  return rt;
}

async function runOnAccount(account: AccountConfig, apply: boolean): Promise<SpikeResult> {
  const result: SpikeResult = {
    account: account.name,
    host: `${account.imap.host}:${account.imap.port}`,
    reachable: false,
    uidplus: false,
    appenduid: false,
    move: false,
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

    // imapflow types client.capabilities as Map<string, boolean | number>.
    const caps: string[] = [...client.capabilities.keys()];
    result.capabilities = caps;
    result.uidplus = caps.some((c) => c.toUpperCase() === 'UIDPLUS');
    result.appenduid = caps.some((c) => c.toUpperCase() === 'APPENDUID') || result.uidplus;
    result.move = caps.some((c) => c.toUpperCase() === 'MOVE');

    if (!apply) {
      await client.logout();
      return result;
    }

    // Apply mode — full round-trips in temp mailboxes.
    await cleanupStaleMailboxes(client);

    try {
      result.expungeRoundtrip = await runExpungeRoundtrip(client);
    } catch (err) {
      result.expungeRoundtrip = {
        attempted: true,
        deleteOk: false,
        scopeOk: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      result.moveRoundtrip = await runMoveRoundtrip(client);
    } catch (err) {
      result.moveRoundtrip = {
        attempted: true,
        moveOk: false,
        scopeOk: false,
        error: err instanceof Error ? err.message : String(err),
      };
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
  let allMoveOk = true;
  for (const r of results) {
    lines.push(`[${r.account}] ${r.host}`);
    if (r.error && !r.reachable) {
      lines.push(`  ERROR: ${r.error}`);
      allOk = false;
      allMoveOk = false;
      continue;
    }
    if (r.error) {
      lines.push(`  WARN: ${r.error}`);
    }
    lines.push(`  reachable: ${r.reachable}`);
    lines.push(`  UIDPLUS:   ${r.uidplus ? 'yes' : 'NO  *** safety premise broken ***'}`);
    lines.push(`  APPENDUID: ${r.appenduid ? 'yes' : 'NO  *** dest_uid capture broken ***'}`);
    lines.push(
      `  MOVE:      ${r.move ? 'yes' : 'no  (messageMove would fall back to COPY+EXPUNGE)'}`,
    );
    if (r.expungeRoundtrip?.attempted) {
      lines.push(`  EXPUNGE roundtrip:`);
      lines.push(`    APPEND A uid: ${r.expungeRoundtrip.appendUidA ?? '(none)'}`);
      lines.push(`    APPEND B uid: ${r.expungeRoundtrip.appendUidB ?? '(none)'}`);
      lines.push(`    messageDelete A ok: ${r.expungeRoundtrip.deleteOk}`);
      lines.push(`    scope ok (A gone, B survived): ${r.expungeRoundtrip.scopeOk}`);
      if (r.expungeRoundtrip.error) {
        lines.push(`    ERROR: ${r.expungeRoundtrip.error}`);
        allOk = false;
      }
    }
    if (r.moveRoundtrip?.attempted) {
      lines.push(`  MOVE roundtrip:`);
      lines.push(`    APPEND A uid: ${r.moveRoundtrip.appendUidA ?? '(none)'}`);
      lines.push(`    APPEND B uid: ${r.moveRoundtrip.appendUidB ?? '(none)'}`);
      lines.push(`    dest uid for A: ${r.moveRoundtrip.destUidA ?? '(none)'}`);
      lines.push(`    messageMove A ok: ${r.moveRoundtrip.moveOk}`);
      lines.push(`    scope ok (A in dest, B stayed, A left source): ${r.moveRoundtrip.scopeOk}`);
      if (r.moveRoundtrip.error) {
        lines.push(`    ${r.moveRoundtrip.moveOk ? 'ERROR' : 'NOTE'}: ${r.moveRoundtrip.error}`);
        // Only count as MOVE failure if we actually had MOVE advertised and the scope check failed.
        if (r.move && !r.moveRoundtrip.scopeOk) {
          allMoveOk = false;
        }
      }
    }
    if (!r.uidplus || !r.appenduid) {
      allOk = false;
    }
    if (!r.move) {
      allMoveOk = false;
    }
  }
  lines.push('');
  lines.push(
    `EXPUNGE VERDICT: ${allOk ? 'PASS — UID-scoped EXPUNGE works on all accounts' : 'FAIL — see errors above'}`,
  );
  lines.push(
    `MOVE VERDICT:    ${allMoveOk ? 'PASS — UID-scoped MOVE works on all accounts (recommended primary path for D4)' : 'FAIL — at least one account cannot rely on UID MOVE; D4 needs per-account branching'}`,
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
        move: false,
        capabilities: [],
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(formatReport(results));

  // Exit nonzero if any account failed an EXPUNGE check, so CI / git hooks notice.
  // MOVE-only failures are informational (they signal a design choice, not a broken
  // server) and don't fail the exit code — read the report to decide D4's path.
  const anyFail = results.some(
    (r) => !r.reachable || !r.uidplus || !r.appenduid || r.expungeRoundtrip?.error,
  );
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(2);
});
