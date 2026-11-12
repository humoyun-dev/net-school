-- Qo'lda yozilgan migratsiya (drizzle-kit trigger va coalesce ifodali unique indeks chiqara olmaydi).
-- P2c: siyosat versiyalari immutable — o'zgartirish yoki o'chirish DB darajasida rad etiladi (rollback = yangi versiya).
CREATE FUNCTION policy_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy_versions is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER policy_versions_no_update BEFORE UPDATE OR DELETE ON "policy_versions"
  FOR EACH ROW EXECUTE FUNCTION policy_versions_immutable();--> statement-breakpoint
-- Ko'lam ichida versiya raqami unique (site_id/lesson_id null bo'lishi mumkin).
CREATE UNIQUE INDEX "policy_versions_scope_version" ON "policy_versions" USING btree (
  "organization_id", coalesce("site_id", '00000000-0000-0000-0000-000000000000'::uuid), "layer",
  coalesce("lesson_id", '00000000-0000-0000-0000-000000000000'::uuid), "version"
);--> statement-breakpoint
-- Har ko'lamda bitta joriy assignment.
CREATE UNIQUE INDEX "policy_assignments_scope" ON "policy_assignments" USING btree (
  "organization_id", coalesce("site_id", '00000000-0000-0000-0000-000000000000'::uuid), "layer",
  coalesce("lesson_id", '00000000-0000-0000-0000-000000000000'::uuid)
);
