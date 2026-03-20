# groupcache-js

[![npm version](https://badge.fury.io/js/groupcache-js.svg)](https://www.npmjs.com/package/groupcache-js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

A distributed caching and cache-filling library for Node.js/TypeScript, inspired by Go's [groupcache](https://github.com/golang/groupcache).

**Your application instances become the distributed cache layer. No Redis. No Memcached. Just your app.**

## Features

- **Embedded Distributed Cache** - No external infrastructure required
- **Singleflight** - Prevents thundering herd on cache misses
- **Consistent Hashing** - Predictable key distribution across peers
- **Hot Cache** - Automatic replication of frequently accessed keys
- **TTL Support** - Configurable expiration for cache entries
- **TypeScript First** - Full type safety and inference
- **Multiple Cache Backends** - LRU, LFU, ARC (Adaptive Replacement Cache)
- **Pluggable Transport** - HTTP/1.1, HTTP/2, gRPC
- **Pluggable Discovery** - Kubernetes, DNS SRV, Static
- **OpenTelemetry** - Built-in tracing and metrics
- **Framework Integrations** - Express, Fastify middleware
- **Worker Thread Support** - Offload CPU-intensive operations

## Installation

```bash
npm install groupcache-js
```

### Optional Dependencies

```bash
# For gRPC transport
npm install @grpc/grpc-js @grpc/proto-loader

# For MessagePack serialization
npm install msgpackr
```

## Quick Start

```typescript
import { GroupCache } from 'groupcache-js';

// Create the cache instance
const cache = new GroupCache({
  self: 'http://localhost:8080',
  peers: ['http://localhost:8080', 'http://localhost:8081', 'http://localhost:8082'],
});

// Define a cache group with a getter
const users = cache.newGroup({
  name: 'users',
  maxSize: '64MB',
  ttl: 300_000, // 5 minutes
  getter: async (ctx, key) => {
    // Called on cache miss - load from database
    const user = await db.users.findById(key);
    return user;
  },
});

// Start the cache (begins listening for peer requests)
await cache.start();

// Get a value - automatically distributed across peers
const user = await users.get('user:123');

// Explicit set (optional - getter handles cache population)
await users.set('user:456', { id: '456', name: 'Jane' }, { ttl: 60000 });

// Remove from cache cluster-wide
await users.remove('user:123');

// Graceful shutdown
await cache.shutdown();
```

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                     Your Application                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │  Instance 1 │  │  Instance 2 │  │     Instance 3      │   │
│  │   (Peer A)  │◄─►│   (Peer B)  │◄─►│      (Peer C)       │   │
│  └─────────────┘  └─────────────┘  └─────────────────────┘   │
│         │                │                    │               │
│         └────────────────┼────────────────────┘               │
│                          │                                    │
│              Consistent Hash Ring                             │
│         ┌────────────────┼────────────────┐                   │
│         │     Keys distributed across     │                   │
│         │     peers based on hash         │                   │
│         └─────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

1. **Request arrives** for key "user:123"
2. **Consistent hash** determines Peer B owns this key
3. Request is **forwarded to Peer B**
4. Peer B checks its **local cache** (mainCache)
5. If miss, **singleflight** ensures only one database load
6. Value is **cached and returned**
7. If key is hot, it's also stored in requester's **hotCache**

## Configuration

### GroupCache Options

```typescript
const cache = new GroupCache({
  // Required: This instance's address
  self: 'http://localhost:8080',

  // Option 1: Static peer list
  peers: ['http://localhost:8080', 'http://localhost:8081'],

  // Option 2: Dynamic peer discovery
  discovery: new KubernetesPeerDiscovery({
    labelSelector: 'app=myapp',
    port: 8080,
  }),

  // Transport (default: HttpTransport)
  transport: new Http2Transport({ timeout: 5000 }),

  // Consistent hash replicas (default: 150)
  hashReplicas: 150,

  // Default TTL for all groups (default: 0 = no expiration)
  defaultTtl: 300000,

  // Default max size for groups (default: 64MB)
  defaultMaxSize: '64MB',

  // Logger
  logger: console,

  // Handle SIGTERM/SIGINT (default: false)
  handleSignals: true,
});
```

### Group Options

```typescript
const group = cache.newGroup({
  name: 'users',
  maxSize: '128MB',           // Size limit (bytes or string like '128MB')
  ttl: 300000,                // Default TTL in milliseconds
  getter: async (ctx, key) => {
    return await fetchData(key);
  },
});
```

## Transports

### HTTP/1.1 (Default)

```typescript
import { HttpTransport } from 'groupcache-js';

const transport = new HttpTransport({
  basePath: '/_groupcache',   // URL prefix (default: '/_groupcache')
  timeout: 5000,              // Request timeout in ms (default: 5000)
  maxSockets: 10,             // Max connections per peer (default: 10)
});
```

### HTTP/2

```typescript
import { Http2Transport } from 'groupcache-js';

const transport = new Http2Transport({
  timeout: 5000,
  maxConcurrentStreams: 100,  // Streams per connection (default: 100)
  sessionTimeout: 60000,      // Idle session timeout (default: 60000)
});
```

### gRPC

```typescript
import { GrpcTransport } from 'groupcache-js';

const transport = new GrpcTransport({
  timeout: 5000,
  maxMessageSize: 4 * 1024 * 1024,  // 4MB (default)
  // Optional TLS
  tls: {
    rootCerts: fs.readFileSync('ca.pem'),
    privateKey: fs.readFileSync('client-key.pem'),
    certChain: fs.readFileSync('client-cert.pem'),
  },
});
```

## Peer Discovery

### Static

```typescript
import { StaticPeerDiscovery } from 'groupcache-js';

const discovery = new StaticPeerDiscovery([
  'http://cache-1:8080',
  'http://cache-2:8080',
  'http://cache-3:8080',
]);
```

### Kubernetes

```typescript
import { KubernetesPeerDiscovery } from 'groupcache-js';

const discovery = new KubernetesPeerDiscovery({
  labelSelector: 'app=myapp,component=cache',
  namespace: 'production',    // Default: current namespace
  port: 8080,
  protocol: 'http',           // 'http' or 'https'
  resyncInterval: 30000,      // Re-list pods interval (default: 30000)
});
```

### DNS SRV

```typescript
import { DnsSrvPeerDiscovery } from 'groupcache-js';

const discovery = new DnsSrvPeerDiscovery({
  serviceName: '_groupcache._tcp.myapp.local',
  protocol: 'http',
  refreshInterval: 30000,
});
```

## Cache Backends

### LRU (Default)

Least Recently Used - evicts oldest accessed items first.

```typescript
import { LRUCache } from 'groupcache-js';

const cache = new LRUCache({
  maxSize: 1024 * 1024 * 100,  // 100MB
  onEvict: (key, entry) => console.log(`Evicted: ${key}`),
});
```

### LFU

Least Frequently Used - evicts least accessed items first.

```typescript
import { LFUCache } from 'groupcache-js';

const cache = new LFUCache({
  maxSize: '100MB',
});
```

### ARC

Adaptive Replacement Cache - self-tuning, balances recency and frequency.

```typescript
import { ARCCache } from 'groupcache-js';

const cache = new ARCCache({
  maxSize: '100MB',
});
```

## Framework Integrations

### Express

```typescript
import express from 'express';
import { GroupCache, createExpressMiddleware } from 'groupcache-js';

const app = express();
const cache = new GroupCache({ self: 'http://localhost:3000' });

// Mount groupcache peer communication endpoint
app.use(createExpressMiddleware(cache));

// Your routes can use the cache
app.get('/api/users/:id', async (req, res) => {
  const user = await cache.getGroup('users').get(req.params.id);
  res.json(user);
});
```

### Fastify

```typescript
import Fastify from 'fastify';
import { GroupCache, fastifyGroupCache } from 'groupcache-js';

const app = Fastify();
const cache = new GroupCache({ self: 'http://localhost:3000' });

// Register plugin
await app.register(fastifyGroupCache, { cache });

// Access via decorator
app.get('/api/users/:id', async (request) => {
  return app.groupcache.getGroup('users').get(request.params.id);
});
```

## Worker Threads

Offload CPU-intensive operations (serialization, compression) to background threads:

```typescript
import { WorkerPool } from 'groupcache-js';

const pool = new WorkerPool({
  size: 4,                    // Number of workers (default: CPU cores - 1)
  threshold: 102400,          // Only offload if payload > 100KB
  taskTimeout: 30000,         // Task timeout in ms
});

// Serialize large objects in worker
const buffer = await pool.serialize(largeObject);
const parsed = await pool.deserialize(buffer);

// Compress in worker
const compressed = await pool.compress(buffer);
const decompressed = await pool.decompress(compressed);

// Get stats
console.log(pool.getStats());

// Cleanup
await pool.shutdown();
```

## OpenTelemetry

### Metrics

```typescript
import { createMetrics } from 'groupcache-js';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

const meterProvider = new MeterProvider();
const meter = meterProvider.getMeter('groupcache');

const metrics = createMetrics(meter, {
  prefix: 'groupcache',
});

const cache = new GroupCache({
  self: 'http://localhost:8080',
  metrics,
});
```

### Tracing

```typescript
import { GroupCacheTracer } from 'groupcache-js';
import { trace } from '@opentelemetry/api';

const tracer = new GroupCacheTracer(trace.getTracer('groupcache'));

// Traces are automatically created for:
// - groupcache.get
// - groupcache.load
// - groupcache.peer_fetch
// - groupcache.set
// - groupcache.remove
```

## Serialization

```typescript
import {
  jsonSerializer,
  binarySerializer,
  stringSerializer,
  createMsgPackSerializer,
  createCompressedSerializer,
} from 'groupcache-js';

// JSON (default)
const group = cache.newGroup({
  name: 'data',
  serializer: jsonSerializer,
  // ...
});

// MessagePack (requires msgpackr)
const msgpack = createMsgPackSerializer();

// Compressed (gzip for payloads > threshold)
const compressed = createCompressedSerializer(jsonSerializer, 1024);
```

## Benchmarks

Run benchmarks:

```bash
npm run bench
```

### Results (Apple M5, Node.js 22)

| Component | Performance |
|-----------|-------------|
| **LRU Cache Read** | 20.6M ops/sec |
| **LRU Cache Write** | 4.7M ops/sec |
| **HTTP/2 Concurrent** | 59K ops/sec |
| **HTTP/1.1 Concurrent** | 29K ops/sec |
| **gRPC Concurrent** | 18K ops/sec |

## API Reference

### GroupCache

| Method | Description |
|--------|-------------|
| `newGroup(options)` | Create a new cache group |
| `getGroup(name)` | Get an existing group |
| `start()` | Start listening for peer requests |
| `shutdown()` | Graceful shutdown |
| `getStats()` | Get instance statistics |
| `isHealthy()` | Health check |

### Group

| Method | Description |
|--------|-------------|
| `get(key, ctx?)` | Get value (loads on miss) |
| `set(key, value, options?)` | Explicitly set value |
| `remove(key)` | Remove from cluster |
| `getStats()` | Get group statistics |

## Comparison with Alternatives

| Feature | groupcache-js | Redis | Memcached |
|---------|--------------|-------|-----------|
| Infrastructure | None | Server required | Server required |
| Consistency | Eventual | Strong | Eventual |
| Persistence | No | Yes | No |
| Pub/Sub | No | Yes | No |
| Singleflight | Yes | No | No |
| TypeScript | Native | Client only | Client only |

**Choose groupcache-js when:**
- You want to eliminate cache infrastructure
- Your app already runs multiple instances
- You need thundering herd protection
- You prefer embedded solutions

**Choose Redis/Memcached when:**
- You need persistence
- You need pub/sub
- You need strong consistency
- Cache must survive app restarts

## Contributing

```bash
# Clone
git clone https://github.com/sameer-m-dev/groupcache-js.git
cd groupcache-js

# Install
npm install

# Test
npm test

# Build
npm run build

# Benchmark
npm run bench
```

## Inspired By

- [golang/groupcache](https://github.com/golang/groupcache) - Original by Brad Fitzpatrick
- [mailgun/groupcache](https://github.com/mailgun/groupcache) - TTL and removal support
- [groupcache/groupcache-go](https://github.com/groupcache/groupcache-go) - Modern v3 rewrite
- [udhos/kubegroup](https://github.com/udhos/kubegroup) - Kubernetes peer discovery

## License

MIT
