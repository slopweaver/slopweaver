CREATE TABLE `integration_tokens` (
	`integration` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`account_label` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
