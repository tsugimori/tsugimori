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
  GrantQuery,
  InboundRecord,
  NewMessage,
  ScheduleRecord,
  ScheduleRun,
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
  isNull,
  lt,
  lte,
  notInArray,
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
  setupRuns,
  setupSecrets,
  tasks,
  traceSpans,
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
  }

  close() {
    this.#sqlite.close();
  }

  getChat(ref: ChatRef): ChatRecord | undefined {
    return this.#db.select().from(chats).where(chatScope(chats, ref)).get();
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
    return this.#db.transaction(
      () => {
        if (!this.#hasScheduleCapacity(schedule, limit)) return false;
        this.#db.insert(schedules).values(schedule).run();
        return true;
      },
      { behavior: 'immediate' },
    );
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
      () => {
        if (
          schedule.status === 'active' &&
          (expected.status === 'done' || expected.status === 'cancelled') &&
          !this.#hasScheduleCapacity(schedule, limit)
        )
          return false;
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
      },
      { behavior: 'immediate' },
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
      .set({ allowlisted })
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

  getMessage(ref: ChatRef, messageId: string) {
    return this.#db
      .select()
      .from(messages)
      .where(and(chatScope(messages, ref), eq(messages.messageId, messageId)))
      .orderBy(messages.direction)
      .get();
  }

  markDeleted(ref: ChatRef, messageId: string) {
    this.#db.transaction((tx) => {
      const deleted = tx
        .update(messages)
        .set({ deleted: true })
        .where(
          and(
            chatScope(messages, ref),
            eq(messages.messageId, messageId),
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
      .set({ text: summary.text, throughSeq: summary.throughSeq })
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
    const { agentId, model, sessionId, throughSeq, seenAfter } = session;
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
          set: { sessionId, throughSeq, seenAfter },
        })
        .run();
      tx.update(chats)
        .set({ sessionAgentId: agentId, sessionModel: model })
        .where(chatScope(chats, session))
        .run();
    });
  }

  clearSession(ref: ChatRef) {
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
    this.#db.insert(tasks).values(task).run();
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
        tx.update(approvals)
          .set({ status: 'cancelled', decidedAt: now })
          .where(eq(approvals.status, 'pending'))
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
    this.#db.insert(approvals).values(approval).run();
  }

  linkApproval(id: string, promptMessageId: string) {
    this.#db
      .update(approvals)
      .set({ promptMessageId })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .run();
  }

  getApproval(id: string) {
    return this.#db.select().from(approvals).where(eq(approvals.id, id)).get();
  }

  findApprovalByPrompt(ref: ChatRef, promptMessageId: string) {
    return this.#db
      .select()
      .from(approvals)
      .where(
        and(
          chatScope(approvals, ref),
          eq(approvals.promptMessageId, promptMessageId),
          eq(approvals.status, 'pending'),
        ),
      )
      .get();
  }

  decideApproval(
    id: string,
    decision: Parameters<Store['decideApproval']>[1],
    grant?: StoredGrant,
  ) {
    return this.#db.transaction(
      (tx) => {
        const approval = tx
          .update(approvals)
          .set(decision)
          .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
          .returning()
          .get();
        if (!approval) return false;
        if (grant) tx.insert(grants).values(grant).run();
        return true;
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

  cancelApprovals(taskId: string, now: number) {
    this.#db
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: now })
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
      .run();
  }

  insertGrant(grant: StoredGrant) {
    this.#db.insert(grants).values(grant).run();
  }

  consumeGrant(
    query: GrantQuery,
    now: number,
    matches: Parameters<Store['consumeGrant']>[2],
  ) {
    return this.#db.transaction(
      (tx) => {
        const candidates = tx
          .select()
          .from(grants)
          .where(
            and(
              chatScope(grants, query),
              eq(grants.action, query.action),
              eq(grants.grantedTo, query.requester),
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
