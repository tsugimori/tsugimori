import type {
  AdapterContext,
  AgentConnector,
  AgentRequest,
  ApprovalFeedback,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PluginDefinition,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';

import { SqliteStore } from '@tsugimori/storage-sqlite';
import { Tracer } from '@tsugimori/trace';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '../src/index.ts';

import { Gateway, PluginRegistry, shouldTrigger } from '../src/index.ts';

const adapterId = 'fake:main';
const chat = { adapterId, chatId: 'room' };

function inbound(
  messageId: string,
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    type: 'message',
    chatId: chat.chatId,
    chatKind: 'dm',
    messageId,
    text,
    userId: 'owner',
    ...overrides,
  };
}

function createPlatform() {
  let context: AdapterContext | undefined;
  let starts = 0;
  const sent: (OutboundMessage & { messageId: string })[] = [];
  const feedback: ApprovalFeedback[] = [];
  const platform: PlatformAdapter = {
    id: adapterId,
    kind: 'fake',
    capabilities: { deleteEvents: true, inlineButtons: true },
    start(ctx) {
      context = ctx;
      starts++;
      return Promise.resolve();
    },
    stop() {
      context = undefined;
      return Promise.resolve();
    },
    send(message) {
      const messageId = `bot-${sent.length + 1}`;
      sent.push({ ...message, messageId });
      return Promise.resolve({ messageId, raw: { delivered: true } });
    },
    respondToApproval(response) {
      feedback.push(response);
      return Promise.resolve();
    },
  };
  return {
    platform,
    sent,
    feedback,
    get starts() {
      return starts;
    },
    async emit(event: Parameters<AdapterContext['emit']>[0]) {
      assert.ok(context, 'adapter attached');
      await context.emit(event);
    },
    getUser(userId: string) {
      return context?.getUser?.(userId);
    },
  };
}

async function fixture(
  t: TestContext,
  run: AgentConnector['run'],
  enableAgent = true,
  options: {
    context?: { recentMessages: number; summary?: { model: string } };
    locale?: 'en' | 'zh-TW';
    plugins?: PluginDefinition[];
    previews?: { named?: TunnelProvider; quick: TunnelProvider };
  } = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-gateway-'));
  const path = join(workspace, 'tsugimori.json');
  const store = new SqliteStore(':memory:');
  const trace = new Tracer(store, { ringSize: 500 });
  const platform = createPlatform();
  let agentStarts = 0;
  let agentStops = 0;
  const registry = new PluginRegistry([
    ...(options.plugins ?? []),
    {
      name: 'test',
      adapters: { fake: () => platform.platform },
      agents: {
        fake: ({ id }) => ({
          id,
          kind: 'fake',
          loop: 'external',
          run,
          start() {
            agentStarts++;
            return Promise.resolve();
          },
          stop() {
            agentStops++;
            return Promise.resolve();
          },
        }),
      },
      tools: [
        {
          name: 'scoped_tool',
          description: 'A permission-gated test operation',
          schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          permission: {
            action: 'test.use',
            describe: () => '🔔 Sample text\n你好😀',
            resource: (args) => {
              assert.ok(
                args &&
                  typeof args === 'object' &&
                  'id' in args &&
                  typeof args.id === 'string',
              );
              return { type: 'project', id: args.id };
            },
          },
          run(_args, task) {
            return Promise.resolve(task.principal.userId);
          },
        },
      ],
    },
  ]);
  const logs: Parameters<Logger>[0][] = [];
  const gateway = new Gateway({
    store,
    workspace,
    registry,
    trace,
    previews: options.previews,
    log: (entry) => logs.push(entry),
  });
  const contextSettings = options.context;
  const locale = options.locale;
  const exec = options.plugins?.some((plugin) => plugin.execBackends?.length)
    ? {}
    : undefined;
  function configure(
    enabled: boolean,
    options: { model?: string; platform?: boolean } = {},
  ) {
    return writeFile(
      path,
      JSON.stringify({
        owner: { fake: 'owner' },
        platforms:
          options.platform === false ? [] : [{ id: adapterId, kind: 'fake' }],
        agents: enabled
          ? [{ id: 'test', kind: 'fake', model: options.model ?? 'first' }]
          : [],
        defaultAgent: 'test',
        context: contextSettings,
        exec,
        locale,
      }),
    );
  }

  t.after(async () => {
    try {
      await gateway.stop();
    } finally {
      store.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
  await configure(enableAgent);
  await gateway.start();
  return {
    gateway,
    configure,
    logs,
    platform,
    store,
    trace,
    path,
    get agentStarts() {
      return agentStarts;
    },
    get agentStops() {
      return agentStops;
    },
  };
}

async function until(t: TestContext, condition: () => boolean) {
  while (!condition()) await delay(10, undefined, { signal: t.signal });
}

test('trigger decisions use native owner status, allowlist, mentions and bot replies', () => {
  const dm = inbound('m', 'hello');
  const group = { ...dm, chatKind: 'group' as const };
  assert.equal(shouldTrigger(dm, true, false), true);
  assert.equal(shouldTrigger(dm, false, false), false);
  assert.equal(shouldTrigger(group, true, true), false);
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, true, false),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, false, false),
    false,
  );
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, false, true),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, repliesToBot: true }, false, true),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, repliesToBot: true }, true, false),
    false,
  );
});

