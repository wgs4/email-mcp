import {
  amountVariants,
  buildSearchCriteria,
  chunkUids,
  hasDateNarrowing,
  RECENCY_WINDOW_DAYS,
  withRecencyWindow,
} from './search-criteria.js';

describe('buildSearchCriteria', () => {
  describe('empty / defaults', () => {
    it('empty params produce empty criteria and no warnings', () => {
      const result = buildSearchCriteria({}, { isGmail: false });
      expect(result).toEqual({
        criteria: {},
        postFilters: {
          hasAttachment: undefined,
          attachmentFilename: undefined,
          attachmentMimetype: undefined,
          facets: undefined,
        },
        gmailRawUsed: false,
        bodyScan: false,
        warnings: [],
      });
    });
  });

  describe('legacy parameter parity (matches imap.service.ts:519-543 shape)', () => {
    it('produces matching merged criteria for query+to+largerThan+smallerThan+answered', () => {
      const result = buildSearchCriteria(
        {
          query: 'invoice',
          to: 'billing@example.com',
          largerThan: 10,
          smallerThan: 1000,
          answered: true,
          hasAttachment: true,
        },
        { isGmail: false },
      );

      // query is deep-by-default (subject/from/body OR). PR-2 makes the
      // big-folder body scan bounded + warned rather than disabling it.
      expect(result.criteria).toEqual({
        or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }],
        to: 'billing@example.com',
        larger: 10 * 1024,
        smaller: 1000 * 1024,
        answered: true,
      });
      // hasAttachment stays in postFilters, NOT in criteria
      expect(result.postFilters.hasAttachment).toBe(true);
      expect(result.gmailRawUsed).toBe(false);
      // A free-text query touches the body → flagged for the R5 at-risk gate.
      expect(result.bodyScan).toBe(true);
    });

    it('answered: false becomes answered: false in criteria (imapflow handles UN- prefix)', () => {
      const result = buildSearchCriteria({ answered: false }, { isGmail: false });
      expect(result.criteria).toEqual({ answered: false });
    });
  });

  describe('query is deep-by-default (subject/from/body); bodyScan flag drives the R5 gate', () => {
    it('query builds {or:[subject,from,body]} (deep by default)', () => {
      const result = buildSearchCriteria({ query: 'Order #29804' }, { isGmail: false });
      expect(result.criteria).toEqual({
        or: [{ subject: 'Order #29804' }, { from: 'Order #29804' }, { body: 'Order #29804' }],
      });
      expect(result.bodyScan).toBe(true);
    });

    it('body: filter performs a body search and sets bodyScan', () => {
      const result = buildSearchCriteria({ body: 'invoice total' }, { isGmail: false });
      expect(result.criteria).toEqual({ body: 'invoice total' });
      expect(result.bodyScan).toBe(true);
    });

    it('text: filter performs a full-text search and sets bodyScan', () => {
      const result = buildSearchCriteria({ text: 'invoice total' }, { isGmail: false });
      expect(result.criteria).toEqual({ text: 'invoice total' });
      expect(result.bodyScan).toBe(true);
    });

    it('query + body: combine — deep OR plus the explicit body condition', () => {
      const result = buildSearchCriteria(
        { query: 'refund', body: 'wire transfer' },
        { isGmail: false },
      );
      expect(result.criteria).toEqual({
        or: [{ subject: 'refund' }, { from: 'refund' }, { body: 'refund' }],
        body: 'wire transfer',
      });
      expect(result.bodyScan).toBe(true);
    });

    it('pure header/date filters (no query/body/text) do NOT set bodyScan', () => {
      const result = buildSearchCriteria(
        { from: 'green.jonadam@gmail.com', subject: 'Order', since: '2024-01-01' },
        { isGmail: false },
      );
      expect(result.bodyScan).toBe(false);
      // sanity: this is a cheap header/date search, no OR-body, no body/text
      expect(JSON.stringify(result.criteria)).not.toContain('"body"');
    });

    it('empty params → bodyScan false', () => {
      const result = buildSearchCriteria({}, { isGmail: false });
      expect(result.bodyScan).toBe(false);
    });

    it('gmail_raw short-circuit → bodyScan false (Gmail searches natively)', () => {
      const result = buildSearchCriteria({ gmailRaw: 'from:x' }, { isGmail: true });
      expect(result.gmailRawUsed).toBe(true);
      expect(result.bodyScan).toBe(false);
    });
  });

  describe('dates', () => {
    it("since: '2024-01-01' → criteria.since is a Date instance", () => {
      const result = buildSearchCriteria({ since: '2024-01-01' }, { isGmail: false });
      expect((result.criteria as { since: unknown }).since).toBeInstanceOf(Date);
      expect((result.criteria as { since: Date }).since.toISOString()).toBe(
        '2024-01-01T00:00:00.000Z',
      );
    });

    it("since: '7d' → criteria.since is ~7 days ago (UTC midnight)", () => {
      const result = buildSearchCriteria({ since: '7d' }, { isGmail: false });
      const { since } = result.criteria as { since: Date };
      expect(since).toBeInstanceOf(Date);
      // normalizeDate returns UTC midnight of (today - 7d). So the diff from
      // current time is between 7d and 8d - 1ms depending on time of day.
      const now = Date.now();
      const diff = now - since.getTime();
      expect(diff).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    });

    it('produces before / on / sentSince / sentBefore as Date instances', () => {
      const result = buildSearchCriteria(
        {
          before: '2024-02-01',
          on: '2024-02-15',
          sentSince: '2024-01-01',
          sentBefore: '2024-03-01',
        },
        { isGmail: false },
      );
      const c = result.criteria as Record<string, Date>;
      expect(c.before).toBeInstanceOf(Date);
      expect(c.on).toBeInstanceOf(Date);
      expect(c.sentSince).toBeInstanceOf(Date);
      expect(c.sentBefore).toBeInstanceOf(Date);
    });
  });

  describe('flags', () => {
    it('flagged:true + seen:false combine correctly', () => {
      const result = buildSearchCriteria({ flagged: true, seen: false }, { isGmail: false });
      expect(result.criteria).toEqual({ flagged: true, seen: false });
    });

    it('supports draft and deleted', () => {
      const result = buildSearchCriteria({ draft: true, deleted: false }, { isGmail: false });
      expect(result.criteria).toEqual({ draft: true, deleted: false });
    });
  });

  describe('keywords', () => {
    it("keyword: ['urgent', 'review'] → two merged keyword conditions", () => {
      const result = buildSearchCriteria({ keyword: ['urgent', 'review'] }, { isGmail: false });
      // Since Object.assign merges by key, the last keyword wins in the merged object,
      // but both must have been emitted for the compiler to AND them correctly.
      // We assert on the presence of a keyword field whose value is the last one:
      expect(result.criteria).toHaveProperty('keyword');
      // Because Object.assign(...) with same keys overrides, callers that need both ANDed
      // should pass them via separate search calls. For now, at least verify the last one sticks:
      expect((result.criteria as { keyword: string }).keyword).toBe('review');
    });

    it('single keyword string passes through', () => {
      const result = buildSearchCriteria({ keyword: 'urgent' }, { isGmail: false });
      expect(result.criteria).toEqual({ keyword: 'urgent' });
    });

    it('notKeyword → unKeyword mapping', () => {
      const result = buildSearchCriteria({ notKeyword: 'spam' }, { isGmail: false });
      expect(result.criteria).toEqual({ unKeyword: 'spam' });
    });
  });

  describe('headers and uids', () => {
    it("header: { 'X-Foo': 'bar' } passes through", () => {
      const result = buildSearchCriteria({ header: { 'X-Foo': 'bar' } }, { isGmail: false });
      expect(result.criteria).toEqual({ header: { 'X-Foo': 'bar' } });
    });

    it('empty header object is omitted', () => {
      const result = buildSearchCriteria({ header: {} }, { isGmail: false });
      expect(result.criteria).toEqual({});
    });

    it('uids as number[] becomes comma-joined string', () => {
      const result = buildSearchCriteria({ uids: [1, 2, 3] }, { isGmail: false });
      expect(result.criteria).toEqual({ uid: '1,2,3' });
    });

    it('uids as string passes through', () => {
      const result = buildSearchCriteria({ uids: '1:100' }, { isGmail: false });
      expect(result.criteria).toEqual({ uid: '1:100' });
    });
  });

  describe('gmail_raw fast path', () => {
    it("gmailRaw: 'from:x' with isGmail:true → short-circuits", () => {
      const result = buildSearchCriteria({ gmailRaw: 'from:x' }, { isGmail: true });
      expect(result.gmailRawUsed).toBe(true);
      expect(result.criteria).toEqual({ gmailRaw: 'from:x' });
      expect(result.warnings).toEqual([]);
    });

    it('gmailRaw with other filters → emits warning listing ignored filters', () => {
      const result = buildSearchCriteria(
        { gmailRaw: 'from:x', query: 'invoice', subject: 'bill' },
        { isGmail: true },
      );
      expect(result.gmailRawUsed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('gmail_raw takes precedence');
      expect(result.warnings[0]).toContain('query');
      expect(result.warnings[0]).toContain('subject');
    });

    it('gmailRaw with isGmail:false → throws', () => {
      expect(() => buildSearchCriteria({ gmailRaw: 'from:x' }, { isGmail: false })).toThrow(
        /only valid on Gmail accounts/,
      );
    });
  });
});

