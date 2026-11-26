CREATE INDEX `tasks_status_created_id` ON `tasks` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_adapter_created_id` ON `tasks` (`adapter_id`,`created_at`,`id`);