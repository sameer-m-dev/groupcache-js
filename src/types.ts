/**
 * Core types and interfaces for groupcache-js
 */

/**
 * Context for cache operations, similar to Go's context.Context
 */
export interface Context {
  signal?: AbortSignal | undefined;
  deadline?: number | undefined;
  values?: Map<string, unknown> | undefined;
}

/**
 * Creates a context with a timeout
 */
export function withTimeout(timeoutMs: number): Context {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const signal = controller.signal;
  signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

  return {
    signal,
    deadline: Date.now() + timeoutMs,
  };
}

/**
 * Creates a context with an abort signal
 */
export function withSignal(signal: AbortSignal): Context {
  return { signal };
}

/**
 * Cache entry with metadata
 */
export interface CacheEntry<T> {
  value: T;
  size: number;
  createdAt: number;
  expiresAt?: number | undefined;
}

/**
 * Options for setting cache values
 */
export interface SetOptions {
  /** TTL in milliseconds */
  ttl?: number;
  /** Absolute expiration time */
  expireAt?: Date;
  /** Size in bytes (for memory tracking) */
  size?: number;
}

/**
 * Cache backend interface - implement this for custom cache implementations
 */
export interface CacheBackend<K, V> {
  get(key: K): CacheEntry<V> | undefined;
  set(key: K, entry: CacheEntry<V>): void;
  delete(key: K): boolean;
  clear(): void;
  has(key: K): boolean;

  /** Current number of items */
  readonly itemCount: number;

  /** Current size in bytes */
  readonly size: number;

  /** Maximum size in bytes */
  readonly maxSize: number;

  /** Iterator over keys */
  keys(): IterableIterator<K>;

  /** Event handler for evictions */
  onEvict?: ((key: K, entry: CacheEntry<V>) => void) | undefined;
}

/**
 * Getter function for loading data on cache miss
 */
export type Getter<T> = (ctx: Context, key: string) => Promise<T>;

/**
 * Result from getter that includes optional TTL
 */
export interface GetterResult<T> {
  value: T;
  ttl?: number;
  size?: number;
}

/**
 * Getter that can return TTL with the value
 */
export type GetterWithMeta<T> = (ctx: Context, key: string) => Promise<T | GetterResult<T>>;

/**
 * Information about a peer in the cluster
 */
export interface PeerInfo {
  /** Full address including protocol, e.g., "http://10.0.0.1:8080" */
  address: string;
  /** Whether this is the current instance */
  isSelf?: boolean;
  /** Weight for load balancing (default: 1) */
  weight?: number;
  /** Additional metadata */
  metadata?: Record<string, string>;
}

/**
 * Statistics for a cache group
 */
export interface GroupStats {
  /** Total get requests */
  gets: number;
  /** Cache hits (main + hot) */
  hits: number;
  /** Cache misses */
  misses: number;
  /** Total loads from getter */
  loads: number;
  /** Loads that were deduplicated by singleflight */
  loadsDeduped: number;
  /** Loads from peer nodes */
  peerLoads: number;
  /** Errors when loading from peers */
  peerErrors: number;
  /** Local loads (from getter) */
  localLoads: number;
  /** Local load errors */
  localLoadErrors: number;
  /** Main cache hits */
  mainCacheHits: number;
  /** Hot cache hits */
  hotCacheHits: number;
  /** Current cache size in bytes */
  cacheSize: number;
  /** Current number of cached items */
  cacheItems: number;
}

/**
 * Statistics for the entire GroupCache instance
 */
export interface InstanceStats {
  /** Stats per group */
  groups: Map<string, GroupStats>;
  /** Number of known peers */
  peerCount: number;
  /** Uptime in milliseconds */
  uptime: number;
}

/**
 * Health status for the cache instance
 */
export interface HealthStatus {
  /** Overall health */
  healthy: boolean;
  /** Peer health information */
  peers: {
    total: number;
    healthy: number;
    unhealthy: string[];
  };
  /** Group health information */
  groups: {
    name: string;
    cacheSize: number;
    maxSize: number;
    utilizationPercent: number;
  }[];
}

/**
 * Logger interface compatible with common logging libraries
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * No-op logger for when logging is disabled
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Console-based logger
 */
export const consoleLogger: Logger = {
  debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[INFO] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? ''),
};

/**
 * Hash function type for consistent hashing
 */
export type HashFunction = (data: string) => number;

/**
 * Parses a size string like "64MB" into bytes
 */
export function parseSize(size: number | string): number {
  if (typeof size === 'number') {
    return size;
  }

  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}`);
  }

  const value = parseFloat(match[1]!);
  const unit = (match[2] ?? 'B').toUpperCase();

  const multipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`Unknown size unit: ${unit}`);
  }

  return Math.floor(value * multiplier);
}