test(
  'routes messages, reloads agent attachment in place, and resumes only the current model',
  { timeout: 5_000 },
  async (t) => {
    const requests: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        requests.push(request);
        yield await Promise.resolve({ type: 'text.delta', text: 'Re' });
        yield { type: 'text.delta', text: 'ply' };
        yield { type: 'sessionId', sessionId: `native-${request.model}` };
      },
      false,
    );

    await f.platform.emit(
      inbound('ignored', 'group history', {
        chatKind: 'group',
        userId: 'member',
      }),
    );
    assert.equal(f.store.getMessage(chat, 'ignored')?.text, 'group history');
    assert.equal(f.platform.sent.length, 0);
    await f.platform.emit(inbound('zero', 'hello'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'No agent is attached.');

    await f.configure(true);
    await until(
      t,
      () =>
        f.agentStarts === 1 &&
        f.logs.some((entry) => entry.event === 'config.reloaded'),
    );
    await f.platform.emit(inbound('first', 'first request'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Reply');
    assert.equal(f.platform.sent.at(-1)?.replyTo, 'first');
    assert.deepEqual(f.store.getMessage(chat, 'bot-2')?.raw, {
      delivered: true,
    });
    assert.equal(requests[0]?.resumeSessionId, undefined);
    assert.ok(
      requests[0]?.context.some((block) => block.content === 'group history'),
    );

    await f.platform.emit(inbound('second', 'second request'));
    await f.gateway.idle();
    assert.equal(requests[1]?.resumeSessionId, 'native-first');
    assert.deepEqual(
      requests[1]?.context
        .filter((block) => block.source !== 'system')
        .map((block) => block.content),
      ['second request'],
    );

    await f.platform.emit(inbound('model', '/model changed'));
    await f.platform.emit(inbound('third', 'new model'));
    await f.gateway.idle();
    assert.equal(requests[2]?.model, 'changed');
    assert.equal(requests[2]?.resumeSessionId, undefined);
    await f.platform.emit(inbound('reset', '/model first'));
    await f.platform.emit(inbound('fourth', 'old model again'));
    await f.gateway.idle();
    assert.equal(requests[3]?.model, 'first');
    assert.equal(requests[3]?.resumeSessionId, undefined);

    await writeFile(f.path, '{"agents":[{"id":"test","kind":"missing"}]}');
    await until(t, () =>
      f.logs.some((entry) => entry.event === 'config.reload_failed'),
    );
    await f.platform.emit(inbound('still-live', 'keep old'));
    await f.gateway.idle();
    assert.equal(requests.length, 5);
    assert.equal(f.agentStops, 0);
    await f.configure(false);
    await until(t, () => f.agentStops === 1);
    await f.platform.emit(inbound('detached', 'test detach'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'No agent is attached.');
    assert.equal(f.platform.starts, 1);
    assert.equal(requests.length, 5);
    assert.ok(f.trace.recent.some((span) => span.name === 'agent.first_text'));
    assert.ok(f.trace.recent.some((span) => span.name === 'outbound.send'));
  },
);

test(
  'deletion aborts the running agent and suppresses its eventual answer',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const f = await fixture(t, async function* ({ signal }) {
      entered.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      yield { type: 'text.final', text: 'late answer' };
    });
    await f.platform.emit(inbound('source', 'to be deleted'));
    const signal = await entered.promise;
    await f.platform.emit({
      type: 'delete',
      chatId: chat.chatId,
      messageId: 'source',
    });
    await f.gateway.idle();
    assert.equal(signal.aborted, true);
    assert.equal(f.store.getMessage(chat, 'source')?.deleted, true);
    assert.deepEqual(f.platform.sent, []);
  },
);

test(
  'a running task gets reply-chain supplements and unrelated turns wait',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const wait = Promise.withResolvers<void>();
    const inputs: string[][] = [];
    const seen: string[] = [];
    const f = await fixture(t, async function* (request, io) {
      inputs.push(
        request.context
          .filter((block) => block.source === 'message')
          .map((block) => block.content),
      );
      if (inputs.length === 1) {
        entered.resolve();
        for await (const message of io.supplements) {
          seen.push(message.text);
          if (seen.length === 2) break;
        }
        await wait.promise;
      }
      yield { type: 'text.final', text: 'answer' };
      yield { type: 'sessionId', sessionId: 'native' };
    });

    await f.platform.emit(inbound('source', 'original'));
    await entered.promise;
    await f.platform.emit(inbound('queued', 'unrelated'));
    await f.platform.emit(
      inbound('one', 'first supplement', { replyTo: 'source' }),
    );
    await f.platform.emit(
      inbound('two', 'second supplement', { replyTo: 'one' }),
    );
    await until(t, () => seen.length === 2);
    assert.equal(inputs.length, 1);
    wait.resolve();
    await f.gateway.idle();
    assert.deepEqual(seen, ['first supplement', 'second supplement']);
    assert.deepEqual(inputs, [['original'], ['unrelated']]);
    assert.deepEqual(
      f.platform.sent.map((message) => message.replyTo),
      ['source', 'queued'],
    );
    await f.platform.emit(inbound('next', 'next turn'));
    await f.gateway.idle();
    assert.deepEqual(inputs.at(-1), ['next turn']);
  },
);

