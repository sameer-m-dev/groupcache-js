/**
 * gRPC Transport Implementation
 *
 * Provides gRPC-based peer-to-peer communication for groupcache.
 * Benefits:
 *   - Efficient binary protocol (Protocol Buffers)
 *   - HTTP/2 multiplexing under the hood
 *   - Strong typing with proto definitions
 *   - TLS support
 *   - Connection pooling and keepalive
 *
 * Note: Requires @grpc/grpc-js and @grpc/proto-loader packages.
 * These are optional dependencies - install them with:
 *   npm install @grpc/grpc-js @grpc/proto-loader
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../types.js';

/**
 * Embedded proto definition for groupcache gRPC service
 */
const PROTO_CONTENT = `syntax = "proto3";

package groupcache;

// GroupCache service for peer-to-peer cache operations
service GroupCache {
  // Get retrieves a value from the cache
  rpc Get(GetRequest) returns (GetResponse);

  // Set stores a value in the cache
  rpc Set(SetRequest) returns (SetResponse);

  // Remove deletes a key from the cache
  rpc Remove(RemoveRequest) returns (RemoveResponse);

  // RemoveMany deletes multiple keys from the cache
  rpc RemoveMany(RemoveManyRequest) returns (RemoveManyResponse);
}

// GetRequest is the request message for Get RPC
message GetRequest {
  string group = 1;
  string key = 2;
}

// GetResponse is the response message for Get RPC
message GetResponse {
  bytes value = 1;
  // Optional expiration timestamp in milliseconds since epoch
  optional int64 expires_at = 2;
  // Whether this was a cache hit on the peer
  optional bool hit = 3;
}

// SetRequest is the request message for Set RPC
message SetRequest {
  string group = 1;
  string key = 2;
  bytes value = 3;
  // Optional TTL in milliseconds
  optional int64 ttl = 4;
}

// SetResponse is the response message for Set RPC
message SetResponse {
  // Empty - success indicated by lack of error
}

// RemoveRequest is the request message for Remove RPC
message RemoveRequest {
  string group = 1;
  string key = 2;
}

// RemoveResponse is the response message for Remove RPC
message RemoveResponse {
  // Empty - success indicated by lack of error
}

// RemoveManyRequest is the request message for RemoveMany RPC
message RemoveManyRequest {
  string group = 1;
  repeated string keys = 2;
}

// RemoveManyResponse is the response message for RemoveMany RPC
message RemoveManyResponse {
  // Empty - success indicated by lack of error
}
`;
import type {
  Transport,
  TransportHandler,
  TransportListenOptions,
  GetRequest,
  GetResponse,
  SetRequest,
  RemoveRequest,
  RemoveManyRequest,
} from './interface.js';
import { TransportError, NotFoundError } from './interface.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProtoLoaderModule = any;

// Lazy-loaded gRPC modules
let grpc: GrpcModule | undefined;
let protoLoader: ProtoLoaderModule | undefined;

/**
 * Lazily load gRPC dependencies
 */
