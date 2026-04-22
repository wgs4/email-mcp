/**
 * Mailbox resolver — maps a caller-supplied mailbox name to the real mailbox
 * path on a given account using IMAP SPECIAL-USE flags (RFC 6154).
 *
 * Rationale: IMAP accounts across providers expose the same semantic folders
 * (Archive, Sent, Trash, Drafts, Junk, Flagged) under wildly different paths.
 * Gmail uses `[Gmail]/All Mail` where cPanel Dovecot uses `INBOX.Archive`;
 * Exchange uses yet another structure. When `searchAcrossAccounts` fans out
 * a single mailbox path to heterogeneous providers, we need to auto-remap
 * to each account's equivalent folder by SPECIAL-USE flag.
 *
 * This helper is intentionally pure — it takes a requested name and a
 * pre-fetched mailbox list, and returns the resolution decision. Callers
 * own the cache/fetch of the mailbox list (see `ImapService.getMailboxList`).
 */

export interface MailboxRef {
  path: string;
  specialUse?: string;
}

export interface ResolveResult {
  resolved: string | null;
  remapped: boolean;
  specialUse?: string;
}

// Ordered list — the first flag in each tuple is preferred; remaining flags
// are fallbacks if the preferred flag isn't present on the server.
interface SemanticRule {
  match: (name: string) => boolean;
  preferredFlags: string[];
}

// Match tokens on word boundaries within the requested mailbox name, using
// the common hierarchy delimiters ('.', '/', '_', '-') so `INBOX.Archive`
// and `[Gmail]/All Mail` both classify correctly.
const ALL_TOKEN = /(^|[./_\- ])all([./_\- ]|$)/i;

const RULES: SemanticRule[] = [
  // Archive / "All Mail" → \All preferred, \Archive fallback.
  // Checked before sent/trash/etc. so `[Gmail]/All Mail` lands on the All
  // category rather than being misclassified.
  {
    match: (n) => /archive/i.test(n) || /all\s*mail/i.test(n) || ALL_TOKEN.test(n),
    preferredFlags: ['\\All', '\\Archive'],
  },
  {
    match: (n) => /sent/i.test(n),
    preferredFlags: ['\\Sent'],
  },
  {
    match: (n) => /trash/i.test(n) || /deleted/i.test(n),
    preferredFlags: ['\\Trash'],
  },
  {
    match: (n) => /draft/i.test(n),
    preferredFlags: ['\\Drafts'],
  },
  {
    match: (n) => /spam/i.test(n) || /junk/i.test(n),
    preferredFlags: ['\\Junk'],
  },
  {
    match: (n) => /flagged/i.test(n) || /starred/i.test(n),
    preferredFlags: ['\\Flagged'],
  },
];

function findByFlag(mailboxes: MailboxRef[], flag: string): MailboxRef | undefined {
  return mailboxes.find((m) => m.specialUse === flag);
}

/**
 * Resolve a requested mailbox name against the given account's mailbox list.
 *
 * - Literal match on `.path` always wins (never remap when the requested
 *   name exists verbatim on the account).
 * - Otherwise derive a semantic category from the requested name and look
 *   up the first mailbox whose `specialUse` matches one of the preferred
 *   flags for that category (preferred first, fallback second).
 * - If the requested name doesn't match any known category, or no mailbox
 *   on the account carries the preferred flag, returns `{ resolved: null }`.
 */
export function resolveMailboxForAccount(
  requestedMailbox: string,
  mailboxes: MailboxRef[],
): ResolveResult {
  // 1. Literal match — exact path on the account.
  const literal = mailboxes.find((m) => m.path === requestedMailbox);
  if (literal) {
    return { resolved: requestedMailbox, remapped: false };
  }

  // 2. Semantic fallback — pick a category based on the requested name.
  const rule = RULES.find((r) => r.match(requestedMailbox));
  if (!rule) {
    return { resolved: null, remapped: false };
  }

  // 3. Walk preferred flags in order; return the first mailbox that carries
  //    one of them. Implemented via reduce to satisfy the repo's
  //    no-restricted-syntax rule on raw for-of loops.
  const flagMatch = rule.preferredFlags.reduce<{ path: string; flag: string } | null>(
    (acc, flag) => {
      if (acc) return acc;
      const hit = findByFlag(mailboxes, flag);
      return hit ? { path: hit.path, flag } : null;
    },
    null,
  );

  if (flagMatch) {
    return { resolved: flagMatch.path, remapped: true, specialUse: flagMatch.flag };
  }

  return { resolved: null, remapped: false };
}
