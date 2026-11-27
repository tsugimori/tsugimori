CREATE TABLE `sticker_descriptions` (
	`platform_kind` text NOT NULL,
	`sticker_id` text NOT NULL,
	`description` text NOT NULL,
	`emoji` text,
	`keywords` text,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `sticker_descriptions_pk` PRIMARY KEY(`platform_kind`, `sticker_id`)
);
