/**
 * HTTP Transport Implementation
 *
 * Provides HTTP-based peer-to-peer communication for groupcache.
 * Protocol:
 *   GET  /_groupcache/{group}/{key}        - Get value
 *   PUT  /_groupcache/{group}/{key}        - Set value
 *   DELETE /_groupcache/{group}/{key}      - Remove key
 *   DELETE /_groupcache/{group}?keys=k1,k2 - Remove multiple keys
 */

import * as http from 'node:http';
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
 * Options for HTTP transport
 */
export interface HttpTransportOptions {
  /** Base path for groupcache endpoints (default: "/_groupcache") */
  basePath?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Maximum number of sockets per host (default: 10) */
  maxSockets?: number;
}

/**
 * HTTP Transport for peer communication
 */
export class HttpTransport implements Transport {
  private server: http.Server | null = null;
  private readonly basePath: string;
  private readonly timeout: number;
  private readonly agent: http.Agent;
  private _listenAddress: string | undefined;

  constructor(options: HttpTransportOptions = {}) {
    this.basePath = options.basePath ?? '/_groupcache';
    this.timeout = options.timeout ?? 5000;
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: options.maxSockets ?? 10,
    });
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
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res, handler).catch((error) => {
          console.error('Request handler error:', error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          }
        });
      });

      server.on('error', reject);

      const host = options.host ?? '0.0.0.0';

      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          this._listenAddress = `http://${addr.address}:${addr.port}`;
        }
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

      // Force close connections after timeout
      this.server.closeAllConnections?.();
    });
  }

  async get(ctx: Context, peer: string, req: GetRequest): Promise<GetResponse> {
    const url = `${peer}${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const response = await this.request('GET', url, ctx);

    if (response.statusCode === 404) {
      throw new NotFoundError(req.group, req.key);
    }

    if (response.statusCode !== 200) {
      throw new TransportError(
        `Unexpected status code: ${response.statusCode}`,
        peer,
        'get',
        response.statusCode,
      );
    }

    const expiresAtHeader = response.headers['x-groupcache-expires-at'];
    const hitHeader = response.headers['x-groupcache-hit'];

    return {
      value: response.body,
      expiresAt: expiresAtHeader ? parseInt(expiresAtHeader as string, 10) : undefined,
      hit: hitHeader === 'true',
    };
  }

  async set(ctx: Context, peer: string, req: SetRequest): Promise<void> {
    const url = `${peer}${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const headers: Record<string, string> = {};
    if (req.ttl !== undefined) {
      headers['x-groupcache-ttl'] = req.ttl.toString();
    }

    const response = await this.request('PUT', url, ctx, req.value, headers);

    if (response.statusCode !== 200 && response.statusCode !== 204) {
      throw new TransportError(
        `Unexpected status code: ${response.statusCode}`,
        peer,
        'set',
        response.statusCode,
      );
    }
  }

  async remove(ctx: Context, peer: string, req: RemoveRequest): Promise<void> {
    const url = `${peer}${this.basePath}/${encodeURIComponent(req.group)}/${encodeURIComponent(req.key)}`;

    const response = await this.request('DELETE', url, ctx);

    if (response.statusCode !== 200 && response.statusCode !== 204 && response.statusCode !== 404) {
      throw new TransportError(
        `Unexpected status code: ${response.statusCode}`,
        peer,
        'remove',
        response.statusCode,
      );
    }
  }

  async removeMany(ctx: Context, peer: string, req: RemoveManyRequest): Promise<void> {
    const keysParam = req.keys.map(k => encodeURIComponent(k)).join(',');
    const url = `${peer}${this.basePath}/${encodeURIComponent(req.group)}?keys=${keysParam}`;

    const response = await this.request('DELETE', url, ctx);

    if (response.statusCode !== 200 && response.statusCode !== 204) {
      throw new TransportError(
        `Unexpected status code: ${response.statusCode}`,
        peer,
        'removeMany',
        response.statusCode,
      );
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: TransportHandler,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Check base path
    if (!url.pathname.startsWith(this.basePath)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // Parse path: /_groupcache/{group}/{key}
    const pathPart = url.pathname.slice(this.basePath.length);
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);

    const ctx: Context = {};

    try {
      if (req.method === 'GET' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        const response = await handler.handleGet(ctx, { group, key });

        res.setHeader('Content-Type', 'application/octet-stream');
        if (response.expiresAt !== undefined) {
          res.setHeader('X-GroupCache-Expires-At', response.expiresAt.toString());
        }
        if (response.hit !== undefined) {
          res.setHeader('X-GroupCache-Hit', response.hit.toString());
        }
        res.statusCode = 200;
        res.end(response.value);
        return;
      }

      if (req.method === 'PUT' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        const body = await this.readBody(req);
        const ttlHeader = req.headers['x-groupcache-ttl'];
        const ttl = ttlHeader ? parseInt(ttlHeader as string, 10) : undefined;

        await handler.handleSet(ctx, { group, key, value: body, ttl });

        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'DELETE' && parts.length === 2) {
        const [group, key] = parts as [string, string];
        await handler.handleRemove(ctx, { group, key });

        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'DELETE' && parts.length === 1) {
        const [group] = parts as [string];
        const keysParam = url.searchParams.get('keys');
        if (!keysParam) {
          res.statusCode = 400;
          res.end('Missing keys parameter');
          return;
        }

        const keys = keysParam.split(',').map(k => decodeURIComponent(k));
        await handler.handleRemoveMany(ctx, { group, keys });

        res.statusCode = 204;
        res.end();
        return;
      }

      res.statusCode = 404;
      res.end('Not Found');
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      throw error;
    }
  }

  private async request(
    method: string,
    url: string,
    ctx: Context,
    body?: Buffer,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const options: http.RequestOptions = {
        method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        agent: this.agent,
        timeout: this.timeout,
        headers: {
          ...headers,
          'Content-Length': body?.length ?? 0,
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Handle abort signal
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          req.destroy();
          reject(new Error('Request aborted'));
          return;
        }

        ctx.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request aborted'));
        });
      }

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}
