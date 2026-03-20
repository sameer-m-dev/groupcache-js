# groupcache-js - Product Requirements Document

## Executive Summary

**groupcache-js** is a distributed caching and cache-filling library for Node.js/TypeScript, inspired by Go's groupcache. It transforms your application instances into a self-organizing distributed cache layer, eliminating the need for external cache infrastructure like Redis or Memcached.

### The Gap in JavaScript Ecosystem

| Feature | Go Ecosystem | JS Ecosystem |
|---------|-------------|--------------|
| Embedded distributed cache | groupcache | **NONE** |
| Peer-to-peer without external service | Yes | No |
| Automatic key ownership via consistent hashing | Yes | No |
| Built-in singleflight | Yes | Separate libs |
| Hot key replication | Yes | No |

---

## Core Architecture

### 1. Fundamental Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    GroupCache Instance                   │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │   Group A   │  │   Group B   │  │    Group C      │  │   │
│  │  │ (users)     │  │ (products)  │  │  (sessions)     │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  │                                                           │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ Main Cache  │  │ Hot Cache   │  │   Singleflight  │  │   │
│  │  │ (owned keys)│  │ (hot copies)│  │  (deduplication)│  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  │                                                           │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │              Transport Layer (HTTP/gRPC)            │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  │                                                           │   │
│  │  ┌─────────────────────────────────────────────────────┐  │   │
│  │  │         Peer Picker (Consistent Hashing)            │  │   │
│  │  └─────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2. How It Works

1. **Request arrives** for key "user:123"
2. **Consistent hash** determines which peer owns this key
3. If **local peer owns it**:
   - Check mainCache → return if hit
   - Use singleflight to load from source (prevents thundering herd)
   - Store in mainCache → return
4. If **remote peer owns it**:
   - Check hotCache → return if hit
   - Request from owning peer
   - Optionally store in hotCache for frequently accessed keys
   - Return value

---

## Feature Specification

### Phase 1: Core Features (MVP)

#### 1.1 Group (Cache Namespace)

```typescript
interface GroupOptions<T> {
  name: string;
  maxSize: number | string; // bytes or "64MB"
  getter: Getter<T>;
  ttl?: number; // milliseconds, 0 = no expiration
}

interface Getter<T> {
  (ctx: Context, key: string): Promise<T>;
}

interface Group<T> {
  name: string;
  get(key: string, ctx?: Context): Promise<T>;
  set(key: string, value: T, options?: SetOptions): Promise<void>;
  remove(key: string): Promise<void>;
  removeMany(keys: string[]): Promise<void>;
  stats(): GroupStats;
}
```

#### 1.2 Singleflight (Request Deduplication)

```typescript
interface Singleflight {
  do<T>(key: string, fn: () => Promise<T>): Promise<T>;
  // If key is in-flight, wait for existing result
  // Otherwise, execute fn and share result with waiters
}
```

**Benefits:**
- Prevents thundering herd on cache miss
- Single database/API call for concurrent requests for same key
- Works across the entire cluster, not just local process

#### 1.3 Consistent Hashing

```typescript
interface ConsistentHash {
  constructor(options?: {
    replicas?: number;      // Virtual nodes per peer (default: 150)
    hashFn?: HashFunction;  // Default: xxhash
  });

  add(...peers: string[]): void;
  remove(peer: string): void;
  get(key: string): string | undefined;
  getN(key: string, n: number): string[];  // Get N nearest peers
}
```

#### 1.4 Dual-Cache Architecture

| Cache | Purpose | Size |
|-------|---------|------|
| **mainCache** | Keys this peer is authoritative for | 7/8 of total |
| **hotCache** | Popular keys from other peers | 1/8 of total |