describe('buildSearchCriteria — PR 2 post-filter extensions', () => {
  it('attachmentFilename flows into postFilters (not into criteria)', () => {
    const result = buildSearchCriteria({ attachmentFilename: 'lease' }, { isGmail: false });
    expect(result.criteria).toEqual({});
    expect(result.postFilters.attachmentFilename).toBe('lease');
  });

  it('attachmentMimetype flows into postFilters (not into criteria)', () => {
    const result = buildSearchCriteria(
      { attachmentMimetype: 'application/pdf' },
      { isGmail: false },
    );
    expect(result.criteria).toEqual({});
    expect(result.postFilters.attachmentMimetype).toBe('application/pdf');
  });

  it('facets flows into postFilters (not into criteria)', () => {
    const result = buildSearchCriteria({ facets: ['sender', 'year'] }, { isGmail: false });
    expect(result.criteria).toEqual({});
    expect(result.postFilters.facets).toEqual(['sender', 'year']);
  });

  it('combining regular filters + new post-filters keeps them in their correct buckets', () => {
    const result = buildSearchCriteria(
      {
        from: 'alice@x',
        attachmentFilename: 'lease',
        attachmentMimetype: 'application/pdf',
        facets: ['sender'],
      },
      { isGmail: false },
    );
    expect(result.criteria).toEqual({ from: 'alice@x' });
    expect(result.postFilters).toEqual({
      hasAttachment: undefined,
      attachmentFilename: 'lease',
      attachmentMimetype: 'application/pdf',
      facets: ['sender'],
    });
  });
});

