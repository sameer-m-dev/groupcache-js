/**
 * groupcache-js - Distributed caching library for Node.js/TypeScript
 *
 * @packageDocumentation
 */

// Main entry point
export { GroupCache, type GroupCacheOptions } from './groupcache.js';

// Group (cache namespace)
export {
  Group,
  type GroupOptions,
  type Serializer,
  jsonSerializer,
} from './group.js';

// Types
export {
  type Context,
  type CacheEntry,
  type SetOptions,
  type Getter,
  type GetterResult,
  type GetterWithMeta,
  type PeerInfo,
  type GroupStats,
  type InstanceStats,
  type HealthStatus,
  type Logger,
  type HashFunction,
  type CacheBackend,
  withTimeout,
  withSignal,
  parseSize,
  noopLogger,
  consoleLogger,
} from './types.js';

// Cache implementations
export { LRUCache, type LRUCacheOptions } from './cache/lru.js';
export { LFUCache, type LFUCacheOptions } from './cache/lfu.js';
export { ARCCache, type ARCCacheOptions } from './cache/arc.js';

// Consistent hashing
export {
  ConsistentHash,
  type ConsistentHashOptions,
  fnv1aHash,
} from './hash/consistent.js';

// Singleflight
export {
  Singleflight,
  type SingleflightResult,
  globalSingleflight,
} from './singleflight/singleflight.js';

// Transport
export {
  type Transport,
  type TransportHandler,
  type TransportListenOptions,
  type GetRequest,
  type GetResponse,
  type SetRequest,
  type RemoveRequest,
  type RemoveManyRequest,
  TransportError,
  NotFoundError,
} from './transport/interface.js';

export { HttpTransport, type HttpTransportOptions } from './transport/http.js';

export { Http2Transport, type Http2TransportOptions } from './transport/http2.js';

// GrpcTransport requires optional dependencies: @grpc/grpc-js and @grpc/proto-loader
export { GrpcTransport, type GrpcTransportOptions, type GrpcTlsOptions } from './transport/grpc.js';

// Discovery
export {
  type PeerDiscovery,
  BasePeerDiscovery,
} from './discovery/interface.js';

export {
  StaticPeerDiscovery,
  type StaticPeerDiscoveryOptions,
} from './discovery/static.js';

export {
  KubernetesPeerDiscovery,
  type KubernetesPeerDiscoveryOptions,
  getPodIP,
  getCurrentNamespace,
} from './discovery/kubernetes.js';

export {
  DnsSrvPeerDiscovery,
  type DnsSrvPeerDiscoveryOptions,
} from './discovery/dns.js';

// Telemetry
export {
  type Meter,
  type MetricOptions,
  type Counter,
  type Histogram,
  type ObservableGauge,
  type ObservableResult,
  type GroupCacheMetrics,
  type MetricsOptions,
  type ObservableCallback,
  createMetrics,
  noopMetrics,
  withTiming,
} from './telemetry/metrics.js';

export {
  SpanKind,
  SpanStatusCode,
  type SpanKindType,
  type SpanStatusCodeType,
  type Span,
  type Tracer,
  type SpanOptions,
  GroupCacheTracer,
  noopTracer,
} from './telemetry/tracing.js';

// Serialization
export {
  type Serializer as SerializerInterface,
  type SerializerType,
  type MsgPackOptions,
  jsonSerializer as jsonSerializerImpl,
  createJsonSerializer,
  createMsgPackSerializer,
  binarySerializer,
  stringSerializer,
  createCompressedSerializer,
  getSerializer,
} from './serialization/index.js';

// Framework integrations
export {
  createExpressMiddleware,
  createCacheMiddleware,
  type ExpressMiddlewareOptions,
  type ExpressRequest,
  type ExpressResponse,
  type ExpressNextFunction,
} from './integrations/express.js';

export {
  fastifyGroupCache,
  createCachedHandler,
  type FastifyGroupCacheOptions,
  type FastifyRequest,
  type FastifyReply,
  type FastifyInstance,
} from './integrations/fastify.js';

// Worker Thread Support
export {
  WorkerPool,
  type WorkerPoolOptions,
  type WorkerPoolStats,
  type WorkerStats,
  type WorkerTaskType,
  type WorkerTask,
  type WorkerResult,
  type WorkerResultSuccess,
  type WorkerResultError,
} from './workers/index.js';
