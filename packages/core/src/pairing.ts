import type { PlatformAdapter } from '@tsugimori/plugin-sdk';
import type { Tracer } from '@tsugimori/trace';

import { untilAborted } from './abort.ts';

export async function pairingContact(trace: Tracer, adapter?: PlatformAdapter) {
  const getLink = adapter?.contactLink;
  if (!adapter || !getLink) return;
  try {
    return await trace.span('pairing.contact', { adapterId: adapter.id }, () =>
      untilAborted(AbortSignal.timeout(5_000), () => getLink.call(adapter)),
    );
  } catch {
    // Contact is optional. The timing span records lookup failures.
    return undefined;
  }
}
