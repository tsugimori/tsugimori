CREATE TABLE `unavailable_command_scopes` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`scope` text NOT NULL,
	CONSTRAINT `unavailable_command_scopes_pk` PRIMARY KEY(`adapter_id`, `chat_id`, `bot_id`, `scope`)
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `allowlist_configured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `migrated_to_chat_id` text;