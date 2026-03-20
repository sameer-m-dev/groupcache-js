/**
 * Group - Cache Namespace Implementation
 *
 * A Group represents a named cache with:
 * - A getter function for loading data on cache miss
 * - A main cache for keys this peer owns
 * - A hot cache for frequently accessed keys from other peers
 * - Singleflight for request deduplication
 */

import type {
  Context,
  CacheEntry,
  GroupStats,
  GetterWithMeta,
  GetterResult,
  SetOptions,
  Logger,
  PeerInfo,
} from './types.js';
import { parseSize, noopLogger } from './types.js';
import { LRUCache } from './cache/lru.js';
import { Singleflight } from './singleflight/singleflight.js';
import type { ConsistentHash } from './hash/consistent.js';
import type { Transport, GetResponse } from './transport/interface.js';
import { NotFoundError } from './transport/interface.js';

/**
 * Serializer interface for encoding/decoding values
 */
export interface Serializer<T = unknown> {
  serialize(value: T): Buffer;
  deserialize(buffer: Buffer): T;
}

/**
 * Default JSON serializer
 */
export const jsonSerializer: Serializer = {
  serialize: (value) => Buffer.from(JSON.stringify(value)),
  deserialize: (buffer) => JSON.parse(buffer.toString()),
};

/**
 * Options for creating a Group
 */
export interface GroupOptions<T> {
  /** Unique name for this group */
  name: string;
  /** Maximum cache size in bytes or string like "64MB" */
  maxSize: number | string;
  /** Function to load data on cache miss */
  getter: GetterWithMeta<T>;
  /** Default TTL in milliseconds (0 = no expiration) */
  ttl?: number;
  /** Serializer for values (default: JSON) */
  serializer?: Serializer<T>;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Internal dependencies injected by GroupCache
 */
export interface GroupDependencies {
  hashRing: ConsistentHash;
  transport: Transport;
  selfAddress: string;
  getPeers: () => PeerInfo[];
}

/**
 * A cache group (namespace) with distributed caching capabilities
 */
export class Group<T = unknown> {
  readonly name: string;
  private readonly maxSize: number;
  private readonly getter: GetterWithMeta<T>;
  private readonly defaultTtl: number;
  private readonly serializer: Serializer<T>;
  private readonly logger: Logger;

  // Caches
  private readonly mainCache: LRUCache<Buffer>;
  private readonly hotCache: LRUCache<Buffer>;

  // Request deduplication
  private readonly singleflight: Singleflight;

  // Dependencies (injected)
  private deps: GroupDependencies | null = null;

  // Statistics
  private stats: GroupStats = {
    gets: 0,
    hits: 0,
    misses: 0,
    loads: 0,
    loadsDeduped: 0,
    peerLoads: 0,
    peerErrors: 0,
    localLoads: 0,
    localLoadErrors: 0,
    mainCacheHits: 0,
    hotCacheHits: 0,
    cacheSize: 0,
    cacheItems: 0,
  };

  constructor(options: GroupOptions<T>) {
    this.name = options.name;
    this.maxSize = parseSize(options.maxSize);
    this.getter = options.getter;
    this.defaultTtl = options.ttl ?? 0;
    this.serializer = (options.serializer ?? jsonSerializer) as Serializer<T>;
    this.logger = options.logger ?? noopLogger;

    // Main cache gets 7/8 of total size (for keys we own)
    const mainCacheSize = Math.floor((this.maxSize * 7) / 8);
    // Hot cache gets 1/8 of total size (for popular keys from other peers)
    const hotCacheSize = Math.floor(this.maxSize / 8);

    this.mainCache = new LRUCache({
      maxSize: mainCacheSize,
      onEvict: (key, entry) => {
        this.logger.debug('Main cache eviction', { group: this.name, key, size: entry.size });
      },
    });

    this.hotCache = new LRUCache({
      maxSize: hotCacheSize,
      onEvict: (key, entry) => {
        this.logger.debug('Hot cache eviction', { group: this.name, key, size: entry.size });
      },
    });

    this.singleflight = new Singleflight();
  }

  /**
   * Inject dependencies (called by GroupCache)
   */
  setDependencies(deps: GroupDependencies): void {
    this.deps = deps;
  }

