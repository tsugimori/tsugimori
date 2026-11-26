import { ClaudeAgent } from '@tsugimori/agent-claude-sdk';
import { Gateway, PluginRegistry } from '@tsugimori/core';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  AdapterContext,
  OutboundMessage,
} from '../../plugin-sdk/src/index.ts';

import { Tracer } from '../../trace/src/index.ts';

type ClaudeQuery = NonNullable<
  ConstructorParameters<typeof ClaudeAgent>[0]['query']
>;
type SdkMessage =
  ReturnType<ClaudeQuery> extends AsyncIterable<infer Message>
    ? Message
    : never;

test(
  'Claude turns, compaction, summaries and scheduled work reach the gateway',
  { timeout: 10_000 },
  async (t) => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'tsugimori-claude-gateway-'),
    );
    const store = new SqliteStore(':memory:');
    const trace = new Tracer(store, { ringSize: 200 });
    const adapterId = 'test';
    const chat = { adapterId, chatId: 'owner' };
    const summaryModel = 'claude-haiku-4-5';
    const scheduleModel = 'claude-sonnet-4-6';
    const model = 'claude-opus-4-8';
    let now = Date.UTC(2026, 10, 26, 5, 0);
    t.mock.method(Date, 'now', () => now);
    t.mock.timers.enable({ apis: ['setInterval'] });
    let compactCalls = 0;
    const sent: OutboundMessage[] = [];
    let adapter: AdapterContext;
    const agent = new ClaudeAgent(
      {
        async *query({ options, prompt }) {
          const summary = options?.persistSession === false;
          const scheduled = String(prompt).includes('[Scheduled task]');
          const compact = prompt === '/compact';
          const session_id = summary
            ? 'summary'
            : scheduled
              ? 'scheduled'
              : 'chat';
          const frame = (data: Record<string, unknown>) =>
            ({ ...data, session_id }) as SdkMessage;
          const reportedModel = options?.model ?? model;
          yield frame({
            type: 'system',
            subtype: 'init',
            model: reportedModel,
            effort: 'medium',
            slash_commands: ['compact'],
          });
          if (compact) {
            assert.equal(options?.resume, 'chat');
            yield frame({
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: {
                trigger: 'manual',
                pre_tokens: 30_000,
                post_tokens: ++compactCalls === 1 ? 5_000 : 4_000,
              },
            });
          } else if (summary) {
            assert.equal(options?.model, summaryModel);
            assert.equal(options?.effort, 'low');
            assert.deepEqual(options?.tools, []);
            assert.equal(options?.resume, undefined);
            assert.match(String(prompt), /Please remember my preference/);
          } else if (scheduled) {
            assert.equal(options?.model, scheduleModel);
            assert.equal(options?.resume, undefined);
          } else {
            assert.equal(options?.model, undefined);
            yield frame({
              type: 'rate_limit_event',
              rate_limit_info: {
                rateLimitType: 'five_hour',
                utilization: 0.25,
                status: 'allowed',
              },
            });
            yield frame({
              type: 'rate_limit_event',
              rate_limit_info: {
                rateLimitType: 'seven_day',
                utilization: 40,
                status: 'allowed',
              },
            });
          }
          yield frame({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            result: summary
              ? 'Stored preference'
              : scheduled
                ? 'Scheduled answer'
                : 'Claude answer',
            usage: {
              input_tokens: compact || summary || scheduled ? 9 : 29_999,
              output_tokens: 1,
            },
            modelUsage: { [reportedModel]: { contextWindow: 200_000 } },
          });
        },
      },
      'claude-sdk',
      null,
      { compactAt: 20_000 },
    );
    const registry = new PluginRegistry([
      {
        name: 'test',
        adapters: {
          test: ({ id }) => ({
            id,
            kind: 'test',
            capabilities: { outboundPush: 'free' },
            async start(ctx) {
              adapter = ctx;
            },
            async stop() {},
            async send(message) {
              sent.push(message);
              return { messageId: 'bot-' + sent.length };
            },
          }),
        },
        agents: { 'claude-sdk': () => agent },
      },
    ]);
    const gateway = new Gateway({
      workspace,
      registry,
      store,
      trace,
      log: () => {},
    });
    t.after(async () => {
      await gateway.stop();
      store.close();
      await rm(workspace, { recursive: true, force: true });
    });
    await writeFile(
      join(workspace, 'tsugimori.json'),
      JSON.stringify({
        owner: { test: 'owner' },
        platforms: [{ id: adapterId, kind: 'test' }],
        agents: [{ id: 'claude-sdk', kind: 'claude-sdk', compactAt: 20_000 }],
        defaultAgent: 'claude-sdk',
        context: {
          recentMessages: 1,
          summary: { minMessages: 1, model: summaryModel },
        },
        timezone: 'UTC',
        locale: 'zh-TW',
      }),
    );
    await gateway.start();
    let next = 0;
    const say = async (text: string) => {
      await adapter.emit({
        type: 'message',
        chatId: chat.chatId,
        chatKind: 'dm',
        userId: 'owner',
        messageId: 'user-' + ++next,
        text,
      });
      await gateway.idle();
    };
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await delay(5);
      assert.ok(done());
    };

    await say('Please remember my preference');
    assert.equal(sent.at(-1)?.text, 'Claude answer');
    await until(() =>
      trace.recent.some(
        ({ name, status, attrs }) =>
          name === 'agent.compaction' &&
          status === 'ok' &&
          attrs.trigger === 'post-turn',
      ),
    );
    await say('/compact');
    await trace.flush();
    assert.deepEqual(
      trace.recent
        .filter(({ name }) => name === 'agent.compaction')
        .map(({ status, attrs }) => [
          status,
          attrs.trigger,
          attrs.contextTokens,
        ]),
      [
        ['ok', 'post-turn', 5_000],
        ['ok', 'manual', 4_000],
      ],
    );
    await say('/status');
    const card = sent.at(-1)?.text ?? '';
    assert.equal(
      card,
      [
        '🟢 tsugimori · 已運作 0 秒（05:00 啟動）',
        '',
        '💬 此聊天室',
        'Agent：Claude Agent SDK',
        '模型：claude-opus-4-8（預設） · 推理：medium（預設） · 快速：預設',
        '上下文：4k / 200k（2%）',
        '額度：5 小時 剩 75% · 每週剩 60%',
        '對話：已持續 0 秒',
        '上次壓縮：05:00 · 手動 · 30k → 4k · 共 2 次',
        '',
        '🖥 系統',
        'test、Claude Agent SDK 運作中',
        '沙箱已停用 · 環境檢查正常',
      ].join('\n'),
    );

    assert.equal(
      store.getSession(chat, agent.id, 'default')?.sessionId,
      'chat',
    );
    const at = now + 60_000;
    assert.ok(
      store.createSchedule(
        {
          ...chat,
          id: 'claude-schedule',
          status: 'active',
          action: {
            kind: 'agent',
            prompt: 'Run my scheduled task',
            model: scheduleModel,
          },
          address: { chatId: chat.chatId },
          target: { chatId: chat.chatId },
          createdBy: 'owner',
          deliveryApprovedBy: 'owner',
          mentions: [],
          missed: 'latest',
          nextDueAt: at,
          timezone: 'UTC',
          trigger: { kind: 'once', at },
        },
        10,
      ),
    );
    now = at;
    t.mock.timers.tick(1_000);
    await until(() => sent.at(-1)?.text === 'Scheduled answer');
    assert.equal(store.getSchedule('claude-schedule')?.status, 'done');
    await until(() => store.getSummary(chat)?.text === 'Stored preference');
  },
);
