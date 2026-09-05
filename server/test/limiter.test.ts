import { describe, it, expect } from 'vitest';
import { Limiter, DEFAULT_PARSE_LIMIT } from '../src/limiter.ts';

/** A promise plus the handle that settles it, for driving tasks by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('Limiter', () => {
  it('runs tasks up to the limit concurrently', async () => {
    const limiter = new Limiter(2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map(gate => limiter.run(async () => {
      started++;
      await gate.promise;
    }));

    // A macrotask boundary drains every pending microtask, so nothing is
    // still mid-handoff when the count is read.
    const settle = (): Promise<void> =>
      new Promise(resolve => setTimeout(resolve, 0));

    await settle();
    expect(started).toBe(2);

    gates[0]!.resolve();
    await settle();
    expect(started).toBe(3);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
  });

  it('never exceeds the limit when callers arrive while a slot is freed', async () => {
    const limiter = new Limiter(2);
    let inFlight = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
    };

    // Half up front, half added mid-flight — the window where a naive
    // implementation hands the same slot to a waiter and a new arrival.
    const first = Array.from({ length: 10 }, () => limiter.run(task));
    const second = Array.from({ length: 10 }, () => limiter.run(task));
    await Promise.all([...first, ...second]);

    expect(peak).toBe(2);
  });

  it('returns each task result and frees the slot after a rejection', async () => {
    const limiter = new Limiter(1);

    await expect(limiter.run(() => Promise.reject(new Error('boom'))))
      .rejects.toThrow('boom');

    // A leaked slot would leave this pending forever.
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('preserves FIFO order among waiting tasks', async () => {
    const limiter = new Limiter(1);
    const order: number[] = [];
    const runs = [1, 2, 3, 4].map(n => limiter.run(async () => {
      order.push(n);
      await new Promise(resolve => setTimeout(resolve, 1));
    }));

    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('defaults to the shared parse limit', async () => {
    const limiter = new Limiter();
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: DEFAULT_PARSE_LIMIT + 5 }, () => limiter.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight--;
      })),
    );

    expect(peak).toBe(DEFAULT_PARSE_LIMIT);
  });
});
