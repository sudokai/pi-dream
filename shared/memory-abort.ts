/**
 * AbortSignal composition and bounded async helpers for memory operations.
 */

/** Whether a query has no searchable lexical/semantic content. */
export function isMemoryQueryBlank(query: string): boolean {
  return query.trim().length === 0;
}

/**
 * Compose caller cancellation with an optional independent timeout.
 * When neither is provided, returns a never-aborted signal.
 */
export function composeMemoryAbortSignal(
  signal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) {
    parts.push(AbortSignal.timeout(timeoutMs));
  }
  if (parts.length === 0) {
    return new AbortController().signal;
  }
  if (parts.length === 1) return parts[0]!;
  return AbortSignal.any(parts);
}

/** Throw when the effective signal is already aborted. */
export function throwIfMemoryAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * Race `promise` against abort/timeout. Rejects with AbortError when the
 * effective signal fires first; does not cancel the underlying promise.
 */
export async function raceMemoryOperation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const effective = composeMemoryAbortSignal(signal, timeoutMs);
  if (effective.aborted) {
    throw effective.reason ?? new DOMException("Aborted", "AbortError");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(effective.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      effective.removeEventListener("abort", onAbort);
    };
    effective.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        if (effective.aborted) {
          reject(effective.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}
