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
} from './interface.js';

export { HttpTransport, type HttpTransportOptions } from './http.js';

export { Http2Transport, type Http2TransportOptions } from './http2.js';

// GrpcTransport requires optional dependencies: @grpc/grpc-js and @grpc/proto-loader
// The types are always exported, but using GrpcTransport without the dependencies will throw at runtime
export { GrpcTransport, type GrpcTransportOptions, type GrpcTlsOptions } from './grpc.js';
