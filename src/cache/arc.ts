/**
 * ARC (Adaptive Replacement Cache) Implementation
 *
 * ARC is a self-tuning cache algorithm that combines the benefits of LRU and LFU.
 * It maintains four lists:
 * - T1: Recent items (LRU behavior)
 * - T2: Frequent items (LFU behavior)
 * - B1: Ghost list of recently evicted items from T1
 * - B2: Ghost list of recently evicted items from T2
 *
 * The algorithm adapts to workload patterns by adjusting the balance between
 * T1 and T2 based on hits in the ghost lists.
 *
 * Features:
 * - O(1) get, set, delete operations
 * - Size-based eviction (tracks bytes, not just item count)
 * - TTL support with lazy expiration
 * - Eviction callbacks
 * - Self-tuning between recency and frequency
 */

import type { CacheBackend, CacheEntry } from '../types.js';

/**
 * Node in the doubly-linked list
 */
interface ARCNode<K, V> {
  key: K;
  entry: CacheEntry<V>;
  prev: ARCNode<K, V> | null;
  next: ARCNode<K, V> | null;
}

/**
 * Ghost entry - only stores key and size (no actual data)
 */
interface GhostNode<K> {
  key: K;
  size: number;
  prev: GhostNode<K> | null;
  next: GhostNode<K> | null;
}

/**
 * Doubly-linked list for cache entries
 */
class CacheList<K, V> {
  head: ARCNode<K, V> | null = null;
  tail: ARCNode<K, V> | null = null;
  private _size: number = 0;
  private _byteSize: number = 0;

  get size(): number {
    return this._size;
  }

  get byteSize(): number {
    return this._byteSize;
  }

  addToHead(node: ARCNode<K, V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }

    this._size++;
    this._byteSize += node.entry.size;
  }

  remove(node: ARCNode<K, V>): void {
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
    this._size--;
    this._byteSize -= node.entry.size;
  }

  removeTail(): ARCNode<K, V> | null {
    if (!this.tail) {
      return null;
    }
    const node = this.tail;
    this.remove(node);
    return node;
  }

  moveToHead(node: ARCNode<K, V>): void {
    this.remove(node);
    // Re-add the size since remove subtracted it
    this._size++;
    this._byteSize += node.entry.size;
    // Now properly add to head
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

  clear(): void {
    this.head = null;
    this.tail = null;
    this._size = 0;
    this._byteSize = 0;
  }

  *[Symbol.iterator](): IterableIterator<ARCNode<K, V>> {
    let node = this.head;
    while (node) {
      yield node;
      node = node.next;
    }
  }
}

/**
 * Doubly-linked list for ghost entries
 */
class GhostList<K> {
  head: GhostNode<K> | null = null;
  tail: GhostNode<K> | null = null;
  private _size: number = 0;
  private _byteSize: number = 0;

  get size(): number {
    return this._size;
  }

  get byteSize(): number {
    return this._byteSize;
  }

  addToHead(node: GhostNode<K>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }

    this._size++;
    this._byteSize += node.size;
  }

  remove(node: GhostNode<K>): void {
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
    this._size--;
    this._byteSize -= node.size;
  }

  removeTail(): GhostNode<K> | null {
    if (!this.tail) {
      return null;
    }
    const node = this.tail;
    this.remove(node);
    return node;
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this._size = 0;
    this._byteSize = 0;
  }
}

/**
 * Options for creating an ARC cache
 */
export interface ARCCacheOptions {
  /** Maximum size in bytes */
  maxSize: number;
  /** Callback when an entry is evicted */
  onEvict?: (key: string, entry: CacheEntry<unknown>) => void;
}

/**
 * ARC Cache implementation
 */
export class ARCCache<V = unknown> implements CacheBackend<string, V> {
  // Main cache lists
  private readonly t1: CacheList<string, V> = new CacheList();  // Recent items
  private readonly t2: CacheList<string, V> = new CacheList();  // Frequent items