  /**
   * Get a value from the cache
   * Will load from source if not cached
   */
  async get(key: string, ctx: Context = {}): Promise<T> {
    this.stats.gets++;

    // Check main cache first
    const mainEntry = this.mainCache.get(key);
    if (mainEntry) {
      this.stats.hits++;
      this.stats.mainCacheHits++;
      return this.serializer.deserialize(mainEntry.value);
    }

    // Check hot cache
    const hotEntry = this.hotCache.get(key);
    if (hotEntry) {
      this.stats.hits++;
      this.stats.hotCacheHits++;
      return this.serializer.deserialize(hotEntry.value);
    }

    this.stats.misses++;

    // Determine owner peer
    const ownerPeer = this.getOwnerPeer(key);

    if (!ownerPeer || ownerPeer.isSelf) {
      // We own this key - load locally
      return this.loadLocally(ctx, key);
    }

    // Another peer owns this key - fetch from them
    return this.loadFromPeer(ctx, key, ownerPeer);
  }

  /**
   * Explicitly set a value in the cache
   */
  async set(key: string, value: T, options: SetOptions = {}): Promise<void> {
    const serialized = this.serializer.serialize(value);
    const size = serialized.length;

    const entry: CacheEntry<Buffer> = {
      value: serialized,
      size,
      createdAt: Date.now(),
      expiresAt: this.calculateExpiry(options),
    };

    // Determine owner peer
    const ownerPeer = this.getOwnerPeer(key);

    if (!ownerPeer || ownerPeer.isSelf) {
      // We own this key - set in main cache
      this.mainCache.set(key, entry);
    } else {
      // Another peer owns this key - set in hot cache
      this.hotCache.set(key, entry);

      // Also propagate to owner if we have transport
      if (this.deps?.transport) {
        try {
          await this.deps.transport.set(ctx, ownerPeer.address, {
            group: this.name,
            key,
            value: serialized,
            ttl: options.ttl ?? this.defaultTtl,
          });
        } catch (error) {
          this.logger.warn('Failed to propagate set to peer', {
            peer: ownerPeer.address,
            error: String(error),
          });
        }
      }
    }

    this.updateCacheStats();
  }

  /**
   * Remove a key from the cache (cluster-wide)
   */
  async remove(key: string): Promise<void> {
    // Remove from local caches
    this.mainCache.delete(key);
    this.hotCache.delete(key);

    // Propagate to all peers
    if (this.deps?.transport) {
      const peers = this.deps.getPeers().filter((p) => !p.isSelf);

      await Promise.allSettled(
        peers.map((peer) =>
          this.deps!.transport.remove({}, peer.address, {
            group: this.name,
            key,
          })
        )
      );
    }

    this.updateCacheStats();
  }

  /**
   * Remove multiple keys from the cache (cluster-wide)
   */
  async removeMany(keys: string[]): Promise<void> {
    // Remove from local caches
    for (const key of keys) {
      this.mainCache.delete(key);
      this.hotCache.delete(key);
    }

    // Propagate to all peers
    if (this.deps?.transport) {
      const peers = this.deps.getPeers().filter((p) => !p.isSelf);

      await Promise.allSettled(
        peers.map((peer) =>
          this.deps!.transport.removeMany({}, peer.address, {
            group: this.name,
            keys,
          })
        )
      );
    }

    this.updateCacheStats();
  }

  /**
   * Clear all entries from this group's caches
   */
  clear(): void {
    this.mainCache.clear();
    this.hotCache.clear();
    this.updateCacheStats();
  }

  /**
   * Get cache statistics
   */
  getStats(): GroupStats {
    this.updateCacheStats();
    return { ...this.stats };
  }

  /**
   * Handle a get request from a peer
   */
  async handlePeerGet(ctx: Context, key: string): Promise<GetResponse> {
    // Check main cache
    const entry = this.mainCache.get(key);
    if (entry) {
      return {
        value: entry.value,
        expiresAt: entry.expiresAt,
        hit: true,
      };
    }

    // Load locally (we're the owner)
    const value = await this.loadLocally(ctx, key);
    const serialized = this.serializer.serialize(value);

    // Get the entry that was just cached
    const newEntry = this.mainCache.get(key);

    return {
      value: serialized,
      expiresAt: newEntry?.expiresAt,
      hit: false,
    };
  }

