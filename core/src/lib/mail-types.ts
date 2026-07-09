/** Normalized email shapes shared by the Microsoft + Google mail readers. */
export interface MailListItem {
  id: string;          // provider message id
  account_id: string;  // connected_accounts uuid — the handle mail.read uses
  account: string;     // account email (display)
  provider: "microsoft" | "google";
  subject: string;
  from: string;
  date: string;        // ISO
  snippet: string;
  isRead: boolean;
}

export interface MailFull {
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;        // plain text
}
