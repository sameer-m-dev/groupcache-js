import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCache } from './lru.js';
import type { CacheEntry } from '../types.js';

function createEntry<T>(value: T, size: number, ttlMs?: number): CacheEntry<T> {
  return {
    value,
    size,
    createdAt: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
  };
}

describe('LRUCache', () => {
  describe('constructor', () => {
    it('should create cache with valid maxSize', () => {
      const cache = new LRUCache({ maxSize: 1024 });
      expect(cache.maxSize).toBe(1024);
      expect(cache.size).toBe(0);
      expect(cache.itemCount).toBe(0);
    });

    it('should throw for non-positive maxSize', () => {
      expect(() => new LRUCache({ maxSize: 0 })).toThrow('maxSize must be positive');
      expect(() => new LRUCache({ maxSize: -1 })).toThrow('maxSize must be positive');
    });
  });

  describe('set and get', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      const entry = createEntry('value1', 100);

      cache.set('key1', entry);

      const result = cache.get('key1');
      expect(result).toBeDefined();
      expect(result?.value).toBe('value1');
    });

    it('should return undefined for non-existent keys', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should update existing key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('value1', 100));
      cache.set('key1', createEntry('value2', 100));

      expect(cache.get('key1')?.value).toBe('value2');
      expect(cache.itemCount).toBe(1);
    });

    it('should track size correctly', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      expect(cache.size).toBe(100);

      cache.set('key2', createEntry('b', 200));
      expect(cache.size).toBe(300);

      cache.set('key1', createEntry('c', 150)); // Update with different size
      expect(cache.size).toBe(350);
    });

    it('should throw for non-positive entry size', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      expect(() => cache.set('key', createEntry('v', 0))).toThrow('Entry size must be positive');
      expect(() => cache.set('key', createEntry('v', -1))).toThrow('Entry size must be positive');
    });

    it('should not store entries larger than maxSize', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxSize: 100, onEvict });

      cache.set('key', createEntry('value', 200));

      expect(cache.itemCount).toBe(0);
      expect(onEvict).toHaveBeenCalledTimes(1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used when full', () => {
      const cache = new LRUCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Cache is full (300/300), adding key4 should evict key1
      cache.set('key4', createEntry('d', 100));

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });

    it('should update LRU order on get', () => {
      const cache = new LRUCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Access key1, making it most recently used
      cache.get('key1');

      // Adding key4 should evict key2 (now LRU)
      cache.set('key4', createEntry('d', 100));

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });

    it('should update LRU order on set (update)', () => {
      const cache = new LRUCache<string>({ maxSize: 300 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      // Update key1, making it most recently used
      cache.set('key1', createEntry('a-updated', 100));

      // Adding key4 should evict key2
      cache.set('key4', createEntry('d', 100));

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
    });

    it('should evict multiple entries if needed', () => {
      const cache = new LRUCache<string>({ maxSize: 300 });

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
      const cache = new LRUCache<string>({ maxSize: 200, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('key1', expect.objectContaining({ value: 'a' }));
    });
  });

  describe('delete', () => {
    it('should delete existing key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));

      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should return false for non-existent key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should not call onEvict on delete', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxSize: 1024, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.delete('key1');

      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      cache.clear();

      expect(cache.itemCount).toBe(0);
      expect(cache.size).toBe(0);
      expect(cache.has('key1')).toBe(false);
    });

    it('should call onEvict for all entries', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string>({ maxSize: 1024, onEvict });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));

      cache.clear();

      expect(onEvict).toHaveBeenCalledTimes(2);
    });
  });

  describe('has', () => {
    it('should return true for existing key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100));
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should not update LRU order', () => {
      const cache = new LRUCache<string>({ maxSize: 200 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));

      // has() should not update LRU order
      cache.has('key1');

      // key1 should still be LRU and evicted
      cache.set('key3', createEntry('c', 100));

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
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
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000)); // 1 second TTL

      expect(cache.get('key1')?.value).toBe('a');

      vi.advanceTimersByTime(1001);

      expect(cache.get('key1')).toBeUndefined();
    });

    it('should remove expired entry from cache on get', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));

      vi.advanceTimersByTime(1001);

      cache.get('key1');

      expect(cache.itemCount).toBe(0);
      expect(cache.size).toBe(0);
    });

    it('should return false for expired entries on has', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100, 1000));

      expect(cache.has('key1')).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(cache.has('key1')).toBe(false);
    });

    it('should not expire entries without TTL', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      cache.set('key1', createEntry('a', 100)); // No TTL

      vi.advanceTimersByTime(1000000);

      expect(cache.get('key1')?.value).toBe('a');
    });

    it('should prune expired entries', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100, 1000));
      cache.set('key2', createEntry('b', 100, 2000));
      cache.set('key3', createEntry('c', 100)); // No TTL

      vi.advanceTimersByTime(1500);

      const pruned = cache.prune();

      expect(pruned).toBe(1);
      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
    });
  });

  describe('peek', () => {
    it('should return entry without updating LRU order', () => {
      const cache = new LRUCache<string>({ maxSize: 200 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));

      // peek should not update order
      const peeked = cache.peek('key1');
      expect(peeked?.value).toBe('a');

      // key1 should still be evicted
      cache.set('key3', createEntry('c', 100));

      expect(cache.has('key1')).toBe(false);
    });

    it('should return undefined for non-existent key', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });
      expect(cache.peek('nonexistent')).toBeUndefined();
    });
  });

  describe('keys iterator', () => {
    it('should iterate keys in MRU order', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));
      cache.set('key3', createEntry('c', 100));

      const keys = [...cache.keys()];
      expect(keys).toEqual(['key3', 'key2', 'key1']);
    });

    it('should skip expired entries', () => {
      vi.useFakeTimers();
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100, 1000));
      cache.set('key2', createEntry('b', 100));

      vi.advanceTimersByTime(1001);

      const keys = [...cache.keys()];
      expect(keys).toEqual(['key2']);

      vi.useRealTimers();
    });
  });

  describe('entries iterator', () => {
    it('should iterate entries in MRU order', () => {
      const cache = new LRUCache<string>({ maxSize: 1024 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 100));

      const entries = [...cache.entries()];
      expect(entries.length).toBe(2);
      expect(entries[0]![0]).toBe('key2');
      expect(entries[1]![0]).toBe('key1');
    });
  });

  describe('edge cases', () => {
    it('should handle single item cache', () => {
      const cache = new LRUCache<string>({ maxSize: 100 });

      cache.set('key1', createEntry('a', 100));
      expect(cache.get('key1')?.value).toBe('a');

      cache.set('key2', createEntry('b', 100));
      expect(cache.has('key1')).toBe(false);
      expect(cache.get('key2')?.value).toBe('b');
    });

    it('should handle rapid set/get/delete operations', () => {
      const cache = new LRUCache<number>({ maxSize: 1000 });

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
      const cache = new LRUCache<string>({ maxSize: 200 });

      cache.set('key1', createEntry('a', 100));
      cache.set('key2', createEntry('b', 50));

      // Update key2 with larger size, should evict key1
      cache.set('key2', createEntry('b-large', 150));

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(true);
      expect(cache.size).toBe(150);
    });
  });
});