  /**
   * Handle a set request from a peer
   */
  handlePeerSet(key: string, value: Buffer, ttl?: number): void {
    const entry: CacheEntry<Buffer> = {
      value,
      size: value.length,
      createdAt: Date.now(),
      expiresAt: ttl ? Date.now() + ttl : undefined,
    };

    this.mainCache.set(key, entry);
    this.updateCacheStats();
  }

  /**
   * Handle a remove request from a peer
   */
  handlePeerRemove(key: string): void {
    this.mainCache.delete(key);
    this.hotCache.delete(key);
    this.updateCacheStats();
  }

  /**
   * Handle a removeMany request from a peer
   */
  handlePeerRemoveMany(keys: string[]): void {
    for (const key of keys) {
      this.mainCache.delete(key);
      this.hotCache.delete(key);
    }
    this.updateCacheStats();
  }

  /**
   * Get the peer that owns a key
   */
  private getOwnerPeer(key: string): PeerInfo | null {
    if (!this.deps) {
      return null;
    }

    const peerAddress = this.deps.hashRing.get(key);
    if (!peerAddress) {
      return null;
    }

    const peers = this.deps.getPeers();
    return peers.find((p) => p.address === peerAddress) ?? null;
  }

  /**
   * Load a value locally using the getter
   */
  private async loadLocally(ctx: Context, key: string): Promise<T> {
    // Use singleflight to deduplicate concurrent requests
    const result = await this.singleflight.doWithInfo(key, async () => {
      this.stats.loads++;
      this.stats.localLoads++;

      try {
        const getterResult = await this.getter(ctx, key);

        // Normalize result
        let value: T;
        let ttl = this.defaultTtl;
        let size: number | undefined;

        if (this.isGetterResult(getterResult)) {
          value = getterResult.value;
          ttl = getterResult.ttl ?? this.defaultTtl;
          size = getterResult.size;
        } else {
          value = getterResult;
        }

        // Serialize and cache
        const serialized = this.serializer.serialize(value);
        const entrySize = size ?? serialized.length;

        const entry: CacheEntry<Buffer> = {
          value: serialized,
          size: entrySize,
          createdAt: Date.now(),
          expiresAt: ttl > 0 ? Date.now() + ttl : undefined,
        };

        this.mainCache.set(key, entry);
        this.updateCacheStats();

        return value;
      } catch (error) {
        this.stats.localLoadErrors++;
        throw error;
      }
    });

    // Track deduplication
    if (!result.executed) {
      this.stats.loadsDeduped++;
    }

    return result.value;
  }

  /**
   * Load a value from a peer
   */
  private async loadFromPeer(ctx: Context, key: string, peer: PeerInfo): Promise<T> {
    if (!this.deps?.transport) {
      // No transport - fall back to local load
      return this.loadLocally(ctx, key);
    }

    this.stats.peerLoads++;

    try {
      const response = await this.deps.transport.get(ctx, peer.address, {
        group: this.name,
        key,
      });

      // Deserialize value
      const value = this.serializer.deserialize(response.value);

      // Always store in hot cache (simplified from Go's 10% random)
      const entry: CacheEntry<Buffer> = {
        value: response.value,
        size: response.value.length,
        createdAt: Date.now(),
        expiresAt: response.expiresAt,
      };

      this.hotCache.set(key, entry);
      this.updateCacheStats();

      return value;
    } catch (error) {
      this.stats.peerErrors++;

      // If not found on peer, it's a real miss
      if (error instanceof NotFoundError) {
        throw error;
      }

      // For other errors, fall back to local load
      this.logger.warn('Peer load failed, falling back to local', {
        peer: peer.address,
        key,
        error: String(error),
      });

      return this.loadLocally(ctx, key);
    }
  }

  /**
   * Check if a value is a GetterResult
   */
  private isGetterResult(value: unknown): value is GetterResult<T> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'value' in value
    );
  }

  /**
   * Calculate expiry time from options
   */
  private calculateExpiry(options: SetOptions): number | undefined {
    if (options.expireAt) {
      return options.expireAt.getTime();
    }

    const ttl = options.ttl ?? this.defaultTtl;
    if (ttl > 0) {
      return Date.now() + ttl;
    }

    return undefined;
  }

  /**
   * Update cache statistics
   */
  private updateCacheStats(): void {
    this.stats.cacheSize = this.mainCache.size + this.hotCache.size;
    this.stats.cacheItems = this.mainCache.itemCount + this.hotCache.itemCount;
  }
}

// Context type for peer set operations
const ctx: Context = {};