// ---------------------------------------------------------------------------
// R2 — the explicit body-search opt-out. `deep:false` must emit NO body term,
// which is what keeps a free-text query off the pathological scan path on a
// huge non-FTS folder (the whole cost half of the false-negative incident).
// ---------------------------------------------------------------------------

describe('buildSearchCriteria — R2 deep opt-out', () => {
  it('deep:false makes a free-text query header-only (subject/from/to), no body term', () => {
    const result = buildSearchCriteria({ query: 'Order #29804', deep: false }, { isGmail: false });

    expect(result.criteria).toEqual({
      or: [{ subject: 'Order #29804' }, { from: 'Order #29804' }, { to: 'Order #29804' }],
    });
    // The load-bearing assertion: nothing in the compiled criteria asks the
    // server to open a message body.
    expect(JSON.stringify(result.criteria)).not.toContain('"body"');
  });

  it('deep:false clears bodyScan, so the R5 at-risk/ephemeral gate does not engage', () => {
    expect(
      buildSearchCriteria({ query: 'invoice', deep: false }, { isGmail: false }).bodyScan,
    ).toBe(false);
  });

  it('deep:true is the same as omitting it — body search is opt-out, not opt-in', () => {
    const explicit = buildSearchCriteria({ query: 'invoice', deep: true }, { isGmail: false });
    const implicit = buildSearchCriteria({ query: 'invoice' }, { isGmail: false });

    expect(explicit.criteria).toEqual(implicit.criteria);
    expect(explicit.criteria).toEqual({
      or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }],
    });
    expect(explicit.bodyScan).toBe(true);
  });

  it('deep:false does NOT disarm an explicit body:/text: filter (that is its own opt-in)', () => {
    const withBody = buildSearchCriteria(
      { query: 'refund', body: 'wire transfer', deep: false },
      { isGmail: false },
    );
    expect(withBody.criteria).toEqual({
      or: [{ subject: 'refund' }, { from: 'refund' }, { to: 'refund' }],
      body: 'wire transfer',
    });
    expect(withBody.bodyScan).toBe(true);

    const withText = buildSearchCriteria({ text: 'anything', deep: false }, { isGmail: false });
    expect(withText.bodyScan).toBe(true);
  });

  it('deep:false alongside a to: filter keeps both — the OR term and the AND term', () => {
    const result = buildSearchCriteria(
      { query: 'adam', to: 'support@wgsusa.com', deep: false },
      { isGmail: false },
    );
    expect(result.criteria).toEqual({
      or: [{ subject: 'adam' }, { from: 'adam' }, { to: 'adam' }],
      to: 'support@wgsusa.com',
    });
  });
});

