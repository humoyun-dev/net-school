CREATE SEQUENCE "public"."control_fencing_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "control_leases" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"fencing" bigint NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "control_leases_session" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "remote_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"closed_by" uuid,
	CONSTRAINT "remote_sessions_id_device" UNIQUE("id","device_id"),
	CONSTRAINT "remote_sessions_mode" CHECK ("remote_sessions"."mode" in ('view', 'control')),
	CONSTRAINT "remote_sessions_status" CHECK ("remote_sessions"."status" in ('opening', 'active', 'closed')),
	CONSTRAINT "remote_sessions_close_reason" CHECK ("remote_sessions"."close_reason" in ('teacher', 'admin', 'lesson_ended', 'device_left', 'lease_expired', 'upstream_failed', 'restart')),
	CONSTRAINT "remote_sessions_closed_consistent" CHECK (("remote_sessions"."status" = 'closed') = ("remote_sessions"."closed_at" is not null and "remote_sessions"."close_reason" is not null) and ("remote_sessions"."closed_at" is not null) = ("remote_sessions"."close_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "control_leases" ADD CONSTRAINT "control_leases_session_fk" FOREIGN KEY ("session_id","device_id") REFERENCES "public"."remote_sessions"("id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_leases" ADD CONSTRAINT "control_leases_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "public"."devices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_lesson_fk" FOREIGN KEY ("site_id","lesson_id") REFERENCES "public"."lessons"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_room_fk" FOREIGN KEY ("site_id","room_id") REFERENCES "public"."rooms"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_actor_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_sessions_open_expires" ON "remote_sessions" USING btree ("expires_at") WHERE "remote_sessions"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "remote_sessions_open_lesson" ON "remote_sessions" USING btree ("lesson_id") WHERE "remote_sessions"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "remote_sessions_open_device" ON "remote_sessions" USING btree ("device_id") WHERE "remote_sessions"."status" <> 'closed';