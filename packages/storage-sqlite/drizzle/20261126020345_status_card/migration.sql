ALTER TABLE `chat_summaries` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `approvals_pending` ON `approvals` (`status`,`expires_at`,`adapter_id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `trace_spans_session` ON `trace_spans` (json_extract("attrs", '$.sessionScope'),`id`) WHERE json_extract("trace_spans"."attrs", '$.sessionScope') is not null;