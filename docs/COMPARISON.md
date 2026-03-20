# Comparison with Go Implementations

This document compares groupcache-js with the various Go implementations that inspired it.

## Feature Matrix

| Feature | golang/groupcache | mailgun/groupcache | groupcache-go v3 | **groupcache-js** |
|---------|------------------|-------------------|------------------|-------------------|
| TTL Support | No | Yes | Yes | **Yes** |
| Key Removal | No | Yes | Yes | **Yes** |
| Explicit Set | No | Yes (v2.3+) | No | **Yes** |
| Multiple Instances | No | No | Yes | **Yes** |
| Pluggable Transport | No | Partial | Yes | **Yes** |
| Pluggable Cache | No | No | Yes | **Yes** |
| gRPC Support | No | No | No | **Yes** |
| OpenTelemetry | No | No | Yes | **Yes** |
| K8s Discovery | External | External | External | **Built-in** |
| TypeScript | N/A | N/A | N/A | **Native** |
| Compression | No | No | No | **Yes** |
| Worker Threads | N/A | N/A | N/A | **Yes** |

---

## Detailed Analysis

### 1. golang/groupcache (Original)

**Repository:** https://github.com/golang/groupcache

**Author:** Brad Fitzpatrick (creator of memcached)

**Philosophy:** Immutable, read-only distributed cache

**Key Characteristics:**
- No TTL - keys never expire
- No deletion - once set, always set
- No updates - key must always return same value
- Single global instance per process
- HTTP-only transport (coupled to library)
- Basic LRU eviction

**Strengths:**
- Simple, battle-tested design
- Excellent for truly immutable data
- Low operational complexity

**Limitations:**
- Cannot invalidate cache entries
- Data must be versioned externally (e.g., "user:123:v2")
- Single instance limits flexibility
- No observability features

**Best For:** URL shorteners, CDN origin shields, immutable asset metadata

---

### 2. mailgun/groupcache (Mailgun Fork)

**Repository:** https://github.com/mailgun/groupcache

**Module:** `github.com/mailgun/groupcache/v2`

**Philosophy:** Production-ready groupcache with mutability

**Key Additions:**
- **TTL Support (v1.1.0):** `SetBytes(value, expireAt time.Time)`
- **Key Removal (v1.3.0):** `Remove(ctx, key)` method
- **Explicit Set (v2.3.0):** `Set(ctx, key, value, expire, hotCache)`
- **Context Support (v2.0.0):** stdlib `context.Context`
- **Logging (v2.2.0):** logrus integration
- **Faster Hashing (v2.2.1):** fnv1 from segmentio/fasthash

**API Changes from Original:**
```go
// Original
dest.SetBytes(value)

// Mailgun
dest.SetBytes(value, time.Now().Add(5*time.Minute))
```

**Strengths:**
- Addresses the biggest limitation (no invalidation)
- Production-tested at Mailgun scale
- Maintains backward compatibility where possible
- Good documentation

**Limitations:**
- Still single instance per process
- HTTP transport only
- No OpenTelemetry support
- Limited cache backend options

**Best For:** General-purpose distributed caching with invalidation needs

---

### 3. groupcache/groupcache-go v3 (Community Fork)

**Repository:** https://github.com/groupcache/groupcache-go

**Module:** `github.com/groupcache/groupcache-go/v3`

**Philosophy:** Modern, extensible groupcache

**Key Additions:**
- **Multiple Instances:** No global state, create many instances
- **Pluggable Transport:** `transport.Transport` interface
- **Pluggable Cache:** `Cache` interface with Otter support
- **TLS Support (v3.2.0):** Secure peer communication
- **OpenTelemetry (v3.3.0):** Full tracing and metrics
- **Batch Remove (v3.4.0):** `RemoveKeys()` for efficiency

**Architecture Changes:**
```go
// Original (global)
groupcache.NewGroup("name", size, getter)

// v3 (instance-based)
instance := groupcache.New(groupcache.Options{...})
group := instance.NewGroup("name", size, getter)
```

**Strengths:**
- Most feature-complete Go implementation
- Modern architecture (no global state)
- Excellent observability
- Active development