test(
  'tool execution waits for owner approval and reuses scoped always grants',
  { timeout: 5_000 },
  async (t) => {
    let runCount = 0;
    const f = await fixture(t, async function* (request) {
      runCount++;
      const tool = request.tools[0];
      assert.ok(tool);
      const result = await tool.run(
        { id: 'p' },
        {
          chat: { adapterId: 'forged', chatId: 'other' },
          principal: { adapterId: 'forged', userId: 'forged' },
          signal: request.signal,
          taskId: 'forged',
        },
      );
      yield { type: 'text.final', text: `Tool for ${String(result)}` };
    });

    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('source', 'use tool', {
        chatKind: 'group',
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () => f.platform.sent.length === 2);
    const prompt = f.platform.sent.at(-1);
    assert.match(prompt?.text ?? '', /Approval requested/);
    assert.ok(prompt?.buttons?.[1]);
    const content = '🔔 Sample text\n你好😀';
    assert.ok(prompt.text.endsWith('\nContent:\n' + content));
    assert.deepEqual(prompt.entities, [
      {
        type: 'pre',
        offset: prompt.text.length - content.length,
        length: content.length,
      },
    ]);
    await f.platform.emit(inbound('unlinked', '好', { chatKind: 'group' }));
    await f.platform.emit(
      inbound('forged', 'yes', {
        chatKind: 'group',
        userId: 'member',
        replyTo: prompt.messageId,
      }),
    );
    assert.equal(f.platform.sent.length, 2);
    await f.platform.emit({
      type: 'callback',
      chatId: chat.chatId,
      userId: 'owner',
      callbackId: prompt.buttons[1].id,
      messageId: prompt.messageId,
    });
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Tool for member');

    await f.platform.emit(
      inbound('second', 'use again', {
        chatKind: 'group',
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await f.gateway.idle();
    assert.equal(runCount, 2);
    assert.equal(f.platform.sent.length, 4);
    assert.equal(f.platform.sent.at(-1)?.text, 'Tool for member');
  },
);

test(
  'a platform can detach and reattach while the gateway remains running',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, async function* () {
      yield await Promise.resolve({ type: 'text.final', text: 'answer' });
    });
    const reloads = () =>
      f.logs.filter((entry) => entry.event === 'config.reloaded').length;
    const initial = reloads();
    await f.configure(true, { platform: false });
    await until(t, () => reloads() > initial);
    await assert.rejects(
      f.platform.emit(inbound('detached', 'cannot arrive')),
      /adapter attached/,
    );
    assert.equal(f.agentStarts, 1);
    assert.equal(f.agentStops, 0);

    await f.configure(true);
    await until(t, () => f.platform.starts === 2 && reloads() > initial + 1);
    await f.platform.emit(inbound('reattached', 'can arrive'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'answer');
  },
);

test(
  'supplements still reach an agent that cannot read them while streaming',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: AgentRequest[] = [];
    const f = await fixture(t, async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: 'sessionId', sessionId: 'native' };
      yield {
        type: 'text.final',
        text: requests.length === 1 ? 'First' : 'Supplement',
      };
    });
    await f.platform.emit(inbound('original', 'original'));
    await entered.promise;
    await f.platform.emit(
      inbound('supplement', 'more detail', { replyTo: 'original' }),
    );
    release.resolve();
    await f.gateway.idle();
    assert.equal(requests[1]?.resumeSessionId, 'native');
    assert.deepEqual(
      requests[1]?.context.map((block) => block.content),
      ['more detail'],
    );
    assert.deepEqual(
      f.platform.sent.map((message) => message.text),
      ['First\n\nSupplement'],
    );
  },
);

