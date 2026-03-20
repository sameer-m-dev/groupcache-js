/**
 * Transport Layer Interfaces
 *
 * Defines the contract for peer-to-peer communication.
 * Implementations include HTTP, HTTP/2, and gRPC.
 */

import type { Context } from '../types.js';

/**
 * Request to get a value from a peer
 */
export interface GetRequest {
  group: string;
  key: string;
}

/**
 * Response from a get request
 */
export interface GetResponse {
  value: Buffer;
  expiresAt?: number | undefined;
  /** Whether this was a cache hit on the peer */
  hit?: boolean | undefined;
}

/**
 * Request to set a value on a peer
 */
export interface SetRequest {
  group: string;
  key: string;
  value: Buffer;
  ttl?: number | undefined;
}

/**
 * Request to remove a key from a peer
 */
export interface RemoveRequest {
  group: string;
  key: string;
}

/**
 * Request to remove multiple keys from a peer
 */
export interface RemoveManyRequest {
  group: string;
  keys: string[];
}

/**
 * Handler for incoming requests from peers
 */
export interface TransportHandler {
  handleGet(ctx: Context, req: GetRequest): Promise<GetResponse>;
  handleSet(ctx: Context, req: SetRequest): Promise<void>;
  handleRemove(ctx: Context, req: RemoveRequest): Promise<void>;
  handleRemoveMany(ctx: Context, req: RemoveManyRequest): Promise<void>;
}

/**
 * Options for transport listen
 */
export interface TransportListenOptions {
  host?: string;
  signal?: AbortSignal;
}

/**
 * Transport interface for peer communication
 */
export interface Transport {
  /**
   * Start listening for incoming requests
   */
  listen(port: number, handler: TransportHandler, options?: TransportListenOptions): Promise<void>;

  /**
   * Stop listening and close all connections
   */
  close(): Promise<void>;

  /**
   * Get a value from a peer
   */
  get(ctx: Context, peer: string, req: GetRequest): Promise<GetResponse>;

  /**
   * Set a value on a peer
   */
  set(ctx: Context, peer: string, req: SetRequest): Promise<void>;

  /**
   * Remove a key from a peer
   */
  remove(ctx: Context, peer: string, req: RemoveRequest): Promise<void>;

  /**
   * Remove multiple keys from a peer
   */
  removeMany(ctx: Context, peer: string, req: RemoveManyRequest): Promise<void>;

  /**
   * Get the address this transport is listening on
   */
  readonly listenAddress: string | undefined;
}

/**
 * Error thrown when a transport operation fails
 */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly peer: string,
    public readonly operation: 'get' | 'set' | 'remove' | 'removeMany',
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Error thrown when a key is not found
 */
export class NotFoundError extends Error {
  constructor(
    public readonly group: string,
    public readonly key: string,
  ) {
    super(`Key not found: ${group}/${key}`);
    this.name = 'NotFoundError';
  }
}
