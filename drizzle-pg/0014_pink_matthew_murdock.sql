CREATE TABLE "audit_dispatch_leases" (
	"slot" integer PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"origin" text NOT NULL,
	"acquired_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "audit_dispatch_leases_audit_id_unique" UNIQUE("audit_id"),
	CONSTRAINT "audit_dispatch_leases_origin_unique" UNIQUE("origin")
);
--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ADD COLUMN "provider_version" text DEFAULT 'open-seo-audit-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ADD COLUMN "lighthouse_version" text;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ADD COLUMN "actual_cost_usd" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ADD COLUMN "created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "provider_version" text DEFAULT 'open-seo-audit-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "workflow_started_at" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "crawl_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "actual_cost_usd" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "raw_delete_after" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "raw_deleted_at" text;--> statement-breakpoint
ALTER TABLE "audit_dispatch_leases" ADD CONSTRAINT "audit_dispatch_leases_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_dispatch_leases_origin_idx" ON "audit_dispatch_leases" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "audits_origin_status_idx" ON "audits" USING btree ("origin","status");--> statement-breakpoint
CREATE INDEX "audits_raw_delete_after_idx" ON "audits" USING btree ("raw_delete_after");--> statement-breakpoint
CREATE UNIQUE INDEX "audits_project_idempotency_uidx" ON "audits" USING btree ("project_id","idempotency_key");