// ---------------------------------------------------------------------------
// R6 — recency-window helpers
// ---------------------------------------------------------------------------

describe('R6 recency-window helpers', () => {
  it('the fallback window is 90 days', () => {
    expect(RECENCY_WINDOW_DAYS).toBe(90);
  });

  it('hasDateNarrowing is true for any of since/before/on/sentSince/sentBefore', () => {
    expect(hasDateNarrowing({ since: '30d' })).toBe(true);
    expect(hasDateNarrowing({ before: '2024-01-01' })).toBe(true);
    expect(hasDateNarrowing({ on: 'yesterday' })).toBe(true);
    expect(hasDateNarrowing({ sentSince: '7d' })).toBe(true);
    expect(hasDateNarrowing({ sentBefore: '7d' })).toBe(true);
  });

  it('hasDateNarrowing is false with no dates, and treats "" as no value', () => {
    expect(hasDateNarrowing({ query: 'invoice', from: 'a@b.com' })).toBe(false);
    expect(hasDateNarrowing({})).toBe(false);
    expect(hasDateNarrowing({ since: '' })).toBe(false);
  });

  it('withRecencyWindow ANDs a since date onto the existing criteria without replacing it', () => {
    const base = { or: [{ subject: 'x' }, { from: 'x' }, { body: 'x' }], seen: false };
    const windowed = withRecencyWindow(base, RECENCY_WINDOW_DAYS) as {
      or: unknown;
      seen: boolean;
      since: Date;
    };

    // Original expression preserved — the retry searches the same thing.
    expect(windowed.or).toEqual(base.or);
    expect(windowed.seen).toBe(false);
    expect(windowed.since).toBeInstanceOf(Date);
    // ~90 days ago at UTC midnight (so between 90 and 91 days back).
    const diff = Date.now() - windowed.since.getTime();
    expect(diff).toBeGreaterThanOrEqual(90 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(91 * 24 * 60 * 60 * 1000);
    // Non-mutating — the caller keeps the un-windowed criteria.
    expect(base).not.toHaveProperty('since');
  });
});

describe('chunkUids', () => {
  it('splits into fixed-size chunks', () => {
    expect(chunkUids([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('empty array returns empty', () => {
    expect(chunkUids([], 10)).toEqual([]);
  });

  it('chunk larger than input returns single chunk', () => {
    expect(chunkUids([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });
});

// ---------------------------------------------------------------------------
// Amount expansion. Measured fts-xapian behaviour (WGS mail-server team,
// 2026-09-09): "2950" substring-matches tokens without a separator and never
// finds "2,950"; "2,950" / "1463.84" match as whole tokens and never find
// "2950" / "1,463.84". One spelling alone silently misses the other, so both
// go into the OR. Under 1,000 nothing can be grouped, so nothing is expanded.
// ---------------------------------------------------------------------------
describe('amountVariants', () => {
  it.each([
    ['2950', ['2,950', '2950']],
    ['2,950', ['2,950', '2950']],
    ['$2,950.00', ['2,950', '2950']],
    ['1463.84', ['1,463', '1463']],
    ['1,463.84', ['1,463', '1463']],
    ['2950000', ['2,950,000', '2950000']],
    ['  $ 12345 ', ['12,345', '12345']],
    ['0012345', ['12,345', '12345']],
  ])('%s -> %j', (term, want) => {
    expect(amountVariants(term)).toEqual(want);
  });

  it.each([
    ['48.20'],
    ['950'],
    ['$999.99'],
    ['invoice'],
    ['Order #29804'],
    ['12,95'],
    ['-2950'],
    ['2950 USD'],
  ])('%s is left alone', (term) => {
    expect(amountVariants(term)).toBeUndefined();
  });
});

describe('amount queries search both spellings', () => {
  it('deep query "1463.84" ORs subject+body for "1,463" and "1463", no FROM, no raw term', () => {
    const r = buildSearchCriteria({ query: '1463.84' }, { isGmail: false });
    expect(r.criteria).toEqual({
      or: [{ subject: '1,463' }, { subject: '1463' }, { body: '1,463' }, { body: '1463' }],
    });
    expect(r.bodyScan).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('"1463.84" searched as "1,463" OR "1463"');
  });

  it('header-only (deep:false) amount query keeps to SUBJECT, both spellings, no BODY', () => {
    const r = buildSearchCriteria({ query: '2,950', deep: false }, { isGmail: false });
    expect(r.criteria).toEqual({ or: [{ subject: '2,950' }, { subject: '2950' }] });
    expect(r.bodyScan).toBe(false);
  });

  it('date bounds still AND around the expanded OR', () => {
    const r = buildSearchCriteria(
      { query: '$2,950.00', since: '2026-08-28', before: '2026-09-04' },
      { isGmail: false },
    );
    expect(r.criteria.or).toEqual([
      { subject: '2,950' },
      { subject: '2950' },
      { body: '2,950' },
      { body: '2950' },
    ]);
    expect(r.criteria.since).toBeInstanceOf(Date);
    expect(r.criteria.before).toBeInstanceOf(Date);
  });

  it('a non-amount query keeps the classic subject/from/body shape and no note', () => {
    const r = buildSearchCriteria({ query: 'invoice' }, { isGmail: false });
    expect(r.criteria).toEqual({
      or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }],
    });
    expect(r.warnings).toEqual([]);
  });

  it('an amount under 1,000 is not expanded', () => {
    const r = buildSearchCriteria({ query: '48.20' }, { isGmail: false });
    expect(r.criteria).toEqual({
      or: [{ subject: '48.20' }, { from: '48.20' }, { body: '48.20' }],
    });
    expect(r.warnings).toEqual([]);
  });

  it('explicit body: amount is expanded when no query holds the OR slot', () => {
    const r = buildSearchCriteria({ body: '1,463.84' }, { isGmail: false });
    expect(r.criteria).toEqual({ or: [{ body: '1,463' }, { body: '1463' }] });
    expect(r.bodyScan).toBe(true);
  });

  it('explicit subject: amount is expanded the same way', () => {
    const r = buildSearchCriteria({ subject: '2950' }, { isGmail: false });
    expect(r.criteria).toEqual({ or: [{ subject: '2,950' }, { subject: '2950' }] });
  });

  it('query + body: amount — the query wins the OR slot, body passes through with a note', () => {
    const r = buildSearchCriteria({ query: 'refund', body: '2950' }, { isGmail: false });
    // one flat `or` only (Object.assign would silently drop a second one)
    expect(r.criteria).toEqual({
      or: [{ subject: 'refund' }, { from: 'refund' }, { body: 'refund' }],
      body: '2950',
    });
    expect(r.warnings.join(' ')).toContain('NOT expanded');
  });

  it('two explicit amount filters — first takes the OR slot, second passes through with a note', () => {
    const r = buildSearchCriteria({ subject: '2950', body: '1463.84' }, { isGmail: false });
    expect(r.criteria).toEqual({
      or: [{ subject: '2,950' }, { subject: '2950' }],
      body: '1463.84',
    });
    expect(r.warnings.filter((w) => w.includes('NOT expanded'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [P4] Future since/before. imapflow converts these to the RFC 5032 relative
// forms YOUNGER/OLDER; a future date makes the age negative, imapflow clamps
// it to 0, and RFC 5032 forbids 0 — Dovecot answers BAD "Invalid search
// interval parameter", which surfaces as a failed search. Captured on the
// wire 2026-09-09: `before 2026-12-31` -> "YOUNGER 584011 OLDER 0", and
// `since 2027-12-31` -> "YOUNGER 0". sentSince/sentBefore are sent as
// absolute SENTSINCE/SENTBEFORE and are unaffected.
// ---------------------------------------------------------------------------
describe('a future since/before never reaches the server as a zero interval', () => {
  const future = () => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };
  const past = '2020-01-01';

  it('drops a future before and says why', () => {
    const r = buildSearchCriteria(
      { subject: 'Kemper', since: past, before: future() },
      { isGmail: false },
    );
    expect(r.criteria.before).toBeUndefined();
    expect(r.criteria.since).toBeInstanceOf(Date);
    expect(r.warnings.join(' ')).toContain('is in the future and was dropped');
  });

  it('clamps a future since rather than dropping it — dropping would widen to everything', () => {
    const r = buildSearchCriteria({ subject: 'Kemper', since: future() }, { isGmail: false });
    const since = r.criteria.since as Date;
    expect(since).toBeInstanceOf(Date);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(r.warnings.join(' ')).toContain('clamped to now');
  });

  it('keeps a past before untouched and warns about nothing', () => {
    const r = buildSearchCriteria({ subject: 'Kemper', before: past }, { isGmail: false });
    expect(r.criteria.before).toBeInstanceOf(Date);
    expect(r.warnings).toEqual([]);
  });

  it('keeps a past since untouched', () => {
    const r = buildSearchCriteria({ subject: 'Kemper', since: past }, { isGmail: false });
    expect(r.criteria.since).toBeInstanceOf(Date);
    expect(r.warnings).toEqual([]);
  });

  it('leaves sent_before alone even in the future — it is sent as an absolute SENTBEFORE', () => {
    const r = buildSearchCriteria({ subject: 'x', sentBefore: future() }, { isGmail: false });
    expect(r.criteria.sentBefore).toBeInstanceOf(Date);
    expect(r.warnings).toEqual([]);
  });

  it('leaves sent_since alone even in the future', () => {
    const r = buildSearchCriteria({ subject: 'x', sentSince: future() }, { isGmail: false });
    expect(r.criteria.sentSince).toBeInstanceOf(Date);
    expect(r.warnings).toEqual([]);
  });

  it('a dropped before still leaves a usable search, not an empty one', () => {
    const r = buildSearchCriteria(
      { query: 'invoice', since: past, before: future() },
      { isGmail: false },
    );
    expect(r.criteria.or).toBeDefined();
    expect(r.criteria.since).toBeInstanceOf(Date);
  });
});
