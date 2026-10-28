CREATE TABLE "device_capabilities" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"reported_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid,
	"hostname" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"key_fingerprint" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_signed_ts" bigint,
	"retired_at" timestamp with time zone,
	CONSTRAINT "devices_key_fingerprint" UNIQUE("key_fingerprint"),
	CONSTRAINT "devices_org_id" UNIQUE("organization_id","id"),
	CONSTRAINT "devices_site_id" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"room_id" uuid,
	"token_hash" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"device_id" uuid,
	CONSTRAINT "enrollments_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "enrollments_device" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "mesh_bindings" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"mesh_instance_id" text NOT NULL,
	"mesh_domain_id" text NOT NULL,
	"mesh_node_id" text NOT NULL,
	"bound_by" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mesh_bindings_node" UNIQUE("mesh_instance_id","mesh_domain_id","mesh_node_id")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_org_required";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "mesh_domain_id" text;--> statement-breakpoint
ALTER TABLE "device_capabilities" ADD CONSTRAINT "device_capabilities_device_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "public"."devices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_room_fk" FOREIGN KEY ("site_id","room_id") REFERENCES "public"."rooms"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_room_fk" FOREIGN KEY ("site_id","room_id") REFERENCES "public"."rooms"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_creator_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesh_bindings" ADD CONSTRAINT "mesh_bindings_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mesh_bindings" ADD CONSTRAINT "mesh_bindings_org_fk" FOREIGN KEY ("organization_id","device_id") REFERENCES "public"."devices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_site_room" ON "devices" USING btree ("site_id","room_id");--> statement-breakpoint
CREATE INDEX "enrollments_site_created" ON "enrollments" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sites_mesh_domain" ON "sites" USING btree ("mesh_domain_id") WHERE "sites"."mesh_domain_id" is not null;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_required" CHECK ("audit_events"."organization_id" is not null or "audit_events"."action" like 'auth.%' or "audit_events"."action" = 'device.claim');