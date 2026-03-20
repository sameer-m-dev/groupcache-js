/**
 * Consistent Hashing Implementation
 *
 * Features:
 * - Virtual nodes for better distribution
 * - O(log n) key lookup via binary search
 * - Minimal key redistribution on node changes
 * - Pluggable hash function
 */

import type { HashFunction } from '../types.js';

/**
 * Default hash function using FNV-1a
 * Fast and has good distribution properties
 */
export function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime multiplication with 32-bit wraparound
    hash = Math.imul(hash, 16777619);
  }

  // Ensure positive number
  return hash >>> 0;
}

/**
 * Options for consistent hash ring
 */
export interface ConsistentHashOptions {
  /** Number of virtual nodes per real node (default: 150) */
  replicas?: number;
  /** Custom hash function */
  hashFn?: HashFunction;
}

/**
 * Consistent hash ring for distributing keys across nodes
 */
export class ConsistentHash {
  private readonly replicas: number;
  private readonly hashFn: HashFunction;

  /** Sorted array of hash values on the ring */
  private ring: number[] = [];

  /** Map from hash value to node name */
  private hashToNode: Map<number, string> = new Map();

  /** Set of all nodes */
  private nodes: Set<string> = new Set();

  constructor(options: ConsistentHashOptions = {}) {
    this.replicas = options.replicas ?? 150;
    this.hashFn = options.hashFn ?? fnv1aHash;

    if (this.replicas < 1) {
      throw new Error('replicas must be at least 1');
    }
  }

  /**
   * Add one or more nodes to the ring
   */
  add(...nodeNames: string[]): void {
    for (const node of nodeNames) {
      if (this.nodes.has(node)) {
        continue; // Already exists
      }

      this.nodes.add(node);

      // Add virtual nodes
      for (let i = 0; i < this.replicas; i++) {
        const virtualKey = `${node}#${i}`;
        const hash = this.hashFn(virtualKey);
        this.ring.push(hash);
        this.hashToNode.set(hash, node);
      }
    }

    // Sort ring for binary search
    this.ring.sort((a, b) => a - b);
  }

  /**
   * Remove a node from the ring
   */
  remove(node: string): boolean {
    if (!this.nodes.has(node)) {
      return false;
    }

    this.nodes.delete(node);

    // Remove virtual nodes
    const hashesToRemove: number[] = [];
    for (let i = 0; i < this.replicas; i++) {
      const virtualKey = `${node}#${i}`;
      const hash = this.hashFn(virtualKey);
      hashesToRemove.push(hash);
      this.hashToNode.delete(hash);
    }

    // Remove from ring
    this.ring = this.ring.filter(h => !hashesToRemove.includes(h));

    return true;
  }

  /**
   * Get the node responsible for a given key
   */
  get(key: string): string | undefined {
    if (this.ring.length === 0) {
      return undefined;
    }

    const hash = this.hashFn(key);
    const index = this.findIndex(hash);
    const ringHash = this.ring[index];

    if (ringHash === undefined) {
      return undefined;
    }

    return this.hashToNode.get(ringHash);
  }

  /**
   * Get N distinct nodes for a key (for replication)
   * Returns up to N nodes, or fewer if not enough nodes exist
   */
  getN(key: string, n: number): string[] {
    if (this.ring.length === 0 || n <= 0) {
      return [];
    }

    const nodeCount = this.nodes.size;
    const resultCount = Math.min(n, nodeCount);

    if (resultCount === 0) {
      return [];
    }

    const result: string[] = [];
    const seen = new Set<string>();

    const hash = this.hashFn(key);
    let index = this.findIndex(hash);

    // Walk around the ring until we have enough distinct nodes
    for (let i = 0; i < this.ring.length && result.length < resultCount; i++) {
      const ringHash = this.ring[index];
      if (ringHash !== undefined) {
        const node = this.hashToNode.get(ringHash);

        if (node && !seen.has(node)) {
          seen.add(node);
          result.push(node);
        }
      }

      index = (index + 1) % this.ring.length;
    }

    return result;
  }

  /**
   * Check if a node exists in the ring
   */
  has(node: string): boolean {
    return this.nodes.has(node);
  }

  /**
   * Get all nodes
   */
  getNodes(): string[] {
    return [...this.nodes];
  }

  /**
   * Get the number of nodes (not virtual nodes)
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Get the total number of points on the ring (virtual nodes)
   */
  get ringSize(): number {
    return this.ring.length;
  }

  /**
   * Clear all nodes from the ring
   */
  clear(): void {
    this.ring = [];
    this.hashToNode.clear();
    this.nodes.clear();
  }

  /**
   * Find the index of the first hash >= target hash
   * Uses binary search for O(log n) lookup
   */
  private findIndex(hash: number): number {
    const ring = this.ring;
    let low = 0;
    let high = ring.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ring[mid]! < hash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Wrap around to the beginning if past the end
    if (low >= ring.length) {
      low = 0;
    }

    return low;
  }

  /**
   * Get distribution statistics for debugging
   */
  getDistribution(sampleKeys: string[]): Map<string, number> {
    const distribution = new Map<string, number>();

    for (const node of this.nodes) {
      distribution.set(node, 0);
    }

    for (const key of sampleKeys) {
      const node = this.get(key);
      if (node) {
        distribution.set(node, (distribution.get(node) ?? 0) + 1);
      }
    }

    return distribution;
  }
}
