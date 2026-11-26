ALTER TABLE `agent_sessions` ADD `scope_chat_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `migrated_prompt` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `migrated_from_chat_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_chat_id` text;--> statement-breakpoint
DROP INDEX `messages_platform_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_platform_id` ON `messages` (`adapter_id`,`chat_id`,`direction`,`message_id`,`migrated_from_chat_id`);