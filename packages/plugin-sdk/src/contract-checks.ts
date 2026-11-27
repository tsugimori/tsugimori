import assert from 'node:assert/strict';

import type {
  AdapterContext,
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  InboundEvent,
  MediaUpload,
  OutboundMessage,
  PlatformAdapter,
  PlatformInboundEvent,
  SendReceipt,
} from './index.ts';

const uploads = [
  ['images', 'sendImage'],
  ['files', 'sendFile'],
  ['audio', 'sendAudio'],
] as const;

export type AdapterStartScenario = 'normal' | 'failed' | 'pending';

export interface AdapterContractFixture {
  adapter: PlatformAdapter;
  /** Count outbound uploads and sends to detect side effects of rejected media. */
  deliveryCount(): number;
  /** Replay fixtures and wait for their delivery before returning. */
  receive?(
    events: readonly PlatformInboundEvent[],
  ): Promise<InboundExpectations>;
  /** Count startup I/O attempts to detect work after a pre-aborted start. */
  startupCalls(): number;
  /** Resolves when the pending startup is blocked on cancellable I/O. */
  startupEntered?: Promise<void>;
  typing?: {
    calls(): number;
    /** Advance the fake clock or wait through at least one refresh interval. */
    tick(): Promise<void>;
    waitForCall(): Promise<void>;
  };
}

interface InboundExpectations {
  messageId: string;
  /** Omit when the native platform provides no outbound echoes. */
  ownEcho?: { disposition: 'emitted' | 'ignored'; messageId: string };
}

export interface AdapterContractOptions {
  create(
    scenario: AdapterStartScenario,
  ): AdapterContractFixture | Promise<AdapterContractFixture>;
  /** A valid sample for each declared upload capability, addressed to message.chatId. */
  media?: Partial<Record<(typeof uploads)[number][0], MediaUpload>>;
  message: OutboundMessage;
  /** Optionally assert the size-specific error for oversized uploads. */
  oversizedError?: RegExp;
  startupError: RegExp;
}

export function checkAdapterContract(
  options: AdapterContractOptions,
): Promise<void>;
export function checkAdapterContract(
  adapter: PlatformAdapter,
  message: OutboundMessage,
  verifyInbound?: (events: readonly InboundEvent[]) => void | Promise<void>,
): Promise<void>;
export async function checkAdapterContract(
  input: AdapterContractOptions | PlatformAdapter,
  message?: OutboundMessage,
  verifyInbound?: (events: readonly InboundEvent[]) => void | Promise<void>,
) {
  if (!('create' in input)) {
    const events: PlatformInboundEvent[] = [];
    checkCapabilities(input);
    try {
      await input.start(collecting(events));
      checkReceipt(await input.send(message!));
      await verifyInbound?.(events);
    } finally {
      await input.stop();
    }
    return;
  }

  const fixture = await input.create('normal');
  const { adapter } = fixture;
  const events: PlatformInboundEvent[] = [];
  checkCapabilities(adapter);
  await stopAdapter(adapter);
  try {
    await adapter.start(collecting(events));
    checkReceipt(await adapter.send(input.message));
    if (fixture.receive) {
      const { messageId, ownEcho } = await fixture.receive(events);
      for (const event of events) checkInbound(event);
      assert.ok(
        events.some(
          (event) => event.type === 'message' && event.messageId === messageId,
        ),
        'Expected a message from the inbound fixture',
      );
      assert.equal(
        events.some((event) => event.type === 'delete'),
        !!adapter.capabilities.deleteEvents,
        'Replay a deletion event when the adapter declares deleteEvents',
      );
      if (ownEcho) {
        const echo = events.find(
          (event) =>
            event.type === 'message' && event.messageId === ownEcho.messageId,
        );
        if (ownEcho.disposition === 'ignored') assert.equal(echo, undefined);
        else {
          assert.ok(
            echo?.type === 'message',
            'Expected the own echo from the fixture',
          );
          assert.equal(
            echo.botMessage,
            true,
            'An own echo must be marked as a bot message',
          );
        }
      }
    } else {
      assert.ok(
        !adapter.capabilities.deleteEvents,
        'Provide an inbound deletion fixture',
      );
    }
    await checkUploads(input, fixture);
    if (adapter.typing) {
      const typing = fixture.typing;
      assert.ok(typing, 'Provide a typing fixture');
      const task = new AbortController();
      try {
        adapter.typing(input.message, task.signal);
        await typing.waitForCall();
        assert.ok(typing.calls() > 0);
      } finally {
        task.abort();
      }
      const calls = typing.calls();
      adapter.typing(input.message, task.signal);
      await typing.tick();
      assert.equal(typing.calls(), calls, 'Typing sent after cancellation');
    }
  } finally {
    await stopAdapter(adapter);
  }

  const failed = await input.create('failed');
  try {
    await assert.rejects(
      failed.adapter.start(collecting([])),
      input.startupError,
    );
    assert.ok(failed.startupCalls() > 0);
  } finally {
    await stopAdapter(failed.adapter);
  }

  const pending = await input.create('pending');
  const controller = new AbortController();
  const reason = new Error('Contract startup cancelled');
  try {
    await assert.rejects(
      pending.adapter.start(collecting([], AbortSignal.abort(reason))),
      reason,
    );
    assert.equal(
      pending.startupCalls(),
      0,
      'Pre-aborted startup performed I/O',
    );
    await stopAdapter(pending.adapter);
    assert.ok(pending.startupEntered, 'Provide a pending startup fixture');
    const aborted = assert.rejects(
      pending.adapter.start(collecting([], controller.signal)),
      reason,
    );
    try {
      await Promise.race([
        pending.startupEntered,
        aborted.then(() =>
          assert.fail('Startup ended before the fixture entered I/O'),
        ),
      ]);
    } finally {
      controller.abort(reason);
      await aborted;
    }
  } finally {
    await stopAdapter(pending.adapter);
  }
}

