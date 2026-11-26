import type {
  AdapterContext,
  AgentConnector,
  ApprovalFeedback,
  ChatRef,
  InboundMessage,
  OutboundMessage,
  PluginDefinition,
} from '@tsugimori/plugin-sdk';
import type { TestContext } from 'node:test';

import { loadSettings } from '@tsugimori/config';
import { credentialKey } from '@tsugimori/plugin-sdk';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { formatRemovalPlan, Gateway, PluginRegistry } from '../src/index.ts';

async function workspaceFixture(
  t: TestContext,
  locale = 'zh-TW',
  run: (id: string) => AgentConnector['run'] = () => async function* () {},
  menu: 'telegram' | 'line' | 'none' = 'none',
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsm-remove-'));
  const inbox = new Map<string, AdapterContext>();
  const sent: {
    adapterId: string;
    buttons?: OutboundMessage['buttons'];
    id: string;
    text: string;
  }[] = [];
  const feedback: ApprovalFeedback[] = [];
  const stopped: string[] = [];
  const fake = {
    name: 'fake',
    adapters: {
      [menu === 'line' ? 'line' : 'fake']: ({ id }) => ({
        id,
        kind: menu === 'line' ? 'line' : 'fake',
        capabilities: { inlineButtons: menu === 'telegram' },
        async respondToApproval(result) {
          feedback.push(result);
        },
        async start(ctx) {
          inbox.set(id, ctx);
        },
        async stop() {
          inbox.delete(id);
          stopped.push(id);
        },
        async send({ text, buttons }) {
          const messageId = 'bot-' + (sent.length + 1);
          sent.push({ adapterId: id, id: messageId, text, buttons });
          return { messageId };
        },
      }),
    },
    agents: {
      fake: ({ id }) => ({
        id,
        kind: 'fake',
        loop: 'external',
        run: run(id),
        async stop() {
          stopped.push(id);
        },
      }),
      codex: ({ id }) => ({
        id,
        kind: 'codex',
        loop: 'external',
        run: run(id),
        async stop() {
          stopped.push(id);
        },
      }),
    },
    managedRuntimePaths: (workspace, entry) =>
      'version' in entry && typeof entry.version === 'string'
        ? [join(workspace, 'runtime', 'codex', entry.version)]
        : [],
  } satisfies PluginDefinition;
  const registry = new PluginRegistry([fake]);
  const setupOnly = credentialKey('TELEGRAM_BOT_TOKEN', 'old');
  await writeFile(
    join(workspace, 'tsugimori.json'),
    JSON.stringify({
      owner: { console: '42', old: '81' },
      defaultAgent: 'main',
      locale,
      storage: { kind: 'sqlite', path: 'state.db' },
      platforms: [
        {
          id: 'console',
          kind: menu === 'line' ? 'line' : 'fake',
          tokenEnv: 'SHARED_TEST_TOKEN',
        },
        {
          id: 'old',
          kind: menu === 'line' ? 'line' : 'fake',
          tokenEnv: 'SHARED_TEST_TOKEN',
          options: { secretEnv: 'ONLY_PROCESS_TEST' },
        },
      ],
      agents: [
        { id: 'main', kind: 'codex', version: '1.2.3' },
        {
          id: 'worker',
          kind: 'codex',
          version: '1.2.3',
          options: {
            codexHome: 'agents/custom-home',
            tokenEnv: 'WORKER_TOKEN',
          },
        },
      ],
    }),
  );
  await writeFile(
    join(workspace, '.env'),
    `SHARED_TEST_TOKEN=shared-test\nWORKER_TOKEN=worker-test\n${setupOnly}=previous-test\n`,
  );
  const store = new SqliteStore(join(workspace, 'state.db'));
  const gateway = new Gateway({
    registry,
    store,
    workspace,
    setup: {
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    log: () => {},
  });
  t.after(async () => {
    await gateway.stop();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  await gateway.start();
  let serial = 0;
  const emit = (text: string, overrides: Partial<InboundMessage> = {}) =>
    inbox.get('console')!.emit({
      type: 'message',
      chatKind: 'group',
      chatId: 'chat',
      userId: '42',
      messageId: String(++serial),
      text,
      ...overrides,
    });
  return {
    emit,
    feedback,
    gateway,
    inbox,
    registry,
    sent,
    setupOnly,
    stopped,
    store,
    workspace,
  };
}

function seedChat(store: SqliteStore, ref: ChatRef) {
  store.recordInbound(
    { ...ref, kind: 'dm', title: null },
    { adapterId: ref.adapterId, userId: 'u', display: null },
    {
      ...ref,
      messageId: 'seed',
      direction: 'inbound',
      userId: 'u',
      text: 'test',
      raw: null,
      replyTo: null,
      threadId: null,
    },
  );
}

function seedToolCall(store: SqliteStore, ref: ChatRef, agentId: string) {
  const id = ref.adapterId + ref.chatId;
  store.createTask({
    ...ref,
    id,
    agentId,
    model: 'default',
    sourceMessageId: 'seed',
    createdAt: 1,
    startedAt: 1,
    finishedAt: 5,
    status: 'completed',
  });
  const seq = store.createToolCall({
    taskId: id,
    name: 'test.tool',
    approvalId: null,
    args: '{"value":42}',
    callId: 'call',
    startedAt: 2,
    endedAt: 4,
    result: 'done',
    status: 'ok',
  });
  assert.ok(seq);
  return id;
}

function seedSession(store: SqliteStore, ref: ChatRef, agentId: string) {
  store.setSession({
    ...ref,
    agentId,
    model: 'default',
    sessionId: agentId,
    throughSeq: 1,
    seenAfter: [],
  });
}

function seedSchedule(
  store: SqliteStore,
  ref: ChatRef,
  id: string,
  kind: 'agent' | 'message' = 'agent',
) {
  const at = Date.now() + 86_400_000;
  store.createSchedule(
    {
      ...ref,
      id,
      createdBy: 'u',
      deliveryApprovedBy: null,
      mentions: [],
      action:
        kind === 'agent'
          ? { kind, prompt: 'scheduled turn' }
          : { kind, text: 'reminder' },
      address: { chatId: ref.chatId },
      target: { chatId: ref.chatId },
      missed: 'latest',
      nextDueAt: at,
      status: 'active',
      timezone: 'UTC',
      trigger: { kind: 'once', at },
    },
    Infinity,
  );
}

function seedSetup(
  store: SqliteStore,
  category: 'agent' | 'platform',
  id: string,
) {
  const now = Date.now();
  return store.claimSetupRun(
    {
      id: JSON.stringify(['add', category, id]),
      category,
      mode: 'add',
      step: 1,
      lease: 'test-lease',
      leaseUntil: now + 60_000,
      status: 'pending',
      draft: {
        entry: {
          id,
          kind: 'fake',
          ...(category === 'platform' && {
            tokenEnv: credentialKey('TELEGRAM_BOT_TOKEN', id),
          }),
        },
      },
    },
    now,
  )!;
}

async function backupPath(workspace: string) {
  const root = join(workspace, 'data', 'backups');
  const directories = await readdir(root);
  assert.equal(directories.length, 1);
  return join(root, directories[0]!);
}

test('chat platform removal authorizes a linked owner reply and backs up only affected data', async (t) => {
  const { emit, inbox, registry, sent, setupOnly, stopped, store, workspace } =
    await workspaceFixture(t);
  const old = { adapterId: 'old', chatId: 'removed-dm' };
  const kept = { adapterId: 'console', chatId: 'remaining-dm' };
  for (const ref of [old, kept]) {
    seedChat(store, ref);
    seedSession(store, ref, 'main');
    seedSchedule(store, ref, ref.adapterId);
    store.markSetupSecret(ref, 'private');
    store.saveCursor(ref.adapterId, 'updates', {
      offset: 2,
      updatedAt: Date.now(),
    });
  }
  const removedTask = seedToolCall(store, old, 'main');
  const keptTask = seedToolCall(store, kept, 'main');
  const run = seedSetup(store, 'platform', 'old');
  assert.ok(
    store.saveSetupRun(
      { ...run, status: 'complete', lease: null, leaseUntil: 0 },
      'test-lease',
    ),
  );
  const oldDir = join(workspace, 'chats', 'old', old.chatId);
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'note.md'), 'chat note');
  process.env.ONLY_PROCESS_TEST = 'process-value';
  t.after(() => {
    delete process.env.ONLY_PROCESS_TEST;
  });

  await emit('/remove platform old', { userId: 'member' });
  assert.equal(sent.length, 0);
  await emit('/remove platform old');
  const first = sent.at(-1)!;
  assert.equal(
    first.text,
    [
      '移除清單',
      '設定項目 (1) · platforms[] old (fake)',
      `移除 .env 變數 (1) · ${setupOnly}`,
      '僅存在程序環境（不受管理，保留原狀） (1) · ONLY_PROCESS_TEST',
      '移入備份的目錄 (1) · chats/old',
      '刪除對話 (1) · removed-dm',
      '移除擁有者設定 (1) · owner.old',
      '資料庫筆數 · approvals=0, grants=0, messages=1, chat_summaries=0, agent_sessions=1, tasks=1, schedules=1, previews=0, chat_workspace_settings=0, setup_secrets=1, unavailable_command_scopes=0, users=1, owners=0, adapter_cursors=1, pairing_codes=0, chats=1, schedule_runs=0, setup_runs=1, trace_spans=1, tool_calls=1',
      '取消進行中的任務 (0) · —',
      '取消排程 (1) · old',
      '',
      '請回覆這則訊息 yes 以刪除，其他回覆會取消。10 分鐘後逾時，也可傳送 /cancel。',
    ].join('\n'),
  );
  await emit('yes', { replyTo: { id: first.id }, userId: 'member' });
  await emit('yes', { replyTo: { id: first.id }, chatId: 'another-chat' });
  assert.ok(inbox.has('old'));
  await emit('no', { replyTo: { id: first.id } });
  assert.equal(sent.at(-1)?.text, '已取消移除。');
  await emit('/remove platform old');
  await emit('/cancel');
  assert.equal(sent.at(-1)?.text, '已取消移除。');
  await emit('/remove platform old');
  await emit('yes', { replyTo: { id: sent.at(-1)!.id }, edited: true });
  assert.ok(inbox.has('old'));
  await emit('yes', { replyTo: { id: sent.at(-1)!.id } });

  assert.match(sent.at(-1)!.text, /^已移除 平台 old。/);
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual([...inbox.keys()], ['console']);
  const config = await loadSettings(workspace, registry);
  assert.deepEqual(
    config.platforms.map(({ id }) => id),
    ['console'],
  );
  assert.deepEqual(config.owner, { console: '42' });
  assert.equal(store.getChat(old), undefined);
  assert.deepEqual(store.taskToolCalls([removedTask]), []);
  assert.equal(store.taskToolCalls([keptTask]).length, 1);
  assert.equal(store.getMessage(old, 'seed'), undefined);
  assert.equal(store.getSchedule('old'), undefined);
  assert.equal(store.isSetupSecret(old, 'private'), false);
  assert.equal(store.getCursor('old', 'updates'), undefined);
  assert.equal(store.getSetupRun(run.id), undefined);
  assert.equal(store.getSession(kept, 'main')?.sessionId, 'main');
  assert.equal(store.getSchedule('console')?.status, 'active');
  assert.deepEqual([...process.env.ONLY_PROCESS_TEST!], [...'process-value']);
  assert.equal(
    await readFile(join(workspace, '.env'), 'utf8'),
    'SHARED_TEST_TOKEN=shared-test\nWORKER_TOKEN=worker-test\n',
  );
  await assert.rejects(lstat(oldDir), { code: 'ENOENT' });

  const backup = await backupPath(workspace);
  assert.equal((await lstat(backup)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(backup, 'removed.env'))).mode & 0o777, 0o600);
  assert.equal(
    await readFile(join(backup, 'removed.env'), 'utf8'),
    `${setupOnly}=previous-test\n`,
  );
  const entry = JSON.parse(await readFile(join(backup, 'entry.json'), 'utf8'));
  assert.equal(entry.entry.id, 'old');
  assert.deepEqual(entry.owner, { old: '81' });
  assert.equal(
    await readFile(
      join(backup, 'directory-1', 'old', old.chatId, 'note.md'),
      'utf8',
    ),
    'chat note',
  );
  const sqlite = new DatabaseSync(join(backup, 'tsugimori.db'), {
    readOnly: true,
  });
  try {
    assert.equal(
      sqlite
        .prepare('SELECT count(*) AS n FROM messages WHERE adapter_id = ?')
        .get('old')?.n,
      1,
    );
    assert.equal(
      sqlite
        .prepare('SELECT count(*) AS n FROM tool_calls WHERE task_id = ?')
        .get(removedTask)?.n,
      1,
    );
  } finally {
    sqlite.close();
  }
});

