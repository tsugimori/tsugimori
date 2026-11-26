import type {
  AdapterCursor,
  ChatRef,
  PreviewCloseReason,
  PrincipalRef,
} from '@tsugimori/plugin-sdk';
import type {
  AgentSession,
  ApprovalRecord,
  ChatRecord,
  ChatSummary,
  CommandScopeChat,
  GrantQuery,
  InboundRecord,
  NewMessage,
  ScheduleAddress,
  ScheduleRecord,
  ScheduleRun,
  SessionMetric,
  SetupRun,
  Store,
  StoredGrant,
  StoredPreview,
  TaskRecord,
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
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  adapterCursors,
  agentSessions,
  approvals,
  chats,
  chatSummaries,
  grants,
  messages,
  owners,
  pairingCodes,
  previews,
  scheduleRuns,
  schedules,
  sessionScope,
  setupRuns,
  setupSecrets,
  tasks,
  traceSpans,
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

function summaryRepair(seq: number) {
  return {
    revision: sql`${chatSummaries.revision} + 1`,
    text: sql`case when ${chatSummaries.throughSeq} >= ${seq} then '' else ${chatSummaries.text} end`,
    throughSeq: sql`case when ${chatSummaries.throughSeq} >= ${seq} then 0 else ${chatSummaries.throughSeq} end`,
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

  claimSetupRun(run: SetupRun, now: number) {
    return this.#db.transaction(
      (tx) => {
        if (
          tx
            .select({ id: setupRuns.id })
            .from(setupRuns)
            .where(gt(setupRuns.leaseUntil, now))
            .get()
        )
          return;
        const existing = tx
          .select()
          .from(setupRuns)
          .where(eq(setupRuns.id, run.id))
          .get();
        const claimed =
          existing?.status === 'pending'
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
    return this.#db.transaction(
      (tx) => this.#migrateChat(tx, ref, newChatId, title),
      { behavior: 'immediate' },
    );
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
      })
      .from(messages)
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

  listApprovals() {
    return this.#db
      .select()
      .from(approvals)
      .orderBy(desc(approvals.decidedAt), approvals.id)
      .limit(500)
      .all();
  }

  approvalStatus(ref: ChatRef, now: number) {
    return this.#db
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
  }

  listGrants() {
    return this.#db
      .select()
      .from(grants)
      .orderBy(desc(grants.createdAt))
      .limit(500)
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
          eq(sessionScope(traceSpans.attrs), scope),
          metric === 'compaction'
            ? eq(traceSpans.name, 'agent.compaction')
            : sql`json_extract(${traceSpans.attrs}, '$.contextTokens') is not null`,
        ),
      )
      .orderBy(desc(traceSpans.id))
      .get();
  }

  getWorkspaceSettings(ref: ChatRef) {
    return this.#db
      .select()
      .from(workspaceSettings)
      .where(chatScope(workspaceSettings, ref))
      .get()?.settings;
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
    return this.#db.transaction(() => this.#saveSchedule(schedule, limit), {
      behavior: 'immediate',
    });
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
    return this.#db.select().from(schedules).where(eq(schedules.id, id)).get();
  }

  listSchedules(ref: ChatRef) {
    return this.#db
      .select()
      .from(schedules)
      .where(chatScope(schedules, ref))
      .all();
  }

  scheduleStatus(adapterId: string, target: ScheduleAddress) {
    const filter = and(
      eq(schedules.status, 'active'),
      eq(schedules.adapterId, adapterId),
      eq(sql`json_extract(${schedules.target}, '$.chatId')`, target.chatId),
      sql`json_extract(${schedules.target}, '$.threadId') is ${target.threadId ?? null}`,
    );
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
        })
        .from(schedules)
        .where(and(filter, isNotNull(schedules.nextDueAt)))
        .orderBy(asc(schedules.nextDueAt), asc(schedules.id))
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
      .all();
  }

  updateSchedule(
    schedule: ScheduleRecord,
    expected: ScheduleRecord,
    limit: number,
  ) {
    return this.#db.transaction(
      () => this.#saveSchedule(schedule, limit, expected),
      { behavior: 'immediate' },
    );
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
  ) {
    return this.#db.transaction(
      (tx) => {
        if (schedule.nextDueAt === null) return false;
        const advanced = tx
          .update(schedules)
          .set({
            nextDueAt,
            status: nextDueAt === null ? 'done' : 'active',
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
        if (!advanced) return false;
        return !!tx
          .insert(scheduleRuns)
          .values(run)
          .onConflictDoNothing()
          .returning({ id: scheduleRuns.scheduleId })
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  finishScheduleRun(run: ScheduleRun) {
    this.#db
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
  }

  setChatRoute(
    ref: ChatRef,
    route: Partial<Pick<ChatRecord, 'agentId' | 'model'>>,
  ) {
    this.#db
      .update(chats)
      .set({ ...route, sessionAgentId: null, sessionModel: null })
      .where(chatScope(chats, ref))
      .run();
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
    return this.#db.transaction((tx) => {
      const insert = tx.insert(messages).values(message);
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
              set: { text: message.text, raw: message.raw },
            })
          : insert.onConflictDoNothing()
      )
        .returning()
        .get();
      if (!result) return;
      if (edited)
        tx.update(chatSummaries)
          .set(summaryRepair(result.seq))
          .where(chatScope(chatSummaries, chat))
          .run();
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
  }

  recordOutbound(message: NewMessage, taskId?: string) {
    const { chatId } = this.resolveChat(message);
    if (chatId !== message.chatId)
      message = { ...message, chatId, migratedFromChatId: message.chatId };
    this.#db.transaction((tx) => {
      tx.insert(messages).values(message).onConflictDoNothing().run();
      if (taskId) {
        tx.update(tasks)
          .set({ status: 'sent', finishedAt: Date.now() })
          .where(eq(tasks.id, taskId))
          .run();
      }
    });
  }

  getMessage(ref: ChatRef, messageId: string, migratedFromChatId?: string) {
    return this.#db
      .select()
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
  }

  markDeleted(ref: ChatRef, messageId: string, migratedFromChatId = '') {
    this.#db.transaction((tx) => {
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
        .returning({ seq: messages.seq })
        .all();
      if (deleted.length)
        tx.update(chatSummaries)
          .set(summaryRepair(Math.min(...deleted.map(({ seq }) => seq))))
          .where(chatScope(chatSummaries, ref))
          .run();
    });
  }

  getSummary(ref: ChatRef) {
    return this.#db
      .select()
      .from(chatSummaries)
      .where(chatScope(chatSummaries, ref))
      .get();
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
    return !!this.#db
      .update(chatSummaries)
      .set({
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
      .returning({ revision: chatSummaries.revision })
      .get();
  }

  summaryMessages(
    ref: ChatRef,
    afterSeq: number,
    throughSeq: number,
    limit: number,
  ) {
    return this.#db
      .select()
      .from(messages)
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
      .all();
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
    const query = this.#db
      .select()
      .from(messages)
      .where(filter)
      .orderBy(desc(messages.seq));
    return (resumed ? query.all() : query.limit(options.limit).all()).reverse();
  }

  getSession(ref: ChatRef, agentId: string, model: string) {
    const chat = this.#db
      .select()
      .from(chats)
      .where(chatScope(chats, ref))
      .get();
    if (chat?.sessionAgentId !== agentId || chat.sessionModel !== model) return;
    return this.#db
      .select()
      .from(agentSessions)
      .where(
        and(
          chatScope(agentSessions, ref),
          eq(agentSessions.agentId, agentId),
          eq(agentSessions.model, model),
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
  }

  updateTask(id: string, patch: Parameters<Store['updateTask']>[1]) {
    this.#db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
  }

  interruptTasks(now: number) {
    this.#db.transaction(
      (tx) => {
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
    this.#db
      .insert(pairingCodes)
      .values({ adapterId, digest, expiresAt })
      .onConflictDoUpdate({
        target: pairingCodes.adapterId,
        set: { digest, expiresAt },
      })
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
        if (!code || code.digest !== digest || code.expiresAt <= now)
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
    return this.#db.transaction(
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
          return { scheduleApplied };
        }
        if (grant) tx.insert(grants).values(grant).run();
        return {};
      },
      { behavior: 'immediate' },
    );
  }

  cancelApproval(id: string, now: number) {
    this.#db
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: now })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .run();
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
    this.#db
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: now })
      .where(
        and(
          inArray(approvals.taskId, sources),
          eq(approvals.status, 'pending'),
        ),
      )
      .run();
  }

  expireApprovals(now: number, adapterIds: readonly string[]) {
    if (!adapterIds.length) return [];
    return this.#db
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
