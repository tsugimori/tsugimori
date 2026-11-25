CREATE TABLE `chat_summaries` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`revision` integer NOT NULL,
	`text` text NOT NULL,
	`through_seq` integer NOT NULL,
	CONSTRAINT `chat_summaries_pk` PRIMARY KEY(`adapter_id`, `chat_id`)
);
