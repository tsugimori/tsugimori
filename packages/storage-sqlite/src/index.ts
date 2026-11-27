import type {
  AdapterCursor,
  AdminEvent,
  AdminTaskFilter,
  AdminTaskSummary,
  ChatRef,
  ContextBlock,
  PreviewCloseReason,
  PrincipalRef,
  TaskEvent,
  TaskExecution,
  TriggerDecision,
} from '@tsugimori/plugin-sdk';
import type {
  ActiveTaskRefs,
  AgentSession,
  ApprovalRecord,
  ChatRecord,
  ChatRoute,
  ChatSummary,
  CommandScopeChat,
  GrantQuery,
  HistoryQuery,
  InboundRecord,
  IndexedSticker,
  NewMessage,
  RemovalRows,
  RemovalTarget,
  ScheduleAddress,
  ScheduleRecord,
  ScheduleRun,
  SessionHistory,
  SessionMetric,
  SetupRun,
  Store,
  StoredGrant,
  StoredPreview,
  TaskRecord,
  ToolCallRecord,
  TraceSpan,
  UserRecord,
  WorkspaceSettings,
} from '@tsugimori/storage';

import {
  and,
  asc,
  count,
  desc,
  eq,
  getColumns,
  getTableName,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  decodeRecord,
  decodeText,
  encodeRecord,
  encodeText,
} from './record-codec.ts';
import { pruneRecords, recordUsage } from './record-retention.ts';
import {
  adapterCursors,
  agentSessions,
  approvals,
  chats,
  chatSummaries,
  chatSummaryVersions,
  contextBlobs,
  grants,
  indexedStickers,
  messageEdits,
  messages,
  owners,
  pairingCodes,
  previews,
  scheduleRuns,
  schedules,
  sessionScope,
  setupRuns,
  setupSecrets,
  stickerFiles,
  stickerSets,
  taskEvents,
  taskRecords,
  tasks,
  toolCalls,
  traceSpans,
  triggerDecisions,
  unavailableCommandScopes,
  users,
  workspaceSettings,
} from './schema.ts';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

function secureDatabaseFile(path: string) {
  if (path === ':memory:') return;
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
    if (!lstatSync(path).isFile())
      throw new Error('Expected a regular SQLite database file');
  }
}

function chatScope(
  table:
    | typeof chats
    | typeof chatSummaries
    | typeof messages
    | typeof agentSessions
    | typeof approvals
    | typeof grants
    | typeof schedules
    | typeof tasks
    | typeof unavailableCommandScopes
    | typeof workspaceSettings,
  ref: ChatRef,
) {
  return and(eq(table.adapterId, ref.adapterId), eq(table.chatId, ref.chatId));
}

function currentApproval(now: number) {
  return and(
    eq(approvals.status, 'pending'),
    or(isNull(approvals.expiresAt), gt(approvals.expiresAt, now)),
  );
}

function saveSummaryVersion(tx: Transaction, summary: ChatSummary) {
  tx.insert(chatSummaryVersions)
    .values({
      adapterId: summary.adapterId,
      chatId: summary.chatId,
      text: encodeRecord(summary.text),
      revision: summary.revision,
      throughSeq: summary.throughSeq,
      createdAt: summary.updatedAt ?? Date.now(),
    })
    .run();
}

function repairSummary(tx: Transaction, ref: ChatRef, seq: number) {
  const summary = tx
    .update(chatSummaries)
    .set({
      revision: sql`${chatSummaries.revision} + 1`,
      text: sql`case when ${chatSummaries.throughSeq} >= ${seq} then '' else ${chatSummaries.text} end`,
      throughSeq: sql`case when ${chatSummaries.throughSeq} >= ${seq} then 0 else ${chatSummaries.throughSeq} end`,
    })
    .where(chatScope(chatSummaries, ref))
    .returning()
    .get();
  if (summary?.text) saveSummaryVersion(tx, summary);
}

function readMessage<Row extends typeof messages.$inferSelect>({
  rawZ,
  ...row
}: Row) {
  return { ...row, raw: rawZ === null ? row.raw : decodeRecord(rawZ) };
}

// Children precede their parents so platform cleanup can keep foreign keys on.
const platformTables = [
  approvals,
  grants,
  messages,
  chatSummaries,
  agentSessions,
  tasks,
  schedules,
  previews,
  workspaceSettings,
  setupSecrets,
  unavailableCommandScopes,
  users,
  owners,
  adapterCursors,
  pairingCodes,
  chats,
] as const;

const activeTaskStatuses = ['queued', 'running', 'sending'] as const;
const activeScheduleStatuses = ['active', 'paused'] as const;

function setupScope({ category, id }: RemovalTarget) {
  return inArray(setupRuns.id, [
    JSON.stringify(['add', category, id]),
    JSON.stringify(['login', category, id]),
  ]);
}

function refsMatch(
  table:
    typeof tasks | typeof schedules | typeof chats | typeof workspaceSettings,
  refs: readonly ChatRef[],
) {
  return sql`exists (select 1 from json_each(${JSON.stringify(refs)})
    where json_extract(value, '$.adapterId') = ${table.adapterId}
      and json_extract(value, '$.chatId') = ${table.chatId})`;
}

function platformDependents(
  db: Pick<ReturnType<typeof createDatabase>['db'], 'select'>,
  id: string,
) {
  const taskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.adapterId, id));
  const scheduleIds = db
    .select({ id: schedules.id })
    .from(schedules)
    .where(eq(schedules.adapterId, id));
  return {
    runs: inArray(scheduleRuns.scheduleId, scheduleIds),
    calls: inArray(toolCalls.taskId, taskIds),
    spans: or(
      sql`json_extract(${traceSpans.attrs}, '$.adapterId') = ${id}`,
      inArray(sql`json_extract(${traceSpans.attrs}, '$.taskId')`, taskIds),
      inArray(
        sql`json_extract(${traceSpans.attrs}, '$.scheduleId')`,
        scheduleIds,
      ),
    ),
  };
}

function createDatabase(path: string) {
  secureDatabaseFile(path);
  const sqlite = new DatabaseSync(path, { timeout: 5_000 });
  try {
    sqlite.exec('PRAGMA journal_mode = WAL');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder });
    return { db, sqlite };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

type Transaction = Parameters<
  Parameters<ReturnType<typeof createDatabase>['db']['transaction']>[0]
>[0];

function scheduleRecord({
  failureReason,
  ...row
}: ScheduleRecord): ScheduleRecord {
  return failureReason == null ? row : { ...row, failureReason };
}

function readdressSchedule(
  schedule: ScheduleRecord,
  resolve: (chatId: string) => string,
) {
  const chatId = resolve(schedule.chatId);
  const resolveOther = (id: string) =>
    id === schedule.chatId ? chatId : resolve(id);
  const addressId = resolveOther(schedule.address.chatId);
  const targetId =
    schedule.target.chatId === schedule.address.chatId
      ? addressId
      : resolveOther(schedule.target.chatId);
  if (
    chatId === schedule.chatId &&
    addressId === schedule.address.chatId &&
    targetId === schedule.target.chatId
  )
    return schedule;
  return {
    ...schedule,
    chatId,
    address: { ...schedule.address, chatId: addressId },
    target: { ...schedule.target, chatId: targetId },
  };
}

function moveSummary(tx: Transaction, previous: ChatRef, next: ChatRef) {
  const read = (chat: ChatRef) =>
    tx.select().from(chatSummaries).where(chatScope(chatSummaries, chat)).get();
  const before = read(previous);
  const current = read(next);
  if (!before && !current) return;
  const firstUncovered = (chat: ChatRef, throughSeq: number) =>
    tx
      .select({ seq: min(messages.seq) })
      .from(messages)
      .where(
        and(
          chatScope(messages, chat),
          gt(messages.seq, throughSeq),
          eq(messages.deleted, false),
        ),
      )
      .get()?.seq ?? Infinity;
  const uncoveredBefore = firstUncovered(previous, before?.throughSeq ?? 0);
  if (!before && uncoveredBefore === Infinity) return;
  const uncoveredCurrent = firstUncovered(next, current?.throughSeq ?? 0);
  const merged = {
    text: [...new Set([before?.text, current?.text].filter(Boolean))].join(
      '\n\n',
    ),
    throughSeq: Math.min(
      Math.max(before?.throughSeq ?? 0, current?.throughSeq ?? 0),
      uncoveredBefore - 1,
      uncoveredCurrent - 1,
    ),
    revision: Math.max(before?.revision ?? 0, current?.revision ?? 0) + 1,
    updatedAt:
      Math.max(before?.updatedAt ?? 0, current?.updatedAt ?? 0) || null,
  };
  tx.insert(chatSummaries)
    .values({ ...next, ...merged })
    .onConflictDoUpdate({
      target: [chatSummaries.adapterId, chatSummaries.chatId],
      set: merged,
    })
    .run();
  if (merged.text) saveSummaryVersion(tx, { ...next, ...merged });
  tx.delete(chatSummaries).where(chatScope(chatSummaries, previous)).run();
}

function moveChatState(tx: Transaction, ref: ChatRef, chatId: string) {
  const next = { adapterId: ref.adapterId, chatId };
  const pending = tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.adapterId, ref.adapterId),
        eq(approvals.status, 'pending'),
      ),
    )
    .all();
  const moveSchedule = (schedule: ScheduleRecord) =>
    readdressSchedule(schedule, (id) => (id === ref.chatId ? chatId : id));
  for (const approval of pending) {
    const movedPrompt = approval.chatId === ref.chatId;
    const continuation = approval.continuation;
    const { resource } = approval;
    const movedResource =
      resource.type === 'chat' &&
      resource.adapterId === ref.adapterId &&
      resource.chatId === ref.chatId;
    const change =
      continuation?.kind === 'schedule' ? continuation.change : undefined;
    const schedule = change && moveSchedule(change.schedule);
    const previous = change?.previous && moveSchedule(change.previous);
    const movedSchedule =
      schedule !== change?.schedule || previous !== change?.previous;
    if (!movedPrompt && !movedResource && !movedSchedule) continue;
    const prompt =
      movedPrompt && approval.promptMessageId
        ? tx
            .select({ text: messages.text })
            .from(messages)
            .where(
              and(
                chatScope(messages, ref),
                eq(messages.direction, 'outbound'),
                eq(messages.messageId, approval.promptMessageId),
                eq(messages.migratedFromChatId, ''),
              ),
            )
            .get()?.text
        : undefined;
    tx.update(approvals)
      .set({
        chatId: movedPrompt ? chatId : undefined,
        promptMessageId: movedPrompt ? null : undefined,
        migratedPrompt: prompt,
        continuation:
          movedSchedule && schedule
            ? { kind: 'schedule', change: { ...change, schedule, previous } }
            : undefined,
        resource: movedResource ? { ...resource, chatId } : undefined,
      })
      .where(eq(approvals.id, approval.id))
      .run();
  }

  const addressId = sql`json_extract(${schedules.address}, '$.chatId')`;
  const targetId = sql`json_extract(${schedules.target}, '$.chatId')`;
  tx.update(schedules)
    .set({
      chatId: sql`case when ${schedules.chatId} = ${ref.chatId} then ${chatId} else ${schedules.chatId} end`,
      address: sql`case when ${addressId} = ${ref.chatId} then json_set(${schedules.address}, '$.chatId', ${chatId}) else ${schedules.address} end`,
      target: sql`case when ${targetId} = ${ref.chatId} then json_set(${schedules.target}, '$.chatId', ${chatId}) else ${schedules.target} end`,
    })
    .where(
      and(
        eq(schedules.adapterId, ref.adapterId),
        or(
          eq(schedules.chatId, ref.chatId),
          eq(addressId, ref.chatId),
          eq(targetId, ref.chatId),
        ),
      ),
    )
    .run();

  tx.update(tasks)
    .set({
      chatId,
      sourceChatId: sql`coalesce(${tasks.sourceChatId}, ${ref.chatId})`,
    })
    .where(chatScope(tasks, ref))
    .run();
  moveSummary(tx, ref, next);
  tx.update(messages)
    .set({
      chatId,
      migratedFromChatId: sql`case when ${messages.migratedFromChatId} = '' then ${ref.chatId} else ${messages.migratedFromChatId} end`,
    })
    .where(chatScope(messages, ref))
    .run();

  const sessions = tx
    .select()
    .from(agentSessions)
    .where(chatScope(agentSessions, ref))
    .all();
  for (const session of sessions)
    tx.insert(agentSessions)
      .values({
        ...session,
        ...next,
        scopeChatId: session.scopeChatId ?? ref.chatId,
      })
      .onConflictDoNothing()
      .run();
  tx.delete(agentSessions).where(chatScope(agentSessions, ref)).run();
}

