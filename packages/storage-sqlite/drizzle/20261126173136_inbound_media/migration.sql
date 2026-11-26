ALTER TABLE `message_edits` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `album_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `metadata` text;--> statement-breakpoint
CREATE INDEX `messages_chat_album` ON `messages` (`adapter_id`,`chat_id`,`album_id`,`migrated_from_chat_id`,`seq`) WHERE "messages"."album_id" is not null;--> statement-breakpoint
CREATE INDEX `messages_chat_reply` ON `messages` (`adapter_id`,`chat_id`,`reply_to`,`migrated_from_chat_id`,`seq`) WHERE "messages"."reply_to" is not null;