test(
  'topic history, workspaces and approvals stay scoped while edits update text',
  { timeout: 5_000 },
  async (t) => {
    const requests: AgentRequest[] = [];
    let approvals = 0;
    const f = await fixture(t, async function* (request, io) {
      requests.push(request);
      if (request.context.at(-1)?.content === 'approve something') {
        const approved = await io.requestApproval({
          action: 'test.topic',
          resource: { type: 'global' },
        });
        if (approved) approvals++;
      }
      yield { type: 'text.final', text: 'answer' };
    });
    const room = {
      chatId: '-1001',
      chatKind: 'supergroup' as const,
      mentionsBot: true,
    };
    await f.platform.emit(
      inbound('info', 'old text', {
        ...room,
        threadId: '7',
        userId: 'member',
        mentionsBot: false,
      }),
    );
    await f.platform.emit(
      inbound('info', 'edited text', {
        ...room,
        threadId: '7',
        edited: true,
        userId: 'member',
      }),
    );
    await f.platform.emit(
      inbound('info', 'second topic', {
        ...room,
        threadId: '8',
        userId: 'member',
        mentionsBot: false,
      }),
    );
    assert.equal(requests.length, 0);
    await f.platform.emit(
      inbound('source', 'approve something', { ...room, threadId: '7' }),
    );
    await until(t, () => f.platform.sent.length === 1);
    const prompt = f.platform.sent[0];
    assert.ok(prompt?.buttons?.[0]);
    const callback = {
      type: 'callback' as const,
      chatId: room.chatId,
      userId: 'owner',
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
    };
    await f.platform.emit({ ...callback, threadId: '8' });
    assert.equal(approvals, 0);
    await f.platform.emit({ ...callback, threadId: '7' });
    await f.gateway.idle();
    assert.equal(approvals, 1);
    await f.platform.emit(
      inbound('source', 'next one', { ...room, threadId: '8' }),
    );
    await f.gateway.idle();

    assert.ok(requests[0]?.workdir.endsWith('/-1001_7'));
    assert.ok(requests[1]?.workdir.endsWith('/-1001_8'));
    assert.ok(
      requests[0]?.context.some((block) => block.content === 'edited text'),
    );
    assert.equal(
      requests[0]?.context.some((block) =>
        ['old text', 'second topic'].includes(block.content),
      ),
      false,
    );
    assert.ok(
      requests[1]?.context.some((block) => block.content === 'second topic'),
    );
    assert.equal(
      requests[1]?.context.some((block) => block.content === 'edited text'),
      false,
    );
    assert.deepEqual(
      f.platform.sent.map((message) => [message.chatId, message.threadId]),
      [
        ['-1001', '7'],
        ['-1001', '7'],
        ['-1001', '8'],
      ],
    );
  },
);

