CREATE TABLE `evidence_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`integration` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`citation_url` text,
	`title` text,
	`body` text,
	`payload_json` text NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`first_seen_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_log_integration_kind_idx` ON `evidence_log` (`integration`,`kind`);--> statement-breakpoint
CREATE INDEX `evidence_log_integration_occurred_at_ms_idx` ON `evidence_log` (`integration`,`occurred_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_log_integration_external_id_unique` ON `evidence_log` (`integration`,`external_id`);--> statement-breakpoint
CREATE TABLE `identity_graph` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text NOT NULL,
	`integration` text NOT NULL,
	`external_id` text NOT NULL,
	`username` text,
	`display_name` text,
	`profile_url` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_graph_canonical_id_idx` ON `identity_graph` (`canonical_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_graph_integration_external_id_unique` ON `identity_graph` (`integration`,`external_id`);--> statement-breakpoint
CREATE TABLE `integration_state` (
	`integration` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_poll_started_at_ms` integer,
	`last_poll_completed_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'default' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "workspaces_single_row" CHECK("workspaces"."id" = 1)
);