async function loadGrpcModules(): Promise<{
  grpc: GrpcModule;
  protoLoader: ProtoLoaderModule;
}> {
  if (grpc && protoLoader) {
    return { grpc, protoLoader };
  }

  try {
    // Use string variables to prevent TypeScript from trying to resolve these modules
    const grpcJsModule = '@grpc/grpc-js';
    const protoLoaderModule = '@grpc/proto-loader';
    grpc = await import(/* webpackIgnore: true */ grpcJsModule);
    protoLoader = await import(/* webpackIgnore: true */ protoLoaderModule);
    return { grpc, protoLoader };
  } catch (error) {
    throw new Error(
      'gRPC dependencies not installed. Please install them with:\n' +
        '  npm install @grpc/grpc-js @grpc/proto-loader\n\n' +
        'Original error: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Options for gRPC transport
 */
export interface GrpcTransportOptions {
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Maximum message size in bytes (default: 4MB) */
  maxMessageSize?: number;
  /** TLS credentials for secure connections */
  tls?: GrpcTlsOptions;
  /** Connection keepalive time in milliseconds (default: 10000) */
  keepaliveTimeMs?: number;
  /** Connection keepalive timeout in milliseconds (default: 5000) */
  keepaliveTimeoutMs?: number;
  /** Maximum number of connection retries (default: 3) */
  maxRetries?: number;
}

/**
 * TLS options for gRPC
 */
export interface GrpcTlsOptions {
  /** Root CA certificate (PEM) */
  rootCerts?: Buffer;
  /** Private key (PEM) */
  privateKey?: Buffer;
  /** Certificate chain (PEM) */
  certChain?: Buffer;
}

/**
 * gRPC client connection entry
 */
interface ClientEntry {
  client: GrpcServiceClient;
  lastUsed: number;
}

/**
 * Type definitions for proto-loaded gRPC service
 */
interface GrpcServiceClient {
  Get: (
    request: { group: string; key: string },
    callback: (
      error: Error | null,
      response?: { value: Buffer; expiresAt?: number | bigint; hit?: boolean },
    ) => void,
  ) => { cancel: () => void };
  Set: (
    request: { group: string; key: string; value: Buffer; ttl?: number | bigint },
    callback: (error: Error | null, response?: object) => void,
  ) => { cancel: () => void };
  Remove: (
    request: { group: string; key: string },
    callback: (error: Error | null, response?: object) => void,
  ) => { cancel: () => void };
  RemoveMany: (
    request: { group: string; keys: string[] },
    callback: (error: Error | null, response?: object) => void,
  ) => { cancel: () => void };
  close: () => void;
  getChannel: () => { getConnectivityState: (tryToConnect: boolean) => number };
}

interface GrpcServiceDefinition {
  service: object;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcCredentials = any;

interface GrpcPackageDefinition {
  groupcache: {
    GroupCache: GrpcServiceDefinition & {
      new (address: string, credentials: GrpcCredentials, options?: object): GrpcServiceClient;
    };
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcServer = any;

/**
 * gRPC Transport for peer communication
 *
 * Provides efficient binary communication using Protocol Buffers and gRPC.
 * Maintains a pool of client connections to peers for connection reuse.
 */
export class GrpcTransport implements Transport {
  private server: GrpcServer | null = null;
  private readonly timeout: number;
  private readonly maxMessageSize: number;
  private readonly tls: GrpcTlsOptions | undefined;
  private readonly keepaliveTimeMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly clients: Map<string, ClientEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private _listenAddress: string | undefined;
  private protoDefinition: GrpcPackageDefinition | null = null;
  private grpcModule: GrpcModule | null = null;

  constructor(options: GrpcTransportOptions = {}) {
    this.timeout = options.timeout ?? 5000;
    this.maxMessageSize = options.maxMessageSize ?? 4 * 1024 * 1024; // 4MB
    this.tls = options.tls;
    this.keepaliveTimeMs = options.keepaliveTimeMs ?? 10000;
    this.keepaliveTimeoutMs = options.keepaliveTimeoutMs ?? 5000;
  }

  get listenAddress(): string | undefined {
    return this._listenAddress;
  }

  /**
   * Load proto definition lazily
   */
  private async loadProto(): Promise<GrpcPackageDefinition> {
    if (this.protoDefinition && this.grpcModule) {
      return this.protoDefinition;
    }

    const { grpc: grpcMod, protoLoader: protoLoaderMod } = await loadGrpcModules();
    this.grpcModule = grpcMod;

    // Write proto content to a temp file since proto-loader requires a file path
    const tempDir = os.tmpdir();
    const protoPath = path.join(tempDir, `groupcache-${process.pid}.proto`);

    // Write the embedded proto content to temp file
    fs.writeFileSync(protoPath, PROTO_CONTENT);

    try {
      const packageDefinition = await protoLoaderMod.load(protoPath, {
        keepCase: false,
        longs: Number,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      this.protoDefinition = grpcMod.loadPackageDefinition(
        packageDefinition,
      ) as unknown as GrpcPackageDefinition;
      return this.protoDefinition;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(protoPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async listen(
    port: number,
    handler: TransportHandler,
    options: TransportListenOptions = {},
  ): Promise<void> {
    const proto = await this.loadProto();
    const grpcMod = this.grpcModule!;

    return new Promise((resolve, reject) => {
      const server = new grpcMod.Server({
        'grpc.max_receive_message_length': this.maxMessageSize,
        'grpc.max_send_message_length': this.maxMessageSize,
      });

      // Add service implementation
      server.addService(proto.groupcache.GroupCache.service, {
        Get: this.createGetHandler(handler),
        Set: this.createSetHandler(handler),
        Remove: this.createRemoveHandler(handler),
        RemoveMany: this.createRemoveManyHandler(handler),
      });

      const host = options.host ?? '0.0.0.0';
      const bindAddress = `${host}:${port}`;

      // Create server credentials
      const credentials = this.tls
        ? grpcMod.ServerCredentials.createSsl(
            this.tls.rootCerts ?? null,
            this.tls.privateKey && this.tls.certChain
              ? [{ private_key: this.tls.privateKey, cert_chain: this.tls.certChain }]
              : [],
            false,
          )
        : grpcMod.ServerCredentials.createInsecure();

      server.bindAsync(
        bindAddress,
        credentials,
        (err: Error | null, boundPort: number) => {
          if (err) {
            reject(err);
            return;
          }

          this.server = server;
          this._listenAddress = `grpc://${host}:${boundPort}`;

          // Start cleanup interval for idle connections
          this.cleanupInterval = setInterval(
            () => {
              this.cleanupClients();
            },
            this.keepaliveTimeMs * 2,
          );

          // Handle abort signal
          if (options.signal) {
            options.signal.addEventListener('abort', () => {
              this.close().catch(() => {});
            });
          }

          resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close all client connections
    for (const [_peer, entry] of this.clients) {
      entry.client.close();
    }
    this.clients.clear();

    // Shutdown server
    return new Promise((resolve) => {
      if (!this.server) {
        this._listenAddress = undefined;
        resolve();
        return;
      }

      this.server.tryShutdown((err: Error | null) => {
        if (err) {
          // Force shutdown if graceful shutdown fails
          this.server?.forceShutdown();
        }
        this.server = null;
        this._listenAddress = undefined;
        resolve();
      });
    });
  }

  async get(ctx: Context, peer: string, req: GetRequest): Promise<GetResponse> {
    const client = await this.getClient(peer);

    return new Promise((resolve, reject) => {
      const call = client.Get({ group: req.group, key: req.key }, (error, response) => {
        if (error) {
          if (this.isNotFoundError(error)) {
            reject(new NotFoundError(req.group, req.key));
          } else {
            reject(
              new TransportError(error.message, peer, 'get', this.grpcStatusToHttp(error), error),
            );
          }
          return;
        }

        if (!response) {
          reject(new TransportError('Empty response', peer, 'get'));
          return;
        }

        const result: GetResponse = {
          value: Buffer.from(response.value),
        };

        if (response.expiresAt !== undefined && response.expiresAt !== 0) {
          result.expiresAt = Number(response.expiresAt);
        }

        if (response.hit !== undefined) {
          result.hit = response.hit;
        }

        resolve(result);
      });

      // Handle timeout and abort
      this.setupCallHandlers(ctx, call, reject);
    });
  }

  async set(ctx: Context, peer: string, req: SetRequest): Promise<void> {
    const client = await this.getClient(peer);

    return new Promise((resolve, reject) => {
      const request: { group: string; key: string; value: Buffer; ttl?: number } = {
        group: req.group,
        key: req.key,
        value: req.value,
      };

      if (req.ttl !== undefined) {
        request.ttl = req.ttl;
      }

      const call = client.Set(request, (error) => {
        if (error) {
          reject(
            new TransportError(error.message, peer, 'set', this.grpcStatusToHttp(error), error),
          );
          return;
        }
        resolve();
      });

      this.setupCallHandlers(ctx, call, reject);
    });
  }

  async remove(ctx: Context, peer: string, req: RemoveRequest): Promise<void> {
    const client = await this.getClient(peer);

    return new Promise((resolve, reject) => {
      const call = client.Remove({ group: req.group, key: req.key }, (error) => {
        if (error && !this.isNotFoundError(error)) {
          reject(
            new TransportError(error.message, peer, 'remove', this.grpcStatusToHttp(error), error),
          );
          return;
        }
        resolve();
      });

      this.setupCallHandlers(ctx, call, reject);
    });
  }

  async removeMany(ctx: Context, peer: string, req: RemoveManyRequest): Promise<void> {
    const client = await this.getClient(peer);

    return new Promise((resolve, reject) => {
      const call = client.RemoveMany({ group: req.group, keys: req.keys }, (error) => {
        if (error) {
          reject(
            new TransportError(
              error.message,
              peer,
              'removeMany',
              this.grpcStatusToHttp(error),
              error,
            ),
          );
          return;
        }
        resolve();
      });

      this.setupCallHandlers(ctx, call, reject);
    });
  }

  /**
   * Create gRPC handler for Get operation
   */
  private createGetHandler(handler: TransportHandler) {
    const grpcMod = this.grpcModule!;

    return async (
      call: { request: { group: string; key: string } },
      callback: (
        error: { code: number; message: string } | null,
        response?: { value: Buffer; expiresAt?: number; hit?: boolean },
      ) => void,
    ) => {
      const ctx: Context = {};

      try {
        const response = await handler.handleGet(ctx, {
          group: call.request.group,
          key: call.request.key,
        });

        const result: { value: Buffer; expiresAt?: number; hit?: boolean } = {
          value: response.value,
        };

        if (response.expiresAt !== undefined) {
          result.expiresAt = response.expiresAt;
        }

        if (response.hit !== undefined) {
          result.hit = response.hit;
        }

        callback(null, result);
      } catch (error) {
        if (error instanceof NotFoundError) {
          callback({
            code: grpcMod.status.NOT_FOUND,
            message: `Key not found: ${call.request.group}/${call.request.key}`,
          });
        } else {
          callback({
            code: grpcMod.status.INTERNAL,
            message: error instanceof Error ? error.message : 'Internal error',
          });
        }
      }
    };
  }

  /**
   * Create gRPC handler for Set operation
   */
  private createSetHandler(handler: TransportHandler) {
    const grpcMod = this.grpcModule!;

    return async (
      call: { request: { group: string; key: string; value: Buffer; ttl?: number | bigint } },
      callback: (error: { code: number; message: string } | null, response?: object) => void,
    ) => {
      const ctx: Context = {};

      try {
        await handler.handleSet(ctx, {
          group: call.request.group,
          key: call.request.key,
          value: Buffer.from(call.request.value),
          ttl: call.request.ttl !== undefined ? Number(call.request.ttl) : undefined,
        });

        callback(null, {});
      } catch (error) {
        callback({
          code: grpcMod.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Internal error',
        });
      }
    };
  }

  /**
   * Create gRPC handler for Remove operation
   */
  private createRemoveHandler(handler: TransportHandler) {
    const grpcMod = this.grpcModule!;

    return async (
      call: { request: { group: string; key: string } },
      callback: (error: { code: number; message: string } | null, response?: object) => void,
    ) => {
      const ctx: Context = {};

      try {
        await handler.handleRemove(ctx, {
          group: call.request.group,
          key: call.request.key,
        });

        callback(null, {});
      } catch (error) {
        callback({
          code: grpcMod.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Internal error',
        });
      }
    };
  }

  /**
   * Create gRPC handler for RemoveMany operation
   */
  private createRemoveManyHandler(handler: TransportHandler) {
    const grpcMod = this.grpcModule!;

    return async (
      call: { request: { group: string; keys: string[] } },
      callback: (error: { code: number; message: string } | null, response?: object) => void,
    ) => {
      const ctx: Context = {};

      try {
        await handler.handleRemoveMany(ctx, {
          group: call.request.group,
          keys: call.request.keys,
        });

        callback(null, {});
      } catch (error) {
        callback({
          code: grpcMod.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Internal error',
        });
      }
    };
  }

  /**
   * Get or create a client for a peer
   */
  private async getClient(peer: string): Promise<GrpcServiceClient> {
    // Check for existing client
    const existing = this.clients.get(peer);
    if (existing) {
      // Check if the client is still connected
      const channel = existing.client.getChannel();
      const state = channel.getConnectivityState(false);
      // IDLE=0, CONNECTING=1, READY=2, TRANSIENT_FAILURE=3, SHUTDOWN=4
      if (state !== 4) {
        // Not SHUTDOWN
        existing.lastUsed = Date.now();
        return existing.client;
      }
      // Client is shutdown, remove it
      existing.client.close();
      this.clients.delete(peer);
    }

    // Create new client
    const proto = await this.loadProto();
    const grpcMod = this.grpcModule!;

    // Parse peer address
    const peerUrl = new URL(peer);
    const address = `${peerUrl.hostname}:${peerUrl.port || 50051}`;

    // Create credentials
    const credentials = this.tls
      ? grpcMod.credentials.createSsl(this.tls.rootCerts, this.tls.privateKey, this.tls.certChain)
      : grpcMod.credentials.createInsecure();

    // Create client with options
    const client = new proto.groupcache.GroupCache(address, credentials, {
      'grpc.max_receive_message_length': this.maxMessageSize,
      'grpc.max_send_message_length': this.maxMessageSize,
      'grpc.keepalive_time_ms': this.keepaliveTimeMs,
      'grpc.keepalive_timeout_ms': this.keepaliveTimeoutMs,
    });

    this.clients.set(peer, {
      client,
      lastUsed: Date.now(),
    });

    return client;
  }

  /**
   * Setup timeout and abort handlers for a call
   */
  private setupCallHandlers(
    ctx: Context,
    call: { cancel: () => void },
    reject: (error: Error) => void,
  ): void {
    // Setup timeout
    const timeoutId = setTimeout(() => {
      call.cancel();
      reject(new Error('Request timeout'));
    }, this.timeout);

    // Clear timeout on completion (we need to track this differently)
    // The callback will be called, so we clear it there
    const originalCancel = call.cancel.bind(call);
    call.cancel = () => {
      clearTimeout(timeoutId);
      originalCancel();
    };

    // Handle abort signal
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        clearTimeout(timeoutId);
        call.cancel();
        reject(new Error('Request aborted'));
        return;
      }

      const abortHandler = () => {
        clearTimeout(timeoutId);
        call.cancel();
        reject(new Error('Request aborted'));
      };

      ctx.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  /**
   * Check if a gRPC error is a NOT_FOUND error
   */
  private isNotFoundError(error: Error & { code?: number }): boolean {
    // gRPC status NOT_FOUND = 5
    return error.code === 5;
  }

  /**
   * Convert gRPC status to HTTP status code
   */
  private grpcStatusToHttp(error: Error & { code?: number }): number {
    const grpcToHttp: Record<number, number> = {
      0: 200, // OK
      1: 499, // CANCELLED
      2: 500, // UNKNOWN
      3: 400, // INVALID_ARGUMENT
      4: 504, // DEADLINE_EXCEEDED
      5: 404, // NOT_FOUND
      6: 409, // ALREADY_EXISTS
      7: 403, // PERMISSION_DENIED
      8: 429, // RESOURCE_EXHAUSTED
      9: 400, // FAILED_PRECONDITION
      10: 409, // ABORTED
      11: 400, // OUT_OF_RANGE
      12: 501, // UNIMPLEMENTED
      13: 500, // INTERNAL
      14: 503, // UNAVAILABLE
      15: 500, // DATA_LOSS
      16: 401, // UNAUTHENTICATED
    };

    return grpcToHttp[error.code ?? 2] ?? 500;
  }

  /**
   * Clean up idle clients
   */
  private cleanupClients(): void {
    const now = Date.now();
    const idleTimeout = this.keepaliveTimeMs * 6; // 6x keepalive time

    for (const [peer, entry] of this.clients) {
      if (now - entry.lastUsed > idleTimeout) {
        entry.client.close();
        this.clients.delete(peer);
      }
    }
  }
}
