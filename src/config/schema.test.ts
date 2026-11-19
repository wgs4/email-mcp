import {
  AccountConfigSchema,
  AppConfigFileSchema,
  ImapConfigSchema,
  MaildirConfigSchema,
  SettingsSchema,
  SmtpConfigSchema,
} from './schema.js';

const validImap = { host: 'imap.example.com' };
const validSmtp = { host: 'smtp.example.com' };

function validAccount(overrides = {}) {
  return {
    name: 'test',
    email: 'user@example.com',
    password: 'secret',
    imap: validImap,
    smtp: validSmtp,
    ...overrides,
  };
}

describe('ImapConfigSchema', () => {
  it('applies default port of 993', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com' });
    expect(result.port).toBe(993);
  });

  it('rejects port 0', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 65536 })).toThrow();
  });

  it('accepts valid port', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com', port: 143 });
    expect(result.port).toBe(143);
  });
});

describe('SmtpConfigSchema', () => {
  it('applies default port of 465', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.port).toBe(465);
  });

  it('rejects port 0', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 65536 })).toThrow();
  });

  it('applies pool defaults', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.pool).toEqual({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    });
  });
});

describe('AccountConfigSchema', () => {
  it('accepts valid minimal config with password', () => {
    const result = AccountConfigSchema.parse(validAccount());
    expect(result.name).toBe('test');
    expect(result.email).toBe('user@example.com');
  });

  it('accepts valid config with oauth2 instead of password', () => {
    const result = AccountConfigSchema.parse(
      validAccount({
        password: undefined,
        oauth2: {
          provider: 'google',
          client_id: 'id',
          client_secret: 'secret',
          refresh_token: 'token',
        },
      }),
    );
    expect(result.oauth2?.provider).toBe('google');
  });

  it('rejects when neither password nor oauth2 provided', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ password: undefined }))).toThrow(
      'password or oauth2',
    );
  });

  it('rejects missing name', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ name: '' }))).toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ email: 'not-an-email' }))).toThrow();
  });

  it('rejects missing imap', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), imap: undefined })).toThrow();
  });

  it('rejects missing smtp', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), smtp: undefined })).toThrow();
  });
});

describe('SettingsSchema', () => {
  it('applies default rate_limit of 10', () => {
    const result = SettingsSchema.parse({});
    expect(result.rate_limit).toBe(10);
  });

  it('applies default read_only of false', () => {
    const result = SettingsSchema.parse({});
    expect(result.read_only).toBe(false);
  });

  it('accepts custom values', () => {
    const result = SettingsSchema.parse({ rate_limit: 5, read_only: true });
    expect(result.rate_limit).toBe(5);
    expect(result.read_only).toBe(true);
  });
});

describe('AppConfigFileSchema', () => {
  it('accepts valid config with one account', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.accounts).toHaveLength(1);
  });

  it('requires at least one account', () => {
    expect(() => AppConfigFileSchema.parse({ accounts: [] })).toThrow('At least one account');
  });

  it('applies settings defaults when not provided', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.rate_limit).toBe(10);
    expect(result.settings.read_only).toBe(false);
  });

  it('rejects accounts with invalid email', () => {
    expect(() =>
      AppConfigFileSchema.parse({ accounts: [validAccount({ email: 'bad' })] }),
    ).toThrow();
  });

  it('accepts an optional [database] section with a url', () => {
    const result = AppConfigFileSchema.parse({
      accounts: [validAccount()],
      database: { url: 'postgresql://email_mcp:pw@192.168.1.200:5433/email_mcp' },
    });
    expect(result.database?.url).toBe('postgresql://email_mcp:pw@192.168.1.200:5433/email_mcp');
  });

  it('omits database when the section is absent', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.database).toBeUndefined();
  });

  it('rejects a [database] section with an empty url', () => {
    expect(() =>
      AppConfigFileSchema.parse({ accounts: [validAccount()], database: { url: '' } }),
    ).toThrow();
  });
});

describe('MaildirConfigSchema', () => {
  it('is disabled by default with safe defaults', () => {
    const c = MaildirConfigSchema.parse({});
    expect(c).toMatchObject({
      enabled: false,
      ssh_host: 'mailserver',
      root: '/var/vmail',
      sudo_user: 'vmail',
      allowed_domains: [],
      excluded_users: [],
      default_timeout_seconds: 300,
      concurrency: 3,
    });
  });

  it('is optional in the app config', () => {
    const r = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(r.maildir).toBeUndefined();
  });

  it.each([
    ['ssh_host as an ssh option', { ssh_host: '-oProxyCommand=id' }],
    ['ssh_host with a space', { ssh_host: 'mail server' }],
    ['relative root', { root: 'var/vmail' }],
    ['root with ..', { root: '/var/../etc' }],
    ['root with a quote', { root: "/var/vmail'" }],
    ['sudo_user with shell chars', { sudo_user: 'vmail;id' }],
    ['bad domain', { allowed_domains: ['../x'] }],
    ['user without domain', { excluded_users: ['justin'] }],
    ['concurrency too high', { concurrency: 50 }],
  ])('rejects %s', (_label, input) => {
    expect(() => MaildirConfigSchema.parse(input)).toThrow();
  });

  it('lower-cases domains and users', () => {
    const c = MaildirConfigSchema.parse({
      allowed_domains: ['WGSUSA.com'],
      excluded_users: ['Bart@WGSUSA.com'],
    });
    expect(c.allowed_domains).toEqual(['wgsusa.com']);
    expect(c.excluded_users).toEqual(['bart@wgsusa.com']);
  });
});
