import type {
  ResourceRef,
  TaskEvent,
  TriggerReason,
} from '@tsugimori/plugin-sdk';
import type {
  ApprovalRecord,
  ChatRecord,
  IndexedSticker,
  MessageRecord,
  ScheduleAddress,
  ScheduleRecord,
  ScheduleRun,
  SetupRun,
  StoredGrant,
  StoredPreview,
  TaskStatus,
  ToolCallRecord,
  TraceSpan,
  WorkspaceSettings,
} from '@tsugimori/storage';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { sql } from 'drizzle-orm';
import {
  blob,
  customType,
  foreignKey,
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
    rawZ: blob('raw_z', { mode: 'buffer' }),
    revision: integer('revision').notNull().default(0),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    recordedAt: integer('recorded_at'),
    albumId: text('album_id'),
    metadata: text('metadata', { mode: 'json' }).$type<
      NonNullable<MessageRecord['metadata']>
    >(),
  },
  (table) => [
    uniqueIndex('messages_platform_id').on(
      table.adapterId,
      table.chatId,
      table.direction,
      table.messageId,
      table.migratedFromChatId,
    ),
    index('messages_chat_album')
      .on(
        table.adapterId,
        table.chatId,
        table.albumId,
        table.migratedFromChatId,
        table.seq,
      )
      .where(sql`${table.albumId} is not null`),
    index('messages_chat_reply')
      .on(
        table.adapterId,
        table.chatId,
        table.replyTo,
        table.migratedFromChatId,
        table.seq,
      )
      .where(sql`${table.replyTo} is not null`),
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

export const tasks = sqliteTable(
  'tasks',
  {
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
  },
  (table) => [
    index('tasks_chat_created').on(
      table.adapterId,
      table.chatId,
      table.createdAt,
    ),
    index('tasks_agent_created').on(table.agentId, table.createdAt),
    index('tasks_created').on(table.createdAt),
    index('tasks_status_created_id').on(
      table.status,
      table.createdAt,
      table.id,
    ),
    index('tasks_adapter_created_id').on(
      table.adapterId,
      table.createdAt,
      table.id,
    ),
    index('tasks_failed_at')
      .on(sql`coalesce(${table.finishedAt}, ${table.createdAt})`)
      .where(sql`${table.status} in ('failed', 'delivery-unknown')`),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    callId: text('call_id'),
    name: text('name').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    status: text('status').$type<NonNullable<ToolCallRecord['status']>>(),
    args: text('args'),
    result: text('result'),
    approvalId: text('approval_id'),
  },
  (table) => [index('tool_calls_task_seq').on(table.taskId, table.seq)],
);

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
    requestedAt: integer('requested_at'),
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
    index('trace_spans_task_started').on(
      sql`json_extract(${table.attrs}, '$.taskId')`,
      table.startedAt,
      table.id,
    ),
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

const encoded = customType<{ data: string | Buffer }>({
  dataType: () => 'blob',
});

export const taskRecords = sqliteTable(
  'task_records',
  {
    taskId: text('task_id')
      .primaryKey()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agent: encoded('agent'),
    input: encoded('input'),
    refs: encoded('refs').notNull(),
    output: encoded('output'),
    outcome: encoded('outcome').notNull(),
    timing: encoded('timing').notNull(),
    supplements: encoded('supplements').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: integer('created_at').notNull(),
    pruned: integer('pruned', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('task_records_pruned_created').on(table.pruned, table.createdAt),
  ],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<TaskEvent['kind']>().notNull(),
    at: integer('at').notNull(),
    data: encoded('data').notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.seq] })],
);

export const contextBlobs = sqliteTable('context_blobs', {
  sha256: text('sha256').primaryKey().notNull(),
  content: encoded('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const chatSummaryVersions = sqliteTable(
  'chat_summary_versions',
  {
    ...chatScope(),
    revision: integer('revision').notNull(),
    text: encoded('text').notNull(),
    throughSeq: integer('through_seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.adapterId, table.chatId, table.revision] }),
  ],
);

export const messageEdits = sqliteTable(
  'message_edits',
  {
    seq: integer('seq')
      .notNull()
      .references(() => messages.seq, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<
      NonNullable<MessageRecord['metadata']>
    >(),
  },
  (table) => [primaryKey({ columns: [table.seq, table.revision] })],
);

export const triggerDecisions = sqliteTable(
  'trigger_decisions',
  {
    ...chatScope(),
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull(),
    messageSeq: integer('message_seq').references(() => messages.seq, {
      onDelete: 'cascade',
    }),
    at: integer('at').notNull(),
    triggered: integer('triggered', { mode: 'boolean' }).notNull(),
    reason: text('reason').$type<TriggerReason>().notNull(),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('trigger_decisions_message').on(table.messageSeq, table.id),
    index('trigger_decisions_task').on(table.taskId),
    index('trigger_decisions_adapter').on(table.adapterId),
  ],
);

export const stickerSets = sqliteTable('sticker_sets', {
  name: text('name').primaryKey(),
  blocked: integer('blocked', { mode: 'boolean' }).notNull().default(false),
  sourceAdapterId: text('source_adapter_id'),
  sourceChatId: text('source_chat_id'),
});

export const indexedStickers = sqliteTable(
  'indexed_stickers',
  {
    setName: text('set_name')
      .notNull()
      .references(() => stickerSets.name, { onDelete: 'cascade' }),
    uniqueId: text('unique_id').notNull(),
    emoji: text('emoji'),
    format: text('format').$type<IndexedSticker['format']>().notNull(),
    description: text('description').notNull(),
  },
  (table) => [primaryKey({ columns: [table.setName, table.uniqueId] })],
);

export const stickerFiles = sqliteTable(
  'sticker_files',
  {
    botId: text('bot_id').notNull(),
    setName: text('set_name').notNull(),
    uniqueId: text('unique_id').notNull(),
    fileId: text('file_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.setName, table.uniqueId] }),
    foreignKey({
      columns: [table.setName, table.uniqueId],
      foreignColumns: [indexedStickers.setName, indexedStickers.uniqueId],
    }).onDelete('cascade'),
  ],
);

export const stickerDescriptions = sqliteTable(
  'sticker_descriptions',
  {
    platformKind: text('platform_kind').notNull(),
    stickerId: text('sticker_id').notNull(),
    description: text('description').notNull(),
    emoji: text('emoji'),
    keywords: text('keywords', { mode: 'json' }).$type<string[]>(),
    model: text('model').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.platformKind, table.stickerId] })],
);
