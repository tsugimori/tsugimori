CREATE TABLE `tool_calls` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` text NOT NULL,
	`call_id` text,
	`name` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text,
	`args` text,
	`result` text,
	CONSTRAINT `fk_tool_calls_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `tool_calls_task_seq` ON `tool_calls` (`task_id`,`seq`);