import type { AdminEvent, AdminWorkspace } from '@tsugimori/plugin-sdk';

import { ApiError, fetchData } from '../lib/api.ts';
import { i18n } from '../lib/i18n.ts';

export type ConsoleEvent =
  Exclude<AdminEvent, { kind: 'reload' }> | { kind: 'reset' };

export function useConsole() {
  const workspace = useState<AdminWorkspace>('workspace', () => ({
    locale: 'en',
    timezone: 'UTC',
  }));
  const connection = useState<'live' | 'reconnecting' | 'offline'>(
    'connection',
    () => 'reconnecting',
  );
  const updated = useState<number | null>('updated', () => null);
  const event = useState<{ signal: ConsoleEvent } | null>('event', () => null);
  const now = useState<number>('clock', () => 0);
  const locale = computed(() => workspace.value.locale);
  const m = computed(() => i18n(locale.value));
  const t = (en: string, zh: string) => (locale.value === 'zh-TW' ? zh : en);
  return { connection, event, locale, m, now, t, updated, workspace };
}

export function useConsoleQuery<T>(
  path: () => string | undefined,
  live?: (event: ConsoleEvent) => boolean,
) {
  const data = shallowRef<T>();
  const error = ref<string>();
  const pending = ref(true);
  const { event } = useConsole();
  let request: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(reset = false) {
    request?.abort();
    const resource = path();
    if (reset) data.value = undefined;
    error.value = undefined;
    if (resource === undefined) {
      pending.value = false;
      return;
    }
    const controller = new AbortController();
    request = controller;
    pending.value = true;
    try {
      const result = await fetchData<T>(resource, controller.signal);
      if (!controller.signal.aborted) data.value = result;
    } catch (cause) {
      if (!controller.signal.aborted)
        error.value = cause instanceof ApiError ? cause.key : 'internal';
    } finally {
      if (!controller.signal.aborted) pending.value = false;
    }
  }

  onMounted(() => void refresh(true));
  watch(path, () => void refresh(true));
  if (live) {
    watch(event, (change) => {
      if (!change || (change.signal.kind !== 'reset' && !live(change.signal)))
        return;
      refreshTimer ??= setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 200);
    });
  }
  onBeforeUnmount(() => {
    request?.abort();
    clearTimeout(refreshTimer);
  });
  return { data, error, pending, refresh };
}

export function useFragment(ready: () => boolean) {
  const route = useRoute();
  watch(
    [() => route.hash, ready],
    async ([hash, available], _, cleanup) => {
      if (!hash || !available) return;
      let stale = false;
      let target: HTMLElement | null = null;
      cleanup(() => {
        stale = true;
        target?.classList.remove('fragment-target');
      });
      await nextTick();
      if (stale) return;
      try {
        target = document.getElementById(decodeURIComponent(hash.slice(1)));
        if (!target) return;
        for (
          let node: HTMLElement | null = target;
          node;
          node = node.parentElement
        )
          if (node instanceof HTMLDetailsElement) node.open = true;
        target.classList.add('fragment-target');
        target.scrollIntoView({ block: 'start' });
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
      }
    },
    { flush: 'post', immediate: true },
  );
}
