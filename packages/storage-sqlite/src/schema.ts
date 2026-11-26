import type { ResourceRef } from '@tsugimori/plugin-sdk';
import type {
  ApprovalRecord,
  ChatRecord,
  MessageRecord,
  ScheduleAddress,
  ScheduleRecord,
  ScheduleRun,
  SetupRun,
  StoredGrant,
  StoredPreview,
  TaskStatus,
  TraceSpan,
  WorkspaceSettings,
} from '@tsugimori/storage';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

function chatScope() {
  return {
    adapterId: text('adapter_id').notNull(),
    chatId: text('chat_id').notNull(),
  };
}

export const chats = sqliteTable(
  'chats',
  {
    ...chatScope(),
    kind: text('kind').$type<ChatRecord['kind']>().notNull(),
    title: text('title'),
    allowlisted: integer('allowlisted', { mode: 'boolean' })
      .notNull()
      .default(false),
    allowlistConfigured: integer('allowlist_configured', { mode: 'boolean' })
      .notNull()
      .default(false),
    agentId: text('agent_id'),
    migratedToChatId: text('migrated_to_chat_id'),
    model: text('model'),
    serviceTier: text('service_tier'),
    thinking: text('thinking'),
    sessionAgentId: text('session_agent_id'),
    sessionModel: text('session_model'),
  },
  (table) => [primaryKey({ columns: [table.adapterId, table.chatId] })],
);

export const unavailableCommandScopes = sqliteTable(
  'unavailable_command_scopes',
  {
    ...chatScope(),
    botId: text('bot_id').notNull(),
    scope: text('scope').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.adapterId, table.chatId, table.botId, table.scope],
    }),
  ],
);

export const users = sqliteTable(
  'users',
  {
    adapterId: text('adapter_id').notNull(),
    userId: text('user_id').notNull(),
    display: text('display'),
    username: text('username'),
  },
  (table) => [primaryKey({ columns: [table.adapterId, table.userId] })],
);

export const messages = sqliteTable(
  'messages',
  {
    ...chatScope(),
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull(),
    migratedFromChatId: text('migrated_from_chat_id').notNull().default(''),
    direction: text('direction').$type<MessageRecord['direction']>().notNull(),
    userId: text('user_id'),
    replyTo: text('reply_to'),
    threadId: text('thread_id'),
    text: text('text').notNull(),
    raw: text('raw', { mode: 'json' }).$type<unknown>(),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    recordedAt: integer('recorded_at'),
  },
  (table) => [
    uniqueIndex('messages_platform_id').on(
      table.adapterId,
      table.chatId,
      table.direction,
      table.messageId,
      table.migratedFromChatId,
    ),
    index('messages_chat_sequence').on(
      table.adapterId,
      table.chatId,
      table.seq,
    ),
  ],
);

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    ...chatScope(),
    agentId: text('agent_id').notNull(),
    model: text('model').notNull(),
    sessionId: text('session_id').notNull(),
    scopeChatId: text('scope_chat_id'),
    throughSeq: integer('through_seq').notNull(),
    seenAfter: text('seen_after', { mode: 'json' }).$type<number[]>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.adapterId, table.chatId, table.agentId, table.model],
    }),
  ],
);

export const tasks = sqliteTable('tasks', {
  ...chatScope(),
  id: text('id').primaryKey().notNull(),
  sourceChatId: text('source_chat_id'),
  sourceMessageId: text('source_message_id').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  agentId: text('agent_id'),
  model: text('model'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
});

export const approvals = sqliteTable(
  'approvals',
  {
    ...chatScope(),
    id: text('id').primaryKey().notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    action: text('action').notNull(),
    resource: text('resource', { mode: 'json' }).$type<ResourceRef>().notNull(),
    requester: text('requester').notNull(),
    approverId: text('approver_id'),
    continuation: text('continuation', { mode: 'json' }).$type<
      NonNullable<ApprovalRecord['continuation']>
    >(),
    expiresAt: integer('expires_at'),
    failureReason: text('failure_reason'),
    promptMessageId: text('prompt_message_id'),
    migratedPrompt: text('migrated_prompt'),
    promptFormat: text('prompt_format', { mode: 'json' }).$type<
      NonNullable<ApprovalRecord['promptFormat']>
    >(),
    status: text('status').$type<ApprovalRecord['status']>().notNull(),
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
  },
  (table) => [
    uniqueIndex('approvals_prompt').on(
      table.adapterId,
      table.chatId,
      table.promptMessageId,
    ),
    index('approvals_task').on(table.taskId, table.status),
    index('approvals_pending').on(
      table.status,
      table.expiresAt,
      table.adapterId,
      table.chatId,
    ),
  ],
);

export const grants = sqliteTable(
  'grants',
  {
    ...chatScope(),
    id: text('id').primaryKey().notNull(),
    action: text('action').notNull(),
    scope: text('scope', { mode: 'json' })
      .$type<StoredGrant['scope']>()
      .notNull(),
    mode: text('mode').$type<StoredGrant['mode']>().notNull(),
    grantedBy: text('granted_by').notNull(),
    grantedTo: text('granted_to').notNull(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
    consumedAt: integer('consumed_at'),
  },
  (table) => [
    index('grants_scope').on(
      table.adapterId,
      table.chatId,
      table.grantedTo,
      table.action,
    ),
  ],
);

export const owners = sqliteTable('owners', {
  adapterId: text('adapter_id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
});

export const adapterCursors = sqliteTable(
  'adapter_cursors',
  {
    adapterId: text('adapter_id').notNull(),
    stream: text('stream').notNull(),
    offset: integer('offset').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.adapterId, table.stream] })],
);

