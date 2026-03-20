# groupcache-js Architecture

## Directory Structure

```
groupcache-js/
├── src/
│   ├── index.ts              # Main exports
│   ├── groupcache.ts         # GroupCache class
│   ├── group.ts              # Group class
│   ├── cache/
│   │   ├── lru.ts           # LRU implementation
│   │   ├── lfu.ts           # LFU implementation
│   │   └── interface.ts     # CacheBackend interface
│   ├── singleflight/
│   │   └── singleflight.ts  # Request deduplication
│   ├── hash/
│   │   └── consistent.ts    # Consistent hashing
│   ├── transport/
│   │   ├── interface.ts     # Transport interface
│   │   ├── http.ts          # HTTP transport
│   │   ├── http2.ts         # HTTP/2 transport
│   │   └── grpc.ts          # gRPC transport
│   ├── discovery/
│   │   ├── interface.ts     # PeerDiscovery interface
│   │   ├── static.ts        # Static peer list
│   │   ├── kubernetes.ts    # K8s discovery
│   │   ├── dns.ts           # DNS SRV discovery
│   │   └── consul.ts        # Consul discovery
│   ├── serialization/
│   │   ├── json.ts
│   │   ├── msgpack.ts
│   │   └── protobuf.ts
│   ├── telemetry/
│   │   ├── metrics.ts
│   │   └── tracing.ts
│   └── integrations/
│       ├── express.ts
│       ├── fastify.ts
│       └── nestjs.ts
├── test/
├── examples/
├── docs/
├── package.json
├── tsconfig.json
└── README.md
```

## Core Components

### 1. GroupCache (Main Class)

The main entry point that orchestrates all components:

```
GroupCache
├── Transport (HTTP/gRPC server)
├── PeerPicker (Consistent hash ring)
├── Discovery (Peer discovery adapter)
├── Groups (Map of cache namespaces)
└── Stats (Instance-level metrics)
```

### 2. Group (Cache Namespace)

Each group represents an isolated cache with its own:
- Getter function (data loader)
- Size limits
- TTL configuration
- Statistics

```
Group
├── mainCache (LRU - owned keys)
├── hotCache (LRU - replicated hot keys)
├── singleflight (Request deduplication)
└── stats (Group-level metrics)
```

### 3. Request Flow

```
                    ┌──────────────────────────────────────────┐
                    │               group.get(key)             │
                    └──────────────────┬───────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────┐
                    │         Check mainCache                   │
                    │         (owned keys)                      │
                    └──────────────────┬───────────────────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         │ HIT                       │ MISS
                         ▼                           ▼
                    ┌─────────┐         ┌────────────────────────┐
                    │ Return  │         │   consistentHash(key)  │
                    └─────────┘         └────────────┬───────────┘
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              │ SELF                                        │ PEER
                              ▼                                             ▼
                    ┌───────────────────────┐                  ┌──────────────────────┐
                    │   Check hotCache      │                  │   Check hotCache     │
                    └───────────┬───────────┘                  └───────────┬──────────┘
                                │                                          │
                    ┌───────────┴───────────┐              ┌───────────────┴───────────────┐
                    │ HIT          MISS     │              │ HIT                     MISS  │
                    ▼              ▼        │              ▼                          ▼
               ┌─────────┐  ┌─────────────┐ │         ┌─────────┐            ┌─────────────┐
               │ Return  │  │ singleflight│ │         │ Return  │            │ Fetch from  │
               └─────────┘  │    .do()    │ │         └─────────┘            │    peer     │
                            └──────┬──────┘ │                                └──────┬──────┘
                                   │        │                                       │
                            ┌──────▼──────┐ │                                ┌──────▼──────┐
                            │   getter()  │ │                                │  Store in   │
                            │  (load data)│ │                                │  hotCache   │
                            └──────┬──────┘ │                                └──────┬──────┘
                                   │        │                                       │
                            ┌──────▼──────┐ │                                ┌──────▼──────┐
                            │  Store in   │ │                                │   Return    │
                            │  mainCache  │ │                                └─────────────┘
                            └──────┬──────┘ │
                                   │        │
                            ┌──────▼──────┐ │
                            │   Return    │ │
                            └─────────────┘ │
```

### 4. Peer Communication

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Peer A                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────┐ │
│  │   Group     │  │  Consistent │  │         Transport               │ │
│  │   "users"   │──│    Hash     │──│  HTTP Server (:8080)            │ │
│  └─────────────┘  └─────────────┘  │  /_groupcache/{group}/{key}     │ │
│                                     └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
         │                                          ▲
         │ GET user:123                             │
         │ hash(user:123) → Peer B                  │
         ▼                                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                              Peer B                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────┐ │
