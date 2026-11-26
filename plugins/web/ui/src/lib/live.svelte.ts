import type { AdminEvent } from '@tsugimori/plugin-sdk';

import { SvelteSet } from 'svelte/reactivity';

type Signal = Exclude<AdminEvent, { kind: 'reload' }> | { kind: 'reset' };
type Listener = (event: Signal) => void;
const kinds = [
  'message',
  'task',
  'tool',
  'approval',
  'summary',
  'chat',
  'schedule',
  'reset',
  'ready',
] as const;
const listeners = new SvelteSet<Listener>();
let status = $state<'connected' | 'reconnecting' | 'offline'>('reconnecting');
let last = $state<number | null>(null);
let source: EventSource | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

function disconnecting() {
  status = 'reconnecting';
  timeout ??= setTimeout(() => {
    status = 'offline';
  }, 30_000);
}

export const live = {
  get status() {
    return status;
  },
  get last() {
    return last;
  },
  start() {
    if (source) return;
    const connection = new EventSource('/api/events');
    source = connection;
    disconnecting();
    connection.onopen = () => {
      clearTimeout(timeout);
      timeout = undefined;
      status = 'connected';
    };
    connection.onerror = () => {
      if (status !== 'offline') disconnecting();
    };
    for (const kind of kinds) {
      connection.addEventListener(kind, (event: MessageEvent<string>) => {
        if (kind !== 'ready') last = Date.now();
        const signal =
          kind === 'ready'
            ? { kind: 'reset' }
            : { ...JSON.parse(event.data), kind };
        for (const listener of listeners) listener(signal as Signal);
      });
    }
    return () => {
      connection.close();
      source = undefined;
      clearTimeout(timeout);
      timeout = undefined;
    };
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function eventKey(event: Signal) {
  switch (event.kind) {
    case 'chat':
    case 'message':
    case 'summary':
      return JSON.stringify([event.adapterId, event.chatId]);
    case 'tool':
      return event.taskId;
    case 'reset':
      return 'reset';
    default:
      return event.id;
  }
}