test(
  'summaries run after delivery and fresh turns keep the summary cutoff and raw window',
  { timeout: 5000 },
  async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const summaryRequest = Promise.withResolvers<AgentRequest>();
    const prompts: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'summary') {
          summaryRequest.resolve(request);
          await release.promise;
          yield { type: 'text.final', text: 'Rolling memory' };
          return;
        }
        prompts.push(request);
        yield { type: 'text.final', text: 'Chat reply' };
      },
      true,
      { context: { recentMessages: 2, summary: { model: 'economy' } } },
    );

    const group = { chatKind: 'group' as const };
    await f.platform.emit(inbound('history-1', 'First old message', group));
    await f.platform.emit(inbound('history-2', 'Recent message', group));
    await f.platform.emit(
      inbound('current-1', 'Answer this', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Chat reply');
    const summary = await summaryRequest.promise;
    assert.equal(summary.model, 'economy');
    assert.equal(summary.tools.length, 0);
    assert.match(summary.context.at(-1)?.content ?? '', /First old message/);
    assert.equal(f.store.getSummary(chat)?.text, '');
    release.resolve();
    await until(t, () => f.store.getSummary(chat)?.text === 'Rolling memory');
    await f.platform.emit(
      inbound('current-2', 'Follow up', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    assert.deepEqual(
      prompts
        .at(-1)
        ?.context.filter(
          ({ source }) => source === 'summary' || source === 'message',
        )
        .map(({ content }) => content),
      ['Rolling memory', 'Chat reply', 'Follow up'],
    );
  },
);

test(
  'a different DM requires linked native recipient approval and scheduled agents use the task pipeline',
  { timeout: 6000 },
  async (t) => {
    const seen: AgentRequest[] = [];
    const f = await fixture(t, async function* (request) {
      seen.push(request);
      const message = request.context
        .filter(({ source }) => source === 'message')
        .at(-1)?.content;
      if (message === 'Create recipient reminder') {
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        const result = await tool?.run({
          action: { kind: 'message', text: 'Recipient reminder' },
          trigger: { kind: 'once', at: Date.now() + 300 },
          targetChatId: 'recipient-dm',
          needsApproval: false,
        });
        assert.equal((result as { status: string }).status, 'pending_approval');
        yield { type: 'text.final', text: 'Awaiting recipient approval' };
      } else if (message === 'Create agent run') {
        await request.tools
          .find(({ name }) => name === 'schedule.create')
          ?.run({
            action: {
              kind: 'agent',
              prompt: 'Report now',
              model: 'scheduled-model',
            },
            trigger: { kind: 'once', at: Date.now() + 300 },
          });
        yield { type: 'text.final', text: 'Agent job scheduled' };
      } else if (message === '[Scheduled task] Report now') {
        yield { type: 'text.final', text: 'Agent job delivered' };
      }
    });
    const recipient = { chatId: 'recipient-dm', userId: 'recipient' };
    await f.platform.emit(inbound('declare-dm', 'Hello', recipient));
    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('schedule-recipient', 'Create recipient reminder', {
        chatKind: 'group',
        userId: 'member',
        mentionsBot: true,
      }),
    );
    await until(t, () =>
      f.platform.sent.some(({ chatId }) => chatId === recipient.chatId),
    );
    const prompt = f.platform.sent.find(
      ({ chatId }) => chatId === recipient.chatId,
    );
    assert.ok(prompt?.buttons?.[0]);
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit(inbound('unlinked-approval', 'yes', recipient));
    await f.platform.emit({
      type: 'callback',
      chatId: recipient.chatId,
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
      userId: 'impostor',
    });
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit({
      type: 'callback',
      chatId: recipient.chatId,
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
      userId: recipient.userId,
    });
    await f.gateway.idle();
    assert.equal(
      f.store.listSchedules(chat)[0]?.deliveryApprovedBy,
      recipient.userId,
    );
    await f.platform.emit(inbound('schedule-agent', 'Create agent run'));
    await f.gateway.idle();
    await until(
      t,
      () =>
        f.platform.sent.some(({ text }) => text === 'Agent job delivered') &&
        f.platform.sent.some(
          ({ chatId, text }) =>
            chatId === recipient.chatId && text === 'Recipient reminder',
        ),
    );
    assert.equal(seen.at(-1)?.model, 'scheduled-model');
    assert.ok(f.trace.recent.some(({ name }) => name === 'inbound.scheduled'));
  },
);

test(
  'localizes a pending schedule and its approval, then delivers the captured mention ranges without extra text',
  { timeout: 6000 },
  async (t) => {
    const text = '😀 [原稿名稱](tg://user?id=79)，請和 @other_user 一起喝水。';
    const deliveredText = '😀 原稿名稱，請和 @other_user 一起喝水。';
    let result: unknown;
    let at = 0;
    const f = await fixture(
      t,
      async function* (request) {
        if (
          request.context.filter(({ source }) => source === 'message').at(-1)
            ?.content !== 'Schedule this'
        )
          return;
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.match(
          tool?.description ?? '',
          /mentions as native platform user IDs/,
        );
        at = Date.now() + 600;
        assert.ok(
          request.context.some(
            ({ source, content }) =>
              source === 'system' &&
              content.includes('only when the user asks to manage'),
          ),
        );
        result = await tool?.run({
          action: { kind: 'message', text },
          mentions: ['80'],
          trigger: { kind: 'once', at },
          needsApproval: true,
          reason: '提醒 Telegram ID 79\n可能打擾開會。',
        });
        yield { type: 'text.final', text: '等管理員同意後就會排上' };
      },
      true,
      { locale: 'zh-TW' },
    );
    await f.platform.emit(
      inbound('owner-dm', 'Register', {
        chatId: 'owner',
        userDisplay: '管理員',
      }),
    );
    const group = { chatKind: 'group' as const, chatTitle: '測試聊天室' };
    await f.platform.emit(
      inbound('member-1', 'Hi', {
        ...group,
        userId: '79',
        userDisplay: '小林',
        userUsername: 'old_username',
      }),
    );
    await f.platform.emit(
      inbound('member-2', 'Hi', {
        ...group,
        userId: '80',
        userDisplay: '小白',
      }),
    );
    await f.platform.emit(
      inbound('schedule', 'Schedule this', {
        ...group,
        mentionsBot: true,
        userDisplay: '管理員',
      }),
    );
    await until(t, () =>
      f.platform.sent.some(({ buttons }) => Boolean(buttons)),
    );
    const prompt = f.platform.sent.find(({ buttons }) => Boolean(buttons));
    assert.ok(prompt);
    assert.equal(prompt.chatId, 'owner');
    assert.deepEqual(
      prompt.buttons?.map(({ label }) => label),
      ['允許一次', '一律允許', '拒絕'],
    );
    assert.equal(prompt.parseTextMentions, false);
    const lines = prompt.text.split('\n');
    assert.equal(lines[0], '🔔 需要你同意：排程提醒');
    assert.ok(lines.includes('位置：測試聊天室'));
    assert.ok(lines.includes('對象：@小林、@小白、＠other_user'));
    assert.ok(lines.includes('發起：管理員'));
    const clock = new Intl.DateTimeFormat('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Taipei',
    }).format(at);
    assert.ok(lines.includes('時間：今天 ' + clock + '（一次）'));
    assert.deepEqual(lines.slice(-2), ['內容：', deliveredText]);
    const pre = {
      offset: prompt.text.length - deliveredText.length,
      length: deliveredText.length,
    };
    assert.deepEqual(prompt.entities, [
      {
        type: 'mention',
        userId: '79',
        offset: prompt.text.indexOf('@小林'),
        length: 3,
      },
      {
        type: 'mention',
        userId: '80',
        offset: prompt.text.indexOf('@小白'),
        length: 3,
      },
      { ...pre, type: 'pre' },
    ]);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('原因：')),
      ['原因：會提及特定的人；提醒 小林 可能打擾開會。'],
    );
    assert.doesNotMatch(prompt.text, /代理程式提供的理由|代理程式要求主人審核/);
    assert.doesNotMatch(lines.join('\n'), /tg:\/\/|"kind"|room/);
    await f.gateway.idle();
    const pending = result as {
      ok: boolean;
      ref: string;
      status: string;
      summary: string;
    };
    assert.deepEqual(Object.keys(pending), ['ok', 'summary', 'status', 'ref']);
    assert.equal(pending.status, 'pending_approval');
    assert.match(pending.ref, /^[a-f0-9]{6}$/);
    assert.match(pending.summary, /^等管理員同意後就會排上/);
    assert.doesNotMatch(pending.summary, /tg:\/\/|mentions|\b79\b|\b80\b/);
    assert.equal(f.platform.sent.at(-1)?.text, '等管理員同意後就會排上');
    await f.platform.emit(
      inbound('unlinked-schedule-approval', '允許一次', { chatId: 'owner' }),
    );
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit(
      inbound('linked-schedule-approval', '允許一次', {
        chatId: 'owner',
        replyTo: prompt.messageId,
      }),
    );
    await f.gateway.idle();
    assert.equal(f.platform.feedback.at(-1)?.decisionText, '✅ 已允許一次');
    assert.deepEqual(f.platform.feedback.at(-1)?.pre, pre);
    const schedule = f.store.listSchedules(chat)[0];
    assert.equal(schedule?.deliveryApprovedBy, 'owner');
    assert.deepEqual(schedule?.mentions, ['79', '80']);
    assert.equal(pending.ref, schedule?.id.slice(0, 6));
    assert.deepEqual(schedule?.action, {
      kind: 'message',
      text: deliveredText,
      mentions: [
        {
          userId: '79',
          displayName: '小林',
          ranges: [{ offset: 3, length: 4 }],
        },
        { userId: '80', displayName: '小白', ranges: [] },
      ],
    });
    await f.platform.emit(
      inbound('member-1-rename', 'Hello again', {
        ...group,
        userId: '79',
        userDisplay: '小林',
        userUsername: 'new_username',
      }),
    );
    assert.equal(f.platform.getUser('79')?.username, 'new_username');
    await until(t, () =>
      f.platform.sent.some((message) => message.text === deliveredText),
    );
    const delivered = f.platform.sent.find(
      (message) => message.text === deliveredText,
    );
    assert.equal(delivered?.chatId, chat.chatId);
    assert.deepEqual(delivered?.entities, [
      { type: 'mention', userId: '79', offset: 3, length: 4 },
    ]);
  },
);

