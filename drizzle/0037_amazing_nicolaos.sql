CREATE TABLE `audit_dispatch_leases` (
	`slot` integer PRIMARY KEY NOT NULL,
	`audit_id` text NOT NULL,
	`origin` text NOT NULL,
	`acquired_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dispatch_leases_audit_id_unique` ON `audit_dispatch_leases` (`audit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dispatch_leases_origin_unique` ON `audit_dispatch_leases` (`origin`);--> statement-breakpoint
CREATE INDEX `audit_dispatch_leases_origin_idx` ON `audit_dispatch_leases` (`origin`);--> statement-breakpoint
ALTER TABLE `audit_lighthouse_results` ADD `provider_version` text DEFAULT 'open-seo-audit-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_lighthouse_results` ADD `lighthouse_version` text;--> statement-breakpoint
ALTER TABLE `audit_lighthouse_results` ADD `actual_cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_lighthouse_results` ADD `created_at` text DEFAULT (current_timestamp) NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `provider_version` text DEFAULT 'open-seo-audit-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `workflow_started_at` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `crawl_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `actual_cost_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audits` ADD `raw_delete_after` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `raw_deleted_at` text;--> statement-breakpoint
CREATE INDEX `audits_origin_status_idx` ON `audits` (`origin`,`status`);--> statement-breakpoint
CREATE INDEX `audits_raw_delete_after_idx` ON `audits` (`raw_delete_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `audits_project_idempotency_uidx` ON `audits` (`project_id`,`idempotency_key`);