test('agent removal clears only its routes, sessions and agent schedules', async (t) => {
  const { gateway, store, stopped, workspace } = await workspaceFixture(t);
  const bound = { adapterId: 'console', chatId: 'bound' };
  const kept = { adapterId: 'console', chatId: 'kept' };
  for (const ref of [bound, kept]) seedChat(store, ref);
  seedSession(store, bound, 'main');
  seedSession(store, bound, 'worker');
  seedSession(store, kept, 'main');
  store.setChatRoute(
    bound,
    {
      agentId: 'worker',
      model: 'custom',
      serviceTier: 'fast',
      thinking: 'high',
    },
    false,
  );
  store.setChatRoute(kept, { agentId: 'main', serviceTier: 'standard' }, false);
  store.setWorkspaceSettings(bound, { agentId: 'worker', thinking: 'high' });
  seedSchedule(store, bound, 'cancel-me');
  seedSchedule(store, bound, 'fixed', 'message');
  seedSchedule(store, kept, 'keep-me');
  const file = join(workspace, 'chats', 'console', 'bound', 'agents.json');
  await mkdir(join(workspace, 'chats', 'console', 'bound'), {
    recursive: true,
  });
  await writeFile(
    file,
    JSON.stringify({
      agentId: 'worker',
      model: 'custom',
      thinking: 'high',
      fast: true,
      futureKey: true,
    }),
  );
  await mkdir(join(workspace, 'agents', 'custom-home'), { recursive: true });
  await writeFile(
    join(workspace, 'agents', 'custom-home', 'login.json'),
    'test fixture',
  );
  await mkdir(join(workspace, 'runtime', 'codex', '1.2.3'), {
    recursive: true,
  });

  const removedTask = seedToolCall(store, bound, 'worker');
  const keptTask = seedToolCall(store, kept, 'main');
  const plan = await gateway.removal.plan({ category: 'agent', id: 'worker' });
  assert.equal(
    formatRemovalPlan(plan, true),
    [
      '移除清單',
      '設定項目 (1) · agents[] worker (codex)',
      '移除 .env 變數 (1) · WORKER_TOKEN',
      '僅存在程序環境（不受管理，保留原狀） (0) · —',
      '移入備份的目錄 (1) · agents/custom-home',
      '保留共用目錄 (1) · runtime/codex/1.2.3',
      '工作區預設代理：否',
      '清除對話的代理、模型、推理與快速模式覆寫 (1) · console/bound',
      '清除資料庫中的對話代理預設 (1) · console/bound',
      '清除 agents.json 內的代理預設 (1) · chats/console/bound/agents.json',
      '資料庫筆數 · agent_sessions=1, setup_runs=0, chat_session_pointers=1, pending_approvals=0, tool_calls=1',
      '取消進行中的任務 (0) · —',
      '取消排程 (1) · cancel-me',
      '',
      '請回覆這則訊息 yes 以刪除，其他回覆會取消。10 分鐘後逾時，也可傳送 /cancel。',
    ].join('\n'),
  );
  assert.match(await gateway.removeInstance(plan), /^已移除 代理 worker。/);
  assert.deepEqual(stopped, ['worker']);
  assert.equal(store.getSession(bound, 'worker'), undefined);
  assert.deepEqual(store.taskToolCalls([removedTask]), []);
  assert.equal(store.taskToolCalls([keptTask]).length, 1);
  assert.equal(store.getSession(kept, 'main')?.sessionId, 'main');
  assert.equal(store.getChat(bound)?.agentId, null);
  assert.equal(store.getChat(bound)?.thinking, null);
  assert.equal(store.getChat(bound)?.serviceTier, null);
  assert.equal(store.getChat(kept)?.serviceTier, 'standard');
  assert.deepEqual(store.getWorkspaceSettings(bound), {});
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    futureKey: true,
  });
  assert.equal(store.getSchedule('cancel-me')?.status, 'cancelled');
  assert.equal(store.getSchedule('fixed')?.status, 'active');
  assert.equal(store.getSchedule('keep-me')?.status, 'active');
  const backup = await backupPath(workspace);
  const db = new DatabaseSync(join(backup, 'tsugimori.db'), { readOnly: true });
  try {
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM tool_calls WHERE task_id = ?')
        .get(removedTask)?.n,
      1,
    );
  } finally {
    db.close();
  }
  assert.equal(
    await readFile(
      join(backup, 'directory-1', 'custom-home', 'login.json'),
      'utf8',
    ),
    'test fixture',
  );
  assert.ok(
    (await lstat(join(workspace, 'runtime', 'codex', '1.2.3'))).isDirectory(),
  );
});

