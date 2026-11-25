CREATE TABLE `setup_runs` (
	`id` text PRIMARY KEY,
	`category` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`step` integer NOT NULL,
	`draft` text NOT NULL,
	`lease` text,
	`lease_until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup_secrets` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	CONSTRAINT `setup_secrets_pk` PRIMARY KEY(`adapter_id`, `chat_id`, `message_id`)
);