function collecting(
  events: PlatformInboundEvent[],
  signal?: AbortSignal,
): AdapterContext {
  return {
    async emit(event) {
      events.push(event);
    },
    signal,
  };
}

async function stopAdapter(adapter: PlatformAdapter) {
  await Promise.all([adapter.stop(), adapter.stop()]);
  await adapter.stop();
}

function nonempty(value: unknown, field: string): asserts value is string {
  assert.ok(
    typeof value === 'string' && value.trim(),
    field + ' must be a non-empty string',
  );
}

function checkCapabilities(adapter: PlatformAdapter) {
  nonempty(adapter.id, 'Adapter ID');
  nonempty(adapter.kind, 'Adapter kind');
  const { capabilities } = adapter;
  for (const [name, method] of uploads) {
    const limit = capabilities[name];
    assert.equal(
      !!limit,
      typeof adapter[method] === 'function',
      `${name} must match ${method}`,
    );
    if (limit)
      assert.ok(
        Number.isSafeInteger(limit.maxBytes) && limit.maxBytes > 0,
        name + ' must have a positive integer maxBytes',
      );
  }
  assert.equal(
    !!capabilities.reactions,
    typeof adapter.sendReaction === 'function',
    'reactions must match sendReaction',
  );
  assert.equal(
    !!capabilities.presence,
    typeof adapter.setPresence === 'function',
    'presence must match setPresence',
  );
  assert.equal(
    !!capabilities.stickers,
    typeof adapter.sendSticker === 'function',
    'stickers must match sendSticker',
  );
  assert.equal(
    !!capabilities.stickers,
    typeof adapter.searchStickers === 'function' ||
      typeof adapter.getStickerSet === 'function',
    'stickers must have native search or an indexable sticker set',
  );
  if (capabilities.presence) {
    const { states, text } = capabilities.presence;
    assert.equal(typeof text, 'boolean');
    assert.ok(
      states.length && new Set(states).size === states.length,
      'Presence states must be non-empty and distinct',
    );
    for (const state of states)
      assert.ok(
        ['online', 'idle', 'busy', 'offline'].includes(state),
        'Unknown presence state',
      );
  }
  if (capabilities.maxInlineButtons !== undefined) {
    assert.ok(
      capabilities.inlineButtons,
      'maxInlineButtons requires inlineButtons',
    );
    assert.ok(
      Number.isSafeInteger(capabilities.maxInlineButtons) &&
        capabilities.maxInlineButtons > 0,
    );
  }
  if (capabilities.outboundPush !== undefined)
    assert.ok(['free', 'metered', 'none'].includes(capabilities.outboundPush));
  for (const method of ['typing', 'deleteMessage', 'updateChoices'] as const) {
    if (adapter[method] !== undefined)
      assert.equal(typeof adapter[method], 'function', method);
  }
}

