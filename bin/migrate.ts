/**
 * email-mcp database migration runner (D5/D6).
 *
 * Forward-only. No down(). Applies pending `migrations/NNN_*.sql` files in
 * filename order, each atomically (BEGIN … file … record … COMMIT), and
 * tracks applied filenames in a `schema_migrations` table so re-runs are
 * idempotent.
 *
 * Connection resolution (D-Open-Q1 / D20), in precedence order:
 *   1. EMAIL_MCP_DATABASE_URL env var
 *   2. [database].url in the email-mcp config.toml (~/.config/email-mcp/)
 *
 * Dev reset: DROP DATABASE email_mcp; CREATE DATABASE email_mcp OWNER
 * email_mcp; then re-run. Production rollback is a Postgres backup +
 * forward fix — there is intentionally no down path.
 *
 * Usage:
 *   pnpm db:migrate            apply all pending migrations
 *   pnpm db:migrate --dry-run  list pending migrations, apply nothing
 *   pnpm db:migrate --status   show applied + pending, apply nothing
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parse as parseTOML } from 'smol-toml';

import { CONFIG_FILE } from '../src/config/xdg.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

async function resolveDatabaseUrl(): Promise<string> {
  const fromEnv = process.env.EMAIL_MCP_DATABASE_URL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = parseTOML(raw) as { database?: { url?: unknown } };
    const url = parsed.database?.url;
    if (typeof url === 'string' && url.trim()) {
      return url.trim();
    }
  } catch {
    // Fall through to the unified error below.
  }
  throw new Error(
    'No database connection string.\n' +
      '  Set EMAIL_MCP_DATABASE_URL, or add to config.toml:\n' +
      '    [database]\n' +
      '    url = "postgresql://email_mcp:…@host:5433/email_mcp"\n' +
      `  config.toml location: ${CONFIG_FILE}`,
  );
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    if (!MIGRATION_FILE_RE.test(f)) {
      throw new Error(
        `Migration filename "${f}" does not match NNN_snake_case.sql — refusing to run (ordering/safety).`,
      );
    }
  }
  return files.sort(); // zero-padded NNN prefix → lexicographic == numeric order
}

type Sql = ReturnType<typeof postgres>;

async function appliedFilenames(sql: Sql): Promise<Set<string>> {
  await sql.unsafe(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'filename TEXT PRIMARY KEY, ' +
      'applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const rows = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`;
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(sql: Sql, filename: string): Promise<void> {
  const body = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf-8');
  // One atomic simple-protocol batch: BEGIN, the migration DDL (multi-statement
  // + dollar-quoted function bodies are fine under the simple protocol), the
  // schema_migrations record, COMMIT. If any statement fails, COMMIT is never
  // reached and Postgres rolls the whole transaction back.
  const script =
    'BEGIN;\n' +
    `${body}\n` +
    `INSERT INTO schema_migrations (filename) VALUES ('${filename}');\n` +
    'COMMIT;';
  try {
    await sql.unsafe(script).simple();
  } catch (err) {
    // Best-effort: if the batch failed after BEGIN but before COMMIT, clear
    // the aborted transaction state on this connection.
    await sql
      .unsafe('ROLLBACK')
      .simple()
      .catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statusOnly = args.includes('--status');

  const url = await resolveDatabaseUrl();
  // Redact credentials when echoing the target.
  const safeTarget = url.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@');
  console.log(`email-mcp migrate — target: ${safeTarget}`);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const applied = await appliedFilenames(sql);
    const all = await listMigrationFiles();
    const pending = all.filter((f) => !applied.has(f));

    console.log(`applied: ${applied.size}  |  total: ${all.length}  |  pending: ${pending.length}`);

    if (statusOnly || dryRun) {
      for (const f of all) {
        console.log(`  [${applied.has(f) ? 'x' : ' '}] ${f}`);
      }
      console.log(
        pending.length === 0
          ? 'nothing to apply.'
          : `${dryRun ? '--dry-run' : '--status'}: ${pending.length} pending, applied nothing.`,
      );
      return;
    }

    if (pending.length === 0) {
      console.log('database is up to date.');
      return;
    }

    for (const f of pending) {
      process.stdout.write(`  applying ${f} ... `);
      await applyMigration(sql, f);
      console.log('ok');
    }
    console.log(`done — ${pending.length} migration(s) applied.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Config problems are exit 2 (operator action); migration failures are exit 1.
  const isConfig = msg.startsWith('No database connection string');
  console.error(`\nmigrate failed: ${msg}`);
  process.exit(isConfig ? 2 : 1);
});
