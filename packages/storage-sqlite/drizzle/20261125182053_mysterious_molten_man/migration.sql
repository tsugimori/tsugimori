CREATE TABLE `previews` (
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`id` text PRIMARY KEY,
	`opened_by` text NOT NULL,
	`port` integer NOT NULL,
	`provider` text NOT NULL,
	`url` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	`closed_reason` text
);
--> statement-breakpoint
CREATE INDEX `previews_open` ON `previews` (`closed_at`,`adapter_id`);