CREATE TABLE `chat_workspace_settings` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`settings` text NOT NULL,
	CONSTRAINT `chat_workspace_settings_pk` PRIMARY KEY(`adapter_id`, `chat_id`)
);
