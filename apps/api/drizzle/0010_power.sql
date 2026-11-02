CREATE TABLE "power_action_targets" (
	"action_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"sent_at" timestamp with time zone,
	"offline_seen_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "power_action_targets_pk" PRIMARY KEY("action_id","device_id"),
	CONSTRAINT "power_action_targets_status" CHECK ("power_action_targets"."status" in ('pending', 'sent', 'succeeded', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "power_action_targets_reason" CHECK (("power_action_targets"."status" = 'failed') = ("power_action_targets"."reason" is not null) and ("power_action_targets"."reason" is null or "power_action_targets"."reason" in ('unbound', 'device_offline', 'wake_unsupported', 'node_missing', 'upstream_unavailable'))),
	CONSTRAINT "power_action_targets_sent" CHECK ("power_action_targets"."status" <> 'sent' or "power_action_targets"."sent_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "power_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"scope" jsonb NOT NULL,
	"site_ids" uuid[] NOT NULL,
	"status" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"schedule_id" uuid,
	"requested_by" uuid,
	"next_wave_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "power_actions_schedule_run" UNIQUE("schedule_id","run_at"),
	CONSTRAINT "power_actions_type" CHECK ("power_actions"."type" in ('shutdown', 'reboot', 'sleep', 'wake')),
	CONSTRAINT "power_actions_status" CHECK ("power_actions"."status" in ('scheduled', 'running', 'completed', 'cancelled', 'missed'))
);
--> statement-breakpoint
CREATE TABLE "power_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"scope" jsonb NOT NULL,
	"site_ids" uuid[] NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"time_of_day" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "power_schedules_type" CHECK ("power_schedules"."type" in ('shutdown', 'reboot', 'sleep', 'wake')),
	CONSTRAINT "power_schedules_time" CHECK ("power_schedules"."time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "power_schedules_next_run" CHECK ("power_schedules"."enabled" or "power_schedules"."next_run_at" is null)
);
--> statement-breakpoint
ALTER TABLE "power_action_targets" ADD CONSTRAINT "power_action_targets_action_fk" FOREIGN KEY ("action_id") REFERENCES "public"."power_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_action_targets" ADD CONSTRAINT "power_action_targets_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_actions" ADD CONSTRAINT "power_actions_schedule_id_power_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."power_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_actions" ADD CONSTRAINT "power_actions_requester_fk" FOREIGN KEY ("organization_id","requested_by") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_schedules" ADD CONSTRAINT "power_schedules_creator_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "power_action_targets_open" ON "power_action_targets" USING btree ("action_id") WHERE "power_action_targets"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "power_actions_status_run" ON "power_actions" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "power_actions_org_created" ON "power_actions" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "power_schedules_due" ON "power_schedules" USING btree ("next_run_at") WHERE "power_schedules"."enabled";