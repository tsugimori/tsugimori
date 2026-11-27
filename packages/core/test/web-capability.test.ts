import type { AgentIO, AgentRequest } from '@tsugimori/plugin-sdk';

import { parseConfig } from '@tsugimori/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { ClaudeAgent } from '../../../plugins/agent-claude-sdk/src/index.ts';
import { CodexAgent } from '../../../plugins/agent-codex/src/index.ts';
import { resolveAgentWeb } from '../src/agent-web.ts';
import { webFetchTool } from '../src/web-fetch.ts';

const fakeAppServer = `
import { createInterface } from 'node:readline';
const write = (frame) => console.log(JSON.stringify(frame));
let next = 0;
let configuration;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const answer = (result) => write({ id, result });
  if (method === 'thread/start' || method === 'thread/resume') {
    const { config, dynamicTools, threadId } = params;
    configuration = {
      method,
      search: config.web_search,
      tools: dynamicTools?.map(({ name }) => name),
    };
    answer({ thread: { id: threadId ?? 'thread-' + ++next } });
  } else if (method === 'turn/start') {
    const { threadId } = params;
    const item = { type: 'agentMessage', id: 'message', phase: 'final_answer', text: JSON.stringify(configuration) };
    const turn = { id: 'turn', status: 'completed', items: [item] };
    answer({ turn });
    write({ method: 'turn/completed', params: { threadId, turn } });
  } else if (method === 'model/list') {
    answer({ data: [] });
  } else {
    answer({});
  }
}
`;

const agents = [
  { id: 'codex', kind: 'codex' },
  { id: 'claude', kind: 'claude-sdk' },
];
const kinds = {
  agentKinds: new Set(agents.map(({ kind }) => kind)),
  platformKinds: new Set<string>(),
};
const workdir = process.cwd();
const base: AgentRequest = {
  context: [],
  model: 'test-model',
  sandbox: { workdir, writable: [workdir], network: 'none', denyRead: [] },
  signal: new AbortController().signal,
  tools: [],
  workdir,
};
const io: AgentIO = {
  requestApproval: async () => false,
  supplements: { async *[Symbol.asyncIterator]() {} },
};
const tool = {
  ...webFetchTool,
  async run() {
    assert.fail('parity test should not make network requests');
  },
};

test('web config validates partial per-agent overrides and defaults', () => {
  const agent = { id: 'codex', capabilities: { webSearch: 'native' as const } };
  const parse = (config: object) =>
    parseConfig(JSON.stringify({ agents, ...config }), kinds);
  assert.deepEqual(resolveAgentWeb(parse({}), agent, false), {
    search: true,
    fetch: true,
  });
  const config = parse({
    agentWeb: { search: false, fetch: false },
    agents: [{ ...agents[0], web: { search: true } }, agents[1]],
  });
  assert.deepEqual(resolveAgentWeb(config, agent, false), {
    search: true,
    fetch: false,
  });
  assert.deepEqual(resolveAgentWeb(config, agent, true), {
    search: false,
    fetch: false,
  });
  assert.deepEqual(resolveAgentWeb(parse({}), { id: 'other' }, false), {
    search: false,
    fetch: true,
  });
  assert.throws(
    () => parse({ agentWeb: { search: 'true' } }),
    /agentWeb\/search/,
  );
  assert.throws(
    () => parse({ agents: [{ ...agents[0], web: { fetch: 1 } }] }),
    /agents\/0\/web\/fetch/,
  );
});