test('chat removal refuses unknown, originating, default, and in-setup instances', async (t) => {
  const { emit, sent, store } = await workspaceFixture(t, 'en');
  await emit('/remove platform nonexistent');
  assert.match(sent.at(-1)!.text, /Configured IDs \(2\) · console, old/);
  await emit('/remove platform console');
  assert.match(sent.at(-1)!.text, /Use another platform or the CLI/);
  await emit('/remove agent main');
  assert.match(sent.at(-1)!.text, /defaultAgent to another agent.*worker/);
  seedSetup(store, 'agent', 'worker');
  await emit('/remove agent worker');
  assert.match(
    sent.at(-1)!.text,
    /Guided setup is active for worker.*\/cancel/,
  );
});

test('removing an agent interrupts its running task and leaves the other agent running', async (t) => {
  const main = Promise.withResolvers<AbortSignal>();
  const worker = Promise.withResolvers<AbortSignal>();
  const { emit, gateway, store } = await workspaceFixture(
    t,
    'en',
    (id) =>
      async function* ({ signal }) {
        (id === 'worker' ? worker : main).resolve(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
  );
  const bound = { adapterId: 'console', chatId: 'worker-chat' };
  const kept = { adapterId: 'console', chatId: 'main-chat' };
  seedChat(store, bound);
  seedChat(store, kept);
  store.setChatRoute(bound, { agentId: 'worker' }, false);
  await emit('start worker turn', { chatId: bound.chatId, chatKind: 'dm' });
  await emit('start main turn', { chatId: kept.chatId, chatKind: 'dm' });
  const [mainSignal, workerSignal] = await Promise.all([
    main.promise,
    worker.promise,
  ]);
  const taskId = store.listChatTasks(bound)[0]!.id;
  const plan = await gateway.removal.plan({ category: 'agent', id: 'worker' });
  assert.deepEqual(plan.rows.tasks, [taskId]);
  await gateway.removeInstance(plan);
  assert.equal(workerSignal.aborted, true);
  assert.equal(store.getTask(taskId)?.status, 'cancelled');
  assert.equal(mainSignal.aborted, false);
  assert.equal(store.listChatTasks(kept)[0]?.status, 'running');
});

test('a failed SQLite purge reports completed work and preserves the backed-up data', async (t) => {
  const { gateway, registry, store, workspace } = await workspaceFixture(
    t,
    'en',
  );
  const chat = { adapterId: 'old', chatId: 'saved' };
  seedChat(store, chat);
  const directory = join(workspace, 'chats', 'old', chat.chatId);
  await mkdir(directory, { recursive: true });
  const plan = await gateway.removal.plan({ category: 'platform', id: 'old' });
  t.mock.method(store, 'deleteInstanceData', () => {
    throw new Error('sensitive underlying error');
  });
  await assert.rejects(gateway.removeInstance(plan), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Removal stopped.*SQLite rows/);
    assert.match(error.message, /Backup · .*remove-platform-old/);
    assert.match(error.message, /Detached the instance/);
    assert.match(error.message, /Updated the configuration/);
    assert.doesNotMatch(error.message, /sensitive underlying error|Moved/);
    return true;
  });
  assert.ok(store.getChat(chat));
  assert.ok((await lstat(directory)).isDirectory());
  assert.deepEqual(
    (await loadSettings(workspace, registry)).platforms.map(({ id }) => id),
    ['console'],
  );
  assert.ok(
    (await lstat(join(await backupPath(workspace), 'tsugimori.db'))).isFile(),
  );
});