test(
  'chat workspace edits are recorded under the member native ID',
  { timeout: 5000 },
  async (t) => {
    let workdir = '';
    const f = await fixture(t, async function* (request) {
      workdir = request.workdir;
      await writeFile(
        join(workdir, 'rules', 'member.md'),
        'Conversation convention',
      );
      yield { type: 'text.final', text: 'Saved rule' };
    });
    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('edit-rule', 'Save this convention', {
        chatKind: 'group',
        userId: 'member',
        mentionsBot: true,
      }),
    );
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Saved rule');
    const commit = execFileSync(
      'git',
      ['-C', workdir, 'log', '-1', '--format=%an', '--', 'rules/member.md'],
      { encoding: 'utf8' },
    );
    assert.equal(commit.trim(), 'member');
  },
);

test(
  'preview selection uses the platform owner and requires a port from that chat execution',
  { timeout: 5000 },
  async (t) => {
    let next = 0;
    const opened: { id: string; provider: string; ttlMs: number }[] = [];
    const closed: string[] = [];
    function provider(id: string): TunnelProvider {
      return {
        id,
        async open({ ttlMs }) {
          const preview = {
            id: `preview-${++next}`,
            provider: id,
            expiresAt: new Date(Date.now() + ttlMs),
            url: `https://${id}.example.test/?token=credential`,
          };
          opened.push({ id: preview.id, provider: id, ttlMs });
          return preview;
        },
        async reconcile() {},
        async close(previewId) {
          closed.push(previewId);
        },
      };
    }
    const controller = new AbortController();
    const plugin: PluginDefinition = {
      name: 'fake-exec',
      execBackends: [
        {
          id: 'local-sandbox',
          async start() {
            const ports = new Set<number>();
            return {
              async exposePort(port) {
                if (!ports.has(port)) throw new Error('unknown sandbox port');
                return {
                  host: '127.0.0.1',
                  port: 12345,
                  closed: controller.signal,
                };
              },
              async readFile() {
                return new Uint8Array();
              },
              async run(_cmd, { backgroundPort }) {
                if (backgroundPort) ports.add(backgroundPort);
                return { exitCode: null, stdout: '', stderr: '' };
              },
              async stop() {
                controller.abort();
              },
              async writeFile() {},
            };
          },
        },
      ],
    };
    const f = await fixture(
      t,
      async function* (request) {
        const open = request.tools.find(({ name }) => name === 'preview.open');
        assert.ok(open);
        await assert.rejects(open.run({ port: 8787, ttl: 1 }));
        await request.tools
          .find(({ name }) => name === 'exec.run')
          ?.run({ cmd: ['fake-app'], backgroundPort: 3000 });
        await open.run({ port: 3000, ttl: 1440 });
        yield { type: 'text.final', text: 'Preview created' };
      },
      true,
      {
        plugins: [plugin],
        previews: { quick: provider('quick'), named: provider('named') },
      },
    );
    await f.platform.emit(inbound('allow', '/allow'));
    const group = { chatKind: 'group' as const, mentionsBot: true };
    await f.platform.emit(
      inbound('member-preview', 'Start preview', {
        ...group,
        userId: 'member',
      }),
    );
    await f.gateway.idle();
    await f.platform.emit(inbound('owner-preview', 'Start preview', group));
    await f.gateway.idle();
    assert.deepEqual(
      opened.map(({ provider, ttlMs }) => [provider, ttlMs]),
      [
        ['quick', 3600000],
        ['named', 3600000],
      ],
    );
    assert.ok(
      f.store.listPreviews().every(({ url }) => !url.includes('token')),
    );
    await f.platform.emit(
      inbound('owner-close', '/preview close preview-1', group),
    );
    assert.deepEqual(closed, ['preview-1']);
    controller.abort();
    await until(t, () => f.store.listPreviews().length === 0);
    assert.deepEqual(closed, ['preview-1', 'preview-2']);
  },
);