test(
  'both scoped agents expose precisely the configured web capabilities',
  { timeout: 20_000 },
  async (t) => {
    const codex = new CodexAgent(
      {
        inspect: async () => undefined,
        spawn(_command, _args, options) {
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeAppServer],
            { ...options, env: {} },
          );
        },
      },
      'codex',
    );
    t.after(() => codex.stop());
    let claudeOptions: { gateway: string[]; native: string[] } | undefined;
    const approvals: string[] = [];
    const claudeIO: AgentIO = {
      ...io,
      async requestApproval({ action }) {
        approvals.push(action);
        return false;
      },
    };
    const claude = new ClaudeAgent(
      {
        async *query({ options }) {
          assert.ok(options);
          assert.ok(Array.isArray(options.tools));
          claudeOptions = {
            gateway: options.allowedTools ?? [],
            native: options.tools.filter((name) => name.startsWith('Web')),
          };
          const permissions = {
            requestId: 'test-request',
            signal: base.signal,
            toolUseID: 'test-tool',
          };
          assert.equal(
            (await options.canUseTool?.('WebFetch', {}, permissions))?.behavior,
            'deny',
          );
          assert.equal(
            (await options.canUseTool?.('WebSearch', {}, permissions))
              ?.behavior,
            !options.sandbox && options.tools.includes('WebSearch')
              ? 'allow'
              : 'deny',
          );
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'test-claude',
            result: 'ok',
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            modelUsage: {},
            permission_denials: [],
            uuid: '00000000-0000-0000-0000-000000000001',
            usage: {
              cache_creation: {
                ephemeral_1h_input_tokens: 0,
                ephemeral_5m_input_tokens: 0,
              },
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              fallback_credit: null,
              inference_geo: 'test',
              input_tokens: 1,
              iterations: [],
              output_tokens: 1,
              output_tokens_details: { thinking_tokens: 0 },
              server_tool_use: {
                web_fetch_requests: 0,
                web_search_requests: 0,
              },
              service_tier: 'standard',
              speed: 'standard',
            },
          };
        },
      },
      'claude',
      null,
    );

    const claudeTurn = async (request: AgentRequest) => {
      for await (const event of claude.run(request, claudeIO))
        if (event.type === 'text.final') assert.equal(event.text, 'ok');
    };

    let previous: string | undefined;
    const codexTurn = async (request: AgentRequest) => {
      let configuration: unknown;
      let sessionId: string | undefined;
      for await (const event of codex.run(request, io)) {
        if (event.type === 'text.final') configuration = JSON.parse(event.text);
        if (event.type === 'sessionId') sessionId = event.sessionId;
      }
      assert.ok(sessionId);
      return { configuration, sessionId };
    };
    for (const search of [true, false]) {
      for (const fetch of [true, false]) {
        const config = parseConfig(
          JSON.stringify({ agentWeb: { search, fetch }, agents }),
          kinds,
        );
        const request = (agent: CodexAgent | ClaudeAgent): AgentRequest => {
          const web = resolveAgentWeb(config, agent, false);
          return { ...base, web, tools: web.fetch ? [tool] : [] };
        };
        const input = request(codex);
        const first = await codexTurn({ ...input, resumeSessionId: previous });
        assert.deepEqual(first.configuration, {
          method: 'thread/start',
          search: search ? 'cached' : 'disabled',
          ...(fetch && { tools: ['web_fetch'] }),
        });
        const second = await codexTurn({
          ...input,
          resumeSessionId: first.sessionId,
        });
        assert.equal(second.sessionId, first.sessionId);
        assert.deepEqual(second.configuration, {
          method: 'thread/resume',
          search: search ? 'cached' : 'disabled',
        });
        previous = second.sessionId;
        await claudeTurn(request(claude));
        assert.deepEqual(claudeOptions, {
          gateway: fetch ? ['mcp__tsugimori__web_fetch'] : [],
          native: search ? ['WebSearch'] : [],
        });
      }
    }
    for (const flags of [
      { purpose: 'summary' },
      { toolsDisabled: true },
    ] as const) {
      const request = {
        ...base,
        ...flags,
        tools: [tool],
        web: { search: true, fetch: true },
      };
      const { configuration } = await codexTurn(request);
      assert.deepEqual(configuration, {
        method: 'thread/start',
        search: 'disabled',
      });
      await claudeTurn(request);
      assert.deepEqual(claudeOptions, { gateway: [], native: [] });
    }
    assert.deepEqual(approvals, []);
    await claudeTurn({
      ...base,
      sandbox: undefined,
      tools: [tool],
      web: { search: true, fetch: true },
    });
    assert.deepEqual(claudeOptions, {
      gateway: ['mcp__tsugimori__web_fetch'],
      native: ['WebFetch', 'WebSearch'],
    });
    assert.deepEqual(approvals, ['claude.WebFetch', 'claude.WebSearch']);
  },
);