function saveUser(
  db: Pick<ReturnType<typeof createDatabase>['db'], 'insert'>,
  user: Omit<UserRecord, 'username'> & Partial<Pick<UserRecord, 'username'>>,
) {
  const insert = db.insert(users).values(user);
  if (user.display === null && user.username === undefined) {
    insert.onConflictDoNothing().run();
  } else {
    insert
      .onConflictDoUpdate({
        target: [users.adapterId, users.userId],
        set: { display: user.display ?? undefined, username: user.username },
      })
      .run();
  }
}

export class SqliteStore implements Store {
  readonly #db;
  readonly #sqlite;
  readonly #adminListeners = new Set<(event: AdminEvent) => void>();

  subscribeAdmin(listener: (event: AdminEvent) => void) {
    this.#adminListeners.add(listener);
    return () => {
      this.#adminListeners.delete(listener);
    };
  }

  #publish(event: AdminEvent) {
    for (const listener of this.#adminListeners) {
      try {
        listener(event);
      } catch {
        console.error(
          JSON.stringify({ level: 'error', event: 'admin.listener_failed' }),
        );
      }
    }
  }

  #publishTask(task: TaskRecord) {
    const {
      adapterId,
      chatId,
      id,
      status,
      agentId,
      model,
      startedAt,
      finishedAt,
    } = task;
    this.#publish({
      kind: 'task',
      adapterId,
      chatId,
      id,
      status,
      agentId,
      model,
      startedAt,
      endedAt: finishedAt,
    });
  }

  #publishTool({
    taskId,
    seq,
    name,
    startedAt,
    endedAt,
    status,
  }: Pick<
    ToolCallRecord,
    'taskId' | 'seq' | 'name' | 'startedAt' | 'endedAt' | 'status'
  >) {
    this.#publish({
      kind: 'tool',
      taskId,
      seq,
      name,
      startedAt,
      endedAt,
      status,
    });
  }

  #publishApproval({ adapterId, chatId, id, status }: ApprovalRecord) {
    this.#publish({ kind: 'approval', adapterId, chatId, id, status });
  }

  #publishSchedule(id: string) {
    if (!this.#adminListeners.size) return;
    const schedule = this.getSchedule(id);
    if (schedule)
      this.#publish({
        kind: 'schedule',
        id,
        status: schedule.status,
        lastRun: this.adminLastScheduleRun(id),
      });
  }

  backup(path: string) {
    closeSync(openSync(path, 'wx', 0o600));
    this.#sqlite.prepare('VACUUM INTO ?').run(path);
  }

  instanceSetupRuns(target: RemovalTarget) {
    return this.#db.select().from(setupRuns).where(setupScope(target)).all();
  }

  releaseRemoval(id: string, lease: string) {
    this.#db
      .delete(setupRuns)
      .where(and(eq(setupRuns.id, id), eq(setupRuns.lease, lease)))
      .run();
  }

  #agentRemoval(id: string, fileRoutes: readonly ChatRef[]) {
    const byAgent = eq(chats.agentId, id);
    const workspaceRoute = sql`json_extract(${workspaceSettings.settings}, '$.agentId') = ${id}`;
    const settings = this.#db
      .select({
        adapterId: workspaceSettings.adapterId,
        chatId: workspaceSettings.chatId,
      })
      .from(workspaceSettings)
      .where(workspaceRoute)
      .all();
    const routes = this.#db
      .select({
        adapterId: chats.adapterId,
        chatId: chats.chatId,
      })
      .from(chats)
      .where(
        or(
          byAgent,
          and(
            isNull(chats.agentId),
            refsMatch(chats, [...fileRoutes, ...settings]),
          ),
        ),
      )
      .all();
    const activeTasks = and(
      inArray(tasks.status, activeTaskStatuses),
      or(
        eq(tasks.agentId, id),
        and(
          eq(tasks.status, 'queued'),
          isNull(tasks.agentId),
          refsMatch(tasks, routes),
        ),
      ),
    );
    const activeSchedules = and(
      inArray(schedules.status, activeScheduleStatuses),
      sql`json_extract(${schedules.action}, '$.kind') = 'agent'`,
      refsMatch(schedules, routes),
    );
    const agentTasks = this.#db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.agentId, id));
    const calls = inArray(toolCalls.taskId, agentTasks);
    const pendingApprovals = and(
      eq(approvals.status, 'pending'),
      inArray(
        approvals.taskId,
        this.#db
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.agentId, id)),
      ),
    );
    return {
      calls,
      activeSchedules,
      activeTasks,
      pendingApprovals,
      routes,
      settings,
      workspaceRoute,
    };
  }

  inspectInstanceData(
    target: RemovalTarget,
    fileRoutes: readonly ChatRef[],
  ): RemovalRows {
    const { id } = target;
    const db = this.#db;
    const setupCount = db.$count(setupRuns, setupScope(target)).sync();
    if (target.category === 'agent') {
      const {
        activeSchedules,
        activeTasks,
        calls,
        pendingApprovals,
        routes,
        settings,
      } = this.#agentRemoval(id, fileRoutes);
      return {
        chats: [],
        counts: {
          agent_sessions: db
            .$count(agentSessions, eq(agentSessions.agentId, id))
            .sync(),
          setup_runs: setupCount,
          chat_session_pointers: db
            .$count(chats, eq(chats.sessionAgentId, id))
            .sync(),
          pending_approvals: db.$count(approvals, pendingApprovals).sync(),
          tool_calls: db.$count(toolCalls, calls).sync(),
        },
        routes,
        schedules: db
          .select({ id: schedules.id })
          .from(schedules)
          .where(activeSchedules)
          .orderBy(schedules.id)
          .all()
          .map((row) => row.id),
        tasks: db
          .select({ id: tasks.id })
          .from(tasks)
          .where(activeTasks)
          .orderBy(tasks.id)
          .all()
          .map((row) => row.id),
        workspaceSettings: settings,
      };
    }
    const { calls, runs, spans } = platformDependents(db, id);
    return {
      chats: db
        .select({ chatId: chats.chatId })
        .from(chats)
        .where(eq(chats.adapterId, id))
        .orderBy(chats.chatId)
        .all()
        .map((row) => row.chatId),
      counts: {
        ...Object.fromEntries(
          platformTables.map((table) => [
            getTableName(table),
            db.$count(table, eq(table.adapterId, id)).sync(),
          ]),
        ),
        schedule_runs: db.$count(scheduleRuns, runs).sync(),
        setup_runs: setupCount,
        trace_spans: db.$count(traceSpans, spans).sync(),
        tool_calls: db.$count(toolCalls, calls).sync(),
      },
      routes: [],
      schedules: db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.adapterId, id),
            inArray(schedules.status, activeScheduleStatuses),
          ),
        )
        .orderBy(schedules.id)
        .all()
        .map((row) => row.id),
      tasks: db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.adapterId, id),
            inArray(tasks.status, activeTaskStatuses),
          ),
        )
        .orderBy(tasks.id)
        .all()
        .map((row) => row.id),
      workspaceSettings: [],
    };
  }

  deleteInstanceData(
    target: RemovalTarget,
    fileRoutes: readonly ChatRef[],
    now: number,
  ) {
    const { id } = target;
    return this.#db.transaction<Record<string, number>>(
      (tx) => {
        const changed = (result: { changes: number | bigint }) =>
          Number(result.changes);
        const setupCount = changed(
          tx.delete(setupRuns).where(setupScope(target)).run(),
        );
        if (target.category === 'agent') {
          const {
            activeSchedules,
            activeTasks,
            calls,
            pendingApprovals,
            routes,
            workspaceRoute,
          } = this.#agentRemoval(id, fileRoutes);
          const updates: Record<string, number> = {
            setup_runs: setupCount,
            tool_calls: changed(tx.delete(toolCalls).where(calls).run()),
            agent_sessions: changed(
              tx
                .delete(agentSessions)
                .where(eq(agentSessions.agentId, id))
                .run(),
            ),
            chat_session_pointers: changed(
              tx
                .update(chats)
                .set({ sessionAgentId: null, sessionModel: null })
                .where(eq(chats.sessionAgentId, id))
                .run(),
            ),
            chats: changed(
              tx
                .update(chats)
                .set({
                  agentId: null,
                  model: null,
                  serviceTier: null,
                  thinking: null,
                })
                .where(refsMatch(chats, routes))
                .run(),
            ),
            chat_workspace_settings: changed(
              tx
                .update(workspaceSettings)
                .set({
                  settings: sql`json_remove(${workspaceSettings.settings}, '$.agentId', '$.model', '$.thinking', '$.serviceTier', '$.fast')`,
                })
                .where(workspaceRoute)
                .run(),
            ),
            approvals: changed(
              tx
                .update(approvals)
                .set({ status: 'cancelled', decidedAt: now })
                .where(pendingApprovals)
                .run(),
            ),
            schedules: changed(
              tx
                .update(schedules)
                .set({ status: 'cancelled', nextDueAt: null })
                .where(activeSchedules)
                .run(),
            ),
            tasks: changed(
              tx
                .update(tasks)
                .set({
                  finishedAt: now,
                  status: sql`case when ${tasks.status} = 'sending' then 'delivery-unknown' else 'cancelled' end`,
                })
                .where(activeTasks)
                .run(),
            ),
          };
          return updates;
        }
        // These records follow the platform's messages and summaries. They do not
        // participate in the confirmation fingerprint, which can itself record a decision.
        tx.delete(triggerDecisions)
          .where(eq(triggerDecisions.adapterId, id))
          .run();
        tx.delete(chatSummaryVersions)
          .where(eq(chatSummaryVersions.adapterId, id))
          .run();
        const { calls, runs, spans } = platformDependents(tx, id);
        const deleted = {
          schedule_runs: changed(tx.delete(scheduleRuns).where(runs).run()),
          setup_runs: setupCount,
          trace_spans: changed(tx.delete(traceSpans).where(spans).run()),
          tool_calls: changed(tx.delete(toolCalls).where(calls).run()),
        };
        return {
          ...deleted,
          ...Object.fromEntries(
            platformTables.map((table) => [
              getTableName(table),
              changed(tx.delete(table).where(eq(table.adapterId, id)).run()),
            ]),
          ),
        };
      },
      { behavior: 'immediate' },
    );
  }

  claimSetupRun(run: SetupRun, now: number) {
    return this.#db.transaction(
      (tx) => {
        if (
          tx
            .select({ id: setupRuns.id })
            .from(setupRuns)
            .where(
              and(
                gt(setupRuns.leaseUntil, now),
                run.mode === 'remove'
                  ? or(
                      run.category === 'webhook'
                        ? undefined
                        : setupScope({
                            category: run.category,
                            id: run.draft.entry.id,
                          }),
                      eq(setupRuns.mode, 'remove'),
                    )
                  : or(
                      inArray(setupRuns.mode, ['add', 'login']),
                      eq(
                        setupRuns.id,
                        JSON.stringify([
                          'remove',
                          run.category,
                          run.draft.entry.id,
                        ]),
                      ),
                    ),
              ),
            )
            .get()
        )
          return;
        const existing = tx
          .select()
          .from(setupRuns)
          .where(eq(setupRuns.id, run.id))
          .get();
        const claimed =
          existing?.status === 'pending' &&
          (run.category !== 'webhook' ||
            existing.draft.entry.kind === run.draft.entry.kind)
            ? { ...existing, lease: run.lease, leaseUntil: run.leaseUntil }
            : run;
        tx.insert(setupRuns)
          .values(claimed)
          .onConflictDoUpdate({ target: setupRuns.id, set: claimed })
          .run();
        return claimed;
      },
      { behavior: 'immediate' },
    );
  }

  getSetupRun(id: string) {
    return this.#db.select().from(setupRuns).where(eq(setupRuns.id, id)).get();
  }

  saveSetupRun(run: SetupRun, lease: string) {
    return (
      this.#db
        .update(setupRuns)
        .set(run)
        .where(and(eq(setupRuns.id, run.id), eq(setupRuns.lease, lease)))
        .run().changes === 1
    );
  }

  markSetupSecret(ref: ChatRef, messageId: string) {
    this.#db
      .insert(setupSecrets)
      .values({ ...ref, messageId })
      .onConflictDoNothing()
      .run();
  }

  isSetupSecret(ref: ChatRef, messageId: string) {
    const { adapterId, chatId } = ref;
    return Boolean(
      this.#db
        .select({ messageId: setupSecrets.messageId })
        .from(setupSecrets)
        .where(
          and(
            eq(setupSecrets.adapterId, adapterId),
            eq(setupSecrets.chatId, chatId),
            eq(setupSecrets.messageId, messageId),
          ),
        )
        .get(),
    );
  }

  isStickerSetBlocked(name: string) {
    return (
      this.#db
        .select({ blocked: stickerSets.blocked })
        .from(stickerSets)
        .where(eq(stickerSets.name, name))
        .get()?.blocked === true
    );
  }

  hasStickerSet(name: string, botId: string) {
    return (
      this.#db
        .select({ botId: stickerFiles.botId })
        .from(stickerFiles)
        .where(
          and(eq(stickerFiles.botId, botId), eq(stickerFiles.setName, name)),
        )
        .get() !== undefined
    );
  }

  getStickerDescriptions(name: string) {
    return this.#db
      .select({
        description: indexedStickers.description,
        uniqueId: indexedStickers.uniqueId,
      })
      .from(indexedStickers)
      .where(eq(indexedStickers.setName, name))
      .all();
  }

  saveStickerSet(
    name: string,
    botId: string,
    source: ChatRef,
    stickers: readonly IndexedSticker[],
  ) {
    return this.#db.transaction((tx) => {
      const set = tx
        .select()
        .from(stickerSets)
        .where(eq(stickerSets.name, name))
        .get();
      if (set?.blocked || !stickers.length) return false;
      if (!set?.sourceAdapterId) {
        const sourceFields = {
          sourceAdapterId: source.adapterId,
          sourceChatId: source.chatId,
        };
        tx.insert(stickerSets)
          .values({ name, ...sourceFields })
          .onConflictDoUpdate({ target: stickerSets.name, set: sourceFields })
          .run();
      }
      for (const { fileId, ...sticker } of stickers) {
        tx.insert(indexedStickers)
          .values({ setName: name, ...sticker })
          .onConflictDoNothing()
          .run();
        tx.insert(stickerFiles)
          .values({ botId, setName: name, uniqueId: sticker.uniqueId, fileId })
          .onConflictDoUpdate({
            target: [
              stickerFiles.botId,
              stickerFiles.setName,
              stickerFiles.uniqueId,
            ],
            set: { fileId },
          })
          .run();
      }
      return true;
    });
  }

  searchStickers(botId: string, query: string, limit: number) {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const keywords =
      terms.length > 1
        ? terms.filter(
            (term) =>
              [...term].length >= 2 || /[\p{Emoji}--\p{ASCII}]/v.test(term),
          )
        : terms;
    const searchText = sql`lower(${indexedStickers.description} || ' ' || coalesce(${indexedStickers.emoji}, '') || ' ' || ${stickerSets.name})`;
    const matchCount = keywords.length
      ? sql.join(
          keywords.map((term) => sql`(instr(${searchText}, ${term}) > 0)`),
          sql` + `,
        )
      : undefined;
    return this.#db
      .select({
        fileId: stickerFiles.fileId,
        emoji: indexedStickers.emoji,
        description: indexedStickers.description,
      })
      .from(stickerFiles)
      .innerJoin(
        indexedStickers,
        and(
          eq(indexedStickers.setName, stickerFiles.setName),
          eq(indexedStickers.uniqueId, stickerFiles.uniqueId),
        ),
      )
      .innerJoin(stickerSets, eq(stickerSets.name, indexedStickers.setName))
      .where(
        and(
          eq(stickerFiles.botId, botId),
          eq(stickerSets.blocked, false),
          matchCount && sql`${matchCount} > 0`,
        ),
      )
      .orderBy(
        ...(matchCount ? [desc(matchCount)] : []),
        stickerFiles.setName,
        stickerFiles.uniqueId,
      )
      .limit(limit)
      .all()
      .map(({ fileId, emoji, description }) => ({
        fileId,
        emoji: emoji ?? undefined,
        description,
      }));
  }

  listStickerSets() {
    return this.#db
      .select({
        name: stickerSets.name,
        count: count(indexedStickers.uniqueId),
        blocked: stickerSets.blocked,
      })
      .from(stickerSets)
      .leftJoin(indexedStickers, eq(stickerSets.name, indexedStickers.setName))
      .groupBy(stickerSets.name)
      .orderBy(stickerSets.name)
      .all();
  }

  setStickerSetBlocked(name: string, blocked: boolean) {
    this.#db
      .insert(stickerSets)
      .values({ name, blocked })
      .onConflictDoUpdate({ target: stickerSets.name, set: { blocked } })
      .run();
  }

  constructor(path: string) {
    const { db, sqlite } = createDatabase(path);
    this.#db = db;
    this.#sqlite = sqlite;
    try {
      // Earlier releases recorded the chat alias without moving conversation state.
      db.transaction(
        (tx) => {
          for (const chat of tx
            .select()
            .from(chats)
            .where(isNotNull(chats.migratedToChatId))
            .all()) {
            if (chat.migratedToChatId)
              this.#migrateChat(
                tx,
                chat,
                chat.migratedToChatId,
                undefined,
                true,
              );
          }
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      sqlite.close();
      throw error;
    }
  }

  close() {
    this.#sqlite.close();
  }

  getChat(ref: ChatRef): ChatRecord | undefined {
    return this.#db.select().from(chats).where(chatScope(chats, ref)).get();
  }

  resolveChat(ref: ChatRef): ChatRef {
    const destination = (scope: ChatRef) =>
      this.#db
        .select({ chatId: chats.migratedToChatId })
        .from(chats)
        .where(chatScope(chats, scope))
        .get()?.chatId;
    let chatId = destination(ref);
    if (!chatId) return ref;
    const seen = new Set([ref.chatId]);
    while (chatId && !seen.has(chatId)) {
      seen.add(chatId);
      ref = { ...ref, chatId };
      chatId = destination(ref);
    }
    if (chatId) throw new Error('Chat migration contains a cycle');
    return ref;
  }

  migrateChat(ref: ChatRef, newChatId: string, title?: string) {
    if (ref.chatId === newChatId) return false;
    const changed = this.#db.transaction(
      (tx) => this.#migrateChat(tx, ref, newChatId, title),
      { behavior: 'immediate' },
    );
    if (changed) {
      this.#publishChat(ref);
      this.#publishChat({ adapterId: ref.adapterId, chatId: newChatId });
    }
    return changed;
  }

  #migrateChat(
    tx: Transaction,
    ref: ChatRef,
    newChatId: string,
    title?: string,
    backfill = false,
  ) {
    const previous = tx.select().from(chats).where(chatScope(chats, ref)).get();
    const next = { adapterId: ref.adapterId, chatId: newChatId };
    const current = tx.select().from(chats).where(chatScope(chats, next)).get();
    if (
      (previous?.migratedToChatId &&
        (!backfill || previous.migratedToChatId !== newChatId)) ||
      current?.migratedToChatId
    )
      return false;
    if (previous?.migratedToChatId) {
      moveChatState(tx, ref, newChatId);
      if (previous.sessionAgentId && !current?.sessionAgentId)
        tx.update(chats)
          .set({
            sessionAgentId: previous.sessionAgentId,
            sessionModel: previous.sessionModel,
          })
          .where(chatScope(chats, next))
          .run();
      if (previous.sessionAgentId || previous.sessionModel)
        tx.update(chats)
          .set({ sessionAgentId: null, sessionModel: null })
          .where(chatScope(chats, ref))
          .run();
      return false;
    }
    const route = {
      agentId: current?.agentId ?? previous?.agentId ?? null,
      model: current?.model ?? previous?.model ?? null,
      serviceTier: current?.serviceTier ?? previous?.serviceTier ?? null,
      thinking: current?.thinking ?? previous?.thinking ?? null,
    };
    const destination = {
      ...route,
      sessionAgentId:
        current?.sessionAgentId ?? previous?.sessionAgentId ?? null,
      sessionModel: current?.sessionModel ?? previous?.sessionModel ?? null,
      kind: 'supergroup' as const,
      title: current?.title ?? title ?? previous?.title ?? null,
      allowlisted:
        current?.allowlistConfigured || current?.allowlisted
          ? current.allowlisted
          : (previous?.allowlisted ?? false),
      allowlistConfigured:
        current?.allowlistConfigured ||
        (previous?.allowlistConfigured ?? false),
    };
    tx.insert(chats)
      .values({ ...next, ...destination })
      .onConflictDoUpdate({
        target: [chats.adapterId, chats.chatId],
        set: destination,
      })
      .run();
    tx.insert(chats)
      .values({ ...ref, kind: 'group', title, migratedToChatId: newChatId })
      .onConflictDoUpdate({
        target: [chats.adapterId, chats.chatId],
        set: {
          migratedToChatId: newChatId,
          sessionAgentId: null,
          sessionModel: null,
        },
      })
      .run();
    const settings = (chat: ChatRef) =>
      tx
        .select()
        .from(workspaceSettings)
        .where(chatScope(workspaceSettings, chat))
        .get()?.settings;
    const previousSettings = settings(ref);
    if (previousSettings) {
      const merged = { ...previousSettings, ...settings(next) };
      tx.insert(workspaceSettings)
        .values({ ...next, settings: merged })
        .onConflictDoUpdate({
          target: [workspaceSettings.adapterId, workspaceSettings.chatId],
          set: { settings: merged },
        })
        .run();
    }
    moveChatState(tx, ref, newChatId);
    return true;
  }

  listUnavailableCommandScopes({
    adapterId,
    botId,
  }: Omit<CommandScopeChat, 'chatId'>) {
    return this.#db
      .select({
        chatId: unavailableCommandScopes.chatId,
        scope: unavailableCommandScopes.scope,
      })
      .from(unavailableCommandScopes)
      .where(
        and(
          eq(unavailableCommandScopes.adapterId, adapterId),
          eq(unavailableCommandScopes.botId, botId),
        ),
      )
      .all();
  }

  markCommandScopeUnavailable(ref: CommandScopeChat, scope: string) {
    this.#db
      .insert(unavailableCommandScopes)
      .values({ ...ref, scope })
      .onConflictDoNothing()
      .run();
  }

  clearUnavailableCommandScopes(ref: CommandScopeChat) {
    this.#db
      .delete(unavailableCommandScopes)
      .where(
        and(
          chatScope(unavailableCommandScopes, ref),
          eq(unavailableCommandScopes.botId, ref.botId),
        ),
      )
      .run();
  }

  getUser({ adapterId, userId }: PrincipalRef) {
    return this.#db
      .select()
      .from(users)
      .where(and(eq(users.adapterId, adapterId), eq(users.userId, userId)))
      .get();
  }

  getUserDisplay(ref: PrincipalRef) {
    return this.getUser(ref)?.display ?? undefined;
  }

  recordUser(user: Parameters<Store['recordUser']>[0]) {
    saveUser(this.#db, user);
  }

  openPreview(preview: StoredPreview) {
    this.#db.insert(previews).values(preview).run();
  }

  closePreview(id: string, closedAt: number, closedReason: PreviewCloseReason) {
    this.#db
      .update(previews)
      .set({ closedAt, closedReason })
      .where(and(eq(previews.id, id), isNull(previews.closedAt)))
      .run();
  }

  closePreviewsOnRestart(now: number) {
    return this.#db
      .update(previews)
      .set({ closedAt: now, closedReason: 'restart' })
      .where(isNull(previews.closedAt))
      .returning()
      .all();
  }

  listPreviews(adapterId?: string) {
    return this.#db
      .select()
      .from(previews)
      .where(
        and(
          isNull(previews.closedAt),
          adapterId === undefined
            ? undefined
            : eq(previews.adapterId, adapterId),
        ),
      )
      .orderBy(desc(previews.createdAt))
      .all();
  }

  listChats() {
    return this.#db
      .select()
      .from(chats)
      .orderBy(chats.adapterId, chats.chatId)
      .all();
  }

  listChatMessages(ref: ChatRef, before?: number) {
    return this.#db
      .select({
        seq: messages.seq,
        adapterId: messages.adapterId,
        chatId: messages.chatId,
        messageId: messages.messageId,
        migratedFromChatId: messages.migratedFromChatId,
        userId: messages.userId,
        text: messages.text,
        direction: messages.direction,
        deleted: messages.deleted,
        replyTo: messages.replyTo,
        threadId: messages.threadId,
        recordedAt: messages.recordedAt,
        displayName: users.display,
      })
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(
        and(
          chatScope(messages, ref),
          before !== undefined ? lt(messages.seq, before) : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(100)
      .all();
  }

  listChatTasks(ref: ChatRef) {
    return this.#db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.adapterId, ref.adapterId), eq(tasks.chatId, ref.chatId)),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(100)
      .all();
  }

  listApprovals(now?: number, recentLimit = 500) {
    const pending = now === undefined ? undefined : currentApproval(now);
    const recent = this.#db
      .select()
      .from(approvals)
      .where(pending && sql`not (${pending})`)
      .orderBy(
        desc(approvals.decidedAt),
        desc(approvals.requestedAt),
        approvals.id,
      )
      .limit(recentLimit)
      .all();
    return pending
      ? [
          ...this.#db
            .select()
            .from(approvals)
            .where(pending)
            .orderBy(desc(approvals.requestedAt), approvals.id)
            .all(),
          ...recent,
        ]
      : recent;
  }

  #adminActivityQueries?: ReturnType<SqliteStore['prepareAdminActivity']>;

  private prepareAdminActivity() {
    const adapter = sql.placeholder('adapterId');
    const chat = sql.placeholder('chatId');
    const scope = (table: typeof messages | typeof tasks | typeof approvals) =>
      and(eq(table.adapterId, adapter), eq(table.chatId, chat));
    const messageStats = this.#db
      .select({
        latestSeq: max(messages.seq),
        messageCount: count(),
        messageTime: max(messages.recordedAt),
      })
      .from(messages)
      .where(scope(messages))
      .prepare();
    const thread = this.#db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(scope(messages), isNotNull(messages.threadId)))
      .orderBy(desc(messages.seq))
      .limit(1)
      .prepare();
    const task = (active: boolean) =>
      this.#db
        .select()
        .from(tasks)
        .where(
          and(
            scope(tasks),
            active ? inArray(tasks.status, activeTaskStatuses) : undefined,
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(1)
        .prepare();
    const preview = this.#db
      .select({
        sender: sql<
          string | null
        >`case when ${messages.direction} = 'outbound' then null else coalesce(${users.display}, ${messages.userId}) end`,
        text: sql<string>`substr(trim(${messages.text}), 1, 81)`,
      })
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(and(scope(messages), eq(messages.deleted, false)))
      .orderBy(desc(messages.seq))
      .limit(1)
      .prepare();
    const tool = this.#db
      .select({ name: toolCalls.name })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.taskId, sql.placeholder('taskId')),
          isNull(toolCalls.endedAt),
          isNull(toolCalls.status),
        ),
      )
      .orderBy(desc(toolCalls.seq))
      .limit(1)
      .prepare();
    const pending = this.#db
      .select({ value: count() })
      .from(approvals)
      .where(
        and(
          scope(approvals),
          eq(approvals.status, 'pending'),
          or(
            isNull(approvals.expiresAt),
            gt(approvals.expiresAt, sql.placeholder('now')),
          ),
        ),
      )
      .prepare();
    return {
      messageStats,
      thread,
      activeTask: task(true),
      lastTask: task(false),
      preview,
      tool,
      pending,
    };
  }

  adminChatActivity(ref: ChatRef, now: number) {
    const {
      messageStats,
      thread,
      activeTask,
      lastTask,
      preview,
      tool,
      pending,
    } = (this.#adminActivityQueries ??= this.prepareAdminActivity());
    const key = { adapterId: ref.adapterId, chatId: ref.chatId };
    const { latestSeq, messageCount, messageTime } = messageStats.get(key)!;
    const active = activeTask.get(key);
    return {
      preview: preview.get(key) ?? null,
      currentTool: active
        ? (tool.get({ taskId: active.id })?.name ?? null)
        : null,
      latestSeq: latestSeq ?? 0,
      messageCount,
      messageTime,
      threadId: thread.get(key)?.threadId ?? null,
      activeTask: active,
      lastTask: lastTask.get(key),
      pendingApprovals: pending.get({ ...key, now })!.value,
    };
  }

  adminAgentActivity(agentId: string, since: number, now: number) {
    const { active, tasksToday, failedToday, lastActivity } = this.#db
      .select({
        active:
          sql<number>`count(*) filter (where ${tasks.status} in ('queued', 'running', 'sending'))`.mapWith(
            Number,
          ),
        tasksToday:
          sql<number>`count(*) filter (where ${tasks.createdAt} between ${since} and ${now})`.mapWith(
            Number,
          ),
        failedToday:
          sql<number>`count(*) filter (where ${tasks.status} in ('failed', 'delivery-unknown') and coalesce(${tasks.finishedAt}, ${tasks.createdAt}) between ${since} and ${now})`.mapWith(
            Number,
          ),
        lastActivity: sql<
          number | null
        >`max(coalesce(${tasks.finishedAt}, ${tasks.startedAt}, ${tasks.createdAt}))`.mapWith(
          Number,
        ),
      })
      .from(tasks)
      .where(eq(tasks.agentId, agentId))
      .get()!;
    const recent = this.#db
      .select()
      .from(tasks)
      .where(eq(tasks.agentId, agentId))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(3)
      .all();
    return { active, tasksToday, failedToday, lastActivity, recent };
  }

  adminChatSchedules(ref: ChatRef) {
    return this.#db
      .select()
      .from(schedules)
      .where(
        and(
          chatScope(schedules, ref),
          inArray(schedules.status, ['active', 'paused']),
        ),
      )
      .orderBy(asc(schedules.nextDueAt), schedules.id)
      .all();
  }

  adminChatApprovals(ref: ChatRef, now: number) {
    return this.#db
      .select()
      .from(approvals)
      .where(and(chatScope(approvals, ref), currentApproval(now)))
      .orderBy(desc(approvals.requestedAt))
      .all();
  }

  adminLastScheduleRun(id: string) {
    return (
      this.#db
        .select({ at: scheduleRuns.startedAt })
        .from(scheduleRuns)
        .where(eq(scheduleRuns.scheduleId, id))
        .orderBy(desc(scheduleRuns.dueAt))
        .limit(1)
        .get()?.at ?? null
    );
  }

  countPendingApprovals(now: number) {
    return this.#db.$count(approvals, currentApproval(now)).sync();
  }

  adminTaskCounts(since: number, now: number) {
    const failedAt = sql`coalesce(${tasks.finishedAt}, ${tasks.createdAt})`;
    return {
      tasksToday: this.#db
        .$count(
          tasks,
          and(gte(tasks.createdAt, since), lte(tasks.createdAt, now)),
        )
        .sync(),
      failedToday: this.#db
        .$count(
          tasks,
          and(
            sql`${tasks.status} in ('failed', 'delivery-unknown')`,
            gte(failedAt, since),
            lte(failedAt, now),
          ),
        )
        .sync(),
      pendingApprovals: this.countPendingApprovals(now),
    };
  }

  adminTasks(
    {
      agent,
      before,
      chat,
      cursor,
      limit,
      platform,
      q,
      since,
      status,
    }: AdminTaskFilter,
    platforms: ReadonlyMap<string, string>,
  ): AdminTaskSummary[] {
    const adapterIds =
      platform === undefined
        ? []
        : [
            ...Array.from(platforms)
              .filter(([, kind]) => kind === platform)
              .map(([id]) => id),
            ...(!platforms.has(platform) ? [platform] : []),
          ];
    const traceTask = sql`json_extract(${traceSpans.attrs}, '$.taskId') = ${tasks.id}`;
    const usage = (path: string) =>
      sql<number | null>`(
      select json_extract(${traceSpans.attrs}, ${path}) from ${traceSpans}
      where ${traceTask} and ${traceSpans.name} = 'agent.usage'
        and json_extract(${traceSpans.attrs}, '$.purpose') is not 'summary'
        and json_type(${traceSpans.attrs}, ${path}) in ('integer', 'real')
      order by ${traceSpans.startedAt} desc, ${traceSpans.id} desc limit 1
    )`.mapWith(Number);
    const rows = this.#db
      .select({
        id: tasks.id,
        adapterId: tasks.adapterId,
        chatId: tasks.chatId,
        chatTitle: chats.title,
        status: tasks.status,
        createdAt: tasks.createdAt,
        startedAt: tasks.startedAt,
        finishedAt: tasks.finishedAt,
        agentId: tasks.agentId,
        model: tasks.model,
        triggerText: sql<string | null>`substr(${messages.text}, 1, 241)`,
        triggerReason: sql<AdminTaskSummary['triggerReason']>`coalesce(
          (select ${triggerDecisions.reason} from ${triggerDecisions}
            where ${triggerDecisions.taskId} = ${tasks.id}
            order by ${triggerDecisions.id} limit 1),
          (select ${triggerDecisions.reason} from ${triggerDecisions}
            where ${triggerDecisions.messageSeq} = ${messages.seq}
              and ${triggerDecisions.reason} <> 'duplicate'
            order by ${triggerDecisions.id} desc limit 1)
        )`,
        toolCount: sql<number>`(
          select count(*) from ${toolCalls} where ${toolCalls.taskId} = ${tasks.id}
        ) + (
          select count(*) from ${traceSpans} where ${traceTask}
            and ${traceSpans.name} in ('agent.tool', 'tool.run')
            and json_type(${traceSpans.attrs}, '$.name') = 'text'
            and not exists (
              select 1 from ${toolCalls} where ${toolCalls.taskId} = ${tasks.id}
                and ${toolCalls.seq} = json_extract(${traceSpans.attrs}, '$.toolCallSeq')
            )
        )`.mapWith(Number),
        inputTokens: usage('$.inputTokens'),
        outputTokens: usage('$.outputTokens'),
        error: sql<string | null>`(
          select substr(json_extract(${traceSpans.attrs}, '$.error'), 1, 241)
          from ${traceSpans} where ${traceTask} and ${traceSpans.name} = 'task.failed'
          and json_type(${traceSpans.attrs}, '$.error') = 'text'
          order by ${traceSpans.startedAt} desc, ${traceSpans.id} desc limit 1
        )`,
        silent: sql<number>`${tasks.status} = 'completed' and exists (
          select 1 from ${traceSpans} where ${traceTask}
            and ${traceSpans.name} = 'outbound.silent'
            and json_extract(${traceSpans.attrs}, '$.reply') = 'silent'
            and not coalesce(json_extract(${traceSpans.attrs}, '$.fallback'), 0)
        )`,
      })
      .from(tasks)
      .leftJoin(
        chats,
        and(
          eq(chats.adapterId, tasks.adapterId),
          eq(chats.chatId, tasks.chatId),
        ),
      )
      .leftJoin(
        messages,
        and(
          eq(messages.adapterId, tasks.adapterId),
          eq(messages.chatId, tasks.chatId),
          eq(messages.direction, 'inbound'),
          eq(messages.messageId, tasks.sourceMessageId),
          eq(
            messages.migratedFromChatId,
            sql`coalesce(${tasks.sourceChatId}, '')`,
          ),
        ),
      )
      .where(
        and(
          chat ? chatScope(tasks, chat) : undefined,
          agent ? eq(tasks.agentId, agent) : undefined,
          platform === undefined
            ? undefined
            : inArray(tasks.adapterId, adapterIds),
          status ? eq(tasks.status, status as TaskRecord['status']) : undefined,
          since === undefined ? undefined : gte(tasks.createdAt, since),
          before === undefined ? undefined : lt(tasks.createdAt, before),
          cursor &&
            sql`(${tasks.createdAt}, ${tasks.id}) < (${cursor.createdAt}, ${cursor.id})`,
          q ? sql`instr(lower(${messages.text}), lower(${q})) > 0` : undefined,
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(limit + 1)
      .all();
    function excerpt(text: string | null) {
      if (text === null) return null;
      const flat = text.replace(/\s+/g, ' ').trim();
      return [...text].length > 240
        ? [...flat].slice(0, 240).join('').trimEnd() + '…'
        : flat;
    }
    return rows.map((row) => ({
      ...row,
      chatKey: JSON.stringify([row.adapterId, row.chatId]),
      chatTitle: row.chatTitle || row.chatId,
      platform: platforms.get(row.adapterId) ?? row.adapterId,
      durationMs:
        row.startedAt === null || row.finishedAt === null
          ? null
          : Math.max(0, row.finishedAt - row.startedAt),
      error: excerpt(row.error),
      triggerText: excerpt(row.triggerText),
      silent: Boolean(row.silent),
    }));
  }

  adminChatTasks(
    ref: ChatRef,
    {
      before,
      oldestSeq,
      oldestTime,
    }: {
      before?: number;
      oldestSeq?: number;
      oldestTime?: number | null;
    },
  ) {
    const cursor =
      before === undefined
        ? undefined
        : this.#db
            .select({ time: messages.recordedAt })
            .from(messages)
            .where(and(chatScope(messages, ref), eq(messages.seq, before)))
            .get()?.time;
    return this.#db
      .select({ ...getColumns(tasks), sourceSeq: messages.seq })
      .from(tasks)
      .leftJoin(
        messages,
        and(
          eq(messages.adapterId, tasks.adapterId),
          eq(messages.chatId, tasks.chatId),
          eq(messages.direction, 'inbound'),
          eq(messages.messageId, tasks.sourceMessageId),
          eq(
            messages.migratedFromChatId,
            sql`coalesce(${tasks.sourceChatId}, '')`,
          ),
        ),
      )
      .where(
        and(
          chatScope(tasks, ref),
          or(
            and(
              isNotNull(messages.seq),
              before === undefined ? undefined : lt(messages.seq, before),
              oldestSeq === undefined
                ? undefined
                : gte(messages.seq, oldestSeq),
            ),
            and(
              isNull(messages.seq),
              before === undefined
                ? undefined
                : cursor == null
                  ? sql`0`
                  : lt(tasks.createdAt, cursor),
              oldestTime == null ? undefined : gte(tasks.createdAt, oldestTime),
            ),
          ),
        ),
      )
      .orderBy(desc(tasks.createdAt), tasks.id)
      .all();
  }

  listAdminSchedules() {
    return this.#db
      .select()
      .from(schedules)
      .orderBy(asc(schedules.nextDueAt), schedules.id)
      .all();
  }

  approvalStatus(ref: ChatRef, now: number, includeRecent = false) {
    const pending = this.#db
      .select({
        chat: sql<number>`count(*) filter (where ${chatScope(approvals, ref)})`,
        total: count(),
        nextExpiry: min(approvals.expiresAt),
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.status, 'pending'),
          sql`(${approvals.expiresAt} is null or ${approvals.expiresAt} > ${now})`,
        ),
      )
      .get()!;
    if (!includeRecent) return pending;
    const latest = this.#db
      .select({
        status: approvals.status,
        failureReason: approvals.failureReason,
      })
      .from(approvals)
      .innerJoin(tasks, eq(tasks.id, approvals.taskId))
      .where(
        and(
          or(chatScope(tasks, ref), chatScope(approvals, ref)),
          inArray(approvals.status, ['approved', 'denied', 'expired']),
        ),
      )
      .orderBy(desc(approvals.decidedAt), approvals.id)
      .limit(1)
      .get();
    return { ...pending, latest };
  }

  listGrants() {
    return this.#db
      .select()
      .from(grants)
      .orderBy(desc(grants.createdAt))
      .limit(500)
      .all();
  }

  createToolCall(call: Omit<ToolCallRecord, 'seq'>) {
    // The task can disappear during removal. Reserve its sequence only if it exists.
    const seq = this.#db
      .insert(toolCalls)
      .select(
        this.#db
          .select({
            seq: sql<number>`null`.as('seq'),
            taskId: tasks.id,
            callId: sql<string | null>`${call.callId}`.as('call_id'),
            name: sql<string>`${call.name}`.as('name'),
            startedAt: sql<number>`${call.startedAt}`.as('started_at'),
            endedAt: sql<number | null>`${call.endedAt}`.as('ended_at'),
            status: sql<ToolCallRecord['status']>`${call.status}`.as('status'),
            args: sql<string | null>`${call.args}`.as('args'),
            result: sql<string | null>`${call.result}`.as('result'),
            approvalId: sql<string | null>`${call.approvalId}`.as(
              'approval_id',
            ),
          })
          .from(tasks)
          .where(eq(tasks.id, call.taskId)),
      )
      .returning({ seq: toolCalls.seq })
      .get()?.seq;
    if (seq !== undefined) this.#publishTool({ ...call, seq });
    return seq;
  }

  updateToolCall(
    seq: number,
    patch: Partial<
      Pick<
        ToolCallRecord,
        'approvalId' | 'args' | 'endedAt' | 'result' | 'status'
      >
    >,
  ) {
    const call = this.#db
      .update(toolCalls)
      .set(patch)
      .where(eq(toolCalls.seq, seq))
      .returning({
        seq: toolCalls.seq,
        name: toolCalls.name,
        taskId: toolCalls.taskId,
        status: toolCalls.status,
        startedAt: toolCalls.startedAt,
        endedAt: toolCalls.endedAt,
      })
      .get();
    if (call) this.#publishTool(call);
  }

  adminToolCall(taskId: string, seq: number) {
    return this.#db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.taskId, taskId), eq(toolCalls.seq, seq)))
      .get();
  }

  taskToolCalls(taskIds: readonly string[], details: boolean | 'args' = true) {
    if (!taskIds.length) return [];
    const columns = getColumns(toolCalls);
    return this.#db
      .select({
        ...columns,
        args: details ? columns.args : sql<null>`null`,
        result: details === true ? columns.result : sql<null>`null`,
        callId: details === true ? columns.callId : sql<null>`null`,
      })
      .from(toolCalls)
      .where(inArray(toolCalls.taskId, [...taskIds]))
      .orderBy(toolCalls.seq)
      .all();
  }

  taskTrace(taskId: string) {
    return this.#db
      .select()
      .from(traceSpans)
      .where(sql`json_extract(${traceSpans.attrs}, '$.taskId') = ${taskId}`)
      .orderBy(traceSpans.startedAt, traceSpans.id)
      .limit(2000)
      .all();
  }

  latestSessionSpan(scope: string, metric: SessionMetric) {
    return this.#db
      .select()
      .from(traceSpans)
      .where(
        and(
          ne(traceSpans.name, 'agent.run'),
          eq(sessionScope(traceSpans.attrs), scope),
          metric === 'compaction'
            ? and(
                eq(traceSpans.name, 'agent.compaction'),
                eq(traceSpans.status, 'ok'),
              )
            : sql`json_extract(${traceSpans.attrs}, ${metric === 'contextWindow' ? '$.contextWindow' : '$.contextTokens'}) is not null`,
        ),
      )
      .orderBy(desc(traceSpans.id))
      .get();
  }

  sessionHistory(scope: string): SessionHistory {
    const { name, startedAt, status, attrs } = traceSpans;
    const row = this.#db
      .select({
        compactions: sql<number>`count(*) filter (where ${name} = 'agent.compaction' and ${status} = 'ok')`,
        createdAt: sql<
          number | null
        >`min(${startedAt}) filter (where ${name} = 'agent.session.created')`,
        firstActivityAt: min(startedAt),
      })
      .from(traceSpans)
      .where(eq(sessionScope(attrs), scope))
      .get()!;
    return {
      compactions: row.compactions,
      createdAt: row.createdAt ?? undefined,
      firstActivityAt: row.firstActivityAt ?? undefined,
    };
  }

  private selectWorkspaceSettings() {
    return this.#db
      .select({ settings: workspaceSettings.settings })
      .from(workspaceSettings)
      .where(
        and(
          eq(workspaceSettings.adapterId, sql.placeholder('adapterId')),
          eq(workspaceSettings.chatId, sql.placeholder('chatId')),
        ),
      )
      .prepare();
  }

  #workspaceSettings?: ReturnType<SqliteStore['selectWorkspaceSettings']>;

  getWorkspaceSettings({ adapterId, chatId }: ChatRef) {
    return (this.#workspaceSettings ??= this.selectWorkspaceSettings()).get({
      adapterId,
      chatId,
    })?.settings;
  }

  setWorkspaceSettings(ref: ChatRef, settings: WorkspaceSettings) {
    this.#db
      .insert(workspaceSettings)
      .values({ ...ref, settings })
      .onConflictDoUpdate({
        target: [workspaceSettings.adapterId, workspaceSettings.chatId],
        set: { settings },
      })
      .run();
    this.#publishChat(ref);
  }

  #publishChat({ adapterId, chatId }: ChatRef) {
    this.#publish({ kind: 'chat', adapterId, chatId });
  }

  deliveryAddress(ref: ChatRef) {
    ref = this.resolveChat(ref);
    const chat = this.getChat(ref);
    if (!chat) return;
    const last = this.#db
      .select({ threadId: messages.threadId, userId: messages.userId })
      .from(messages)
      .where(and(chatScope(messages, ref), eq(messages.direction, 'inbound')))
      .orderBy(desc(messages.seq))
      .limit(1)
      .get();
    if (!last?.userId) return;
    const threadId = last.threadId ?? undefined;
    if (threadId !== undefined && !ref.chatId.endsWith(`_${threadId}`)) return;
    const chatId =
      threadId === undefined
        ? ref.chatId
        : ref.chatId.slice(0, -(threadId.length + 1));
    return { chatId, threadId, kind: chat.kind, userId: last.userId };
  }

  createSchedule(schedule: ScheduleRecord, limit: number) {
    const changed = this.#db.transaction(
      () => this.#saveSchedule(schedule, limit),
      {
        behavior: 'immediate',
      },
    );
    if (changed) this.#publishSchedule(schedule.id);
    return changed;
  }

  #hasScheduleCapacity(schedule: ScheduleRecord, limit: number) {
    const active = this.#db
      .select({ value: count() })
      .from(schedules)
      .where(
        and(
          eq(schedules.adapterId, schedule.adapterId),
          eq(schedules.createdBy, schedule.createdBy),
          inArray(schedules.status, ['active', 'paused']),
        ),
      )
      .get();
    return (active?.value ?? 0) < limit;
  }

  getSchedule(id: string) {
    const row = this.#db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .get();
    return row && scheduleRecord(row);
  }

  listSchedules(ref: ChatRef) {
    return this.#db
      .select()
      .from(schedules)
      .where(chatScope(schedules, ref))
      .all()
      .map(scheduleRecord);
  }

  scheduleStatus(adapterId: string, target: ScheduleAddress) {
    const destination = and(
      eq(schedules.adapterId, adapterId),
      eq(sql`json_extract(${schedules.target}, '$.chatId')`, target.chatId),
      sql`json_extract(${schedules.target}, '$.threadId') is ${target.threadId ?? null}`,
    );
    const filter = and(destination, eq(schedules.status, 'active'));
    return {
      count: this.#db
        .select({ value: count() })
        .from(schedules)
        .where(filter)
        .get()!.value,
      next: this.#db
        .select({
          id: schedules.id,
          action: schedules.action,
          nextDueAt: schedules.nextDueAt,
          timezone: schedules.timezone,
          trigger: schedules.trigger,
        })
        .from(schedules)
        .where(and(filter, isNotNull(schedules.nextDueAt)))
        .orderBy(asc(schedules.nextDueAt), asc(schedules.id))
        .get(),
      failed: this.#db
        .select({ id: schedules.id, failureReason: schedules.failureReason })
        .from(schedules)
        .innerJoin(scheduleRuns, eq(schedules.id, scheduleRuns.scheduleId))
        .where(
          and(
            destination,
            eq(schedules.status, 'failed'),
            eq(scheduleRuns.status, 'failed'),
          ),
        )
        .orderBy(desc(scheduleRuns.dueAt), schedules.id)
        .limit(1)
        .get(),
    };
  }

  dueSchedules(now: number, adapterIds: readonly string[]) {
    if (!adapterIds.length) return [];
    return this.#db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, 'active'),
          lte(schedules.nextDueAt, now),
          inArray(schedules.adapterId, [...adapterIds]),
        ),
      )
      .orderBy(asc(schedules.nextDueAt))
      .limit(100)
      .all()
      .map(scheduleRecord);
  }

  updateSchedule(
    schedule: ScheduleRecord,
    expected: ScheduleRecord,
    limit: number,
  ) {
    const changed = this.#db.transaction(
      () => this.#saveSchedule(schedule, limit, expected),
      { behavior: 'immediate' },
    );
    if (changed) this.#publishSchedule(schedule.id);
    return changed;
  }

  #saveSchedule(
    schedule: ScheduleRecord,
    limit: number,
    expected?: ScheduleRecord,
  ) {
    schedule = this.#resolveSchedule(schedule);
    if (
      (!expected ||
        (schedule.status === 'active' &&
          (expected.status === 'done' || expected.status === 'cancelled'))) &&
      !this.#hasScheduleCapacity(schedule, limit)
    )
      return false;
    if (!expected)
      return !!this.#db
        .insert(schedules)
        .values(schedule)
        .onConflictDoNothing()
        .returning({ id: schedules.id })
        .get();
    const nextDue =
      expected.nextDueAt === null
        ? isNull(schedules.nextDueAt)
        : eq(schedules.nextDueAt, expected.nextDueAt);
    return !!this.#db
      .update(schedules)
      .set(schedule)
      .where(
        and(
          eq(schedules.id, expected.id),
          eq(schedules.status, expected.status),
          nextDue,
          eq(schedules.trigger, expected.trigger),
          eq(schedules.action, expected.action),
        ),
      )
      .returning({ id: schedules.id })
      .get();
  }

  #resolveSchedule(schedule: ScheduleRecord) {
    return readdressSchedule(
      schedule,
      (chatId) =>
        this.resolveChat({ adapterId: schedule.adapterId, chatId }).chatId,
    );
  }

  claimScheduleRun(
    schedule: ScheduleRecord,
    run: ScheduleRun,
    nextDueAt: number | null,
    failureReason?: string,
  ) {
    const change = this.#db.transaction(
      (tx) => {
        if (schedule.nextDueAt === null) return;
        const advanced = tx
          .update(schedules)
          .set({
            nextDueAt,
            status: failureReason
              ? 'failed'
              : nextDueAt === null
                ? 'done'
                : 'active',
            failureReason,
          })
          .where(
            and(
              eq(schedules.id, schedule.id),
              eq(schedules.status, 'active'),
              eq(schedules.nextDueAt, schedule.nextDueAt),
              eq(schedules.trigger, schedule.trigger),
              eq(schedules.action, schedule.action),
            ),
          )
          .returning({ id: schedules.id })
          .get();
        if (!advanced) return;
        const claimed = !!tx
          .insert(scheduleRuns)
          .values(run)
          .onConflictDoNothing()
          .returning({ id: scheduleRuns.scheduleId })
          .get();
        return { claimed };
      },
      { behavior: 'immediate' },
    );
    if (change) this.#publishSchedule(schedule.id);
    return change?.claimed ?? false;
  }

  finishScheduleRun(run: ScheduleRun) {
    const changed = this.#db
      .update(scheduleRuns)
      .set({ status: run.status, finishedAt: run.finishedAt })
      .where(
        and(
          eq(scheduleRuns.scheduleId, run.scheduleId),
          eq(scheduleRuns.dueAt, run.dueAt),
          eq(scheduleRuns.status, 'claimed'),
        ),
      )
      .run();
    if (changed.changes) this.#publishSchedule(run.scheduleId);
  }

  interruptScheduleRuns(now: number) {
    this.#db
      .update(scheduleRuns)
      .set({ status: 'delivery-unknown', finishedAt: now })
      .where(eq(scheduleRuns.status, 'claimed'))
      .run();
  }

  getCursor(adapterId: string, stream: string) {
    return this.#db
      .select({
        offset: adapterCursors.offset,
        updatedAt: adapterCursors.updatedAt,
      })
      .from(adapterCursors)
      .where(
        and(
          eq(adapterCursors.adapterId, adapterId),
          eq(adapterCursors.stream, stream),
        ),
      )
      .get();
  }

  saveCursor(adapterId: string, stream: string, cursor: AdapterCursor) {
    this.#db
      .insert(adapterCursors)
      .values({ adapterId, stream, ...cursor })
      .onConflictDoUpdate({
        target: [adapterCursors.adapterId, adapterCursors.stream],
        set: cursor,
      })
      .run();
  }

  setAllowlisted(ref: ChatRef, allowlisted: boolean) {
    this.#db
      .update(chats)
      .set({ allowlisted, allowlistConfigured: true })
      .where(chatScope(chats, ref))
      .run();
    this.#publishChat(ref);
  }

  setChatRoute(ref: ChatRef, route: ChatRoute, invalidateSession = true) {
    this.#db
      .update(chats)
      .set({
        ...route,
        ...(invalidateSession && { sessionAgentId: null, sessionModel: null }),
      })
      .where(chatScope(chats, ref))
      .run();
    this.#publishChat(ref);
  }

  recordInbound(
    chat: ChatRef & Pick<ChatRecord, 'kind' | 'title'>,
    user: Parameters<Store['recordInbound']>[1],
    message: InboundRecord,
    edited = false,
  ) {
    const { chatId } = this.resolveChat(chat);
    message = {
      ...message,
      chatId,
      migratedFromChatId:
        message.migratedFromChatId ??
        (chatId === chat.chatId ? '' : chat.chatId),
    };
    if (chatId !== chat.chatId)
      chat = { ...chat, chatId, kind: 'supergroup', title: null };
    const recorded = this.#db.transaction((tx) => {
      const rawZ = message.raw == null ? null : encodeRecord(message.raw, true);
      let revised = false;
      if (edited) {
        const previous = tx
          .select({
            seq: messages.seq,
            revision: messages.revision,
            metadata: messages.metadata,
            text: messages.text,
          })
          .from(messages)
          .where(
            and(
              chatScope(messages, message),
              eq(messages.direction, 'inbound'),
              eq(messages.messageId, message.messageId),
              eq(messages.migratedFromChatId, message.migratedFromChatId ?? ''),
            ),
          )
          .get();
        revised = Boolean(
          previous &&
          (previous.text !== message.text ||
            (message.metadata !== undefined &&
              JSON.stringify(previous.metadata ?? null) !==
                JSON.stringify(message.metadata))),
        );
        if (previous && revised) tx.insert(messageEdits).values(previous).run();
      }
      const insert = tx
        .insert(messages)
        .values({ ...message, raw: null, rawZ, recordedAt: Date.now() });
      const result = (
        edited
          ? insert.onConflictDoUpdate({
              target: [
                messages.adapterId,
                messages.chatId,
                messages.direction,
                messages.messageId,
                messages.migratedFromChatId,
              ],
              set: {
                text: message.text,
                raw: null,
                rawZ,
                replyTo: message.replyTo,
                albumId: message.albumId,
                metadata: message.metadata,
                revision: revised
                  ? sql`${messages.revision} + 1`
                  : messages.revision,
              },
            })
          : insert.onConflictDoNothing()
      )
        .returning()
        .get();
      if (!result) return;
      if (edited) repairSummary(tx, chat, result.seq);
      tx.insert(chats)
        .values(chat)
        .onConflictDoUpdate({
          target: [chats.adapterId, chats.chatId],
          set: { kind: chat.kind, title: chat.title ?? undefined },
        })
        .run();
      saveUser(tx, user);
      return result;
    });
    if (recorded) {
      const { adapterId, chatId, seq, direction } = recorded;
      this.#publish({ kind: 'message', adapterId, chatId, seq, direction });
    }
    return recorded && readMessage(recorded);
  }

  recordOutbound(message: NewMessage, taskId?: string) {
    const { chatId } = this.resolveChat(message);
    if (chatId !== message.chatId)
      message = { ...message, chatId, migratedFromChatId: message.chatId };
    const { recorded, task } = this.#db.transaction((tx) => {
      const recorded = tx
        .insert(messages)
        .values({
          ...message,
          raw: null,
          rawZ: message.raw == null ? null : encodeRecord(message.raw, true),
          recordedAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning({ seq: messages.seq })
        .get();
      const task = taskId
        ? tx
            .update(tasks)
            .set({ status: 'sent', finishedAt: Date.now() })
            .where(eq(tasks.id, taskId))
            .returning()
            .get()
        : undefined;
      return { recorded, task };
    });
    if (recorded)
      this.#publish({
        kind: 'message',
        adapterId: message.adapterId,
        chatId,
        seq: recorded.seq,
        direction: message.direction,
      });
    if (task) this.#publishTask(task);
  }

  messageAlbum(ref: ChatRef, albumId: string, migratedFromChatId: string) {
    return this.#db
      .select({
        ...getColumns(messages),
        raw: sql<null>`null`,
        rawZ: sql<null>`null`,
      })
      .from(messages)
      .where(
        and(
          chatScope(messages, ref),
          eq(messages.albumId, albumId),
          eq(messages.migratedFromChatId, migratedFromChatId),
        ),
      )
      .orderBy(messages.seq)
      .all();
  }

  quotedAttachmentMessage(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId: string,
  ) {
    return this.#db
      .select({
        ...getColumns(messages),
        raw: sql<null>`null`,
        rawZ: sql<null>`null`,
      })
      .from(messages)
      .where(
        and(
          chatScope(messages, ref),
          eq(messages.replyTo, messageId),
          eq(messages.migratedFromChatId, migratedFromChatId),
          eq(messages.deleted, false),
          sql`json_array_length(${messages.metadata}, '$.replyTo.attachments') > 0`,
        ),
      )
      .orderBy(desc(messages.seq))
      .get();
  }

  getMessage(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId?: string,
    includeRaw = true,
  ) {
    const fields = getColumns(messages);
    const row = this.#db
      .select(
        includeRaw
          ? fields
          : { ...fields, raw: sql<null>`null`, rawZ: sql<null>`null` },
      )
      .from(messages)
      .where(
        and(
          chatScope(messages, ref),
          eq(messages.messageId, messageId),
          migratedFromChatId === undefined
            ? undefined
            : eq(messages.migratedFromChatId, migratedFromChatId),
        ),
      )
      .orderBy(messages.migratedFromChatId, messages.direction)
      .get();
    return row && readMessage(row);
  }

  markDeleted(ref: ChatRef, messageId: string, migratedFromChatId = '') {
    const changed = this.#db.transaction((tx) => {
      const deleted = tx
        .update(messages)
        .set({ deleted: true })
        .where(
          and(
            chatScope(messages, ref),
            eq(messages.messageId, messageId),
            eq(messages.migratedFromChatId, migratedFromChatId),
            eq(messages.deleted, false),
          ),
        )
        .returning({ seq: messages.seq, direction: messages.direction })
        .all();
      if (deleted.length)
        repairSummary(tx, ref, Math.min(...deleted.map(({ seq }) => seq)));
      return deleted;
    });
    for (const { seq, direction } of changed)
      this.#publish({
        kind: 'message',
        adapterId: ref.adapterId,
        chatId: ref.chatId,
        seq,
        direction,
      });
  }

  private selectSummary() {
    return this.#db
      .select()
      .from(chatSummaries)
      .where(
        and(
          eq(chatSummaries.adapterId, sql.placeholder('adapterId')),
          eq(chatSummaries.chatId, sql.placeholder('chatId')),
        ),
      )
      .prepare();
  }

  #summary?: ReturnType<SqliteStore['selectSummary']>;

  getSummary({ adapterId, chatId }: ChatRef) {
    return (this.#summary ??= this.selectSummary()).get({ adapterId, chatId });
  }

  getSummaryStatus(ref: ChatRef) {
    const summary = this.getSummary(ref);
    if (!summary?.text) return;
    const { value } = this.#db
      .select({ value: count() })
      .from(messages)
      .where(
        and(
          chatScope(messages, ref),
          eq(messages.deleted, false),
          lte(messages.seq, summary.throughSeq),
        ),
      )
      .get()!;
    return { messages: value, updatedAt: summary.updatedAt };
  }

  beginSummary(ref: ChatRef) {
    this.#db
      .insert(chatSummaries)
      .values({ ...ref, revision: 0, text: '', throughSeq: 0 })
      .onConflictDoNothing()
      .run();
    return this.getSummary(ref)!;
  }

  saveSummary(summary: ChatSummary) {
    const changed = this.#db.transaction((tx) => {
      const row = tx
        .update(chatSummaries)
        .set({
          revision: sql`${chatSummaries.revision} + 1`,
          text: summary.text,
          throughSeq: summary.throughSeq,
          updatedAt: Date.now(),
        })
        .where(
          and(
            chatScope(chatSummaries, summary),
            eq(chatSummaries.revision, summary.revision),
            gt(sql`${summary.throughSeq}`, chatSummaries.throughSeq),
          ),
        )
        .returning()
        .get();
      if (row) saveSummaryVersion(tx, row);
      return Boolean(row);
    });
    if (changed) {
      const { adapterId, chatId, throughSeq } = summary;
      this.#publish({ kind: 'summary', adapterId, chatId, throughSeq });
    }
    return changed;
  }

  summaryMessages(
    ref: ChatRef,
    afterSeq: number,
    throughSeq: number,
    limit: number,
    offset = 0,
  ) {
    return this.#db
      .select({
        ...getColumns(messages),
        raw: sql<null>`null`,
        rawZ: sql<null>`null`,
        displayName: users.display,
      })
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(
        and(
          chatScope(messages, ref),
          eq(messages.deleted, false),
          gt(messages.seq, afterSeq),
          lte(messages.seq, throughSeq),
        ),
      )
      .orderBy(messages.seq)
      .limit(limit)
      .offset(offset)
      .all()
      .map(readMessage);
  }

  recentMessages(
    ref: ChatRef,
    options: Parameters<Store['recentMessages']>[1],
  ) {
    ref = this.resolveChat(ref);
    const { afterSeq } = options;
    const resumed = afterSeq !== undefined;
    const filter = and(
      chatScope(messages, ref),
      eq(messages.deleted, false),
      lte(messages.seq, options.throughSeq),
      resumed ? gt(messages.seq, afterSeq) : undefined,
      options.afterSummarySeq === undefined
        ? undefined
        : gt(messages.seq, options.afterSummarySeq),
      options.skipSeq?.length
        ? notInArray(messages.seq, [...options.skipSeq])
        : undefined,
      resumed ? eq(messages.direction, 'inbound') : undefined,
    );
    const fields = getColumns(messages);
    const query = this.#db
      .select(
        options.includeRaw === false
          ? {
              ...fields,
              raw: sql<null>`null`,
              rawZ: sql<null>`null`,
              displayName: users.display,
            }
          : { ...fields, displayName: users.display },
      )
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(filter)
      .orderBy(desc(messages.seq));
    return (
      resumed || options.limit === undefined
        ? query.all()
        : query.limit(options.limit).all()
    )
      .reverse()
      .map(readMessage);
  }

  historyMessages(ref: ChatRef, options: HistoryQuery) {
    const search = 'query' in options ? options : undefined;
    const match = search
      ? sql<number>`instr(lower(${messages.text}), lower(${search.query}))`
      : undefined;
    const filter =
      'fromSeq' in options
        ? and(
            gte(messages.seq, options.fromSeq),
            lte(messages.seq, options.throughSeq),
          )
        : and(
            gt(match!, 0),
            options.beforeSeq === undefined
              ? undefined
              : lt(messages.seq, options.beforeSeq),
            options.fromTime === undefined
              ? undefined
              : gte(messages.recordedAt, options.fromTime),
            options.toTime === undefined
              ? undefined
              : lte(messages.recordedAt, options.toTime),
            options.userId === undefined
              ? undefined
              : eq(messages.userId, options.userId),
          );
    return this.#db
      .select({
        seq: messages.seq,
        messageId: messages.messageId,
        metadata: messages.metadata,
        albumId: messages.albumId,
        migratedFromChatId: messages.migratedFromChatId,
        replyTo: messages.replyTo,
        direction: messages.direction,
        recordedAt: messages.recordedAt,
        userId: messages.userId,
        displayName: users.display,
        text: match
          ? sql<string>`substr(${messages.text}, max(1, ${match} - 80), 400)`
          : messages.text,
      })
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(
        and(
          chatScope(messages, this.resolveChat(ref)),
          eq(messages.deleted, false),
          filter,
        ),
      )
      .orderBy(search ? desc(messages.seq) : asc(messages.seq))
      .limit(options.limit)
      .all();
  }

  getSession(ref: ChatRef, agentId: string, model?: string) {
    const chat = this.#db
      .select()
      .from(chats)
      .where(chatScope(chats, ref))
      .get();
    if (
      chat?.sessionAgentId !== agentId ||
      chat.sessionModel === null ||
      (model !== undefined && chat.sessionModel !== model)
    )
      return;
    return this.#db
      .select()
      .from(agentSessions)
      .where(
        and(
          chatScope(agentSessions, ref),
          eq(agentSessions.agentId, agentId),
          eq(agentSessions.model, chat.sessionModel),
        ),
      )
      .get();
  }

  setSession(session: AgentSession) {
    const { chatId } = this.resolveChat(session);
    if (session.chatId !== chatId) {
      const current = this.getSession(
        { ...session, chatId },
        session.agentId,
        session.model,
      );
      if (current && current.throughSeq > session.throughSeq) return;
      session = {
        ...session,
        chatId,
        scopeChatId: session.scopeChatId ?? session.chatId,
      };
    }
    const { agentId, model, sessionId, throughSeq, seenAfter, scopeChatId } =
      session;
    this.#db.transaction((tx) => {
      tx.insert(agentSessions)
        .values(session)
        .onConflictDoUpdate({
          target: [
            agentSessions.adapterId,
            agentSessions.chatId,
            agentSessions.agentId,
            agentSessions.model,
          ],
          set: {
            sessionId,
            throughSeq,
            seenAfter,
            scopeChatId: scopeChatId ?? null,
          },
        })
        .run();
      tx.update(chats)
        .set({ sessionAgentId: agentId, sessionModel: model })
        .where(chatScope(chats, session))
        .run();
    });
  }

  clearSession(ref: ChatRef) {
    ref = this.resolveChat(ref);
    this.#db
      .update(chats)
      .set({ sessionAgentId: null, sessionModel: null })
      .where(chatScope(chats, ref))
      .run();
  }

  clearAgentSessions(agentId: string) {
    this.#db
      .update(chats)
      .set({ sessionAgentId: null, sessionModel: null })
      .where(eq(chats.sessionAgentId, agentId))
      .run();
  }

  appendTaskEvents(
    taskId: string,
    events: readonly TaskEvent[],
    replaceAfterSeq?: number,
  ) {
    const write = (
      db: Transaction | ReturnType<typeof createDatabase>['db'],
    ) => {
      const record = db
        .select({ pruned: taskRecords.pruned })
        .from(taskRecords)
        .where(eq(taskRecords.taskId, taskId))
        .get();
      if (record?.pruned) return;
      if (replaceAfterSeq !== undefined)
        db.delete(taskEvents)
          .where(
            and(
              eq(taskEvents.taskId, taskId),
              gt(taskEvents.seq, replaceAfterSeq),
            ),
          )
          .run();
      for (let index = 0; index < events.length; index += 100)
        db.insert(taskEvents)
          .values(
            events.slice(index, index + 100).map(({ seq, kind, at, data }) => ({
              taskId,
              seq,
              kind,
              at,
              data: encodeRecord(data),
            })),
          )
          .onConflictDoUpdate({
            target: [taskEvents.taskId, taskEvents.seq],
            set: { data: sql`excluded.data` },
          })
          .run();
    };
    if (replaceAfterSeq === undefined && events.length <= 100) write(this.#db);
    else this.#db.transaction(write);
  }

  getTaskEvents(taskId: string) {
    return this.#db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(taskEvents.seq)
      .all()
      .map(
        ({ seq, kind, at, data }) =>
          ({ seq, kind, at, data: decodeRecord(data) }) as TaskEvent,
      );
  }

  saveTaskExecution(taskId: string, record: TaskExecution) {
    const task = this.getTask(taskId);
    if (!task) return;
    const data = {
      agent: record.agent === null ? null : encodeRecord(record.agent),
      input:
        record.input === null
          ? null
          : encodeText(
              record.input.map((block) => JSON.stringify(block)).join('\n'),
            ),
      output: record.output === null ? null : encodeRecord(record.output),
      refs: encodeRecord(record.refs),
      outcome: encodeRecord(record.outcome),
      timing: encodeRecord(record.timing),
      supplements: encodeRecord(record.supplements),
    };
    const bytes = Object.values(data).reduce(
      (sum, value) => sum + (value === null ? 0 : Buffer.byteLength(value)),
      0,
    );
    this.#db
      .insert(taskRecords)
      .values({ taskId, ...data, bytes, createdAt: task.createdAt })
      .run();
  }

  getTaskExecution(taskId: string): TaskExecution | undefined {
    const row = this.#db
      .select()
      .from(taskRecords)
      .where(eq(taskRecords.taskId, taskId))
      .get();
    if (!row) return;
    const input = row.input === null ? null : decodeText(row.input);
    return {
      input:
        input === null
          ? null
          : input
            ? input.split('\n').map((line) => JSON.parse(line) as ContextBlock)
            : [],
      output: row.output === null ? null : decodeRecord(row.output),
      agent: row.agent === null ? null : decodeRecord(row.agent),
      refs: decodeRecord(row.refs),
      outcome: decodeRecord(row.outcome),
      timing: decodeRecord(row.timing),
      supplements: decodeRecord(row.supplements),
    };
  }

  saveContextBlob(sha256: string, content: string) {
    this.#db
      .insert(contextBlobs)
      .values({
        sha256,
        content: encodeRecord(content),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  contextBlob(sha256: string) {
    const row = this.#db
      .select({ content: contextBlobs.content })
      .from(contextBlobs)
      .where(eq(contextBlobs.sha256, sha256))
      .get();
    return row && decodeRecord<string>(row.content);
  }

  getSummaryVersion({ adapterId, chatId }: ChatRef, revision: number) {
    const row = this.#db
      .select({ text: chatSummaryVersions.text })
      .from(chatSummaryVersions)
      .where(
        and(
          eq(chatSummaryVersions.adapterId, adapterId),
          eq(chatSummaryVersions.chatId, chatId),
          eq(chatSummaryVersions.revision, revision),
        ),
      )
      .get();
    return row && decodeRecord<string>(row.text);
  }

  messageRaw(ref: ChatRef, seq: number) {
    const row = this.#db
      .select({ raw: messages.raw, rawZ: messages.rawZ })
      .from(messages)
      .where(
        and(chatScope(messages, this.resolveChat(ref)), eq(messages.seq, seq)),
      )
      .get();
    return row && (row.rawZ === null ? row.raw : decodeRecord(row.rawZ));
  }

  contextMessage(ref: ChatRef, seq: number, revision = 0) {
    const row = this.#db
      .select({
        albumId: messages.albumId,
        displayName: users.display,
        messageId: messages.messageId,
        metadata: messages.metadata,
        migratedFromChatId: messages.migratedFromChatId,
        recordedAt: messages.recordedAt,
        replyTo: messages.replyTo,
        revision: messages.revision,
        text: messages.text,
        userId: messages.userId,
      })
      .from(messages)
      .leftJoin(
        users,
        and(
          eq(users.adapterId, messages.adapterId),
          eq(users.userId, messages.userId),
        ),
      )
      .where(
        and(chatScope(messages, this.resolveChat(ref)), eq(messages.seq, seq)),
      )
      .get();
    if (!row || row.revision === revision) return row;
    const edit = this.#db
      .select({ metadata: messageEdits.metadata, text: messageEdits.text })
      .from(messageEdits)
      .where(
        and(eq(messageEdits.seq, seq), eq(messageEdits.revision, revision)),
      )
      .get();
    return (
      edit && { ...row, ...edit, replyTo: edit.metadata?.replyTo?.id ?? null }
    );
  }

  saveTrigger(decision: TriggerDecision, messageSeq?: number) {
    this.#db
      .insert(triggerDecisions)
      .values({ ...decision, messageSeq })
      .run();
  }

  triggerForTask({
    id,
    sourceMessageId,
    sourceChatId,
    ...ref
  }: TaskRecord): TriggerDecision | undefined {
    const columns = getColumns(triggerDecisions);
    const fields = {
      adapterId: columns.adapterId,
      chatId: columns.chatId,
      messageId: columns.messageId,
      at: columns.at,
      triggered: columns.triggered,
      reason: columns.reason,
      taskId: columns.taskId,
    };
    const decision = this.#db
      .select(fields)
      .from(triggerDecisions)
      .where(eq(triggerDecisions.taskId, id))
      .orderBy(triggerDecisions.id)
      .get();
    if (decision) return decision;
    const message = this.getMessage(ref, sourceMessageId, sourceChatId ?? '');
    return message && this.triggersForMessages([message.seq]).get(message.seq);
  }

  triggersForMessages(
    seqs: readonly number[],
  ): ReadonlyMap<number, TriggerDecision> {
    const result = new Map<number, TriggerDecision>();
    if (!seqs.length) return result;
    const { id, ...fields } = getColumns(triggerDecisions);
    const rows = this.#db
      .select(fields)
      .from(triggerDecisions)
      .where(
        and(
          inArray(triggerDecisions.messageSeq, [...seqs]),
          sql`${triggerDecisions.reason} <> 'duplicate'`,
        ),
      )
      .orderBy(desc(id))
      .all();
    for (const { messageSeq, ...row } of rows)
      if (messageSeq !== null && !result.has(messageSeq))
        result.set(messageSeq, row);
    return result;
  }

  recordUsage() {
    const { bytes, oldestFullTaskAt } = recordUsage(this.#db);
    return { bytes, oldestFullTaskAt: oldestFullTaskAt ?? undefined };
  }

  pruneRecords(maxBytes: number, active?: readonly ActiveTaskRefs[]) {
    return pruneRecords(this.#db, maxBytes, active);
  }

  getTask(id: string) {
    return this.#db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  createTask(task: TaskRecord) {
    const { chatId } = this.resolveChat(task);
    this.#db
      .insert(tasks)
      .values({
        ...task,
        chatId,
        sourceChatId:
          task.sourceChatId ?? (chatId === task.chatId ? null : task.chatId),
      })
      .run();
    this.#publishTask({ ...task, chatId });
  }

  updateTask(id: string, patch: Parameters<Store['updateTask']>[1]) {
    const task = this.#db
      .update(tasks)
      .set(patch)
      .where(eq(tasks.id, id))
      .returning()
      .get();
    if (task) this.#publishTask(task);
  }

  interruptTasks(now: number) {
    this.#db.transaction(
      (tx) => {
        tx.update(toolCalls)
          .set({ status: 'error', endedAt: now })
          .where(and(isNull(toolCalls.endedAt), isNull(toolCalls.status)))
          .run();
        tx.update(toolCalls)
          .set({ endedAt: now })
          .where(
            and(
              isNull(toolCalls.endedAt),
              eq(toolCalls.status, 'pending-approval'),
            ),
          )
          .run();
        const interrupted = tx
          .select()
          .from(tasks)
          .where(inArray(tasks.status, ['queued', 'running', 'sending']))
          .all();
        for (const task of interrupted) {
          if (task.status !== 'queued') {
            tx.update(chats)
              .set({ sessionAgentId: null, sessionModel: null })
              .where(chatScope(chats, task))
              .run();
          }
        }
        tx.update(tasks)
          .set({ status: 'cancelled', finishedAt: now })
          .where(inArray(tasks.status, ['queued', 'running']))
          .run();
        tx.update(tasks)
          .set({ status: 'delivery-unknown', finishedAt: now })
          .where(eq(tasks.status, 'sending'))
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  getOwner(adapterId: string) {
    return this.#db
      .select()
      .from(owners)
      .where(eq(owners.adapterId, adapterId))
      .get()?.userId;
  }

  savePairingCode(adapterId: string, digest: string, expiresAt: number) {
    this.#db.transaction(
      (tx) => {
        if (
          tx.select().from(owners).where(eq(owners.adapterId, adapterId)).get()
        )
          throw new Error('This adapter already has an owner');
        tx.insert(pairingCodes)
          .values({ adapterId, digest, expiresAt })
          .onConflictDoUpdate({
            target: pairingCodes.adapterId,
            set: { digest, expiresAt },
          })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  deletePairingCode(adapterId: string) {
    this.#db
      .delete(pairingCodes)
      .where(eq(pairingCodes.adapterId, adapterId))
      .run();
  }

  claimPairing(principal: PrincipalRef, digest: string, now: number) {
    return this.#db.transaction(
      (tx) => {
        const code = tx
          .select()
          .from(pairingCodes)
          .where(eq(pairingCodes.adapterId, principal.adapterId))
          .get();
        if (!code || code.expiresAt <= now) return false;
        const stored = Buffer.from(code.digest);
        const supplied = Buffer.from(digest);
        if (
          stored.length !== supplied.length ||
          !timingSafeEqual(stored, supplied)
        )
          return false;
        const row = tx
          .insert(owners)
          .values(principal)
          .onConflictDoNothing()
          .returning()
          .get();
        if (!row) return false;
        tx.delete(pairingCodes)
          .where(eq(pairingCodes.adapterId, principal.adapterId))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  createApproval(approval: ApprovalRecord) {
    const { chatId } = this.resolveChat(approval);
    const { resource, continuation } = approval;
    if (continuation?.kind === 'schedule') {
      const { change } = continuation;
      approval = {
        ...approval,
        continuation: {
          kind: 'schedule',
          change: {
            ...change,
            schedule: this.#resolveSchedule(change.schedule),
            previous: change.previous && this.#resolveSchedule(change.previous),
          },
        },
      };
    }
    this.#db
      .insert(approvals)
      .values({
        ...approval,
        chatId,
        resource:
          resource.type === 'chat'
            ? { ...resource, ...this.resolveChat(resource) }
            : resource,
      })
      .run();
    this.#publishApproval({ ...approval, chatId });
  }

  linkApproval(
    id: string,
    promptMessageId: string,
    promptFormat?: Parameters<Store['linkApproval']>[2],
  ) {
    this.#db
      .update(approvals)
      .set({ promptMessageId, promptFormat, migratedPrompt: null })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .run();
  }

  getApproval(id: string) {
    return this.#db.select().from(approvals).where(eq(approvals.id, id)).get();
  }

  listMigratedApprovalPrompts(adapterId: string, now: number) {
    return this.#db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.adapterId, adapterId),
          eq(approvals.status, 'pending'),
          isNotNull(approvals.migratedPrompt),
          gt(approvals.expiresAt, now),
        ),
      )
      .all();
  }

  listPendingApprovals(ref: ChatRef) {
    return this.#db
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(tasks, eq(tasks.id, approvals.taskId))
      .where(and(chatScope(tasks, ref), eq(approvals.status, 'pending')))
      .all()
      .map(({ approval }) => approval);
  }

  findApprovalByPrompt(ref: ChatRef, promptMessageId: string) {
    return this.#db
      .select()
      .from(approvals)
      .where(
        and(
          chatScope(approvals, ref),
          eq(approvals.promptMessageId, promptMessageId),
        ),
      )
      .get();
  }

  decideApproval(
    id: string,
    decision: Parameters<Store['decideApproval']>[1],
    grant?: StoredGrant,
    scheduleLimit?: number,
  ) {
    const change = this.#db.transaction(
      (tx) => {
        const approval = tx
          .update(approvals)
          .set(decision)
          .where(
            and(
              eq(approvals.id, id),
              eq(approvals.status, 'pending'),
              gt(approvals.expiresAt, decision.decidedAt),
            ),
          )
          .returning()
          .get();
        if (!approval) return;
        const continuation = approval.continuation;
        if (
          decision.status === 'approved' &&
          continuation?.kind === 'schedule'
        ) {
          const { schedule, previous } = continuation.change;
          const scheduleApplied =
            scheduleLimit !== undefined &&
            this.#saveSchedule(
              { ...schedule, deliveryApprovedBy: decision.decidedBy },
              scheduleLimit,
              previous,
            );
          if (scheduleApplied && grant) tx.insert(grants).values(grant).run();
          return {
            approval,
            result: { scheduleApplied },
            scheduleId: scheduleApplied ? schedule.id : undefined,
          };
        }
        if (grant) tx.insert(grants).values(grant).run();
        return { approval, result: {}, scheduleId: undefined };
      },
      { behavior: 'immediate' },
    );
    if (!change) return;
    this.#publishApproval(change.approval);
    if (change.scheduleId) this.#publishSchedule(change.scheduleId);
    return change.result;
  }

  cancelApproval(id: string, now: number) {
    const changed = this.#db
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: now })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .returning()
      .all();
    for (const approval of changed) this.#publishApproval(approval);
  }

  cancelChatApprovals(
    ref: ChatRef,
    now: number,
    sourceMessageId?: string,
    sourceChatId?: string,
  ) {
    const sources = this.#db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          chatScope(tasks, ref),
          sourceMessageId === undefined
            ? undefined
            : and(
                eq(tasks.sourceMessageId, sourceMessageId),
                sourceChatId === undefined
                  ? isNull(tasks.sourceChatId)
                  : eq(tasks.sourceChatId, sourceChatId),
              ),
        ),
      );
    const changed = this.#db
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: now })
      .where(
        and(
          inArray(approvals.taskId, sources),
          eq(approvals.status, 'pending'),
        ),
      )
      .returning()
      .all();
    for (const approval of changed) this.#publishApproval(approval);
  }

  expireApprovals(now: number, adapterIds: readonly string[]) {
    if (!adapterIds.length) return [];
    const changed = this.#db
      .update(approvals)
      .set({ status: 'expired', decidedAt: now })
      .where(
        and(
          eq(approvals.status, 'pending'),
          lte(approvals.expiresAt, now),
          inArray(approvals.adapterId, adapterIds),
          isNotNull(approvals.promptMessageId),
        ),
      )
      .returning()
      .all();
    for (const approval of changed) this.#publishApproval(approval);
    return changed;
  }

  insertGrant(grant: StoredGrant) {
    this.#db.insert(grants).values(grant).run();
  }

  consumeGrant(
    query: GrantQuery,
    now: number,
    matches: Parameters<Store['consumeGrant']>[2],
  ) {
    const schedule = query.resource.type === 'schedule';
    return this.#db.transaction(
      (tx) => {
        const candidates = tx
          .select()
          .from(grants)
          .where(
            and(
              eq(grants.adapterId, query.adapterId),
              schedule
                ? eq(grants.mode, 'always')
                : eq(grants.chatId, query.chatId),
              eq(grants.action, query.action),
              schedule ? undefined : eq(grants.grantedTo, query.requester),
              eq(grants.grantedBy, query.grantedBy),
              isNull(grants.revokedAt),
              isNull(grants.consumedAt),
            ),
          )
          .orderBy(grants.createdAt)
          .all();
        const eligible = candidates.filter((grant) =>
          matches(grant.scope, query.resource),
        );
        if (eligible.some((grant) => grant.mode === 'always')) return true;
        const once = eligible[0];
        if (!once) return false;
        tx.update(grants)
          .set({ consumedAt: now })
          .where(eq(grants.id, once.id))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  writeTraceSpans(spans: readonly TraceSpan[]) {
    if (spans.length)
      this.#db
        .insert(traceSpans)
        .values([...spans])
        .run();
  }
}