function checkInbound(event: PlatformInboundEvent) {
  nonempty(event.chatId, 'Inbound chat ID');
  if ('threadId' in event && event.threadId !== undefined)
    nonempty(event.threadId, 'Inbound thread ID');
  switch (event.type) {
    case 'chat-migrated':
      nonempty(event.newChatId, 'Migrated chat ID');
      if (event.message) checkInbound(event.message);
      break;
    case 'message':
      nonempty(event.userId, 'Inbound user ID');
      nonempty(event.sender?.id, 'Inbound sender ID');
      assert.ok(
        ['dm', 'group', 'supergroup'].includes(event.chatKind),
        'Invalid inbound chat kind',
      );
      assert.equal(typeof event.text, 'string');
      if (event.edited !== undefined)
        assert.equal(typeof event.edited, 'boolean');
      if (event.botMessage !== undefined)
        assert.equal(typeof event.botMessage, 'boolean');
      nonempty(event.messageId, 'Inbound message ID');
      break;
    case 'callback':
      nonempty(event.userId, 'Callback user ID');
      nonempty(event.callbackId, 'Callback ID');
      if (event.queryId !== undefined)
        nonempty(event.queryId, 'Callback query ID');
      nonempty(event.messageId, 'Callback message ID');
      break;
    case 'delete':
      nonempty(event.messageId, 'Deleted message ID');
      break;
    default:
      assert.fail('Unknown inbound event type');
  }
}

function checkReceipt(receipt: SendReceipt) {
  nonempty(receipt.messageId, 'Sent message ID');
  if (receipt.parts) {
    assert.ok(receipt.parts.length > 0);
    assert.ok(
      receipt.parts.some((part) => part.messageId === receipt.messageId),
      'Receipt message ID must identify a sent part',
    );
    for (const part of receipt.parts) {
      nonempty(part.messageId, 'Sent part message ID');
      assert.equal(typeof part.text, 'string');
      if (part.chatId !== undefined) nonempty(part.chatId, 'Sent part chat ID');
      if (part.mediaId !== undefined)
        nonempty(part.mediaId, 'Sent part media ID');
      if (part.mediaIds !== undefined) {
        assert.ok(Array.isArray(part.mediaIds));
        for (const id of part.mediaIds) nonempty(id, 'Sent part media ID');
      }
    }
  }
}

async function checkUploads(
  { media, message, oversizedError }: AdapterContractOptions,
  { adapter, deliveryCount }: AdapterContractFixture,
) {
  const signal = new AbortController().signal;
  for (const [name, method] of uploads) {
    const limit = adapter.capabilities[name]?.maxBytes;
    if (limit === undefined) continue;
    const sample = media?.[name];
    assert.ok(sample, `Provide a valid ${name} upload fixture`);
    const send = adapter[method]!.bind(adapter);
    const receipt = await send(sample, signal);
    if (name === 'images') {
      assert.equal(
        'queued' in receipt,
        !!adapter.capabilities.images?.queued,
        'Image receipts must match images.queued',
      );
    }
    if ('queued' in receipt) {
      assert.equal(receipt.queued, true);
      nonempty(receipt.id, 'Queued media ID');
      const delivered = await adapter.send(message, { media: [receipt] });
      checkReceipt(delivered);
      assert.ok(
        delivered.parts?.some(
          (part) =>
            part.mediaId === receipt.id || part.mediaIds?.includes(receipt.id),
        ),
        'A queued upload must be linked to its delivered part',
      );
    } else {
      checkReceipt(receipt);
    }
    const calls = deliveryCount();
    const bytes = new Uint8Array(limit + 1);
    bytes.set(sample.file.bytes);
    await assert.rejects(async () => {
      await send({ ...sample, file: { ...sample.file, bytes } }, signal);
    }, oversizedError ?? Error);
    assert.equal(
      deliveryCount(),
      calls,
      'Rejected upload reached the platform',
    );
  }
}

