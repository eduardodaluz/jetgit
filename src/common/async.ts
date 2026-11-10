/**
 * Pure async utilities shared by all JetGit modules. No vscode imports —
 * everything here must be unit-testable in plain Node.
 */

export interface IDisposable {
  dispose(): void | Promise<void>;
}

/** Collects disposables and disposes them all on `dispose()`. */
export class DisposableCollection implements IDisposable {
  private readonly disposables: IDisposable[] = [];
  private disposed = false;

  add(disposable: IDisposable): IDisposable {
    if (this.disposed) {
      void disposable.dispose();
      return disposable;
    }
    this.disposables.push(disposable);
    return disposable;
  }

  dispose(): void | Promise<void> {
    this.disposed = true;
    const all = this.disposables.splice(0, this.disposables.length);
    const results = all.map((d) => d.dispose());
    const async = results.filter((r): r is Promise<void> => r instanceof Promise);
    if (async.length > 0) {
      return Promise.all(async).then(() => undefined);
    }
  }
}

/**
 * Generation-token cancellation: capture a generation, do async work, and
 * check `isCurrent(captured)` before applying results. Only the latest
 * generation is current — used by blame so a stale request can never paint
 * decorations over a newer one.
 */
export class GenerationToken {
  private generation = 0;

  /** Captures the current generation before starting async work. */
  capture(): number {
    return this.generation;
  }

  /** True when the captured generation is still the latest one. */
  isCurrent(captured: number): boolean {
    return captured === this.generation;
  }

  /** Advances the generation, invalidating all earlier captures. */
  invalidate(): void {
    this.generation += 1;
  }
}

/**
 * Debounce: the returned function schedules `fn` to run after `delayMs`
 * of silence. Multiple pending invocations collapse into one. The pending
 * timer is flushed by `cancel()`.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): ((...args: A) => void) & { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = (...args: A): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  };
  wrapped.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}

/**
 * Serializes async work: `run` calls queue and execute one at a time in
 * submission order. Used to serialize per-repo git write operations so two
 * commands never race each other into `index.lock`.
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrent = 1) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.running += 1;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.running -= 1;
            const next = this.queue.shift();
            if (next) {
              next();
            }
          });
      };
      if (this.running < this.maxConcurrent) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }
}

/** `setTimeout` as a promise. Never use for gating saves — local history must not block. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
