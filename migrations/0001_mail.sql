-- Inbox for mail.liamjc.dev. Apply: npx wrangler d1 migrations apply nexus-mail --remote
CREATE TABLE mail (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mail_received ON mail (received_at DESC);
