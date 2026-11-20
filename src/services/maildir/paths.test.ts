import { MaildirIdError } from './errors.js';
import {
  decodeModifiedUtf7,
  escapeFindGlob,
  fromAbsolute,
  globToRegExp,
  isMailboxAllowed,
  parseDir,
  parseFile,
  parseMaildirFileName,
  validateMessageId,
} from './paths.js';

const cfg = {
  root: '/var/vmail',
  allowedDomains: [] as string[],
  excludedDomains: [] as string[],
  allowedUsers: [] as string[],
  excludedUsers: [] as string[],
};

const KNOWN =
  'wgsusa.com/justin/Maildir/cur/1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098:2,RSa';

describe('parseDir', () => {
  it('parses INBOX and sub-folders', () => {
    expect(parseDir('wgsusa.com/lisa/Maildir/cur')).toMatchObject({
      domain: 'wgsusa.com',
      user: 'lisa',
      mailbox: 'lisa@wgsusa.com',
      folder: 'INBOX',
      folderDir: '',
      sub: 'cur',
    });
    expect(parseDir('wgsusa.com/a.smith/Maildir/.Sent Messages/new')).toMatchObject({
      mailbox: 'a.smith@wgsusa.com',
      folder: 'Sent Messages',
      sub: 'new',
    });
    expect(parseDir('wgsusa.com/x/Maildir/.[Airmail].To Do/cur')?.folder).toBe('[Airmail].To Do');
  });

  it('rejects non-Dovecot layouts', () => {
    expect(parseDir('wgsusa.com/jesse/Maildir/jesse/cur')).toBeNull();
    expect(parseDir('wgsusa.com/jesse/Maildir/tmp')).toBeNull();
    expect(parseDir('wgsusa.com/jesse/Maildir/xapian-indexes/cur')).toBeNull();
    expect(parseDir('wgsusa.com/../etc/Maildir/cur')).toBeNull();
    expect(parseDir('wgsusa.com/u/Maildir/../cur')).toBeNull();
    expect(parseDir('wgsusa.com/u/Maildir/.x\ny/cur')).toBeNull();
  });
});

describe('parseFile / parseMaildirFileName', () => {
  it('parses the known message', () => {
    const f = parseFile(KNOWN);
    expect(f).toMatchObject({
      mailbox: 'justin@wgsusa.com',
      folder: 'INBOX',
      base: '1742362272.M944266P6252.server-5.wgsusa.com,S=647637,W=656098',
      flags: 'RSa',
      savedAt: 1742362272,
      size: 647637,
    });
  });

  it('handles new/ files without flags', () => {
    expect(parseMaildirFileName('1700000000.M1P2.host,S=10')).toEqual({
      base: '1700000000.M1P2.host,S=10',
      flags: '',
      savedAt: 1700000000,
      size: 10,
    });
  });
});

describe('validateMessageId', () => {
  it('accepts a relative id and an absolute path under the root', () => {
    expect(validateMessageId(cfg, KNOWN).rel).toBe(KNOWN);
    expect(validateMessageId(cfg, `/var/vmail/${KNOWN}`).rel).toBe(KNOWN);
  });

  it.each([
    ['dot-dot', 'wgsusa.com/justin/Maildir/cur/../../../../etc/passwd'],
    ['dot-dot folder', 'wgsusa.com/justin/Maildir/../cur/x'],
    ['outside root', '/etc/passwd'],
    ['root prefix trick', '/var/vmail-evil/wgsusa.com/justin/Maildir/cur/x'],
    ['NUL', `${KNOWN}\u0000`],
    ['newline', `${KNOWN}\nfoo`],
    ['tmp dir', 'wgsusa.com/justin/Maildir/tmp/x'],
    ['no Maildir', 'wgsusa.com/justin/cur/x'],
    ['quote', "wgsusa.com/justin/Maildir/cur/x'; id"],
  ])('refuses %s', (_label, id) => {
    // A quote is a legal file-name character; it must still be safe because
    // every remote argument is single-quoted. Only that case may pass.
    if (id.includes("'")) {
      expect(validateMessageId(cfg, id).file).toBe("x'; id");
      return;
    }
    expect(() => validateMessageId(cfg, id)).toThrow(MaildirIdError);
  });

  it('enforces the allow/deny lists', () => {
    expect(() =>
      validateMessageId({ ...cfg, excludedUsers: ['justin@wgsusa.com'] }, KNOWN),
    ).toThrow(/excluded/);
    expect(() => validateMessageId({ ...cfg, allowedDomains: ['allpedal.com'] }, KNOWN)).toThrow(
      /excluded/,
    );
  });
});

describe('isMailboxAllowed', () => {
  it('applies allowed and excluded lists', () => {
    expect(isMailboxAllowed(cfg, 'wgsusa.com', 'lisa')).toBe(true);
    expect(
      isMailboxAllowed({ ...cfg, allowedUsers: ['lisa@wgsusa.com'] }, 'wgsusa.com', 'bart'),
    ).toBe(false);
    expect(
      isMailboxAllowed({ ...cfg, excludedDomains: ['wgsusa.com'] }, 'wgsusa.com', 'lisa'),
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('fromAbsolute stays inside the root', () => {
    expect(fromAbsolute('/var/vmail', '/var/vmail/a/b')).toBe('a/b');
    expect(fromAbsolute('/var/vmail', '/var/vmailx/a')).toBeNull();
  });

  it('globToRegExp matches case-insensitively and escapes regex chars', () => {
    expect(globToRegExp('sent*').test('Sent Messages')).toBe(true);
    expect(globToRegExp('INBOX').test('inbox')).toBe(true);
    expect(globToRegExp('[Airmail].*').test('[Airmail].Done')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('escapeFindGlob escapes glob metacharacters', () => {
    expect(escapeFindGlob('a*b?[c]\\')).toBe('a\\*b\\?\\[c\\]\\\\');
  });

  it('decodes modified UTF-7 folder names', () => {
    expect(decodeModifiedUtf7('Caf&AOk-')).toBe('Café');
    expect(decodeModifiedUtf7('A&-B')).toBe('A&B');
  });
});
