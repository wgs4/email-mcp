/**
 * copy_email's cross-account guard.
 *
 * The two copy tools mirror the two move tools, so each has to send the other's
 * case to the right place: cross_account_copy refuses a same-account request
 * with "use copy_email" (covered in routing/cross-account-copy.test.ts), and
 * copy_email refuses a cross-account request with "use cross_account_copy".
 */

import { crossAccountCopyRefusal } from './manage.tool.js';

describe('crossAccountCopyRefusal', () => {
  it('allows a single-account copy (no destinationAccount given)', () => {
    expect(crossAccountCopyRefusal('wgs-usa')).toBeNull();
  });

  it('allows a copy whose destinationAccount matches the source account', () => {
    expect(crossAccountCopyRefusal('wgs-usa', 'wgs-usa')).toBeNull();
  });

  it('refuses a cross-account copy and points at cross_account_copy', () => {
    const refusal = crossAccountCopyRefusal('wgs-usa', 'khara');

    expect(refusal).not.toBeNull();
    expect(refusal).toContain('cross_account_copy');
    expect(refusal).toContain('wgs-usa');
    expect(refusal).toContain('khara');
  });

  it('treats an empty destinationAccount as "not supplied"', () => {
    expect(crossAccountCopyRefusal('wgs-usa', '')).toBeNull();
  });
});