test(
  'always allow reuses only the same reminder scope and denial leaves no schedule',
  { timeout: 5_000 },
  async (t) => {
    const results: { ref: string; status: string }[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        const command = request.context
          .filter(({ source }) => source === 'message')
          .at(-1)?.content;
        if (!command?.startsWith('Reminder: ')) return;
        const create = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.ok(create);
        const result = (await create.run({
          action: {
            kind: 'message',
            text: '[月光](tg://user?id=79)，' + command.slice(10),
          },
          trigger: { kind: 'once', at: Date.now() + 60_000 },
        })) as (typeof results)[number];
        results.push(result);
        yield { type: 'text.final', text: result.status };
      },
      true,
      { locale: 'zh-TW' },
    );
    const group = {
      chatKind: 'group' as const,
      chatTitle: 'Development',
      mentionsBot: true,
    };
    await f.platform.emit(inbound('allow-reminders', '/allow', group));
    await f.platform.emit(inbound('first-reminder', 'Reminder: 喝水', group));
    await f.gateway.idle();
    const first = f.platform.sent.find(({ buttons }) => buttons?.length);
    assert.ok(first?.buttons?.[1]);
    assert.equal(results[0]?.status, 'pending_approval');
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit({
      type: 'callback',
      chatId: chat.chatId,
      callbackId: first.buttons[1].id,
      messageId: first.messageId,
      userId: '79',
    });
    await until(t, () => f.store.listSchedules(chat).length === 1);
    assert.equal(f.platform.feedback[0]?.decisionText, '✅ 已設為一律允許');

    await f.platform.emit(inbound('same-reminder', 'Reminder: 喝水', group));
    await f.gateway.idle();
    assert.equal(results[1]?.status, 'scheduled');
    assert.equal(
      f.platform.sent.filter(({ buttons }) => buttons?.length).length,
      1,
    );
    assert.equal(f.store.listSchedules(chat).length, 2);

    await f.platform.emit(
      inbound('different-reminder', 'Reminder: 開會', group),
    );
    await f.gateway.idle();
    assert.equal(results[2]?.status, 'pending_approval');
    const last = f.platform.sent
      .filter(({ buttons }) => buttons?.length)
      .at(-1);
    assert.ok(last?.buttons?.[2]);
    await f.platform.emit({
      type: 'callback',
      chatId: chat.chatId,
      callbackId: last.buttons[2].id,
      messageId: last.messageId,
      userId: '79',
    });
    assert.equal(f.platform.feedback.at(-1)?.decisionText, '❌ 已拒絕');
    assert.equal(f.store.listSchedules(chat).length, 2);
  },
);

