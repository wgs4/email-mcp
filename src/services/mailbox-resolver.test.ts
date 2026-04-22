import { resolveMailboxForAccount } from './mailbox-resolver.js';

describe('resolveMailboxForAccount', () => {
  // ---------------------------------------------------------------------------
  // Literal match precedence
  // ---------------------------------------------------------------------------

  describe('literal path match', () => {
    it('returns the literal path without remapping when it exists', () => {
      const result = resolveMailboxForAccount('INBOX', [{ path: 'INBOX', specialUse: '\\Inbox' }]);
      expect(result).toEqual({ resolved: 'INBOX', remapped: false });
    });

    it('prefers literal match over semantic remap when both apply', () => {
      // `Archive` exists literally AND there's a \All folder — literal wins.
      const result = resolveMailboxForAccount('Archive', [
        { path: 'Archive' },
        { path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]);
      expect(result).toEqual({ resolved: 'Archive', remapped: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Archive / All Mail category
  // ---------------------------------------------------------------------------

  describe('archive / all-mail category', () => {
    it('remaps INBOX.Archive → [Gmail]/All Mail via \\All', () => {
      const result = resolveMailboxForAccount('INBOX.Archive', [
        { path: '[Gmail]/All Mail', specialUse: '\\All' },
        { path: 'INBOX', specialUse: '\\Inbox' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/All Mail',
        remapped: true,
        specialUse: '\\All',
      });
    });

    it('remaps [Gmail]/All Mail → INBOX.Archive via \\Archive fallback', () => {
      // Account has \Archive but no \All — rule falls back to \Archive.
      const result = resolveMailboxForAccount('[Gmail]/All Mail', [
        { path: 'INBOX.Archive', specialUse: '\\Archive' },
        { path: 'INBOX', specialUse: '\\Inbox' },
      ]);
      expect(result).toEqual({
        resolved: 'INBOX.Archive',
        remapped: true,
        specialUse: '\\Archive',
      });
    });

    it('resolves a bare "Archive" name via \\All', () => {
      const result = resolveMailboxForAccount('Archive', [
        { path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/All Mail',
        remapped: true,
        specialUse: '\\All',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Sent category
  // ---------------------------------------------------------------------------

  describe('sent category', () => {
    it('remaps INBOX.Sent → [Gmail]/Sent Mail via \\Sent', () => {
      const result = resolveMailboxForAccount('INBOX.Sent', [
        { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Sent Mail',
        remapped: true,
        specialUse: '\\Sent',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Trash category
  // ---------------------------------------------------------------------------

  describe('trash category', () => {
    it('remaps "Deleted Items" → [Gmail]/Trash via \\Trash', () => {
      const result = resolveMailboxForAccount('Deleted Items', [
        { path: '[Gmail]/Trash', specialUse: '\\Trash' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Trash',
        remapped: true,
        specialUse: '\\Trash',
      });
    });

    it('remaps INBOX.Trash → Deleted Items via \\Trash', () => {
      const result = resolveMailboxForAccount('INBOX.Trash', [
        { path: 'Deleted Items', specialUse: '\\Trash' },
      ]);
      expect(result).toEqual({
        resolved: 'Deleted Items',
        remapped: true,
        specialUse: '\\Trash',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Drafts category
  // ---------------------------------------------------------------------------

  describe('drafts category', () => {
    it('remaps INBOX.Drafts → [Gmail]/Drafts via \\Drafts', () => {
      const result = resolveMailboxForAccount('INBOX.Drafts', [
        { path: '[Gmail]/Drafts', specialUse: '\\Drafts' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Drafts',
        remapped: true,
        specialUse: '\\Drafts',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Junk / Spam category
  // ---------------------------------------------------------------------------

  describe('junk category', () => {
    it('remaps "Spam" → [Gmail]/Spam via \\Junk', () => {
      const result = resolveMailboxForAccount('Spam', [
        { path: '[Gmail]/Spam', specialUse: '\\Junk' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Spam',
        remapped: true,
        specialUse: '\\Junk',
      });
    });

    it('remaps INBOX.Junk → Junk E-mail via \\Junk', () => {
      const result = resolveMailboxForAccount('INBOX.Junk', [
        { path: 'Junk E-mail', specialUse: '\\Junk' },
      ]);
      expect(result).toEqual({
        resolved: 'Junk E-mail',
        remapped: true,
        specialUse: '\\Junk',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Flagged / Starred category
  // ---------------------------------------------------------------------------

  describe('flagged category', () => {
    it('remaps "Starred" → [Gmail]/Starred via \\Flagged', () => {
      const result = resolveMailboxForAccount('Starred', [
        { path: '[Gmail]/Starred', specialUse: '\\Flagged' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Starred',
        remapped: true,
        specialUse: '\\Flagged',
      });
    });

    it('remaps "Flagged" → Flagged-equivalent via \\Flagged', () => {
      const result = resolveMailboxForAccount('Flagged', [
        { path: '[Gmail]/Starred', specialUse: '\\Flagged' },
      ]);
      expect(result).toEqual({
        resolved: '[Gmail]/Starred',
        remapped: true,
        specialUse: '\\Flagged',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // No match
  // ---------------------------------------------------------------------------

  describe('no equivalent found', () => {
    it('returns null when requested name has no semantic category', () => {
      const result = resolveMailboxForAccount('CustomFolder', [
        { path: 'INBOX' },
        { path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]);
      expect(result).toEqual({ resolved: null, remapped: false });
    });

    it('returns null when category matches but no mailbox carries the flag', () => {
      // "Archive" triggers the archive rule, but account has only INBOX.
      const result = resolveMailboxForAccount('Archive', [
        { path: 'INBOX', specialUse: '\\Inbox' },
      ]);
      expect(result).toEqual({ resolved: null, remapped: false });
    });
  });
});
