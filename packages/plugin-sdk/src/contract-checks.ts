import assert from 'node:assert/strict';

import type {
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  InboundEvent,
  OutboundMessage,
  PlatformAdapter,
} from './index.ts';

export async function checkAdapterContract(
  adapter: PlatformAdapter,
  message: OutboundMessage,
  verifyInbound?: (events: readonly InboundEvent[]) => void | Promise<void>,
) {
  assert.ok(adapter.id && adapter.kind);
  const events: InboundEvent[] = [];
  try {
    await adapter.start({
      emit(event) {
        events.push(event);
        return Promise.resolve();
      },
    });
    const receipt = await adapter.send(message);
    assert.ok(receipt.messageId);
    await verifyInbound?.(events);
  } finally {
    await adapter.stop();
  }
}

export async function checkAgentContract(
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
): Promise<AgentEvent[]> {
  assert.ok(agent.id && agent.kind);
  assert.ok(agent.loop === 'external' || agent.loop === 'framework');
  try {
    await agent.start?.();
    const events: AgentEvent[] = [];
    for await (const event of agent.run(request, io)) {
      if (event.type === 'error') throw event.error;
      events.push(event);
    }
    assert.ok(
      events.some(
        (event) => event.type === 'text.delta' || event.type === 'text.final',
      ),
    );
    return events;
  } finally {
    await agent.stop?.();
  }
}