test(
  'a delayed legacy fixed reminder converts its link and keeps all other text',
  { timeout: 4_000 },
  async (t) => {
    const f = await fixture(
      t,
      async function* () {
        yield { type: 'text.final', text: 'Unexpected agent run' };
      },
      false,
    );
    await f.platform.emit(
      inbound('allow-old-reminders', '/allow', { chatKind: 'group' }),
    );
    const at = Date.now() - 60_000;
    assert.ok(
      f.store.createSchedule(
        {
          ...chat,
          action: {
            kind: 'message',
            text: '🔔 [月光](tg://user?id=79)，喝水！\n**保留原文**',
          },
          address: { chatId: chat.chatId },
          target: { chatId: chat.chatId },
          createdBy: 'owner',
          deliveryApprovedBy: 'owner',
          id: 'legacy',
          mentions: [],
          missed: 'latest',
          nextDueAt: at,
          status: 'active',
          timezone: 'UTC',
          trigger: { kind: 'once', at },
        },
        20,
      ),
    );
    const expected = '🔔 月光，喝水！\n**保留原文**';
    await until(t, () => f.platform.sent.some(({ text }) => text === expected));
    assert.deepEqual(f.platform.sent.at(-1)?.entities, [
      { type: 'mention', offset: 3, length: 2, userId: '79' },
    ]);
  },
);
