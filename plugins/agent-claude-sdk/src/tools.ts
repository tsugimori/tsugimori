import type {
  createSdkMcpServer,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentTool } from '@tsugimori/plugin-sdk';

import { ToolFailure, toolWireName } from '@tsugimori/plugin-sdk';

export function gatewayTools(
  createServer: typeof createSdkMcpServer,
  tools: readonly AgentTool[],
): Pick<Options, 'allowedTools' | 'mcpServers'> {
  const names = new Map(tools.map((tool) => [toolWireName(tool.name), tool]));
  if (names.size !== tools.length)
    throw new Error('Conflicting Claude tool names');
  const config = createServer({ name: 'tsugimori', tools: [] });
  // The SDK owns the MCP handshake. Forward JSON Schema directly for Tsugimori tools.
  const instance = config.instance;
  instance.server.registerCapabilities({ tools: {} });
  const connect = instance.connect.bind(instance);
  instance.connect = async (transport) => {
    await connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (
        !('id' in message) ||
        !('method' in message) ||
        (message.method !== 'tools/list' && message.method !== 'tools/call')
      ) {
        onmessage?.(message, extra);
        return;
      }
      const wire = async () => {
        if (message.method === 'tools/list')
          return {
            tools: [...names].map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.schema,
            })),
          };
        const params = message.params;
        const tool =
          typeof params?.name === 'string' ? names.get(params.name) : undefined;
        try {
          if (!tool) throw new Error('Tool is unavailable');
          const result = await tool.run(
            params?.arguments ?? {},
            undefined,
            String(message.id),
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  error instanceof ToolFailure
                    ? error.message
                    : 'The framework rejected or could not complete this tool call.',
              },
            ],
          };
        }
      };
      void wire()
        .then((result) =>
          transport.send({ jsonrpc: '2.0', id: message.id, result }),
        )
        .catch((error: unknown) =>
          transport.onerror?.(
            error instanceof Error ? error : new Error('Tool response failed'),
          ),
        );
    };
  };
  return {
    mcpServers: { tsugimori: config },
    allowedTools: [...names.keys()].map((name) => `mcp__tsugimori__${name}`),
  };
}
