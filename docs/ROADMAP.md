# groupcache-js Roadmap

## Version Planning

### v0.1.0 - Core (MVP)

**Target:** Foundation that proves the concept works

- [ ] **Cache Module**
  - [ ] LRU cache implementation with size limits
  - [ ] TTL support with lazy expiration
  - [ ] Eviction callbacks
  - [ ] Memory size tracking

- [ ] **Consistent Hashing**
  - [ ] Hash ring with virtual nodes
  - [ ] Add/remove peers dynamically
  - [ ] Configurable hash function (default: xxhash)
  - [ ] Get N nearest peers for replication

- [ ] **Singleflight**
  - [ ] Request deduplication
  - [ ] Promise-based waiting
  - [ ] Timeout support
  - [ ] Error propagation

- [ ] **Group Abstraction**
  - [ ] Named cache namespaces
  - [ ] Getter function support
  - [ ] Dual cache (main + hot)
  - [ ] Basic statistics

- [ ] **HTTP Transport**
  - [ ] Server implementation
  - [ ] Client implementation
  - [ ] Protocol: GET/PUT/DELETE
  - [ ] Error handling

- [ ] **Static Peer Discovery**
  - [ ] Manual peer configuration
  - [ ] Peer health checking
  - [ ] Self-identification

- [ ] **Basic Stats**
  - [ ] Gets, hits, misses
  - [ ] Cache size, item count
  - [ ] Load counts

**Deliverables:**
- Working distributed cache
- Example application
- Basic documentation
- Unit tests (>80% coverage)

---

### v0.2.0 - Production Ready

**Target:** Deployable in production environments

- [ ] **TTL Enhancements**
  - [ ] Absolute expiration (expireAt)
  - [ ] Sliding expiration (refreshOnAccess)
  - [ ] Background cleanup task
  - [ ] Clock skew handling

- [ ] **Key Operations**
  - [ ] Single key removal
  - [ ] Batch removal
  - [ ] Cluster-wide propagation
  - [ ] Pattern-based removal (optional)

- [ ] **Kubernetes Discovery**
  - [ ] Pod watcher using @kubernetes/client-node
  - [ ] Label selector filtering
  - [ ] Ready state filtering
  - [ ] Namespace awareness
  - [ ] Auto-configuration from environment

- [ ] **OpenTelemetry Integration**
  - [ ] Tracing (spans for get, load, peer fetch)
  - [ ] Metrics (counters, gauges, histograms)
  - [ ] Context propagation
  - [ ] Configurable exporters

- [ ] **Graceful Shutdown**
  - [ ] SIGTERM/SIGINT handling
  - [ ] Peer notification before exit
  - [ ] In-flight request completion
  - [ ] Configurable timeout

- [ ] **Health Checks**
  - [ ] Self health status
  - [ ] Peer health status
  - [ ] Cache utilization
  - [ ] HTTP endpoint

**Deliverables:**
- Kubernetes deployment example
- Helm chart (optional)
- Grafana dashboard
- Performance benchmarks
- Production deployment guide

---

### v0.3.0 - Advanced Features

**Target:** Enterprise-grade capabilities

- [ ] **HTTP/2 Transport**
  - [ ] Multiplexed connections
  - [ ] Connection pooling
  - [ ] Stream management
  - [ ] Performance comparison

- [ ] **gRPC Transport**
  - [ ] Protocol buffer definitions
  - [ ] Streaming support
  - [ ] TLS/mTLS
  - [ ] Polyglot compatibility

- [ ] **Multiple Serializers**
  - [ ] JSON (default, human-readable)
  - [ ] MessagePack (fast, compact)
  - [ ] Protocol Buffers (schema-based)
  - [ ] Custom serializer interface

- [ ] **Compression**
  - [ ] gzip (widely compatible)
  - [ ] Brotli (better ratio)
  - [ ] LZ4 (fastest)
  - [ ] Threshold-based activation

- [ ] **DNS SRV Discovery**
  - [ ] SRV record lookup
  - [ ] Automatic refresh
  - [ ] Priority/weight handling
  - [ ] Failover support

- [ ] **Consul Discovery**
  - [ ] Service catalog integration
  - [ ] Health check awareness
  - [ ] Tag filtering
  - [ ] Datacenter support

- [ ] **Alternative Cache Backends**
  - [ ] LFU (Least Frequently Used)
  - [ ] ARC (Adaptive Replacement Cache)
  - [ ] Custom backend interface

**Deliverables:**
- Transport comparison benchmarks
- Service mesh integration guide
- Multi-datacenter example

---

### v1.0.0 - Stable Release

**Target:** Production-stable, fully documented

- [ ] **Framework Integrations**
  - [ ] Express middleware
  - [ ] Fastify plugin
  - [ ] NestJS module
  - [ ] Koa middleware
  - [ ] tRPC middleware

- [ ] **Worker Thread Support**
  - [ ] Worker pool management
  - [ ] CPU-intensive operation offloading
  - [ ] Configurable worker count
  - [ ] Error handling

- [ ] **Redis-like API Layer**
  - [ ] get/set/del
  - [ ] mget/mset
  - [ ] expire/ttl
  - [ ] Familiar interface

- [ ] **Full Test Coverage**
  - [ ] Unit tests (>90%)
  - [ ] Integration tests
  - [ ] Chaos testing
  - [ ] Load testing

- [ ] **Documentation Site**
  - [ ] Getting started guide
  - [ ] API reference
  - [ ] Architecture deep-dive
  - [ ] Deployment guides
  - [ ] Troubleshooting

- [ ] **Performance Benchmarks**
  - [ ] Single node throughput
  - [ ] Multi-node latency
  - [ ] Memory efficiency
  - [ ] Comparison with alternatives

**Deliverables:**
- Stable API (semver guaranteed)
- Documentation website
- Video tutorials
- Community examples

---

## Future Ideas (Post v1.0)

### v1.1.0 - Enhanced Replication
- [ ] Write-through caching
- [ ] Configurable replication factor
- [ ] Quorum reads/writes

### v1.2.0 - Persistence
- [ ] Disk-backed cache option
- [ ] Snapshot/restore
- [ ] WAL for durability

### v1.3.0 - Security
- [ ] Authentication between peers
- [ ] Encryption at rest
- [ ] Audit logging

### v1.4.0 - Multi-Region
- [ ] Cross-datacenter replication
- [ ] Region-aware routing
- [ ] Conflict resolution

### v2.0.0 - Next Generation
- [ ] WebSocket transport
- [ ] Browser client (service worker)
- [ ] Edge deployment support

---

## Release Principles

1. **Semantic Versioning:** Strict adherence to semver after v1.0
2. **Backward Compatibility:** No breaking changes in minor versions
3. **Deprecation Policy:** 2 minor versions warning before removal
4. **LTS Releases:** v1.x LTS for 2 years after v2.0 release

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Development setup
- Code style guide
- Pull request process
- Issue templates
