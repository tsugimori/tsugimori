ALTER TABLE `chats` RENAME COLUMN `private_since` TO `incognito_id`;--> statement-breakpoint
ALTER TABLE `messages` ADD `incognito_id` integer;--> statement-breakpoint
UPDATE `messages` SET `incognito_id` = `chats`.`incognito_id`
FROM `chats`
WHERE `chats`.`adapter_id` = `messages`.`adapter_id`
  AND `chats`.`chat_id` = `messages`.`chat_id`
  AND `messages`.`seq` >= `chats`.`incognito_id`;
