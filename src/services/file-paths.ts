/**
 * Filesystem-path helpers for the direct-to-disk export / save tools.
 *
 * - `sanitizeFilename` — strip path separators and reserved characters so we
 *   never let an attacker's filename break out of the destination directory.
 * - `assertSafeDestination` — guard-rail that rejects any destination outside
 *   the user's home directory (or `/tmp`). Normalizes `..` traversal.
 * - `resolveUniquePath` — auto-suffix `name.ext` → `name-1.ext`, `name-2.ext`
 *   when the caller doesn't want to overwrite.
 */

import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/** Async existence check — uses `fs.access`; throws become "does not exist". */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace anything that could make a filename unsafe with `_`. Also strips
 * leading/trailing dots so we don't produce `..` or hidden-file surprises.
 *
 * Safe on all three major platforms (macOS, Linux, Windows).
 */
export function sanitizeFilename(name: string): string {
  // Strip any directory separators first — we only want the leaf.
  const leaf = name.replace(/[\\/]/g, '_');
  // Replace Windows-reserved and other problematic chars with `_`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in filenames
  const replaced = leaf.replace(/[<>:"|?*\x00-\x1F]/g, '_'); // eslint-disable-line no-control-regex
  // Collapse consecutive underscores introduced by the replace pass.
  const collapsed = replaced.replace(/_+/g, '_');
  // Trim leading dots so we don't produce `.hidden` files accidentally, and
  // trim trailing whitespace or dots (Windows rejects trailing dots anyway).
  const trimmed = collapsed.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  return trimmed.length > 0 ? trimmed : 'unnamed';
}

/**
 * Validate that a target path lies under the user's home directory OR under
 * the OS tmp dir. Throws an Error describing the violation otherwise.
 *
 * The checks use `path.resolve` to canonicalize, so `..` traversal
 * (`~/Downloads/../../etc/passwd`) is caught. `startsWith` is compared with
 * the platform separator appended so `/tmp-evil/` isn't treated as inside
 * `/tmp`.
 */
export function assertSafeDestination(absolutePath: string): void {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Destination must be an absolute path, got: ${absolutePath}`);
  }

  const resolved = resolve(absolutePath);

  // Reject any path that contains `..` as a literal segment after resolve —
  // resolve() collapses most cases, but catching the raw `..` in the input
  // gives a clearer error than the home-check failing further down.
  if (absolutePath.split(/[\\/]/).includes('..')) {
    throw new Error(`Destination path must not contain ".." traversal segments: ${absolutePath}`);
  }

  const home = resolve(homedir());
  const tmp = resolve(tmpdir());

  // Append path separator so `/tmp-evil` isn't accepted as inside `/tmp`. The
  // exact equality case (path === home / tmp) is also valid.
  const underHome = resolved === home || resolved.startsWith(`${home}/`);
  const underTmp = resolved === tmp || resolved.startsWith(`${tmp}/`);

  if (!underHome && !underTmp) {
    throw new Error(
      `Destination "${resolved}" is outside the user's home directory and tmp dir — refusing to write.`,
    );
  }
}

/**
 * Given a desired destination path, return a unique path that does not
 * collide with an existing file. If `filename.ext` already exists, try
 * `filename-1.ext`, `filename-2.ext`, ... up to 9999.
 *
 * When `overwrite=true` this simply returns the input unchanged.
 */
export async function resolveUniquePath(desiredPath: string, overwrite: boolean): Promise<string> {
  if (overwrite) return desiredPath;
  if (!(await pathExists(desiredPath))) return desiredPath;

  const dir = dirname(desiredPath);
  const ext = extname(desiredPath);
  const base = basename(desiredPath, ext);

  /* eslint-disable no-await-in-loop */
  for (let i = 1; i < 10000; i += 1) {
    const candidate = join(dir, `${base}-${i}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`Could not find a unique filename after 10000 attempts for "${desiredPath}"`);
}