│  │   Group     │  │  Consistent │  │         Transport               │ │
│  │   "users"   │◄─│    Hash     │◄─│  HTTP Server (:8080)            │ │
│  └─────────────┘  └─────────────┘  │  /_groupcache/{group}/{key}     │ │
│                                     └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Structures

### Consistent Hash Ring

```
Virtual Nodes (replicas = 3):

Hash Ring:
0 ────────────────────────────────────────────────── MAX_UINT32
    │         │         │         │         │
    A-0       B-0       A-1       B-1       A-2

Key Distribution:
- key "user:1" → hash = 12345 → between A-0 and B-0 → Peer B
- key "user:2" → hash = 67890 → between B-1 and A-2 → Peer A
```

### LRU Cache

```
Doubly Linked List + HashMap:

HashMap: { key → Node }
List:    HEAD ←→ Node1 ←→ Node2 ←→ Node3 ←→ TAIL
                  ↑                           ↑
                 MRU                         LRU

Operations:
- get(key): O(1) - move to head
- set(key): O(1) - insert at head, evict from tail if full
- delete(key): O(1) - remove node
```

### Singleflight

```
In-Flight Map: { key → { promise, waiters[] } }

Concurrent requests for same key:

Time →
Request 1: ───┬─── execute fn() ───┬─── resolve ───►
              │                    │
Request 2: ───┼─── wait ───────────┴─── receive same result ───►
              │
Request 3: ───┴─── wait ─────────────── receive same result ───►
```

## Memory Layout

### Cache Size Allocation

```
Total Cache Size: 64MB (configured)
├── mainCache: 56MB (7/8)
│   └── Keys this peer owns
└── hotCache: 8MB (1/8)
    └── Hot keys from other peers

Per-Entry Overhead:
- Key: string length + 16 bytes (object overhead)
- Value: serialized size + 16 bytes
- Metadata: 48 bytes (timestamps, size, links)
- Total overhead: ~80 bytes per entry
```

## Network Protocol

### HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/_groupcache/{group}/{key}` | Fetch cached value |
| PUT | `/_groupcache/{group}/{key}` | Set value (with TTL header) |
| DELETE | `/_groupcache/{group}/{key}` | Remove single key |
| DELETE | `/_groupcache/{group}?keys=k1,k2` | Batch remove |
| GET | `/_groupcache/_health` | Health check |
| GET | `/_groupcache/_stats` | Statistics |

### Request Headers

| Header | Description |
|--------|-------------|
| `X-GroupCache-TTL` | TTL in milliseconds |
| `X-GroupCache-Trace-ID` | Distributed trace ID |
| `X-GroupCache-From` | Requesting peer address |

### Response Headers

| Header | Description |
|--------|-------------|
| `X-GroupCache-Hit` | "main", "hot", or "miss" |
| `X-GroupCache-Owner` | Key owner peer address |
| `X-GroupCache-Age` | Time since cached (ms) |

## Error Handling

### Failure Modes

| Failure | Behavior |
|---------|----------|
| Peer unreachable | Fall back to local getter |
| Getter throws | Propagate error, don't cache |
| Timeout | Return error, don't cache |
| Invalid key | Return error immediately |

### Circuit Breaker (per peer)

```
States: CLOSED → OPEN → HALF_OPEN → CLOSED

CLOSED: Normal operation
        → 5 failures in 10s → OPEN

OPEN:   Fail fast (don't contact peer)
        → 30s timeout → HALF_OPEN

HALF_OPEN: Try one request
           → Success → CLOSED
           → Failure → OPEN
```

## Thread Model (Node.js)

### Event Loop Architecture

```
Main Thread (Event Loop):
├── HTTP Server (libuv)
├── Cache Operations (sync, in-memory)
├── Consistent Hashing (sync, CPU-bound)
└── Singleflight Management (async)

Worker Threads (optional):
├── Heavy Serialization
├── Compression
└── Custom Getters (CPU-intensive)
```

### Async Boundaries

```
Sync Operations:
- Cache get/set
- Consistent hash lookup
- Singleflight check

Async Operations:
- Network requests to peers
- Getter function calls
- Disk I/O (if any)
```

## Scaling Characteristics

### Horizontal Scaling

```
Adding a peer:
1. New peer joins cluster
2. Discovery notifies all peers
3. Consistent hash ring updated
4. ~1/N keys migrate to new peer (lazy)
5. Hot cache naturally rebalances

Removing a peer:
1. Peer leaves (graceful or crash)
2. Discovery notifies remaining peers
3. Consistent hash ring updated
4. Keys owned by removed peer → next peer
5. Temporary increase in getter calls
```

### Performance Expectations

| Operation | Latency | Throughput |
|-----------|---------|------------|
| Local cache hit | <1ms | 100K+ ops/s |
| Hot cache hit | <1ms | 100K+ ops/s |
| Peer fetch | 1-5ms | 10K+ ops/s |
| Getter (DB) | 10-100ms | Varies |
