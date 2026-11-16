-- The mailbox moved to the owner's Debian box (NexusBackend mail/). D1 only holds incoming
-- mail while Debian is unreachable; the cron trigger hands it over and deletes it.
DROP TABLE IF EXISTS mail;
CREATE TABLE inbound_queue (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  raw BLOB NOT NULL
);
