ALTER TABLE "devices" ADD COLUMN "helper_public_key" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "helper_last_signed_ts" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "helper_status" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "helper_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_helper_public_key" UNIQUE("helper_public_key");