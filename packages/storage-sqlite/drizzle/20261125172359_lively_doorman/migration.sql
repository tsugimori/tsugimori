CREATE TABLE `agent_sessions` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model` text NOT NULL,
	`session_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`seen_after` text NOT NULL,
	CONSTRAINT `agent_sessions_pk` PRIMARY KEY(`adapter_id`, `chat_id`, `agent_id`, `model`)
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`requester` text NOT NULL,
	`prompt_message_id` text,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	CONSTRAINT `fk_approvals_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`allowlisted` integer DEFAULT false NOT NULL,
	`agent_id` text,
	`model` text,
	`session_agent_id` text,
	`session_model` text,
	CONSTRAINT `chats_pk` PRIMARY KEY(`adapter_id`, `chat_id`)
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` text PRIMARY KEY,
	`action` text NOT NULL,
	`scope` text NOT NULL,
	`mode` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_to` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`message_id` text NOT NULL,
	`direction` text NOT NULL,
	`user_id` text,
	`reply_to` text,
	`thread_id` text,
	`text` text NOT NULL,
	`raw` text,
	`deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`adapter_id` text PRIMARY KEY,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`adapter_id` text PRIMARY KEY,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` text PRIMARY KEY,
	`source_message_id` text NOT NULL,
	`status` text NOT NULL,
	`agent_id` text,
	`model` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `trace_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`attrs` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`adapter_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display` text,
	CONSTRAINT `users_pk` PRIMARY KEY(`adapter_id`, `user_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_prompt` ON `approvals` (`adapter_id`,`chat_id`,`prompt_message_id`);--> statement-breakpoint
CREATE INDEX `approvals_task` ON `approvals` (`task_id`,`status`);--> statement-breakpoint
CREATE INDEX `grants_scope` ON `grants` (`adapter_id`,`chat_id`,`granted_to`,`action`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_platform_id` ON `messages` (`adapter_id`,`chat_id`,`direction`,`message_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_sequence` ON `messages` (`adapter_id`,`chat_id`,`seq`);--> statement-breakpoint
CREATE INDEX `trace_spans_started_at` ON `trace_spans` (`started_at`);