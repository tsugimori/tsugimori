CREATE INDEX `tasks_chat_created` ON `tasks` (`adapter_id`,`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_agent_created` ON `tasks` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_created` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_failed_at` ON `tasks` (coalesce("finished_at", "created_at")) WHERE "tasks"."status" in ('failed', 'delivery-unknown');--> statement-breakpoint
CREATE INDEX `trace_spans_task_started` ON `trace_spans` (json_extract("attrs", '$.taskId'),`started_at`,`id`);