export const pairingCodes = sqliteTable('pairing_codes', {
  adapterId: text('adapter_id').primaryKey().notNull(),
  digest: text('digest').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const traceSpans = sqliteTable(
  'trace_spans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    attrs: text('attrs', { mode: 'json' })
      .$type<TraceSpan['attrs']>()
      .notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at').notNull(),
    durationMs: real('duration_ms').notNull(),
    status: text('status').$type<TraceSpan['status']>().notNull(),
  },
  (table) => [
    index('trace_spans_started_at').on(table.startedAt),
    index('trace_spans_session')
      .on(sessionScope(table.attrs), table.id)
      .where(sql`${sessionScope(table.attrs)} is not null`),
  ],
);

export function sessionScope(attrs: AnySQLiteColumn) {
  return sql`json_extract(${attrs}, '$.sessionScope')`;
}

export const chatSummaries = sqliteTable(
  'chat_summaries',
  {
    ...chatScope(),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    throughSeq: integer('through_seq').notNull(),
    updatedAt: integer('updated_at'),
  },
  (table) => [primaryKey({ columns: [table.adapterId, table.chatId] })],
);

export const schedules = sqliteTable(
  'schedules',
  {
    ...chatScope(),
    id: text('id').primaryKey().notNull(),
    action: text('action', { mode: 'json' })
      .$type<ScheduleRecord['action']>()
      .notNull(),
    address: text('address', { mode: 'json' })
      .$type<ScheduleAddress>()
      .notNull(),
    createdBy: text('created_by').notNull(),
    deliveryApprovedBy: text('delivery_approved_by'),
    failureReason: text('failure_reason'),
    mentions: text('mentions', { mode: 'json' }).$type<string[]>().notNull(),
    missed: text('missed').$type<ScheduleRecord['missed']>().notNull(),
    nextDueAt: integer('next_due_at'),
    status: text('status').$type<ScheduleRecord['status']>().notNull(),
    target: text('target', { mode: 'json' }).$type<ScheduleAddress>().notNull(),
    timezone: text('timezone').notNull(),
    trigger: text('trigger', { mode: 'json' })
      .$type<ScheduleRecord['trigger']>()
      .notNull(),
  },
  (table) => [
    index('schedules_due').on(table.status, table.nextDueAt),
    index('schedules_creator').on(
      table.adapterId,
      table.createdBy,
      table.status,
    ),
    index('schedules_chat').on(table.adapterId, table.chatId),
  ],
);

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id),
    dueAt: integer('due_at').notNull(),
    finishedAt: integer('finished_at'),
    startedAt: integer('started_at').notNull(),
    status: text('status').$type<ScheduleRun['status']>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scheduleId, table.dueAt] })],
);

export const workspaceSettings = sqliteTable(
  'chat_workspace_settings',
  {
    ...chatScope(),
    settings: text('settings', { mode: 'json' })
      .$type<WorkspaceSettings>()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.adapterId, table.chatId] })],
);

export const previews = sqliteTable(
  'previews',
  {
    ...chatScope(),
    id: text('id').primaryKey().notNull(),
    openedBy: text('opened_by').notNull(),
    port: integer('port').notNull(),
    provider: text('provider').notNull(),
    url: text('url').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    closedAt: integer('closed_at'),
    closedReason: text('closed_reason').$type<StoredPreview['closedReason']>(),
  },
  (table) => [index('previews_open').on(table.closedAt, table.adapterId)],
);

export const setupRuns = sqliteTable('setup_runs', {
  id: text('id').primaryKey(),
  category: text('category').$type<SetupRun['category']>().notNull(),
  mode: text('mode').$type<SetupRun['mode']>().notNull(),
  status: text('status').$type<SetupRun['status']>().notNull(),
  step: integer('step').notNull(),
  draft: text('draft', { mode: 'json' }).$type<SetupRun['draft']>().notNull(),
  lease: text('lease'),
  leaseUntil: integer('lease_until').notNull(),
});

export const setupSecrets = sqliteTable(
  'setup_secrets',
  {
    ...chatScope(),
    messageId: text('message_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.adapterId, table.chatId, table.messageId] }),
  ],
);
