import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ARCCache } from './arc.js';
import type { CacheEntry } from '../types.js';

function createEntry<T>(value: T, size: number, ttlMs?: number): CacheEntry<T> {
  return {
    value,
    size,
    createdAt: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
  };
}

describe('ARCCache', () => {
  describe('constructor', () => {
    it('should create cache with valid maxSize', () => {
      const cache = new ARCCache({ maxSize: 1024 });
      expect(cache.maxSize).toBe(1024);
      expect(cache.size).toBe(0);
      expect(cache.itemCount).toBe(0);
    });

    it('should throw for non-positive maxSize', () => {
      expect(() => new ARCCache({ maxSize: 0 })).toThrow('maxSize must be positive');
      expect(() => new ARCCache({ maxSize: -1 })).toThrow('maxSize must be positive');
    });
  });

  describe('set and get', () => {
    it('should store and retrieve values', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      const entry = createEntry('value1', 100);

      cache.set('key1', entry);

      const result = cache.get('key1');
      expect(result).toBeDefined();
      expect(result?.value).toBe('value1');
    });

    it('should return undefined for non-existent keys', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should update existing key', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('value1', 100));
      cache.set('key1', createEntry('value2', 100));

      expect(cache.get('key1')?.value).toBe('value2');
      expect(cache.itemCount).toBe(1);
    });

    it('should track size correctly', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      expect(cache.size).toBe(100);

      cache.set('key2', createEntry('b', 200));
      expect(cache.size).toBe(300);

      cache.set('key1', createEntry('c', 150)); // Update with different size
      expect(cache.size).toBe(350);
    });

    it('should throw for non-positive entry size', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      expect(() => cache.set('key', createEntry('v', 0))).toThrow('Entry size must be positive');
      expect(() => cache.set('key', createEntry('v', -1))).toThrow('Entry size must be positive');
    });

    it('should not store entries larger than maxSize', () => {
      const onEvict = vi.fn();
      const cache = new ARCCache<string>({ maxSize: 100, onEvict });

      cache.set('key', createEntry('value', 200));

      expect(cache.itemCount).toBe(0);
      expect(onEvict).toHaveBeenCalledTimes(1);
    });
  });

  describe('ARC eviction and adaptation', () => {
    it('should evict entries when full', () => {
      const cache = new ARCCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Cache is full (300/300), adding key4 should evict something
      cache.set('key4', createEntry('d', 100));

      expect(cache.itemCount).toBe(3);
      expect(cache.size).toBeLessThanOrEqual(300);
    });

    it('should promote items from T1 to T2 on second access', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      const stats1 = cache.getStats();
      expect(stats1.t1Size).toBe(100);
      expect(stats1.t2Size).toBe(0);

      // Access key1, should move to T2
      cache.get('key1');
      const stats2 = cache.getStats();
      expect(stats2.t1Size).toBe(0);
      expect(stats2.t2Size).toBe(100);
    });

    it('should adapt to workload by adjusting p', () => {
      const cache = new ARCCache<string>({ maxSize: 400 });

      // Fill cache
      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));
      cache.set('key4', createEntry('d', 100));

      // All in T1, evict key1 and key2 to make room
      cache.set('key5', createEntry('e', 100));
      cache.set('key6', createEntry('f', 100));

      const stats = cache.getStats();
      // p should adapt based on hits in ghost lists
      expect(stats.p).toBeGreaterThanOrEqual(0);
      expect(stats.p).toBeLessThanOrEqual(cache.maxSize);
    });

    it('should evict multiple entries if needed', () => {
      const cache = new ARCCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Adding large entry should evict multiple
      cache.set('key4', createEntry('d', 250));

      expect(cache.itemCount).toBe(1);
      expect(cache.has('key4')).toBe(true);
    });

    it('should call onEvict callback', () => {
      const onEvict = vi.fn();
      const cache = new ARCCache<string>({ maxSize: 200, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      expect(onEvict).toHaveBeenCalled();
    });

    it('should prefer keeping frequently accessed items', () => {
      const cache = new ARCCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Access key1 twice to move it to T2 and make it "frequent"
      cache.get('key1');
      cache.get('key1');

      // key2 and key3 are still in T1 (recent only)
      // Adding key4 should prefer evicting from T1
      cache.set('key4', createEntry('d', 100));

      expect(cache.has('key1')).toBe(true); // Should survive (in T2)
    });

    it('should handle ghost list hits for adaptation', () => {
      const cache = new ARCCache<string>({ maxSize: 200 });

      // Add and evict key1
      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100)); // key1 evicted to B1

      const statsBefore = cache.getStats();

      // Re-add key1 - should hit B1 ghost and increase p
      cache.set('key1', createEntry('a', 100));

      const statsAfter = cache.getStats();
      // p should have increased (more space for T1)
      expect(statsAfter.p).toBeGreaterThanOrEqual(statsBefore.p);
    });
  });

  describe('delete', () => {
    it('should delete existing key from T1', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));

      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should delete existing key from T2', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));
      cache.get('key1'); // Move to T2

      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should return false for non-existent key', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should not call onEvict on delete', () => {
      const onEvict = vi.fn();
      const cache = new ARCCache<string>({ maxSize: 1024, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.delete('key1');

      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.get('key1'); // Move to T2
      cache.set('key3', createEntry('c', 100));

      cache.clear();

      expect(cache.itemCount).toBe(0);
      expect(cache.size).toBe(0);
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(false);
    });

    it('should call onEvict for all entries', () => {
      const onEvict = vi.fn();
      const cache = new ARCCache<string>({ maxSize: 1024, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.get('key1'); // Move to T2

      cache.clear();

      expect(onEvict).toHaveBeenCalledTimes(2);
    });

    it('should reset internal state including ghost lists', () => {
      const cache = new ARCCache<string>({ maxSize: 200 });

      // Create ghost entries
      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100)); // Evicts key1

      cache.clear();

      const stats = cache.getStats();
      expect(stats.t1Size).toBe(0);
      expect(stats.t2Size).toBe(0);
      expect(stats.b1Size).toBe(0);
      expect(stats.b2Size).toBe(0);
      expect(stats.p).toBe(0);
    });
  });

  describe('has', () => {
    it('should return true for existing key in T1', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));
      expect(cache.has('key1')).toBe(true);
    });

    it('should return true for existing key in T2', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));
      cache.get('key1'); // Move to T2
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should not move item between lists', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));

      const statsBefore = cache.getStats();
      cache.has('key1');
      const statsAfter = cache.getStats();

      expect(statsAfter.t1Size).toBe(statsBefore.t1Size);
      expect(statsAfter.t2Size).toBe(statsBefore.t2Size);
    });
  });

  describe('TTL and expiration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return undefined for expired entries on get', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000)); // 1 second TTL

      expect(cache.get('key1')?.value).toBe('a');

      vi.advanceTimersByTime(1001);

      expect(cache.get('key1')).toBeUndefined();
    });

    it('should remove expired entry from cache on get', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));

      vi.advanceTimersByTime(1001);

      cache.get('key1');

      expect(cache.itemCount).toBe(0);
      expect(cache.size).toBe(0);
    });

    it('should return false for expired entries on has', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));

      expect(cache.has('key1')).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(cache.has('key1')).toBe(false);
    });

    it('should not expire entries without TTL', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100)); // No TTL

      vi.advanceTimersByTime(1000000);

      expect(cache.get('key1')?.value).toBe('a');
    });

    it('should prune expired entries from T1 and T2', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100, 1000));
      cache.set('key2', createEntry('b', 100, 2000));
      cache.set('key3', createEntry('c', 100)); // No TTL
      cache.get('key1'); // Move key1 to T2

      vi.advanceTimersByTime(1500);

      const pruned = cache.prune();

      expect(pruned).toBe(1);
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
    });

    it('should handle expiration in T2', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));
      cache.get('key1'); // Move to T2

      vi.advanceTimersByTime(1001);

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.itemCount).toBe(0);
    });
  });

  describe('peek', () => {
    it('should return entry without moving between lists', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      const statsBefore = cache.getStats();

      const peeked = cache.peek('key1');
      expect(peeked?.value).toBe('a');

      const statsAfter = cache.getStats();
      expect(statsAfter.t1Size).toBe(statsBefore.t1Size);
      expect(statsAfter.t2Size).toBe(statsBefore.t2Size);
    });

    it('should return undefined for non-existent key', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });
      expect(cache.peek('nonexistent')).toBeUndefined();
    });

    it('should handle expired entries', () => {
      vi.useFakeTimers();
      const cache = new ARCCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));

      vi.advanceTimersByTime(1001);

      expect(cache.peek('key1')).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe('keys iterator', () => {
    it('should iterate all keys (T2 first, then T1)', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.get('key1'); // Move key1 to T2
      cache.set('key3', createEntry('c', 100));

      const keys = [...cache.keys()];
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
      expect(keys.length).toBe(3);
    });

    it('should skip expired entries', () => {
      vi.useFakeTimers();
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100, 1000));
      cache.set('key2', createEntry('b', 100));

      vi.advanceTimersByTime(1001);

      const keys = [...cache.keys()];
      expect(keys).toEqual(['key2']);

      vi.useRealTimers();
    });
  });

  describe('entries iterator', () => {
    it('should iterate all entries', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.get('key1'); // Move to T2

      const entries = [...cache.entries()];
      expect(entries.length).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      const cache = new ARCCache<string>({ maxSize: 500 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.get('key1'); // Move to T2

      const stats = cache.getStats();

      expect(stats.t1Size).toBe(100); // key2
      expect(stats.t2Size).toBe(100); // key1
      expect(stats.maxSize).toBe(500);
    });
  });

  describe('edge cases', () => {
    it('should handle single item cache', () => {
      const cache = new ARCCache<string>({ maxSize: 100 });

      cache.set('key1', createEntry('a', 100));
      expect(cache.get('key1')?.value).toBe('a');

      cache.set('key2', createEntry('b', 100));
      expect(cache.has('key1')).toBe(false);
      expect(cache.get('key2')?.value).toBe('b');
    });

    it('should handle rapid set/get/delete operations', () => {
      const cache = new ARCCache<number>({ maxSize: 1000 });

      for (let i = 0; i < 100; i++) {
        cache.set(`key${i}`, createEntry(i, 10));
      }

      for (let i = 0; i < 50; i++) {
        cache.get(`key${i * 2}`);
      }

      for (let i = 0; i < 25; i++) {
        cache.delete(`key${i}`);
      }

      // Should not throw and maintain invariants
      expect(cache.size).toBeLessThanOrEqual(cache.maxSize);
      expect(cache.itemCount).toBeGreaterThan(0);
    });

    it('should handle updating entry with larger size causing eviction', () => {
      const cache = new ARCCache<string>({ maxSize: 200 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 50));

      // Update key2 with larger size, should evict key1
      cache.set('key2', createEntry('b-large', 150));

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.size).toBe(150);
    });

    it('should handle workload pattern changes (scan-resistant)', () => {
      const cache = new ARCCache<string>({ maxSize: 300 });

      // Working set
      cache.set('w1', createEntry('work1', 100));
      cache.set('w2', createEntry('work2', 100));

      // Access working set frequently
      for (let i = 0; i < 10; i++) {
        cache.get('w1');
        cache.get('w2');
      }

      // Scan - add many items once
      for (let i = 0; i < 20; i++) {
        cache.set(`scan${i}`, createEntry(`scan${i}`, 100));
      }

      // Working set should still be accessible (ARC should adapt)
      // At least one of the working set items should survive
      const w1Present = cache.has('w1');
      const w2Present = cache.has('w2');
      expect(w1Present || w2Present).toBe(true);
    });

    it('should handle empty cache operations gracefully', () => {
      const cache = new ARCCache<string>({ maxSize: 100 });

      expect(cache.get('nonexistent')).toBeUndefined();
      expect(cache.delete('nonexistent')).toBe(false);
      expect(cache.has('nonexistent')).toBe(false);
      expect([...cache.keys()]).toEqual([]);
      expect([...cache.entries()]).toEqual([]);

      cache.clear(); // Should not throw

      expect(cache.itemCount).toBe(0);
      expect(cache.size).toBe(0);
    });

    it('should maintain T1 and T2 ordering (MRU at head)', () => {
      const cache = new ARCCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // key3 should be at head of T1 (most recent)
      const keys = [...cache.keys()];
      expect(keys[0]).toBe('key3');
    });

    it('should handle re-adding evicted keys (ghost hits)', () => {
      const cache = new ARCCache<string>({ maxSize: 200 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));

      // Evict key1
      cache.set('key3', createEntry('c', 100));

      // key1 should now be in B1 ghost list
      expect(cache.has('key1')).toBe(false);

      // Re-add key1 - should hit ghost and adapt
      cache.set('key1', createEntry('a-new', 100));

      expect(cache.has('key1')).toBe(true);
      expect(cache.get('key1')?.value).toBe('a-new');
    });
  });
});