**Limitations:**
- Breaking API changes from original
- No gRPC transport (HTTP only)
- Still requires external K8s integration

**Best For:** New projects needing full feature set and observability

---

### 4. udhos/kubegroup (K8s Integration)

**Repository:** https://github.com/udhos/kubegroup

**Purpose:** Kubernetes peer discovery for groupcache

**How It Works:**
1. Uses Kubernetes API to watch pods with matching labels
2. Automatically updates peer list when pods scale
3. Only includes pods in `Ready` state
4. Supports both groupcache v2 (Mailgun) and v3

**Usage:**
```go
kubegroup.New(kubegroup.Options{
    Pool:           httpPool,
    Client:         k8sClient,
    GroupCachePort: ":5000",
    LabelSelector:  "app=myapp",
})
```

**Requirements:**
- RBAC: pods get/list/watch permissions
- Service account with appropriate role binding

**Metrics:**
- `kubegroup_peers`: Number of discovered peers
- `kubegroup_events`: Discovery events count

---

## What groupcache-js Brings to the Table

### 1. First for JavaScript Ecosystem

The fundamental gap: JavaScript has no embedded distributed cache. You either use:
- Local caches (lru-cache, node-cache) - no distribution
- External services (Redis, Memcached) - infrastructure overhead

groupcache-js fills this gap.

### 2. TypeScript-First Design

```typescript
// Full type safety and inference
const users = cache.newGroup<User>({
  name: 'users',
  getter: async (ctx, key) => {
    return db.users.findById(key); // Returns User
  },
});

const user = await users.get('user:123'); // Type: User
```

### 3. Built-in Kubernetes Discovery

Unlike Go implementations that require external kubegroup:

```typescript
const cache = new GroupCache({
  discovery: new KubernetesPeerDiscovery({
    labelSelector: 'app=myapp',
  }),
});
```

### 4. Multiple Transport Options

```typescript
// HTTP (default)
new HttpTransport({ port: 8080 })

// HTTP/2 (multiplexed connections)
new Http2Transport({ port: 8080 })

// gRPC (polyglot environments)
new GrpcTransport({ port: 8080 })
```

### 5. Compression Support

```typescript
new GroupCache({
  serializer: 'msgpack',
  compression: 'lz4',
  compressionThreshold: 1024, // Only compress if > 1KB
});
```

### 6. Worker Thread Support

```typescript
new GroupCache({
  workers: 4, // Offload CPU-intensive operations
});
```

### 7. Framework Integrations

```typescript
// Express
app.use(cache.middleware());

// Fastify
fastify.register(cache.fastifyPlugin());

// NestJS
@Module({
  imports: [GroupCacheModule.forRoot({ ... })],
})
```

---

## Migration Guide

### From Redis/Memcached

```typescript
// Before: External Redis
const redis = new Redis();
const value = await redis.get('key');
if (!value) {
  const data = await loadFromDB('key');
  await redis.set('key', data, 'EX', 60);
  return data;
}
return value;

// After: Embedded groupcache-js
const group = cache.newGroup({
  name: 'mydata',
  getter: async (ctx, key) => loadFromDB(key),
  ttl: 60_000,
});
const value = await group.get('key');
```

### From node-cache/lru-cache

```typescript
// Before: Local cache only
const cache = new LRUCache({ max: 1000 });
const value = cache.get('key') ?? await loadAndCache('key');

// After: Distributed cache
const group = cache.newGroup({
  name: 'mydata',
  getter: async (ctx, key) => loadFromDB(key),
});
const value = await group.get('key');
// Now distributed across all instances!
```

---

## When to Use What

| Scenario | Recommendation |
|----------|----------------|
| Immutable data, simple setup | golang/groupcache |
| Need invalidation, Go project | mailgun/groupcache v2 |
| Full features, new Go project | groupcache-go v3 |
| Running on Kubernetes (Go) | groupcache-go v3 + kubegroup |
| **JavaScript/TypeScript project** | **groupcache-js** |
| **Need embedded distributed cache in Node.js** | **groupcache-js** |
