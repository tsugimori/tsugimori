ALTER TABLE `approvals` ADD `requested_at` integer;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `approval_id` text;