**Hot cache strategy:**
- Always populate (simplified from Go's 10% random)
- LRU eviction maintains balance
- Prevents network hotspotting on viral keys

#### 1.5 LRU Cache Implementation

```typescript
interface LRUCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, options?: { ttl?: number; size?: number }): void;
  delete(key: K): boolean;
  clear(): void;
  size: number;
  maxSize: number;

  // Events
  on(event: 'evict', handler: (key: K, value: V) => void): void;
}
```

### Phase 2: Networking & Distribution

#### 2.1 Transport Layer (Pluggable)

```typescript
interface Transport {
  // Server side
  listen(port: number, options?: ListenOptions): Promise<void>;
  close(): Promise<void>;

  // Client side
  get(peer: string, group: string, key: string, ctx?: Context): Promise<Buffer>;
  set(peer: string, group: string, key: string, value: Buffer, ttl?: number): Promise<void>;
  remove(peer: string, group: string, key: string): Promise<void>;
  removeMany(peer: string, group: string, keys: string[]): Promise<void>;
}

// Built-in transports
class HttpTransport implements Transport { }
class Http2Transport implements Transport { }  // Multiplexed connections
class GrpcTransport implements Transport { }   // For polyglot environments
```

**HTTP Protocol:**
```
GET  /_groupcache/{group}/{key}
PUT  /_groupcache/{group}/{key}  (body: value, headers: X-TTL)
DELETE /_groupcache/{group}/{key}
DELETE /_groupcache/{group}?keys=k1,k2,k3  (batch remove)
```

#### 2.2 Peer Discovery

```typescript
interface PeerPicker {
  pickPeer(key: string): PeerInfo | null;  // null = self
  setPeers(peers: PeerInfo[]): void;
  getPeers(): PeerInfo[];

  on(event: 'peersChanged', handler: (peers: PeerInfo[]) => void): void;
}

interface PeerInfo {
  address: string;  // "http://10.0.0.1:8080"
  isSelf?: boolean;
  weight?: number;
  metadata?: Record<string, string>;
}
```

#### 2.3 Peer Discovery Adapters

```typescript
// Static configuration
const staticDiscovery = new StaticPeerDiscovery([
  'http://node1:8080',
  'http://node2:8080',
]);

// Kubernetes
const k8sDiscovery = new KubernetesPeerDiscovery({
  labelSelector: 'app=myapp',
  namespace: 'default',
  port: 8080,
});

// DNS SRV
const dnsDiscovery = new DnsSrvPeerDiscovery({
  service: '_groupcache._tcp.myapp.local',
  refreshInterval: 30000,
});

// Consul
const consulDiscovery = new ConsulPeerDiscovery({
  serviceName: 'myapp',
  dc: 'dc1',
});

// Custom
const customDiscovery = new CustomPeerDiscovery(async () => {
  return fetchPeersFromMyRegistry();
});
```

### Phase 3: Advanced Features

#### 3.1 TTL / Expiration Support

```typescript
interface SetOptions {
  ttl?: number;           // Milliseconds
  expireAt?: Date;        // Absolute timestamp
  refreshOnAccess?: boolean;  // Sliding expiration
}

// In getter
async function getter(ctx: Context, key: string): Promise<CacheValue<User>> {
  const user = await db.users.findById(key);
  return {
    value: user,
    ttl: 60_000,  // 1 minute
  };
}
```

**Expiration strategy:**
- Lazy expiration: checked on access
- Optional background cleanup interval
- Requires synchronized clocks for cross-node consistency

#### 3.2 Key Removal & Invalidation

```typescript
interface Group<T> {
  // Remove from entire cluster
  remove(key: string): Promise<void>;

  // Batch removal
  removeMany(keys: string[]): Promise<void>;

  // Pattern-based removal (optional)
  removeByPattern(pattern: string | RegExp): Promise<number>;

  // Clear entire group
  clear(): Promise<void>;
}
```

**Removal strategy:**
1. Send to owning peer
2. Owner broadcasts to all peers
3. Best-effort delivery (TTL provides eventual consistency)

#### 3.3 Multiple Instances Per Process

```typescript
// Original Go limitation: single global instance
// Our improvement: unlimited instances

const cacheA = new GroupCache({ port: 8001 });
const cacheB = new GroupCache({ port: 8002 });

// Different peer lists, different configurations
```

#### 3.4 Pluggable Cache Backends

```typescript
interface CacheBackend<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, options?: CacheSetOptions): void;
  delete(key: K): boolean;
  clear(): void;
  size: number;
  has(key: K): boolean;
}

// Built-in
new GroupCache({ cacheBackend: 'lru' });      // Default LRU
new GroupCache({ cacheBackend: 'lfu' });      // LFU alternative
new GroupCache({ cacheBackend: 'arc' });      // Adaptive Replacement Cache

// Custom
new GroupCache({ cacheBackend: new MyCustomCache() });
```

### Phase 4: Observability & Production Features

#### 4.1 Metrics & Statistics

```typescript
interface GroupStats {
  gets: number;
  hits: number;
  misses: number;
  loads: number;
  loadsDeduped: number;      // Saved by singleflight
  peerLoads: number;
  peerErrors: number;
  localLoads: number;
  localLoadErrors: number;

  cacheSize: number;         // bytes
  cacheItems: number;
  mainCacheHits: number;
  hotCacheHits: number;

  avgLoadLatencyMs: number;
  avgPeerLatencyMs: number;
  p99LoadLatencyMs: number;
}

interface InstanceStats {
  groups: Map<string, GroupStats>;
  peers: PeerStats[];
  uptime: number;
}
```

#### 4.2 OpenTelemetry Integration

```typescript
import { trace, metrics } from '@opentelemetry/api';

const cache = new GroupCache({
  telemetry: {
    tracer: trace.getTracer('groupcache'),
    meter: metrics.getMeter('groupcache'),
  },
});
```

**Exported metrics:**
- `groupcache.gets` (counter)
- `groupcache.hits` (counter)
- `groupcache.misses` (counter)
- `groupcache.load.duration` (histogram)
- `groupcache.peer.requests` (counter)
- `groupcache.cache.size` (gauge)

**Trace spans:**
- `groupcache.get`
- `groupcache.load`
- `groupcache.peer.fetch`

#### 4.3 Logging

```typescript
interface Logger {
  debug(message: string, meta?: object): void;
  info(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

new GroupCache({
  logger: pino({ level: 'info' }),
  // or
  logger: winston.createLogger({ ... }),
  // or
  logger: console,
});
```

#### 4.4 Health Checks

```typescript
interface HealthStatus {
  healthy: boolean;
  peers: {
    total: number;
    healthy: number;
    unhealthy: string[];
  };
  groups: {
    name: string;
    cacheSize: number;
    maxSize: number;
    utilizationPercent: number;
  }[];
}

cache.health(): HealthStatus;

// Express middleware
app.get('/health', cache.healthMiddleware());
```

### Phase 5: JS-Specific Enhancements

#### 5.1 TypeScript First

```typescript
// Full type inference
const usersCache = cache.newGroup<User>({
  name: 'users',
  getter: async (ctx, key) => {
    // Return type inferred as User
    return db.users.findById(key);
  },
});

const user = await usersCache.get('user:123');
// Type: User
```

#### 5.2 Serialization Options

```typescript
interface SerializerOptions {
  serializer: 'json' | 'msgpack' | 'protobuf' | Serializer;
  compression?: 'none' | 'gzip' | 'brotli' | 'lz4';
  compressionThreshold?: number;  // Only compress if > N bytes
}

interface Serializer<T = any> {
  serialize(value: T): Buffer;
  deserialize(buffer: Buffer): T;
}
```

#### 5.3 Worker Thread Support

```typescript
// Main thread
const cache = new GroupCache({
  workers: 4,  // Use worker threads for heavy operations
});

// Automatic load balancing of getter functions
// across worker pool
```

#### 5.4 Graceful Shutdown

```typescript
// Signals peer removal before shutdown
await cache.shutdown({ timeout: 30_000 });

// SIGTERM handler built-in
new GroupCache({ handleSignals: true });
```

#### 5.5 Framework Integrations

```typescript
// Express
app.use(cache.middleware());

// Fastify
fastify.register(cache.fastifyPlugin());

// NestJS
@Module({
  imports: [GroupCacheModule.forRoot({ ... })],
})

// tRPC
const t = initTRPC.create();
const cachedProcedure = t.procedure.use(cache.trpcMiddleware());
```

#### 5.6 Redis-like API (Optional Layer)

```typescript
// Familiar API for Redis users
const kv = cache.asKeyValue('mygroup');

await kv.set('key', 'value', { ex: 60 });
await kv.get('key');
await kv.del('key');
await kv.mget(['k1', 'k2', 'k3']);
await kv.mset({ k1: 'v1', k2: 'v2' });
```

---

## API Design Summary

### Main Entry Point

```typescript
import { GroupCache, HttpTransport, KubernetesPeerDiscovery } from 'groupcache-js';

// Create instance
const cache = new GroupCache({
  // Identity
  self: 'http://localhost:8080',

  // Networking
  transport: new HttpTransport({ port: 8080 }),
  discovery: new KubernetesPeerDiscovery({
    labelSelector: 'app=myapp',
  }),

  // Defaults
  defaultTtl: 300_000,
  defaultMaxSize: '256MB',

  // Observability
  logger: console,
  telemetry: { /* otel config */ },

  // Advanced
  hashReplicas: 150,
  cacheBackend: 'lru',
  serializer: 'msgpack',
});

// Create groups
const users = cache.newGroup<User>({
  name: 'users',
  maxSize: '64MB',
  getter: async (ctx, key) => {
    return db.users.findById(key);
  },
});

// Use
const user = await users.get('user:123');

// Manual set (for preloading)
await users.set('user:456', userData, { ttl: 60_000 });

// Invalidation
await users.remove('user:123');

// Stats
console.log(users.stats());

// Shutdown
await cache.shutdown();
```
