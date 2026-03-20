import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Singleflight, globalSingleflight } from './singleflight.js';

describe('Singleflight', () => {
  let sf: Singleflight;

  beforeEach(() => {
    sf = new Singleflight();
  });

  describe('do', () => {
    it('should execute function and return result', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const result = await sf.do('key1', fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should execute different keys independently', async () => {
      const fn1 = vi.fn().mockResolvedValue('result1');
      const fn2 = vi.fn().mockResolvedValue('result2');

      const [r1, r2] = await Promise.all([
        sf.do('key1', fn1),
        sf.do('key2', fn2),
      ]);

      expect(r1).toBe('result1');
      expect(r2).toBe('result2');
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent calls for same key', async () => {
      let resolvePromise: (value: string) => void;
      const slowFn = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      // Start multiple concurrent calls
      const promise1 = sf.do('key1', slowFn);
      const promise2 = sf.do('key1', slowFn);
      const promise3 = sf.do('key1', slowFn);

      // Function should only be called once
      expect(slowFn).toHaveBeenCalledTimes(1);

      // Resolve the function
      resolvePromise!('shared-result');

      // All should receive the same result
      const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

      expect(r1).toBe('shared-result');
      expect(r2).toBe('shared-result');
      expect(r3).toBe('shared-result');
    });

    it('should propagate errors to all waiters', async () => {
      const error = new Error('test error');
      let rejectPromise: (error: Error) => void;
      const failingFn = vi.fn().mockImplementation(() => {
        return new Promise<string>((_, reject) => {
          rejectPromise = reject;
        });
      });

      const promise1 = sf.do('key1', failingFn);
      const promise2 = sf.do('key1', failingFn);

      rejectPromise!(error);

      await expect(promise1).rejects.toThrow('test error');
      await expect(promise2).rejects.toThrow('test error');
    });

    it('should allow new call after previous completes', async () => {
      const fn = vi.fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      const result1 = await sf.do('key1', fn);
      const result2 = await sf.do('key1', fn);

      expect(result1).toBe('first');
      expect(result2).toBe('second');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should allow new call after previous fails', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('first'))
        .mockResolvedValueOnce('second');

      await expect(sf.do('key1', fn)).rejects.toThrow('first');
      const result = await sf.do('key1', fn);

      expect(result).toBe('second');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should handle many concurrent waiters', async () => {
      let resolvePromise: (value: number) => void;
      const fn = vi.fn().mockImplementation(() => {
        return new Promise<number>((resolve) => {
          resolvePromise = resolve;
        });
      });

      // Start 100 concurrent calls
      const promises = Array.from({ length: 100 }, () =>
        sf.do('key1', fn)
      );

      expect(fn).toHaveBeenCalledTimes(1);

      resolvePromise!(42);

      const results = await Promise.all(promises);

      expect(results.every(r => r === 42)).toBe(true);
    });
  });

  describe('doWithInfo', () => {
    it('should return executed: true for executor', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const result = await sf.doWithInfo('key1', fn);

      expect(result.value).toBe('result');
      expect(result.executed).toBe(true);
      expect(result.shared).toBe(1);
    });

    it('should return executed: false for waiters', async () => {
      let resolvePromise: (value: string) => void;
      const fn = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      const promise1 = sf.doWithInfo('key1', fn);
      const promise2 = sf.doWithInfo('key1', fn);
      const promise3 = sf.doWithInfo('key1', fn);

      resolvePromise!('result');

      const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

      // First caller executed
      expect(r1.executed).toBe(true);
      expect(r1.shared).toBe(3);

      // Others waited
      expect(r2.executed).toBe(false);
      expect(r2.shared).toBe(3);
      expect(r3.executed).toBe(false);
      expect(r3.shared).toBe(3);
    });

    it('should track correct number of shared waiters', async () => {
      let resolvePromise: (value: string) => void;
      const fn = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      // Start with 2 concurrent calls
      const promise1 = sf.doWithInfo('key1', fn);
      const promise2 = sf.doWithInfo('key1', fn);

      // Slight delay then add more
      await new Promise(r => setTimeout(r, 0));
      const promise3 = sf.doWithInfo('key1', fn);
      const promise4 = sf.doWithInfo('key1', fn);

      resolvePromise!('result');

      const results = await Promise.all([promise1, promise2, promise3, promise4]);

      // All should report shared = 4
      expect(results.every(r => r.shared === 4)).toBe(true);
    });
  });

  describe('isInFlight', () => {
    it('should return false when no call is in flight', () => {
      expect(sf.isInFlight('key1')).toBe(false);
    });

    it('should return true when call is in flight', async () => {
      let resolvePromise: () => void;
      const fn = () => new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

      const promise = sf.do('key1', fn);

      expect(sf.isInFlight('key1')).toBe(true);

      resolvePromise!();
      await promise;

      expect(sf.isInFlight('key1')).toBe(false);
    });
  });

  describe('inFlightCount', () => {
    it('should return 0 when no calls are in flight', () => {
      expect(sf.inFlightCount).toBe(0);
    });

    it('should track number of in-flight keys', async () => {
      const fn = () => new Promise<void>(() => {}); // Never resolves

      sf.do('key1', fn);
      expect(sf.inFlightCount).toBe(1);

      sf.do('key2', fn);
      expect(sf.inFlightCount).toBe(2);

      // Same key doesn't increase count
      sf.do('key1', fn);
      expect(sf.inFlightCount).toBe(2);
    });
  });

  describe('forget', () => {
    it('should allow new execution for forgotten key', async () => {
      let resolveFirst: (value: string) => void;
      let callCount = 0;

      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve('second');
      });

      // Start first call
      const promise1 = sf.do('key1', fn);

      // Forget allows new call
      sf.forget('key1');

      // Second call now executes
      const promise2 = sf.do('key1', fn);

      expect(fn).toHaveBeenCalledTimes(2);

      resolveFirst!('first');

      const [r1, r2] = await Promise.all([promise1, promise2]);
      expect(r1).toBe('first');
      expect(r2).toBe('second');
    });

    it('should return false for non-existent key', () => {
      expect(sf.forget('nonexistent')).toBe(false);
    });

    it('should return true for existing key', async () => {
      const fn = () => new Promise<void>(() => {});
      sf.do('key1', fn);
      expect(sf.forget('key1')).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear all in-flight tracking', async () => {
      const fn = () => new Promise<void>(() => {});

      sf.do('key1', fn);
      sf.do('key2', fn);
      sf.do('key3', fn);

      expect(sf.inFlightCount).toBe(3);

      sf.clear();

      expect(sf.inFlightCount).toBe(0);
      expect(sf.isInFlight('key1')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid sequential calls', async () => {
      let counter = 0;
      const fn = vi.fn().mockImplementation(async () => {
        return ++counter;
      });

      const results: number[] = [];
      for (let i = 0; i < 100; i++) {
        results.push(await sf.do('key1', fn));
      }

      // Each sequential call should execute
      expect(fn).toHaveBeenCalledTimes(100);
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    });

    it('should handle synchronous functions', async () => {
      const fn = vi.fn().mockImplementation(() => Promise.resolve('sync'));

      const result = await sf.do('key1', fn);

      expect(result).toBe('sync');
    });

    it('should handle undefined return value', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);

      const result = await sf.do('key1', fn);

      expect(result).toBeUndefined();
    });

    it('should handle null return value', async () => {
      const fn = vi.fn().mockResolvedValue(null);

      const result = await sf.do('key1', fn);

      expect(result).toBeNull();
    });

    it('should handle complex objects', async () => {
      const obj = { nested: { value: 42 }, arr: [1, 2, 3] };
      const fn = vi.fn().mockResolvedValue(obj);

      const result = await sf.do('key1', fn);

      expect(result).toBe(obj);
      expect(result).toEqual({ nested: { value: 42 }, arr: [1, 2, 3] });
    });
  });

  describe('globalSingleflight', () => {
    it('should be a Singleflight instance', () => {
      expect(globalSingleflight).toBeInstanceOf(Singleflight);
    });

    it('should work correctly', async () => {
      // Clear any previous state
      globalSingleflight.clear();

      const fn = vi.fn().mockResolvedValue('global');
      const result = await globalSingleflight.do('test-key', fn);

      expect(result).toBe('global');
    });
  });
});
