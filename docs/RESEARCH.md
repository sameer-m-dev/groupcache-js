# Research: Go Groupcache Implementations

This document summarizes the research conducted on existing Go groupcache implementations to inform the design of groupcache-js.

---

## 1. golang/groupcache (Original)

**Repository:** https://github.com/golang/groupcache

**Author:** Brad Fitzpatrick (creator of memcached)

### Overview

groupcache is a distributed caching and cache-filling library developed by Google. It's designed as a replacement for memcached pools in many scenarios, serving as both a client library and server simultaneously.

### Core Concepts

#### Group
The central abstraction representing a cache namespace:
- Unique name (string identifier)
- Associated with a `Getter` function for loading data on cache misses
- Configurable total cache size (`cacheBytes`) shared between mainCache and hotCache
- Contains statistics tracking (Gets, CacheHits, PeerLoads, etc.)
- Uses singleflight to deduplicate concurrent requests

#### Getter / GetterFunc
Interface for loading data when not in cache:
```go
type Getter interface {
    Get(ctx context.Context, key string, dest Sink) error
}
```

#### Sink
Interface for receiving data from Get operations:
- **StringSink**: Populates a string pointer
- **ByteViewSink**: Populates a ByteView
- **ProtoSink**: Unmarshals into a protobuf message
- **AllocatingByteSliceSink**: Allocates new byte slice
- **TruncatingByteSliceSink**: Writes into pre-allocated buffer

#### ByteView
Immutable view of bytes (value type, not pointer):
- Internally holds either `[]byte` or `string`
- Provides methods: `Len()`, `ByteSlice()`, `String()`, `Slice()`, `Reader()`, `WriteTo()`

#### PeerPicker
Interface for locating which peer owns a key:
```go
type PeerPicker interface {
    PickPeer(key string) (peer ProtoGetter, ok bool)
}
```

### Key Features

#### Singleflight (Duplicate Suppression)
- Ensures only one execution is in-flight for a given key at a time
- Duplicate concurrent callers wait and receive the same result
- Uses `sync.WaitGroup` for blocking duplicate callers
- Prevents cache stampedes / thundering herd problem

#### Consistent Hashing
- Ring-based hash using CRC32 (default) or custom hash function
- 50 virtual replicas per node by default (configurable)
- Keys are distributed by computing hash and finding next node clockwise
- Binary search for O(log n) peer lookup

#### Dual-Cache Architecture
1. **mainCache**: Stores keys this peer is authoritative for
2. **hotCache**: Replicates popular keys from other peers locally
   - Prevents network hotspotting on frequently accessed keys
   - Populated probabilistically (10% chance) when fetching from peers
   - Size limited to 1/8 of mainCache

#### LRU Eviction
- Classic LRU using doubly-linked list + hashmap
- Optional `OnEvicted` callback
- NOT thread-safe (groupcache wraps with mutex)

### HTTP Protocol

**Endpoint Structure:**
```
GET /_groupcache/<group-name>/<key>
```

**Request/Response Format (Protocol Buffers):**
```protobuf
message GetRequest {
  required string group = 1;
  required string key = 2;
}

message GetResponse {
  optional bytes value = 1;
  optional double minute_qps = 2;
}
```

### Limitations

**By Design:**
1. No TTL/Expiration: Keys never expire; data must be immutable
2. No Explicit Deletion: Cannot delete/invalidate keys
3. No Updates: If key "foo" = "bar", it must always be "bar"
4. No CAS Operations: No compare-and-swap, increment/decrement
5. Read-Only Cache: Write-through not supported
6. No Automatic Peer Discovery: Must manually manage cluster membership

**Technical:**
1. Single HTTPPool: `NewHTTPPool` can only be called once per process
2. No gRPC Support: HTTP-only
3. No Module Support: Library predates Go modules

---

## 2. mailgun/groupcache (Mailgun Fork)

**Repository:** https://github.com/mailgun/groupcache

**Module:** `github.com/mailgun/groupcache/v2`

### New Features

