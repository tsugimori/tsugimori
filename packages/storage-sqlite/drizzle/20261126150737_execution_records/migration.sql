CREATE TABLE `chat_summary_versions` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`revision` integer NOT NULL,
	`text` blob NOT NULL,
	`through_seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `chat_summary_versions_pk` PRIMARY KEY(`adapter_id`, `chat_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `context_blobs` (
	`sha256` text PRIMARY KEY,
	`content` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_edits` (
	`seq` integer NOT NULL,
	`revision` integer NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `message_edits_pk` PRIMARY KEY(`seq`, `revision`),
	CONSTRAINT `fk_message_edits_seq_messages_seq_fk` FOREIGN KEY (`seq`) REFERENCES `messages`(`seq`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`data` blob NOT NULL,
	CONSTRAINT `task_events_pk` PRIMARY KEY(`task_id`, `seq`),
	CONSTRAINT `fk_task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_records` (
	`task_id` text PRIMARY KEY,
	`agent` blob,
	`input` blob,
	`refs` blob NOT NULL,
	`output` blob,
	`outcome` blob NOT NULL,
	`timing` blob NOT NULL,
	`supplements` blob NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`pruned` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_task_records_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `trigger_decisions` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`message_id` text NOT NULL,
	`message_seq` integer,
	`at` integer NOT NULL,
	`triggered` integer NOT NULL,
	`reason` text NOT NULL,
	`task_id` text,
	CONSTRAINT `fk_trigger_decisions_message_seq_messages_seq_fk` FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON DELETE CASCADE,
	CONSTRAINT `fk_trigger_decisions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `raw_z` blob;--> statement-breakpoint
ALTER TABLE `messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `task_records_pruned_created` ON `task_records` (`pruned`,`created_at`);--> statement-breakpoint
CREATE INDEX `trigger_decisions_message` ON `trigger_decisions` (`message_seq`,`id`);--> statement-breakpoint
CREATE INDEX `trigger_decisions_task` ON `trigger_decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `trigger_decisions_adapter` ON `trigger_decisions` (`adapter_id`);
--> statement-breakpoint
INSERT INTO chat_summary_versions (adapter_id, chat_id, revision, text, through_seq, created_at)
SELECT adapter_id, chat_id, revision, json_quote(text), through_seq, coalesce(updated_at, 0)
FROM chat_summaries
WHERE text <> '';
