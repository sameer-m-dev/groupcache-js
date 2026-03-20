/**
 * LFU (Least Frequently Used) Cache Implementation
 *
 * Features:
 * - O(1) get, set, delete operations
 * - Size-based eviction (tracks bytes, not just item count)
 * - TTL support with lazy expiration
 * - Eviction callbacks
 * - Uses recency as tiebreaker for items with same frequency
 */

import type { CacheBackend, CacheEntry } from '../types.js';

/**
 * Node in the frequency list
 */
interface LFUNode<K, V> {
  key: K;
  entry: CacheEntry<V>;
  frequency: number;
  // Position within the frequency bucket (for recency tiebreaker)
  prev: LFUNode<K, V> | null;
  next: LFUNode<K, V> | null;
}

/**
 * Frequency bucket containing nodes with the same access frequency
 * Uses a doubly-linked list to maintain recency order within the bucket
 */
interface FrequencyBucket<K, V> {
  frequency: number;
  head: LFUNode<K, V> | null;
  tail: LFUNode<K, V> | null;
  size: number;
}

/**
 * Options for creating an LFU cache
 */
export interface LFUCacheOptions {
  /** Maximum size in bytes */
  maxSize: number;
  /** Callback when an entry is evicted */
  onEvict?: (key: string, entry: CacheEntry<unknown>) => void;
}

/**
 * LFU Cache implementation using frequency buckets with O(1) operations
 *
 * Each frequency level maintains a doubly-linked list of nodes.
 * When nodes have the same frequency, the least recently accessed
 * node within that frequency bucket is evicted first (LRU tiebreaker).
 */
export class LFUCache<V = unknown> implements CacheBackend<string, V> {
  private readonly map: Map<string, LFUNode<string, V>> = new Map();
  private readonly frequencyBuckets: Map<number, FrequencyBucket<string, V>> = new Map();
  private minFrequency: number = 1;
  private currentSize: number = 0;
  private readonly _maxSize: number;

  public onEvict?: ((key: string, entry: CacheEntry<V>) => void) | undefined;

  constructor(options: LFUCacheOptions) {
    if (options.maxSize <= 0) {
      throw new Error('maxSize must be positive');
    }
    this._maxSize = options.maxSize;
    if (options.onEvict) {
      this.onEvict = options.onEvict as (key: string, entry: CacheEntry<V>) => void;
    }
  }

