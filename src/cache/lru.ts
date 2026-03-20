/**
 * LRU (Least Recently Used) Cache Implementation
 *
 * Features:
 * - O(1) get, set, delete operations
 * - Size-based eviction (tracks bytes, not just item count)
 * - TTL support with lazy expiration
 * - Eviction callbacks
 */

import type { CacheBackend, CacheEntry } from '../types.js';

/**
 * Node in the doubly-linked list
 */
interface LRUNode<K, V> {
  key: K;
  entry: CacheEntry<V>;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

/**
 * Options for creating an LRU cache
 */
export interface LRUCacheOptions {
  /** Maximum size in bytes */
  maxSize: number;
  /** Callback when an entry is evicted */
  onEvict?: (key: string, entry: CacheEntry<unknown>) => void;
}

/**
 * LRU Cache implementation using a doubly-linked list and hash map
 */
export class LRUCache<V = unknown> implements CacheBackend<string, V> {
  private readonly map: Map<string, LRUNode<string, V>> = new Map();
  private head: LRUNode<string, V> | null = null;
  private tail: LRUNode<string, V> | null = null;
  private currentSize: number = 0;
  private readonly _maxSize: number;

  public onEvict?: ((key: string, entry: CacheEntry<V>) => void) | undefined;

  constructor(options: LRUCacheOptions) {
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

    // Move to front (most recently used)
    this.moveToFront(node);

    return node.entry;
  }

  /**
   * Set an entry in the cache
   * Will evict least recently used entries if necessary
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
      this.moveToFront(existing);

      // May need to evict other entries if new size is larger
      while (this.currentSize > this._maxSize && this.tail && this.tail !== existing) {
        this.evictLRU();
      }
      return;
    } else {
      // Create new node
      const node: LRUNode<string, V> = {
        key,
        entry,
        prev: null,
        next: null,
      };

      // Evict entries until we have space
      while (this.currentSize + entry.size > this._maxSize && this.tail) {
        this.evictLRU();
      }

      // Add to front
      this.addToFront(node);
      this.map.set(key, node);
      this.currentSize += entry.size;
    }
  }

  /**
   * Delete an entry from the cache
   */
  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) {
      return false;
    }

    this.removeNode(node);
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
    this.head = null;
    this.tail = null;
    this.currentSize = 0;
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
   * Iterator over keys (most recent first)
   */
  *keys(): IterableIterator<string> {
    let node = this.head;
    while (node) {
      // Skip expired entries
      if (!this.isExpired(node.entry)) {
        yield node.key;
      }
      node = node.next;
    }
  }

  /**
   * Iterator over entries (most recent first)
   */
  *entries(): IterableIterator<[string, CacheEntry<V>]> {
    let node = this.head;
    while (node) {
      if (!this.isExpired(node.entry)) {
        yield [node.key, node.entry];
      }
      node = node.next;
    }
  }

  /**
   * Peek at a value without updating LRU order
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
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    if (!entry.expiresAt) {
      return false;
    }
    return Date.now() >= entry.expiresAt;
  }

  /**
   * Move a node to the front of the list (most recently used)
   */
  private moveToFront(node: LRUNode<string, V>): void {
    if (node === this.head) {
      return;
    }

    this.removeNode(node);
    this.addToFront(node);
  }

  /**
   * Add a node to the front of the list
   */
  private addToFront(node: LRUNode<string, V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  /**
   * Remove a node from the list
   */
  private removeNode(node: LRUNode<string, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }

  /**
   * Evict the least recently used entry (tail)
   */
  private evictLRU(): void {
    if (!this.tail) {
      return;
    }

    const node = this.tail;
    this.removeNode(node);
    this.map.delete(node.key);
    this.currentSize -= node.entry.size;

    this.onEvict?.(node.key, node.entry);
  }
}