test('remove menus hide protected instances and require an owner press to open the plan', async (t) => {
  const { emit, sent, feedback, inbox } = await workspaceFixture(
    t,
    'zh-TW',
    undefined,
    'telegram',
  );
  await emit('/remove');
  const menu = sent.at(-1)!;
  assert.deepEqual(
    menu.buttons?.map(({ label }) => label),
    ['平台', '代理'],
  );
  const press = (prompt: typeof menu, index: number, userId = '42') =>
    inbox.get('console')!.emit({
      type: 'callback',
      chatId: 'chat',
      messageId: prompt.id,
      callbackId: prompt.buttons![index]!.id,
      queryId: 'query',
      userId,
    });
  await press(menu, 0);
  const platforms = sent.at(-1)!;
  assert.match(platforms.text, /console（fake）.*另一個平台或 CLI/);
  assert.match(platforms.text, /old（fake）/);
  assert.deepEqual(
    platforms.buttons?.map(({ label }) => label),
    ['old'],
  );
  await press(platforms, 0, 'member');
  assert.equal(sent.at(-1), platforms);
  assert.ok(feedback.at(-1)?.notice);
  await press(platforms, 0);
  assert.match(sent.at(-1)!.text, /^移除清單[\s\S]*platforms\[\] old/);
  assert.deepEqual(
    sent.at(-1)?.buttons?.map(({ label }) => label),
    ['刪除', '取消'],
  );
  await emit('/cancel');
  await emit('/remove agent');
  const agents = sent.at(-1)!;
  assert.match(agents.text, /main（codex）.*預設代理/);
  assert.match(agents.text, /worker（codex）/);
  assert.deepEqual(
    agents.buttons?.map(({ label }) => label),
    ['worker'],
  );
});

test('LINE shows removal categories and a text command hint', async (t) => {
  const { emit, sent } = await workspaceFixture(t, 'zh-TW', undefined, 'line');
  await emit('/remove');
  assert.match(sent.at(-1)!.text, /平台（platform）、代理（agent）/);
  assert.equal(sent.at(-1)!.buttons, undefined);
  await emit('/remove platform');
  assert.match(
    sent.at(-1)!.text,
    /old（line）[\s\S]*傳送 \/remove platform <id>/,
  );
  assert.equal(sent.at(-1)!.buttons, undefined);
  await emit('/remove platform old');
  await emit('yes', { replyTo: { id: sent.at(-1)!.id } });
  await emit('/remove platform');
  assert.match(sent.at(-1)!.text, /沒有可在此移除的項目/);
  assert.equal(sent.at(-1)!.buttons, undefined);
});
