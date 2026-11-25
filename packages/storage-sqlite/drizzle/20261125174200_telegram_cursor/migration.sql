CREATE TABLE `adapter_cursors` (
	`adapter_id` text NOT NULL,
	`stream` text NOT NULL,
	`offset` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `adapter_cursors_pk` PRIMARY KEY(`adapter_id`, `stream`)
);
