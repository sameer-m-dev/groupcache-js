/**
 * HTTP/2 Transport Implementation
 *
 * Provides HTTP/2-based peer-to-peer communication for groupcache.
 * Benefits over HTTP/1.1:
 *   - Multiplexed streams (no head-of-line blocking)
 *   - Connection reuse (single connection per peer)
 *   - Header compression (HPACK)
 *   - Binary framing (more efficient)
 *
 * Protocol:
 *   GET  /_groupcache/{group}/{key}        - Get value
 *   PUT  /_groupcache/{group}/{key}        - Set value
 *   DELETE /_groupcache/{group}/{key}      - Remove key
 *   DELETE /_groupcache/{group}?keys=k1,k2 - Remove multiple keys
 */

import * as http2 from 'node:http2';
import type { Context } from '../types.js';
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

/**
 * Options for HTTP/2 transport
 */
export interface Http2TransportOptions {
  /** Base path for groupcache endpoints (default: "/_groupcache") */
  basePath?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Maximum concurrent streams per session (default: 100) */
  maxConcurrentStreams?: number;
  /** Session idle timeout in milliseconds (default: 60000) */
  sessionTimeout?: number;
}

/**
 * Connection pool entry
 */
interface SessionEntry {
  session: http2.ClientHttp2Session;
  lastUsed: number;
}

/**
 * HTTP/2 Transport for peer communication
 *
 * Provides multiplexed connections for high-performance peer communication.
 * Maintains a pool of HTTP/2 sessions to peers for connection reuse.
 */
export class Http2Transport implements Transport {
  private server: http2.Http2Server | null = null;
  private readonly basePath: string;
  private readonly timeout: number;
  private readonly maxConcurrentStreams: number;
  private readonly sessionTimeout: number;
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly serverSessions: Set<http2.ServerHttp2Session> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private _listenAddress: string | undefined;

  constructor(options: Http2TransportOptions = {}) {
    this.basePath = options.basePath ?? '/_groupcache';
    this.timeout = options.timeout ?? 5000;
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? 100;
    this.sessionTimeout = options.sessionTimeout ?? 60000;
  }

  get listenAddress(): string | undefined {
    return this._listenAddress;
  }

  async listen(
    port: number,
    handler: TransportHandler,
    options: TransportListenOptions = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http2.createServer({
        settings: {
          maxConcurrentStreams: this.maxConcurrentStreams,
        },
      });

      server.on('session', (session) => {
        this.serverSessions.add(session);
        session.on('close', () => {
          this.serverSessions.delete(session);
        });
      });

      server.on('stream', (stream, headers) => {
        this.handleStream(stream, headers, handler).catch((error) => {
          console.error('Stream handler error:', error);
          if (!stream.destroyed) {
            stream.respond({ ':status': 500 });
            stream.end('Internal Server Error');
          }
        });
      });

      server.on('error', reject);

      const host = options.host ?? '0.0.0.0';

      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          // Use http scheme for unencrypted HTTP/2 (h2c)
          this._listenAddress = `http://${addr.address}:${addr.port}`;
        }

        // Start session cleanup interval
        this.cleanupInterval = setInterval(() => {
          this.cleanupSessions();
        }, this.sessionTimeout / 2);

