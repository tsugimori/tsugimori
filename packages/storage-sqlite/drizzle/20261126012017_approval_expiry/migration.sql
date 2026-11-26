ALTER TABLE `approvals` DROP COLUMN `once_only`;--> statement-breakpoint
UPDATE `approvals`
SET `expires_at` = min(
  coalesce(
    `expires_at` - 120000,
    (SELECT coalesce(`started_at`, `created_at`) FROM `tasks` WHERE `tasks`.`id` = `approvals`.`task_id`)
  ) + 86400000,
  coalesce(json_extract(`continuation`, '$.change.schedule.nextDueAt'), 9223372036854775807)
)
WHERE `status` = 'pending';