export interface AgentContractOptions {
  create(): AgentConnector | Promise<AgentConnector>;
  failure: { expected: Error | RegExp; request: AgentRequest };
  io: AgentIO;
  request: AgentRequest;
}

export function checkAgentContract(
  options: AgentContractOptions,
): Promise<AgentEvent[]>;
export function checkAgentContract(
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
): Promise<AgentEvent[]>;
export async function checkAgentContract(
  input: AgentConnector | AgentContractOptions,
  request?: AgentRequest,
  io?: AgentIO,
): Promise<AgentEvent[]> {
  if (!('create' in input)) {
    checkAgentIdentity(input);
    try {
      await input.start?.();
      return await checkRun(input, request!, io!);
    } finally {
      await input.stop?.();
    }
  }

  const agent = await input.create();
  checkAgentIdentity(agent);
  await stopAgent(agent);
  try {
    await Promise.all([agent.start?.(), agent.start?.()]);
    await agent.start?.();
    const events = await checkRun(agent, input.request, input.io);
    await assert.rejects(
      checkRun(agent, input.failure.request, input.io),
      input.failure.expected,
    );
    await stopAgent(agent);
    await agent.start?.();
    await checkRun(agent, input.request, input.io);
    return events;
  } finally {
    await stopAgent(agent);
  }
}

async function stopAgent(agent: AgentConnector) {
  await Promise.all([agent.stop?.(), agent.stop?.()]);
  await agent.stop?.();
}

function checkAgentIdentity(agent: AgentConnector) {
  nonempty(agent.id, 'Agent ID');
  nonempty(agent.kind, 'Agent kind');
  assert.ok(
    ['external', 'framework'].includes(agent.loop),
    'Invalid agent loop',
  );
}

async function checkRun(
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
) {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(request, io)) {
    checkAgentEvent(event);
    if (event.type === 'error') throw event.error;
    events.push(event);
  }
  assert.ok(
    events.some(
      (event) =>
        (event.type === 'text.delta' || event.type === 'text.final') &&
        event.text.trim(),
    ),
    'Expected a text response from the agent fixture',
  );
  return events;
}

function checkAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case 'text.delta':
    case 'text.final':
    case 'reasoning':
      assert.equal(typeof event.text, 'string');
      break;
    case 'sessionId':
      nonempty(event.sessionId, 'Agent session ID');
      break;
    case 'model':
      nonempty(event.model, 'Agent model');
      if (event.reasoning !== undefined)
        assert.equal(typeof event.reasoning, 'string');
      break;
    case 'tool.started':
    case 'tool.finished':
      nonempty(event.name, 'Agent tool name');
      nonempty(event.callId, 'Agent tool call ID');
      if (event.type === 'tool.finished')
        assert.ok(['ok', 'error', 'denied'].includes(event.status));
      break;
    case 'tool.input':
      nonempty(event.callId, 'Agent tool call ID');
      assert.ok('args' in event);
      break;
    case 'approval.requested':
      nonempty(event.request.action, 'Approval action');
      assert.ok(event.request.resource);
      break;
    case 'compaction':
      assert.ok(
        ['post-turn', 'async', 'manual', 'native'].includes(event.trigger),
      );
      if (event.status !== undefined)
        assert.ok(['ok', 'error'].includes(event.status));
      checkUsage(event.durationMs, event.tokensBefore, event.tokensAfter);
      break;
    case 'usage':
      checkUsage(
        event.inputTokens,
        event.outputTokens,
        event.cachedInputTokens,
        event.cacheWriteTokens,
        event.contextWindow,
        event.contextTokens ?? undefined,
        event.costUsd,
      );
      break;
    case 'error':
      assert.ok(event.error instanceof Error);
      break;
    default:
      assert.fail('Unknown agent event type');
  }
}

function checkUsage(...values: (number | undefined)[]) {
  for (const value of values) {
    if (value !== undefined)
      assert.ok(
        Number.isFinite(value) && value >= 0,
        'Usage must be finite and non-negative',
      );
  }
}