  // Ghost lists
  private readonly b1: GhostList<string> = new GhostList();  // Ghost of recently evicted from T1
  private readonly b2: GhostList<string> = new GhostList();  // Ghost of recently evicted from T2

  // Maps for O(1) lookups
  private readonly t1Map: Map<string, ARCNode<string, V>> = new Map();
  private readonly t2Map: Map<string, ARCNode<string, V>> = new Map();
  private readonly b1Map: Map<string, GhostNode<string>> = new Map();
  private readonly b2Map: Map<string, GhostNode<string>> = new Map();

  // Target size for T1 (adapts based on workload)
  // p represents the size in bytes for T1's target
  private p: number = 0;

  private readonly _maxSize: number;
  public onEvict?: ((key: string, entry: CacheEntry<V>) => void) | undefined;

  constructor(options: ARCCacheOptions) {
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
    // Check T1 (recent)
    let node = this.t1Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT1(key);
        return undefined;
      }
      // Move from T1 to T2 (promote to frequent)
      this.moveT1ToT2(node);
      return node.entry;
    }

    // Check T2 (frequent)
    node = this.t2Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT2(key);
        return undefined;
      }
      // Move to head of T2 (most recently used)
      this.t2.moveToHead(node);
      return node.entry;
    }

    return undefined;
  }

  /**
   * Set an entry in the cache
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

    // Case 1: Key exists in T1
    let node = this.t1Map.get(key);
    if (node) {
      // Update entry and move to T2
      const oldSize = node.entry.size;
      node.entry = entry;
      // Adjust size accounting
      (this.t1 as unknown as { _byteSize: number })._byteSize += entry.size - oldSize;
      this.moveT1ToT2(node);
      this.ensureCapacity();
      return;
    }

    // Case 2: Key exists in T2
    node = this.t2Map.get(key);
    if (node) {
      // Update entry and move to head of T2
      const oldSize = node.entry.size;
      node.entry = entry;
      (this.t2 as unknown as { _byteSize: number })._byteSize += entry.size - oldSize;
      this.t2.moveToHead(node);
      this.ensureCapacity();
      return;
    }

    // Case 3: Key exists in B1 (ghost of T1)
    const ghost1 = this.b1Map.get(key);
    if (ghost1) {
      // Adapt: increase target for T1
      const delta = Math.max(1, Math.floor((this.b2.byteSize / Math.max(1, this.b1.byteSize)) * entry.size));
      this.p = Math.min(this._maxSize, this.p + delta);

      // Remove from B1
      this.b1.remove(ghost1);
      this.b1Map.delete(key);

      // Make room and add to T2
      this.ensureCapacityFor(entry.size);

      const newNode: ARCNode<string, V> = {
        key,
        entry,
        prev: null,
        next: null,
      };
      this.t2.addToHead(newNode);
      this.t2Map.set(key, newNode);
      return;
    }

    // Case 4: Key exists in B2 (ghost of T2)
    const ghost2 = this.b2Map.get(key);
    if (ghost2) {
      // Adapt: decrease target for T1
      const delta = Math.max(1, Math.floor((this.b1.byteSize / Math.max(1, this.b2.byteSize)) * entry.size));
      this.p = Math.max(0, this.p - delta);

      // Remove from B2
      this.b2.remove(ghost2);
      this.b2Map.delete(key);

      // Make room and add to T2
      this.ensureCapacityFor(entry.size);

      const newNode: ARCNode<string, V> = {
        key,
        entry,
        prev: null,
        next: null,
      };
      this.t2.addToHead(newNode);
      this.t2Map.set(key, newNode);
      return;
    }

    // Case 5: New key not in any list
    // Make room for the new entry before adding it
    this.ensureCapacityFor(entry.size);

    // Add new entry to T1
    const newNode: ARCNode<string, V> = {
      key,
      entry,
      prev: null,
      next: null,
    };
    this.t1.addToHead(newNode);
    this.t1Map.set(key, newNode);
  }

  /**
   * Delete an entry from the cache
   */
  delete(key: string): boolean {
    if (this.deleteFromT1(key)) {
      return true;
    }
    if (this.deleteFromT2(key)) {
      return true;
    }
    return false;
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    // Call onEvict for all entries in T1 and T2
    if (this.onEvict) {
      for (const node of this.t1) {
        this.onEvict(node.key, node.entry);
      }
      for (const node of this.t2) {
        this.onEvict(node.key, node.entry);
      }
    }

    this.t1.clear();
    this.t2.clear();
    this.b1.clear();
    this.b2.clear();
    this.t1Map.clear();
    this.t2Map.clear();
    this.b1Map.clear();
    this.b2Map.clear();
    this.p = 0;
  }

  /**
   * Check if key exists in cache (and is not expired)
   */
  has(key: string): boolean {
    let node = this.t1Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT1(key);
        return false;
      }
      return true;
    }

    node = this.t2Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT2(key);
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Number of items in the cache
   */
  get itemCount(): number {
    return this.t1Map.size + this.t2Map.size;
  }

  /**
   * Current size in bytes
   */
  get size(): number {
    return this.t1.byteSize + this.t2.byteSize;
  }

  /**
   * Maximum size in bytes
   */
  get maxSize(): number {
    return this._maxSize;
  }

  /**
   * Iterator over keys
   */
  *keys(): IterableIterator<string> {
    // Yield T2 keys first (frequent), then T1 (recent)
    for (const node of this.t2) {
      if (!this.isExpired(node.entry)) {
        yield node.key;
      }
    }
    for (const node of this.t1) {
      if (!this.isExpired(node.entry)) {
        yield node.key;
      }
    }
  }

  /**
   * Iterator over entries
   */
  *entries(): IterableIterator<[string, CacheEntry<V>]> {
    for (const node of this.t2) {
      if (!this.isExpired(node.entry)) {
        yield [node.key, node.entry];
      }
    }
    for (const node of this.t1) {
      if (!this.isExpired(node.entry)) {
        yield [node.key, node.entry];
      }
    }
  }

  /**
   * Peek at a value without updating cache state
   */
  peek(key: string): CacheEntry<V> | undefined {
    let node = this.t1Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT1(key);
        return undefined;
      }
      return node.entry;
    }

    node = this.t2Map.get(key);
    if (node) {
      if (this.isExpired(node.entry)) {
        this.deleteFromT2(key);
        return undefined;
      }
      return node.entry;
    }

    return undefined;
  }

  /**
   * Prune expired entries
   */
  prune(): number {
    let pruned = 0;
    const now = Date.now();

    for (const [key, node] of this.t1Map) {
      if (node.entry.expiresAt && node.entry.expiresAt <= now) {
        this.deleteFromT1(key);
        pruned++;
      }
    }

    for (const [key, node] of this.t2Map) {
      if (node.entry.expiresAt && node.entry.expiresAt <= now) {
        this.deleteFromT2(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get statistics about the cache (for debugging/tuning)
   */
  getStats(): {
    t1Size: number;
    t2Size: number;
    b1Size: number;
    b2Size: number;
    p: number;
    maxSize: number;
  } {
    return {
      t1Size: this.t1.byteSize,
      t2Size: this.t2.byteSize,
      b1Size: this.b1.byteSize,
      b2Size: this.b2.byteSize,
      p: this.p,
      maxSize: this._maxSize,
    };
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
   * Move a node from T1 to T2
   */
  private moveT1ToT2(node: ARCNode<string, V>): void {
    this.t1.remove(node);
    this.t1Map.delete(node.key);
    this.t2.addToHead(node);
    this.t2Map.set(node.key, node);
  }

  /**
   * Delete a key from T1
   */
  private deleteFromT1(key: string): boolean {
    const node = this.t1Map.get(key);
    if (!node) {
      return false;
    }
    this.t1.remove(node);
    this.t1Map.delete(key);
    return true;
  }

  /**
   * Delete a key from T2
   */
  private deleteFromT2(key: string): boolean {
    const node = this.t2Map.get(key);
    if (!node) {
      return false;
    }
    this.t2.remove(node);
    this.t2Map.delete(key);
    return true;
  }

  /**
   * Ensure the cache is within capacity by evicting as needed
   */
  private ensureCapacity(): void {
    while (this.t1.byteSize + this.t2.byteSize > this._maxSize) {
      if (this.t1.size > 0 && (this.t2.size === 0 || this.t1.byteSize > this.p)) {
        // Evict from T1
        const evicted = this.t1.removeTail();
        if (evicted) {
          this.t1Map.delete(evicted.key);
          const ghost: GhostNode<string> = {
            key: evicted.key,
            size: evicted.entry.size,
            prev: null,
            next: null,
          };
          this.b1.addToHead(ghost);
          this.b1Map.set(evicted.key, ghost);
          this.onEvict?.(evicted.key, evicted.entry);
        }
      } else if (this.t2.size > 0) {
        // Evict from T2
        const evicted = this.t2.removeTail();
        if (evicted) {
          this.t2Map.delete(evicted.key);
          const ghost: GhostNode<string> = {
            key: evicted.key,
            size: evicted.entry.size,
            prev: null,
            next: null,
          };
          this.b2.addToHead(ghost);
          this.b2Map.set(evicted.key, ghost);
          this.onEvict?.(evicted.key, evicted.entry);
        }
      } else {
        // Both empty, nothing to evict
        break;
      }

      // Limit ghost list sizes
      while (this.b1.byteSize > this._maxSize) {
        const evicted = this.b1.removeTail();
        if (evicted) {
          this.b1Map.delete(evicted.key);
        }
      }
      while (this.b2.byteSize > this._maxSize) {
        const evicted = this.b2.removeTail();
        if (evicted) {
          this.b2Map.delete(evicted.key);
        }
      }
    }
  }

  /**
   * Ensure the cache has capacity for a new entry of the given size
   * This evicts entries BEFORE adding the new entry
   */
  private ensureCapacityFor(newEntrySize: number): void {
    while (this.t1.byteSize + this.t2.byteSize + newEntrySize > this._maxSize) {
      if (this.t1.size > 0 && (this.t2.size === 0 || this.t1.byteSize > this.p)) {
        // Evict from T1
        const evicted = this.t1.removeTail();
        if (evicted) {
          this.t1Map.delete(evicted.key);
          const ghost: GhostNode<string> = {
            key: evicted.key,
            size: evicted.entry.size,
            prev: null,
            next: null,
          };
          this.b1.addToHead(ghost);
          this.b1Map.set(evicted.key, ghost);
          this.onEvict?.(evicted.key, evicted.entry);
        }
      } else if (this.t2.size > 0) {
        // Evict from T2
        const evicted = this.t2.removeTail();
        if (evicted) {
          this.t2Map.delete(evicted.key);
          const ghost: GhostNode<string> = {
            key: evicted.key,
            size: evicted.entry.size,
            prev: null,
            next: null,
          };
          this.b2.addToHead(ghost);
          this.b2Map.set(evicted.key, ghost);
          this.onEvict?.(evicted.key, evicted.entry);
        }
      } else {
        // Both empty, nothing to evict
        break;
      }

      // Limit ghost list sizes
      while (this.b1.byteSize > this._maxSize) {
        const evicted = this.b1.removeTail();
        if (evicted) {
          this.b1Map.delete(evicted.key);
        }
      }
      while (this.b2.byteSize > this._maxSize) {
        const evicted = this.b2.removeTail();
        if (evicted) {
          this.b2Map.delete(evicted.key);
        }
      }
    }
  }
}