  /**
   * Get an entry from the cache
   * Returns undefined if not found or expired
   */
  get(key: string): CacheEntry<V> | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }

    // Check if expired
    if (this.isExpired(node.entry)) {
      this.delete(key);
      return undefined;
    }

    // Increase frequency
    this.incrementFrequency(node);

    return node.entry;
  }

  /**
   * Set an entry in the cache
   * Will evict least frequently used entries if necessary
   */
  set(key: string, entry: CacheEntry<V>): void {
    // Validate entry size
    if (entry.size <= 0) {
      throw new Error('Entry size must be positive');
    }

    if (entry.size > this._maxSize) {
      // Entry is larger than entire cache - don't cache but call onEvict
      this.onEvict?.(key, entry);
      return;
    }

    // Check if key already exists
    const existing = this.map.get(key);
    if (existing) {
      // Update existing entry
      this.currentSize -= existing.entry.size;
      existing.entry = entry;
      this.currentSize += entry.size;

      // Increase frequency on update
      this.incrementFrequency(existing);

      // May need to evict other entries if new size is larger
      while (this.currentSize > this._maxSize && this.map.size > 1) {
        this.evictLFU();
      }
      return;
    }

    // Evict entries until we have space
    while (this.currentSize + entry.size > this._maxSize && this.map.size > 0) {
      this.evictLFU();
    }

    // Create new node with frequency 1
    const node: LFUNode<string, V> = {
      key,
      entry,
      frequency: 1,
      prev: null,
      next: null,
    };

    // Add to frequency bucket 1
    this.addToBucket(node, 1);
    this.map.set(key, node);
    this.currentSize += entry.size;

    // Reset minFrequency to 1 for new entries
    this.minFrequency = 1;
  }

  /**
   * Delete an entry from the cache
   */
  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) {
      return false;
    }

    this.removeFromBucket(node);
    this.map.delete(key);
    this.currentSize -= node.entry.size;

    return true;
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    // Call onEvict for all entries
    if (this.onEvict) {
      for (const [key, node] of this.map) {
        this.onEvict(key, node.entry);
      }
    }

    this.map.clear();
    this.frequencyBuckets.clear();
    this.currentSize = 0;
    this.minFrequency = 1;
  }

  /**
   * Check if key exists in cache (and is not expired)
   */
  has(key: string): boolean {
    const node = this.map.get(key);
    if (!node) {
      return false;
    }

    if (this.isExpired(node.entry)) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Number of items in the cache
   */
  get itemCount(): number {
    return this.map.size;
  }

  /**
   * Current size in bytes
   */
  get size(): number {
    return this.currentSize;
  }

  /**
   * Maximum size in bytes
   */
  get maxSize(): number {
    return this._maxSize;
  }

  /**
   * Iterator over keys (ordered by frequency, then recency within frequency)
   */
  *keys(): IterableIterator<string> {
    // Iterate from highest to lowest frequency
    const frequencies = [...this.frequencyBuckets.keys()].sort((a, b) => b - a);
    for (const freq of frequencies) {
      const bucket = this.frequencyBuckets.get(freq);
      if (bucket) {
        let node = bucket.head;
        while (node) {
          if (!this.isExpired(node.entry)) {
            yield node.key;
          }
          node = node.next;
        }
      }
    }
  }

  /**
   * Iterator over entries (ordered by frequency, then recency within frequency)
   */
  *entries(): IterableIterator<[string, CacheEntry<V>]> {
    const frequencies = [...this.frequencyBuckets.keys()].sort((a, b) => b - a);
    for (const freq of frequencies) {
      const bucket = this.frequencyBuckets.get(freq);
      if (bucket) {
        let node = bucket.head;
        while (node) {
          if (!this.isExpired(node.entry)) {
            yield [node.key, node.entry];
          }
          node = node.next;
        }
      }
    }
  }

  /**
   * Peek at a value without updating frequency
   */
  peek(key: string): CacheEntry<V> | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }

    if (this.isExpired(node.entry)) {
      this.delete(key);
      return undefined;
    }

    return node.entry;
  }

  /**
   * Prune expired entries
   * Call periodically for eager expiration
   */
  prune(): number {
    let pruned = 0;
    const now = Date.now();

    for (const [key, node] of this.map) {
      if (node.entry.expiresAt && node.entry.expiresAt <= now) {
        this.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get the frequency of a key (for testing/debugging)
   */
  getFrequency(key: string): number | undefined {
    const node = this.map.get(key);
    return node?.frequency;
  }

  /**
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    if (!entry.expiresAt) {
      return false;
    }
    return Date.now() >= entry.expiresAt;
  }

  /**
   * Increment the frequency of a node
   */
  private incrementFrequency(node: LFUNode<string, V>): void {
    const oldFreq = node.frequency;
    const newFreq = oldFreq + 1;

    // Remove from old bucket
    this.removeFromBucket(node);

    // Update minFrequency if needed
    if (oldFreq === this.minFrequency) {
      const oldBucket = this.frequencyBuckets.get(oldFreq);
      if (!oldBucket || oldBucket.size === 0) {
        this.minFrequency = newFreq;
      }
    }

    // Update node frequency and add to new bucket
    node.frequency = newFreq;
    this.addToBucket(node, newFreq);
  }

  /**
   * Add a node to a frequency bucket (at the head for recency)
   */
  private addToBucket(node: LFUNode<string, V>, frequency: number): void {
    let bucket = this.frequencyBuckets.get(frequency);
    if (!bucket) {
      bucket = {
        frequency,
        head: null,
        tail: null,
        size: 0,
      };
      this.frequencyBuckets.set(frequency, bucket);
    }

    // Add to head (most recent)
    node.prev = null;
    node.next = bucket.head;

    if (bucket.head) {
      bucket.head.prev = node;
    }
    bucket.head = node;

    if (!bucket.tail) {
      bucket.tail = node;
    }

    bucket.size++;
  }

  /**
   * Remove a node from its frequency bucket
   */
  private removeFromBucket(node: LFUNode<string, V>): void {
    const bucket = this.frequencyBuckets.get(node.frequency);
    if (!bucket) {
      return;
    }

    if (node.prev) {
      node.prev.next = node.next;
    } else {
      bucket.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      bucket.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
    bucket.size--;

    // Clean up empty buckets
    if (bucket.size === 0) {
      this.frequencyBuckets.delete(node.frequency);
    }
  }

  /**
   * Evict the least frequently used entry
   * (with LRU tiebreaker for same frequency)
   */
  private evictLFU(): void {
    // Find the minimum frequency bucket
    const bucket = this.frequencyBuckets.get(this.minFrequency);
    if (!bucket || !bucket.tail) {
      // Find next min frequency
      this.updateMinFrequency();
      return;
    }

    // Evict from tail (least recently used within this frequency)
    const node = bucket.tail;
    this.removeFromBucket(node);
    this.map.delete(node.key);
    this.currentSize -= node.entry.size;

    this.onEvict?.(node.key, node.entry);

    // Update minFrequency if bucket is now empty
    if (bucket.size === 0) {
      this.updateMinFrequency();
    }
  }

  /**
   * Update minFrequency to the current minimum
   */
  private updateMinFrequency(): void {
    if (this.frequencyBuckets.size === 0) {
      this.minFrequency = 1;
      return;
    }

    let min = Number.MAX_SAFE_INTEGER;
    for (const freq of this.frequencyBuckets.keys()) {
      if (freq < min) {
        min = freq;
      }
    }
    this.minFrequency = min === Number.MAX_SAFE_INTEGER ? 1 : min;
  }
}
