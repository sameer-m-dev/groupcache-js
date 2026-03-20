# groupcache-js Documentation

Welcome to the groupcache-js documentation. This directory contains all the design documents, research, and specifications for the project.

## Documents

| Document | Description |
|----------|-------------|
| [PRD.md](./PRD.md) | Product Requirements Document - Full feature specification |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture and component design |
| [COMPARISON.md](./COMPARISON.md) | Comparison with Go implementations |
| [ROADMAP.md](./ROADMAP.md) | Development roadmap and version planning |
| [RESEARCH.md](./RESEARCH.md) | Research notes on Go groupcache implementations |

## Quick Links

### Understanding the Concept

- **What is groupcache?** A distributed caching library where your application instances ARE the cache layer. No external Redis or Memcached needed.

- **Why for JavaScript?** The Go ecosystem has several mature implementations, but JavaScript/Node.js has nothing equivalent. This fills that gap.

### Key Concepts

1. **Group**: A named cache namespace with its own getter function
2. **Singleflight**: Deduplicates concurrent requests for the same key
3. **Consistent Hashing**: Determines which peer owns each key
4. **Hot Cache**: Replicates frequently accessed keys locally
5. **Transport**: Pluggable network layer (HTTP, gRPC)
6. **Discovery**: Automatic peer detection (K8s, DNS, Consul)

### Getting Started

```typescript
import { GroupCache, HttpTransport } from 'groupcache-js';

const cache = new GroupCache({
  self: 'http://localhost:8080',
  transport: new HttpTransport({ port: 8080 }),
});

const users = cache.newGroup<User>({
  name: 'users',
  maxSize: '64MB',
  getter: async (ctx, key) => {
    return await db.users.findById(key);
  },
});

// Distributed cache get - automatically routes to correct peer
const user = await users.get('user:123');
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.
