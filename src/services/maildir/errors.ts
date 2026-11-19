/**
 * Error types for the raw Maildir tools. Kept in one file so every module
 * (and the tool layer) can tell input mistakes from transport failures.
 */

/* eslint-disable max-classes-per-file -- a small error family, one module */

/** The caller's input is invalid or out of scope; nothing was searched/read. */
export class MaildirInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaildirInputError';
  }
}

/** A message id failed validation (outside root, bad layout, excluded mailbox). */
export class MaildirIdError extends MaildirInputError {
  constructor(message: string) {
    super(message);
    this.name = 'MaildirIdError';
  }
}

/** SSH / sudo / remote-command failure, or an unsafe argument was refused. */
export class MaildirRemoteError extends Error {
  constructor(
    message: string,
    readonly kind: 'ssh_failed' | 'sudo_denied' | 'unsafe_argument',
  ) {
    super(message);
    this.name = 'MaildirRemoteError';
  }
}
