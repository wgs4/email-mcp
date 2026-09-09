/**
 * Unit tests for full-text-search detection (`accountHasFts` / `declaredFts`).
 *
 * Why these exist: detection used to be capability-only, keyed on
 * `SEARCH=FUZZY` (RFC 6203). Dovecot's fts/fts_xapian plugins index message
 * bodies but advertise NOTHING in CAPABILITY — verified against the WGS mail
 * server (Dovecot 2.3.21 + fts_xapian), whose greeting is:
 *
 *   IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ AUTH=PLAIN AUTH=LOGIN
 *
 * so a working index that answered a 17,076-message body search in 0.154s was
 * still reported to every caller as "no server-side full-text index". These
 * tests pin the precedence that fixes it, in both directions.
 *
 * No live IMAP: the client is a stub that only carries `capabilities`.
 */

import type { ImapFlow } from 'imapflow';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

type Fts = boolean | undefined;

/** Minimal stub: `accountHasFts` reads only `client.capabilities`. */
const clientWith = (caps: string[] | null): ImapFlow =>
  ({
    capabilities: caps === null ? undefined : new Map(caps.map((c) => [c, true])),
  }) as unknown as ImapFlow;

/** Dovecot 2.3.21 + fts_xapian: a real index, advertised nowhere. */
const DOVECOT_CAPS = [
  'IMAP4rev1',
  'SASL-IR',
  'LOGIN-REFERRALS',
  'ID',
  'ENABLE',
  'IDLE',
  'LITERAL+',
  'AUTH=PLAIN',
];

const serviceFor = (hasFts: Fts): ImapService => {
  const connections = {
    getAccount: () => ({ name: 'wgs-usa', email: 'd@x.test', hasFts }),
  } as unknown as IConnectionManager;
  return new ImapService(connections);
};

/** `accountHasFts` is private; these tests are about that exact contract. */
const detect = (svc: ImapService, client: ImapFlow, account = 'wgs-usa'): boolean =>
  (svc as unknown as { accountHasFts: (a: string, c: ImapFlow) => boolean }).accountHasFts(
    account,
    client,
  );

describe('FTS detection', () => {
  beforeEach(() => {
    delete process.env.EMAIL_MCP_FTS_ACCOUNTS;
  });

  it('reports NO index for Dovecot+fts_xapian when nothing declares it (the old, wrong reading)', () => {
    expect(detect(serviceFor(undefined), clientWith(DOVECOT_CAPS))).toBe(false);
  });

  it('reports an index for Dovecot+fts_xapian once the account declares hasFts', () => {
    expect(detect(serviceFor(true), clientWith(DOVECOT_CAPS))).toBe(true);
  });

  it('still autodetects SEARCH=FUZZY when the account declares nothing', () => {
    expect(detect(serviceFor(undefined), clientWith([...DOVECOT_CAPS, 'SEARCH=FUZZY']))).toBe(true);
  });

  it('lets hasFts:false override a server that DOES advertise SEARCH=FUZZY', () => {
    expect(detect(serviceFor(false), clientWith([...DOVECOT_CAPS, 'SEARCH=FUZZY']))).toBe(false);
  });

  it('accepts EMAIL_MCP_FTS_ACCOUNTS as an escape hatch when config is silent', () => {
    process.env.EMAIL_MCP_FTS_ACCOUNTS = 'other, wgs-usa ,third';
    expect(detect(serviceFor(undefined), clientWith(DOVECOT_CAPS))).toBe(true);
  });

  it('does not apply the env list to an account it does not name', () => {
    process.env.EMAIL_MCP_FTS_ACCOUNTS = 'someone-else';
    expect(detect(serviceFor(undefined), clientWith(DOVECOT_CAPS))).toBe(false);
  });

  it('never lets the env list undo a deliberate hasFts:false', () => {
    process.env.EMAIL_MCP_FTS_ACCOUNTS = 'wgs-usa';
    expect(detect(serviceFor(false), clientWith(DOVECOT_CAPS))).toBe(false);
  });

  it('does not memoize an undecided reading from an unpopulated capability map', () => {
    const svc = serviceFor(undefined);
    // Pre-connect: capabilities absent. Must NOT cache false, or the account is
    // misclassified for the rest of the process once the server does answer.
    expect(detect(svc, clientWith(null))).toBe(false);
    expect(detect(svc, clientWith([...DOVECOT_CAPS, 'SEARCH=FUZZY']))).toBe(true);
  });
});