#### TTL/Expiration Support
- All `Sink` methods accept a `time.Time` parameter for value expiration
- Methods: `SetBytes(v []byte, e time.Time)`, `SetString(s string, e time.Time)`, `SetProto(m proto.Message, e time.Time)`
- Pass `time.Time{}` (zero value) to disable expiration
- Expiration checked during `Get()` calls without cluster coordination

#### Explicit Key Removal
- `Remove(ctx context.Context, key string) error` method on `Group`
- Sends deletion requests to the peer owning the key, then forwards to all peers
- "Best effort" design - network disruptions could prevent some removals

#### Explicit Value Setting
- `Set(ctx context.Context, key string, value []byte, expire time.Time, hotCache bool) error`
- Added in v2.3.0

#### Simplified Hot Cache Algorithm
- Changed from complex logic to "always populate the hotcache"
- Relies on LRU eviction to maintain efficiency

#### Group Deregistration
- `DeregisterGroup(name string)` function to remove groups

### API Changes

#### Context Support (v2.0.0)
- Replaced proprietary context with standard `context.Context`
- `Get()` returns immediately when context is done during peer conversation

#### HTTP Configuration
```go
type HTTPPoolOptions struct {
    BasePath  string
    Replicas  int
    HashFn    consistenthash.Hash
    Transport func(context.Context) http.RoundTripper
    Context   func(*http.Request) context.Context
}
```

#### Logging Support (v2.2.0)
- `SetLogger(log *logrus.Entry)`
- `SetLoggerFromLogger(log Logger)`

### Performance Improvements

#### Faster Hashing (v2.2.1)
- Switched to `fnv1.HashBytes64` from segmentio/fasthash
- MD5 key hashing for improved host distribution

### Version History

| Version | Key Changes |
|---------|-------------|
| v2.3.1 | Fixed panic handling in Getter.Get |
| v2.3.0 | Added `Group.Set()` |
| v2.2.1 | Faster hashing (fnv1) |
| v2.2.0 | Logging support, `DeregisterGroup`, race fix |
| v2.1.0 | Context cancellation during peer conversations |
| v2.0.0 | stdlib context, HTTPPoolOptions, Go modules |
| v1.3.0 | Added `Remove()` method |
| v1.1.0 | Sink expiration support |

---

## 3. groupcache/groupcache-go v3 (Community Fork)

**Repository:** https://github.com/groupcache/groupcache-go

**Module:** `github.com/groupcache/groupcache-go/v3`

### Key Improvements

#### Explicit Key Removal
- `Remove()` for single keys
- `RemoveKeys()` for batch removal
- Remove requests sent to owning peer, then forwarded to all peers
- Uses singleflight to deduplicate concurrent remove requests

#### TTL / Expiration Support
- `SetBytes()`, `SetProto()`, and `SetString()` accept `time.Time` for expiration
- Expiration handled at lookup time
- Requires synchronized clocks across cluster nodes

#### Removal of Global State (Multiple Instances)
- No global state; multiple `groupcache.Instance` objects can exist
- Each instance is self-contained with its own groups, picker, and options

#### Pluggable Transport Layer
- Separated `transport.Transport` interface
- Custom third-party transports possible
- No need to access library internals
- Default HTTP transport still provided

#### Pluggable Cache Implementations
- `Cache` interface allows custom cache implementations
- Ships with optional Otter cache support (high-performance lockless cache)
- Factory pattern via `Options.CacheFactory`

#### TLS Support
- Full TLS support in HTTP transport via `HttpTransportOptions.Client`

#### OpenTelemetry Integration (v3.3.0+)
- Tracing instrumentation via `transport.Tracer`
- Metrics via `MeterProvider` integration
- Group-level metrics export
- HTTP transport instrumented with `otelhttp`

#### Optimized Consistent Hash Picker (v3.4.0)
- Performance optimization eliminating map lookup
- Improved key distribution efficiency

### Architecture Changes

```go
// Original (global)
groupcache.NewGroup("name", size, getter)

// v3 (instance-based)
instance := groupcache.New(groupcache.Options{...})
group := instance.NewGroup("name", size, getter)
```

### Version History

