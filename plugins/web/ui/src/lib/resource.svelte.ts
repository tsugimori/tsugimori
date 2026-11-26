import { SvelteMap } from 'svelte/reactivity';

import { ApiError, fetchData } from './api.ts';
import { eventKey, live } from './live.svelte.ts';

type Signal = Parameters<Parameters<typeof live.subscribe>[0]>[0];

export function resource<T>(
  url: () => string | undefined,
  follows: (event: Signal, current: T | undefined) => boolean,
) {
  let data = $state.raw<T>();
  let error = $state<string>();
  let refresh: (() => void) | undefined;
  let updated = $state(Date.now());
  $effect(() => {
    const path = url();
    data = undefined;
    error = undefined;
    if (path === undefined) return;
    const timers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
    let current: T | undefined;
    let controller: AbortController | undefined;
    let queued = false;
    const load = async () => {
      if (controller) {
        queued = true;
        return;
      }
      const request = (controller = new AbortController());
      try {
        const value = await fetchData<T>(path, request.signal);
        if (request.signal.aborted) return;
        current = data = value;
        error = undefined;
        updated = Date.now();
      } catch (cause) {
        if (!request.signal.aborted)
          error = cause instanceof ApiError ? cause.key : 'internal';
      } finally {
        controller = undefined;
        if (queued && !request.signal.aborted) {
          queued = false;
          void load();
        }
      }
    };
    refresh = () => {
      void load();
    };
    refresh();
    let batch: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = live.subscribe((event) => {
      if (event.kind !== 'reset' && !follows(event, current)) return;
      const key = eventKey(event);
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          batch ??= setTimeout(() => {
            batch = undefined;
            void load();
          }, 0);
        }, 300),
      );
    });
    return () => {
      refresh = undefined;
      unsubscribe();
      controller?.abort();
      clearTimeout(batch);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  });
  return {
    get data() {
      return data;
    },
    get updated() {
      return updated;
    },
    get error() {
      return error;
    },
    retry() {
      refresh?.();
    },
  };
}
