CREATE TABLE `indexed_stickers` (
	`set_name` text NOT NULL,
	`unique_id` text NOT NULL,
	`emoji` text,
	`format` text NOT NULL,
	`description` text NOT NULL,
	CONSTRAINT `indexed_stickers_pk` PRIMARY KEY(`set_name`, `unique_id`),
	CONSTRAINT `fk_indexed_stickers_set_name_sticker_sets_name_fk` FOREIGN KEY (`set_name`) REFERENCES `sticker_sets`(`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sticker_files` (
	`bot_id` text NOT NULL,
	`set_name` text NOT NULL,
	`unique_id` text NOT NULL,
	`file_id` text NOT NULL,
	CONSTRAINT `sticker_files_pk` PRIMARY KEY(`bot_id`, `set_name`, `unique_id`),
	CONSTRAINT `fk_sticker_files_set_name_unique_id_indexed_stickers_set_name_unique_id_fk` FOREIGN KEY (`set_name`,`unique_id`) REFERENCES `indexed_stickers`(`set_name`,`unique_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sticker_sets` (
	`name` text PRIMARY KEY,
	`blocked` integer DEFAULT false NOT NULL,
	`source_adapter_id` text,
	`source_chat_id` text
);
