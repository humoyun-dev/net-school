DROP INDEX "outbox_due";--> statement-breakpoint
CREATE INDEX "command_targets_open" ON "command_targets" USING btree ("command_id") WHERE "command_targets"."status" in ('pending', 'sent', 'acknowledged');--> statement-breakpoint
CREATE INDEX "commands_expires_at" ON "commands" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "events_at" ON "events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbox_processed_at" ON "outbox" USING btree ("processed_at") WHERE "outbox"."processed_at" is not null;--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("next_attempt_at") WHERE "outbox"."processed_at" is null and "outbox"."attempts" < 10;