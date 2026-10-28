CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_targets" (
	"command_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "command_targets_pk" PRIMARY KEY("command_id","device_id"),
	CONSTRAINT "command_targets_status" CHECK ("command_targets"."status" in ('pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "command_targets_reason" CHECK (("command_targets"."status" = 'failed') = ("command_targets"."reason" is not null) and ("command_targets"."reason" is null or "command_targets"."reason" in ('unsupported', 'permission_required', 'error')))
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "commands_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"issued_by" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commands_seq" UNIQUE("seq"),
	CONSTRAINT "commands_type" CHECK ("commands"."type" in ('message.show', 'overlay.lock', 'overlay.unlock'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"lesson_id" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"actor_user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("actor_user_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "lesson_devices" (
	"lesson_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"overlay_locked" boolean DEFAULT false NOT NULL,
	"overlay_seq" bigint,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "lesson_devices_pk" PRIMARY KEY("lesson_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ended_by" uuid,
	CONSTRAINT "lessons_org_id" UNIQUE("organization_id","id"),
	CONSTRAINT "lessons_site_id" UNIQUE("site_id","id"),
	CONSTRAINT "lessons_status" CHECK ("lessons"."status" in ('active', 'ended')),
	CONSTRAINT "lessons_end_reason" CHECK ("lessons"."end_reason" in ('teacher', 'admin', 'timeout')),
	CONSTRAINT "lessons_ended_consistent" CHECK (("lessons"."status" = 'ended') = ("lessons"."ended_at" is not null) and ("lessons"."status" = 'ended') = ("lessons"."end_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_target_fk" FOREIGN KEY ("command_id","device_id") REFERENCES "public"."command_targets"("command_id","device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_targets" ADD CONSTRAINT "command_targets_command_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_targets" ADD CONSTRAINT "command_targets_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "public"."devices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_lesson_fk" FOREIGN KEY ("site_id","lesson_id") REFERENCES "public"."lessons"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_issuer_fk" FOREIGN KEY ("organization_id","issued_by") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_devices" ADD CONSTRAINT "lesson_devices_lesson_fk" FOREIGN KEY ("site_id","lesson_id") REFERENCES "public"."lessons"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_devices" ADD CONSTRAINT "lesson_devices_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_room_fk" FOREIGN KEY ("site_id","room_id") REFERENCES "public"."rooms"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacher_fk" FOREIGN KEY ("organization_id","teacher_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_targets_device_status" ON "command_targets" USING btree ("device_id","status");--> statement-breakpoint
CREATE INDEX "commands_lesson_issued" ON "commands" USING btree ("lesson_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_room_seq" ON "events" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_devices_active" ON "lesson_devices" USING btree ("device_id") WHERE "lesson_devices"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_room_active" ON "lessons" USING btree ("room_id") WHERE "lessons"."status" = 'active';--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("next_attempt_at") WHERE "outbox"."processed_at" is null;