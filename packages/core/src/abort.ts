export function untilAborted<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const done = Promise.withResolvers<T>();
  const cancel = () => done.reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  void Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return run();
    })
    .then(done.resolve, done.reject);
  return done.promise.finally(() =>
    signal.removeEventListener('abort', cancel),
  );
}