        resolve();
      });

      // Handle abort signal
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.close().catch(() => {});
        });
      }
    });
  }

  async close(): Promise<void> {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Destroy all client sessions (force close)
    const destroyPromises: Promise<void>[] = [];
    for (const [_peer, entry] of this.sessions) {
      destroyPromises.push(
        new Promise<void>((resolve) => {
          if (entry.session.destroyed || entry.session.closed) {
            resolve();
            return;
          }
          entry.session.destroy();
          entry.session.once('close', () => resolve());
          // Fallback timeout
          setTimeout(resolve, 100);
        }),
      );
    }
    await Promise.all(destroyPromises);
    this.sessions.clear();

    // Destroy all server-side sessions
    for (const session of this.serverSessions) {
      if (!session.destroyed && !session.closed) {
        session.destroy();
      }
    }
    this.serverSessions.clear();

    // Close server
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((err) => {
        this.server = null;
        this._listenAddress = undefined;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async get(ctx: Context, peer: string, req: GetRequest): Promise<GetResponse> {
    const path = `${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const response = await this.request(ctx, peer, {
      ':method': 'GET',
      ':path': path,
    });

    if (response.status === 404) {
      throw new NotFoundError(req.group, req.key);
    }

    if (response.status !== 200) {
      throw new TransportError(
        `Unexpected status code: ${response.status}`,
        peer,
        'get',
        response.status,
      );
    }

    return {
      value: response.body,
      expiresAt: response.headers['x-groupcache-expires-at']
        ? parseInt(response.headers['x-groupcache-expires-at'] as string, 10)
        : undefined,
      hit: response.headers['x-groupcache-hit'] === 'true',
    };
  }

  async set(ctx: Context, peer: string, req: SetRequest): Promise<void> {
    const path = `${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const headers: Record<string, string | number> = {
      ':method': 'PUT',
      ':path': path,
      'content-length': req.value.length,
    };

    if (req.ttl !== undefined) {
      headers['x-groupcache-ttl'] = req.ttl.toString();
    }

    const response = await this.request(ctx, peer, headers, req.value);

    if (response.status !== 200 && response.status !== 204) {
      throw new TransportError(
        `Unexpected status code: ${response.status}`,
        peer,
        'set',
        response.status,
      );
    }
  }

  async remove(ctx: Context, peer: string, req: RemoveRequest): Promise<void> {
    const path = `${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const response = await this.request(ctx, peer, {
      ':method': 'DELETE',
      ':path': path,
    });

    if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
      throw new TransportError(
        `Unexpected status code: ${response.status}`,
        peer,
        'remove',
        response.status,
      );
    }
  }

  async removeMany(ctx: Context, peer: string, req: RemoveManyRequest): Promise<void> {
    const keysParam = req.keys.map((k) => encodeURIComponent(k)).join(',');
    const path = `${this.basePath}/${encodeURIComponent(req.group)}?keys=${keysParam}`;

    const response = await this.request(ctx, peer, {
      ':method': 'DELETE',
      ':path': path,
    });

    if (response.status !== 200 && response.status !== 204) {
      throw new TransportError(
        `Unexpected status code: ${response.status}`,
        peer,
        'removeMany',
        response.status,
      );
    }
  }

  /**
   * Handle an incoming HTTP/2 stream
   */
  private async handleStream(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    handler: TransportHandler,
  ): Promise<void> {
    const method = headers[':method'];
    const pathname = headers[':path'] as string;

    // Parse URL
    const url = new URL(pathname, 'http://localhost');

    // Check base path
    if (!url.pathname.startsWith(this.basePath)) {
      stream.respond({ ':status': 404 });
      stream.end('Not Found');
      return;
    }

    // Parse path: /_groupcache/{group}/{key}
    const pathPart = url.pathname.slice(this.basePath.length);
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);

    const ctx: Context = {};

    try {
      if (method === 'GET' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        const response = await handler.handleGet(ctx, { group, key });

        const responseHeaders: http2.OutgoingHttpHeaders = {
          ':status': 200,
          'content-type': 'application/octet-stream',
        };

        if (response.expiresAt !== undefined) {
          responseHeaders['x-groupcache-expires-at'] = response.expiresAt.toString();
        }
        if (response.hit !== undefined) {
          responseHeaders['x-groupcache-hit'] = response.hit.toString();
        }

        stream.respond(responseHeaders);
        stream.end(response.value);
        return;
      }

      if (method === 'PUT' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        const body = await this.readStream(stream);
        const ttlHeader = headers['x-groupcache-ttl'];
        const ttl = ttlHeader ? parseInt(ttlHeader as string, 10) : undefined;

        await handler.handleSet(ctx, { group, key, value: body, ttl });

        stream.respond({ ':status': 204 });
        stream.end();
        return;
      }

      if (method === 'DELETE' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        await handler.handleRemove(ctx, { group, key });

        stream.respond({ ':status': 204 });
        stream.end();
        return;
      }

      if (method === 'DELETE' && parts.length === 1) {
        const [group] = parts as [string];
        const keysParam = url.searchParams.get('keys');
        if (!keysParam) {
          stream.respond({ ':status': 400 });
          stream.end('Missing keys parameter');
          return;
        }

        const keys = keysParam.split(',').map((k) => decodeURIComponent(k));
        await handler.handleRemoveMany(ctx, { group, keys });

        stream.respond({ ':status': 204 });
        stream.end();
        return;
      }

      stream.respond({ ':status': 404 });
      stream.end('Not Found');
    } catch (error) {
      if (error instanceof NotFoundError) {
        stream.respond({ ':status': 404 });
        stream.end('Not Found');
        return;
      }

      throw error;
    }
  }

  /**
   * Make an HTTP/2 request to a peer
   */
  private async request(
    ctx: Context,
    peer: string,
    headers: Record<string, string | number>,
    body?: Buffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const session = await this.getSession(peer);

    return new Promise((resolve, reject) => {
      const stream = session.request(headers);

      let responseStatus = 500;
      let responseHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];

      // Set timeout
      const timeoutId = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('Request timeout'));
      }, this.timeout);

      // Handle abort signal
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          clearTimeout(timeoutId);
          stream.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error('Request aborted'));
          return;
        }

        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          stream.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error('Request aborted'));
        });
      }

      stream.on('response', (headers) => {
        responseStatus = headers[':status'] as number;
        responseHeaders = {};
        for (const [key, value] of Object.entries(headers)) {
          if (!key.startsWith(':') && typeof value === 'string') {
            responseHeaders[key] = value;
          }
        }
      });

      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      stream.on('end', () => {
        clearTimeout(timeoutId);
        resolve({
          status: responseStatus,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
        });
      });

      stream.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      // Send body if provided
      if (body) {
        stream.write(body);
      }
      stream.end();
    });
  }

  /**
   * Get or create an HTTP/2 session for a peer
   */
  private async getSession(peer: string): Promise<http2.ClientHttp2Session> {
    // Check for existing session
    const existing = this.sessions.get(peer);
    if (existing && !existing.session.destroyed && !existing.session.closed) {
      existing.lastUsed = Date.now();
      return existing.session;
    }

    // Create new session
    return new Promise((resolve, reject) => {
      const session = http2.connect(peer, {
        peerMaxConcurrentStreams: this.maxConcurrentStreams,
      });

      session.on('error', (err) => {
        this.sessions.delete(peer);
        reject(err);
      });

      session.on('close', () => {
        this.sessions.delete(peer);
      });

      session.once('connect', () => {
        this.sessions.set(peer, {
          session,
          lastUsed: Date.now(),
        });
        resolve(session);
      });
    });
  }

  /**
   * Clean up idle sessions
   */
  private cleanupSessions(): void {
    const now = Date.now();
    for (const [peer, entry] of this.sessions) {
      if (now - entry.lastUsed > this.sessionTimeout) {
        entry.session.close();
        this.sessions.delete(peer);
      }
    }
  }

  /**
   * Read data from a stream
   */
  private async readStream(stream: http2.ServerHttp2Stream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer | string) => {
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
        } else {
          chunks.push(chunk);
        }
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
