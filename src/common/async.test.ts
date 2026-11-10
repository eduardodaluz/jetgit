import { describe, it, expect, vi } from 'vitest';
import { debounce, DisposableCollection, GenerationToken, Semaphore } from './async';

describe('debounce', () => {
  it('collapses rapid calls into one invocation', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 50);
    debounced('a');
    debounced('b');
    debounced('c');
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
    vi.useRealTimers();
  });

  it('cancel() prevents the pending invocation', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 50);
    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('GenerationToken', () => {
  it('captured generations stay current until invalidated', () => {
    const token = new GenerationToken();
    const captured = token.capture();
    expect(token.isCurrent(captured)).toBe(true);
    token.invalidate();
    expect(token.isCurrent(captured)).toBe(false);
    const fresh = token.capture();
    expect(token.isCurrent(fresh)).toBe(true);
  });

  it('multiple invalidations keep moving the generation forward', () => {
    const token = new GenerationToken();
    const first = token.capture();
    token.invalidate();
    token.invalidate();
    expect(token.isCurrent(first)).toBe(false);
  });
});

describe('Semaphore', () => {
  it('runs tasks one at a time in submission order', async () => {
    const sem = new Semaphore(1);
    const events: number[] = [];
    const make = (n: number, ms: number): Promise<void> =>
      sem.run(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              events.push(n);
              resolve();
            }, ms);
          }),
      );
    const all = Promise.all([make(1, 30), make(2, 10), make(3, 5)]);
    await all;
    expect(events).toEqual([1, 2, 3]);
  });

  it('propagates rejection without blocking the queue', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('DisposableCollection', () => {
  it('disposes everything exactly once and disposes late adds immediately', () => {
    const disposed: string[] = [];
    const coll = new DisposableCollection();
    coll.add({ dispose: () => void disposed.push('a') });
    coll.dispose();
    const late = coll.add({ dispose: () => void disposed.push('late') });
    void late;
    expect(disposed).toEqual(['a', 'late']);
  });
});
