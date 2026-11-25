CREATE TABLE `schedule_runs` (
	`schedule_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`finished_at` integer,
	`started_at` integer NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT `schedule_runs_pk` PRIMARY KEY(`schedule_id`, `due_at`),
	CONSTRAINT `fk_schedule_runs_schedule_id_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` text PRIMARY KEY,
	`action` text NOT NULL,
	`address` text NOT NULL,
	`created_by` text NOT NULL,
	`delivery_approved_by` text,
	`mentions` text NOT NULL,
	`missed` text NOT NULL,
	`next_due_at` integer,
	`status` text NOT NULL,
	`target` text NOT NULL,
	`timezone` text NOT NULL,
	`trigger` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `approvals` ADD `approver_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `once_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `schedules_due` ON `schedules` (`status`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `schedules_creator` ON `schedules` (`adapter_id`,`created_by`,`status`);--> statement-breakpoint
CREATE INDEX `schedules_chat` ON `schedules` (`adapter_id`,`chat_id`);