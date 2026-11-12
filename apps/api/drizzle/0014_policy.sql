CREATE TABLE "policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"layer" text NOT NULL,
	"lesson_id" uuid,
	"version_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policy_assignments_layer" CHECK ("policy_assignments"."layer" in ('baseline', 'lesson')),
	CONSTRAINT "policy_assignments_scope" CHECK (("policy_assignments"."layer" = 'baseline' and "policy_assignments"."lesson_id" is null) or ("policy_assignments"."layer" = 'lesson' and "policy_assignments"."lesson_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "policy_receipts" (
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"layer" text NOT NULL,
	"reporter" text NOT NULL,
	"applied" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"rules" jsonb NOT NULL,
	"repaired" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policy_receipts_pk" PRIMARY KEY("device_id","layer","reporter"),
	CONSTRAINT "policy_receipts_layer" CHECK ("policy_receipts"."layer" in ('baseline', 'lesson')),
	CONSTRAINT "policy_receipts_reporter" CHECK ("policy_receipts"."reporter" in ('companion', 'helper'))
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"layer" text NOT NULL,
	"lesson_id" uuid,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_from" uuid,
	CONSTRAINT "policy_versions_layer" CHECK ("policy_versions"."layer" in ('baseline', 'lesson')),
	CONSTRAINT "policy_versions_scope" CHECK (("policy_versions"."layer" = 'baseline' and "policy_versions"."lesson_id" is null) or ("policy_versions"."layer" = 'lesson' and "policy_versions"."lesson_id" is not null and "policy_versions"."site_id" is not null)),
	CONSTRAINT "policy_versions_version" CHECK ("policy_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_version_id_policy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_receipts" ADD CONSTRAINT "policy_receipts_device_fk" FOREIGN KEY ("site_id","device_id") REFERENCES "public"."devices"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_lesson_fk" FOREIGN KEY ("site_id","lesson_id") REFERENCES "public"."lessons"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_creator_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_restored_fk" FOREIGN KEY ("restored_from") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;