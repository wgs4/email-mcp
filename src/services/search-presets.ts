/**
 * Saved-search preset registry — looks up `[[searches]]` entries from
 * config.toml by name and exposes a simple list/get API consumed by the
 * `run_preset` and `list_presets` tools.
 *
 * Presets are camelCase at this layer (see `SearchPreset` in
 * `src/types/index.ts`); snake_case → camelCase normalization happens in the
 * config loader. The `normalizePreset` helper exported here is a convenience
 * for tests that want to exercise the snake_case → camelCase transform
 * without going through the full config loader.
 */

import { SearchPresetSchema } from '../config/schema.js';
import type { SearchPreset } from '../types/index.js';

/**
 * Normalize a raw (snake_case) preset into the camelCase runtime shape. Runs
 * the Zod schema first so callers also get validation (e.g. the
 * `account` XOR `accounts` refinement). Throws on invalid input.
 */
export function normalizePreset(raw: unknown): SearchPreset {
  const parsed = SearchPresetSchema.parse(raw);
  return {
    name: parsed.name,
    description: parsed.description,
    account: parsed.account,
    accounts: parsed.accounts,
    mailbox: parsed.mailbox,
    query: parsed.query,
    to: parsed.to,
    from: parsed.from,
    subject: parsed.subject,
    cc: parsed.cc,
    bcc: parsed.bcc,
    text: parsed.text,
    body: parsed.body,
    since: parsed.since,
    before: parsed.before,
    on: parsed.on,
    sentSince: parsed.sent_since,
    sentBefore: parsed.sent_before,
    seen: parsed.seen,
    flagged: parsed.flagged,
    answered: parsed.answered,
    draft: parsed.draft,
    deleted: parsed.deleted,
    keyword: parsed.keyword,
    notKeyword: parsed.not_keyword,
    header: parsed.header,
    largerThan: parsed.larger_than,
    smallerThan: parsed.smaller_than,
    hasAttachment: parsed.has_attachment,
    attachmentFilename: parsed.attachment_filename,
    attachmentMimetype: parsed.attachment_mimetype,
    facets: parsed.facets,
    gmailRaw: parsed.gmail_raw,
  };
}

/** In-memory lookup for saved-search presets keyed by `name`. */
export class SearchPresetRegistry {
  private readonly presets = new Map<string, SearchPreset>();

  constructor(presets: SearchPreset[] = []) {
    presets.forEach((p) => {
      this.presets.set(p.name, p);
    });
  }

  /** All presets, in insertion order. */
  list(): SearchPreset[] {
    return [...this.presets.values()];
  }

  /** Lookup a preset by name. Returns `undefined` for unknown names. */
  get(name: string): SearchPreset | undefined {
    return this.presets.get(name);
  }

  /** Number of presets registered. */
  get size(): number {
    return this.presets.size;
  }
}
