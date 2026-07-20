/**
 * Draft supersession error + hint (design §7). Lives in its own module so
 * imap.service.ts stays within the one-class-per-file lint rule, and so the
 * tool/SMTP layers can import the error without pulling the whole IMAP service.
 */

/** Structured hint carried when a draft UID has been superseded. */
export interface SupersessionHint {
  newestUid: number;
  newestDate: string;
  attachmentDiff: { filename: string; presentOnNewest: boolean }[];
}

/** Thrown when an operation targets a draft UID that has been superseded. */
export class SupersededDraftError extends Error {
  constructor(
    message: string,
    readonly hint: SupersessionHint,
  ) {
    super(message);
    this.name = 'SupersededDraftError';
  }
}
