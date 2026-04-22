import type { SearchPreset } from '../types/index.js';
import { normalizePreset, SearchPresetRegistry } from './search-presets.js';

describe('normalizePreset', () => {
  it('returns camelCase fields from a snake_case raw preset', () => {
    const raw = {
      name: 'pines-lease',
      description: 'Pines Rd lease paperwork',
      accounts: ['wgs-usa', 'all-pedal'],
      mailbox: 'INBOX',
      query: 'Pines Rd',
      from: 'landlord@example.com',
      sent_since: '2024-01-01',
      sent_before: '2024-12-31',
      has_attachment: true,
      attachment_filename: 'lease',
      attachment_mimetype: 'application/pdf',
      larger_than: 100,
      smaller_than: 20000,
      not_keyword: ['Archive', 'Spam'],
      gmail_raw: '',
      facets: ['sender' as const, 'year' as const],
    };

    const result = normalizePreset(raw);

    expect(result.name).toBe('pines-lease');
    expect(result.accounts).toEqual(['wgs-usa', 'all-pedal']);
    expect(result.sentSince).toBe('2024-01-01');
    expect(result.sentBefore).toBe('2024-12-31');
    expect(result.hasAttachment).toBe(true);
    expect(result.attachmentFilename).toBe('lease');
    expect(result.attachmentMimetype).toBe('application/pdf');
    expect(result.largerThan).toBe(100);
    expect(result.smallerThan).toBe(20000);
    expect(result.notKeyword).toEqual(['Archive', 'Spam']);
    expect(result.gmailRaw).toBe('');
    expect(result.facets).toEqual(['sender', 'year']);
  });

  it('accepts an account-only preset (single-account)', () => {
    const result = normalizePreset({
      name: 'urgent-only',
      account: 'primary',
      flagged: true,
    });
    expect(result.account).toBe('primary');
    expect(result.flagged).toBe(true);
    expect(result.accounts).toBeUndefined();
  });

  it('accepts an accounts-only preset (cross-account)', () => {
    const result = normalizePreset({
      name: 'all-inbox-flagged',
      accounts: ['a', 'b'],
      flagged: true,
    });
    expect(result.accounts).toEqual(['a', 'b']);
    expect(result.account).toBeUndefined();
  });

  it('rejects when both account and accounts are provided', () => {
    expect(() =>
      normalizePreset({
        name: 'conflict',
        account: 'primary',
        accounts: ['a', 'b'],
      }),
    ).toThrow(/account.*accounts|account'.*'accounts/);
  });

  it('rejects when name is empty', () => {
    expect(() => normalizePreset({ name: '' })).toThrow();
  });
});

describe('SearchPresetRegistry', () => {
  const presets: SearchPreset[] = [
    { name: 'alpha', from: 'a@example.com' },
    { name: 'beta', subject: 'b' },
    { name: 'gamma', accounts: ['acc1', 'acc2'] },
  ];

  it('lookup by name returns the preset', () => {
    const registry = new SearchPresetRegistry(presets);
    expect(registry.get('alpha')?.from).toBe('a@example.com');
    expect(registry.get('beta')?.subject).toBe('b');
    expect(registry.get('gamma')?.accounts).toEqual(['acc1', 'acc2']);
  });

  it('returns undefined for unknown name', () => {
    const registry = new SearchPresetRegistry(presets);
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('list() returns all presets in insertion order', () => {
    const registry = new SearchPresetRegistry(presets);
    expect(registry.list().map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('size reflects the registered count', () => {
    const registry = new SearchPresetRegistry(presets);
    expect(registry.size).toBe(3);
  });

  it('empty registry behaves correctly', () => {
    const registry = new SearchPresetRegistry();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.get('anything')).toBeUndefined();
  });

  it('last preset wins when names collide', () => {
    const registry = new SearchPresetRegistry([
      { name: 'dup', from: 'first' },
      { name: 'dup', from: 'second' },
    ]);
    expect(registry.get('dup')?.from).toBe('second');
    expect(registry.size).toBe(1);
  });
});
