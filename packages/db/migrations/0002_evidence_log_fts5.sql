-- FTS5 full-text search over evidence_log.title + body. External-content mode
-- means the virtual table stores no rows of its own; it indexes the columns
-- and the triggers below keep the index in sync with evidence_log.
CREATE VIRTUAL TABLE `evidence_log_fts` USING fts5(
  title,
  body,
  content='evidence_log',
  content_rowid='id'
);
--> statement-breakpoint
CREATE TRIGGER `evidence_log_ai` AFTER INSERT ON `evidence_log` BEGIN
  INSERT INTO evidence_log_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_log_ad` AFTER DELETE ON `evidence_log` BEGIN
  INSERT INTO evidence_log_fts(evidence_log_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_log_au` AFTER UPDATE ON `evidence_log` BEGIN
  INSERT INTO evidence_log_fts(evidence_log_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO evidence_log_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
-- Backfill the FTS index from rows that existed before this migration ran.
-- On a fresh DB this is a no-op; on an upgraded user DB it ensures historical
-- evidence is searchable immediately rather than waiting for each row to be
-- updated. `rebuild` is FTS5's built-in command for external-content tables.
INSERT INTO evidence_log_fts(evidence_log_fts) VALUES ('rebuild');
