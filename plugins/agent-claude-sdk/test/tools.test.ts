import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatewayTools } from '../src/tools.ts';

test('Claude SDK MCP bridge lists framework schemas and dispatches trusted tool wrappers', async (t) => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  };
  const options = gatewayTools(createSdkMcpServer, [
    {
      name: 'preview.close',
      description: 'Close a preview',
      schema,
      async run(args) {
        assert.deepEqual(args, { id: 'preview-1' });
        return { closed: 'preview-1' };
      },
    },
  ]);
  assert.deepEqual(options.allowedTools, ['mcp__tsugimori__preview_close']);
  const config = options.mcpServers?.tsugimori;
  assert.ok(config?.type === 'sdk' && 'instance' in config);
  const { instance } = config;
  type Transport = Parameters<typeof instance.connect>[0];
  type Message = Parameters<NonNullable<Transport['onmessage']>>[0];
  let result = Promise.withResolvers<Message>();
  const transport: Transport = {
    async start() {},
    async close() {},
    async send(message) {
      result.resolve(message);
    },
  };
  await instance.connect(transport);
  t.after(() => instance.close());
  transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(await result.promise, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        {
          name: 'preview_close',
          description: 'Close a preview',
          inputSchema: schema,
        },
      ],
    },
  });
  result = Promise.withResolvers<Message>();
  transport.onmessage?.({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'preview_close', arguments: { id: 'preview-1' } },
  });
  assert.deepEqual(await result.promise, {
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [{ type: 'text', text: '{"closed":"preview-1"}' }],
    },
  });
});
