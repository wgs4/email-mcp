import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types/index.js';

export interface IConnectionManager {
  getAccount: (name: string) => AccountConfig;
  getAccountNames: () => string[];
  getImapClient: (accountName: string) => Promise<ImapFlow>;
  /** D3/R3: a throwaway, UNCACHED IMAP connection for a bounded deep search. */
  createEphemeralImapClient: (accountName: string) => Promise<ImapFlow>;
  getSmtpTransport: (accountName: string, options?: { verify?: boolean }) => Promise<Transporter>;
  closeAll: () => Promise<void>;
}