| Version | Key Changes |
|---------|-------------|
| v3.4.0 | Batch `RemoveKeys()`, consistent hash optimization |
| v3.3.0 | OpenTelemetry instrumentation |
| v3.2.0 | TLS support, hot cache fix |
| v3.0.0 | Major refactor: no global state, transport abstraction, pluggable caches |

---

## 4. udhos/kubegroup (Kubernetes Integration)

**Repository:** https://github.com/udhos/kubegroup

### Overview

kubegroup provides automatic peer discovery for groupcache pods running in Kubernetes clusters. Supports both groupcache2 (mailgun) and groupcache3.

### Kubernetes Integration

- Uses official `k8s.io/client-go/kubernetes` clientset
- Leverages `github.com/udhos/kubepodinformer/podinformer` for pod watching
- Automatically discovers namespace from service account mount
- Label-based discovery (e.g., `app=miniapi`)

### Peer Discovery Mechanism

1. **Self-Discovery**: Pod finds its own IP via `FindMyAddress()` using `net.LookupHost()`
2. **Namespace Detection**: Reads from `/var/run/secrets/kubernetes.io/serviceaccount/namespace`
3. **Pod Watch**: Creates informer watching pods matching `LabelSelector`
4. **Ready State Filtering**: Only includes pods in `Ready` state
5. **Continuous Updates**: `onUpdate()` callback triggered on pod changes

### Configuration Options

| Option | Description |
|--------|-------------|
| `Pool` | For groupcache2: `*groupcache.HTTPPool` |
| `Peers` | For groupcache3: `*groupcache.Daemon` |
| `Client` | Kubernetes clientset (required) |
| `GroupCachePort` | Groupcache listening port (required) |
| `LabelSelector` | Pod label selector (required) |
| `Debug` | Enable debug logging |

### Metrics

- `kubegroup_peers` (Gauge): Number of peer PODs discovered
- `kubegroup_events` (Counter): Number of events received

Supports Prometheus, Dogstatsd, and AWS CloudWatch EMF.

### Required RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
```

### Pod Scaling Handling

- Watch-based updates via Kubernetes watch API
- New pods automatically added when `Ready`
- Terminated pods automatically removed
- Self-identification (`isSelf` flag) prevents routing to self

---

## JavaScript Ecosystem Gap Analysis

### What Exists

| Category | Libraries |
|----------|-----------|
| Local/In-Process | lru-cache, node-cache, @cacheable/node-cache |
| Multi-Tier/Abstraction | BentoCache, cache-manager, keyv |
| External Cache Clients | ioredis, node-redis, memjs |
| Distributed (Require Servers) | Hazelcast client, Apache Ignite client |
| Singleflight | node-singleflight, @onestone/singleflight, DataLoader |
| Supporting | node-hashring (consistent hashing) |

### The Gap

| Feature | Groupcache (Go) | JS Ecosystem |
|---------|-----------------|--------------|
| Embedded distributed cache | Yes | **NO** |
| Peer-to-peer without external service | Yes | **NO** |
| Automatic key ownership via consistent hashing | Yes | Manual/partial |
| Built-in singleflight | Yes | Separate libraries |
| Hot key replication | Yes | **NO** |
| Read-through cache | Yes | Some (BentoCache) |
| Zero-config clustering | Yes | **NO** |

### Why This Matters

- **Eliminates infrastructure dependency**: No Redis/Memcached servers
- **Reduces operational complexity**: No separate cache layer to manage
- **Lower latency**: No network hop to external cache
- **Cost reduction**: No separate cache servers
- **Natural scaling**: Scales with application instances

---

## Design Decisions for groupcache-js

Based on this research, groupcache-js will:

1. **Follow groupcache-go v3 architecture**: Multiple instances, pluggable transport/cache
2. **Include Mailgun's additions**: TTL, removal, explicit set
3. **Build-in K8s discovery**: Unlike Go versions that need kubegroup
4. **Add JS-specific features**: TypeScript, compression, worker threads
5. **Support multiple transports**: HTTP, HTTP/2, gRPC from the start
6. **Native OpenTelemetry**: First-class observability
