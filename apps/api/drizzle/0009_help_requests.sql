CREATE TABLE "help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"clear_reason" text,
	"cleared_by" uuid,
	CONSTRAINT "help_requests_clear_reason" CHECK ("help_requests"."clear_reason" in ('teacher', 'device', 'lesson_ended', 'device_left')),
	CONSTRAINT "help_requests_cleared_consistent" CHECK (("help_requests"."cleared_at" is null) = ("help_requests"."clear_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_lesson_fk" FOREIGN KEY ("site_id","lesson_id") REFERENCES "public"."lessons"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_room_fk" FOREIGN KEY ("site_id","room_id") REFERENCES "public"."rooms"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "help_requests_open_device" ON "help_requests" USING btree ("lesson_id","device_id") WHERE "help_requests"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "help_requests_open_by_device" ON "help_requests" USING btree ("device_id") WHERE "help_requests"."cleared_at" is null;