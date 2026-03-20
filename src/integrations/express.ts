/**
 * Express.js Integration
 *
 * Provides middleware for Express.js applications to easily serve groupcache
 * peer requests. This allows groupcache to be embedded into existing Express
 * applications without running a separate HTTP server.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { GroupCache, createExpressMiddleware } from 'groupcache-js';
 *
 * const app = express();
 * const cache = new GroupCache({ self: 'http://localhost:3000' });
 *
 * // Mount groupcache middleware
 * app.use(createExpressMiddleware(cache));
 *
 * // Your other routes
 * app.get('/api/users/:id', async (req, res) => {
 *   const user = await cache.getGroup('users').get(req.params.id);
 *   res.json(user);
 * });
 * ```
 */

import type { GroupCache } from '../groupcache.js';
import type { Context } from '../types.js';
import { NotFoundError } from '../transport/interface.js';

/**
 * Express-compatible request interface (minimal subset)
 */
export interface ExpressRequest {
  method?: string | undefined;
  url?: string | undefined;
  path?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/**
 * Express-compatible response interface (minimal subset)
 */
export interface ExpressResponse {
  status(code: number): this;
  set(header: string, value: string): this;
  setHeader(name: string, value: string | number | readonly string[]): this;
  send(body?: Buffer | string): this;
  end(data?: string | Buffer): this;
}

/**
 * Express-compatible next function
 */
export type ExpressNextFunction = (err?: Error | 'route' | 'router') => void;

/**
 * Options for Express middleware
 */
export interface ExpressMiddlewareOptions {
  /** Base path for groupcache endpoints (default: "/_groupcache") */
  basePath?: string;
}

/**
 * Creates Express middleware for handling groupcache peer requests
 *
 * @param cache - The GroupCache instance
 * @param options - Middleware options
 * @returns Express middleware function
 */
export function createExpressMiddleware(
  cache: GroupCache,
  options: ExpressMiddlewareOptions = {},
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => void {
  const basePath = options.basePath ?? '/_groupcache';

  return (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => {
    const path = req.path ?? req.url?.split('?')[0] ?? '';

    // Check if this is a groupcache request
    if (!path.startsWith(basePath)) {
      return next();
    }

    // Handle the request
    handleRequest(cache, basePath, req, res).catch((error) => {
      console.error('Groupcache middleware error:', error);
      res.status(500).send('Internal Server Error');
    });
  };
}

/**
 * Handle a groupcache request
 */
async function handleRequest(
  cache: GroupCache,
  basePath: string,
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const urlPath = req.path ?? req.url?.split('?')[0] ?? '';
  const queryString = req.url?.includes('?') ? req.url.split('?')[1] : '';
  const query = new URLSearchParams(queryString);

  // Parse path: /_groupcache/{group}/{key}
  const pathPart = urlPath.slice(basePath.length);
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);

  const ctx: Context = {};

  try {
    // GET /_groupcache/{group}/{key}
    if (method === 'GET' && parts.length === 2) {
      const [groupName, key] = parts as [string, string];
      const group = cache.getGroup(groupName);

      if (!group) {
        res.status(404).send('Group not found');
        return;
      }

      // Use handlePeerGet for transport-level requests
      const result = await group.handlePeerGet(ctx, key);

      res.setHeader('Content-Type', 'application/octet-stream');
      if (result.expiresAt !== undefined) {
        res.setHeader('X-GroupCache-Expires-At', result.expiresAt.toString());
      }
      res.setHeader('X-GroupCache-Hit', result.hit ? 'true' : 'false');
      res.status(200).send(result.value);
      return;
    }

    // PUT /_groupcache/{group}/{key}
    if (method === 'PUT' && parts.length === 2) {
      const [groupName, key] = parts as [string, string];
      const group = cache.getGroup(groupName);

      if (!group) {
        res.status(404).send('Group not found');
        return;
      }

      const body = await readBody(req);
      const ttlHeader = req.headers['x-groupcache-ttl'];
      const ttl = ttlHeader ? parseInt(ttlHeader as string, 10) : undefined;

      // Use handlePeerSet for transport-level requests
      group.handlePeerSet(key, body, ttl);

      res.status(204).end();
      return;
    }

    // DELETE /_groupcache/{group}/{key}
    if (method === 'DELETE' && parts.length === 2) {
      const [groupName, key] = parts as [string, string];
      const group = cache.getGroup(groupName);

      if (!group) {
        res.status(404).send('Group not found');
        return;
      }

      // Use handlePeerRemove for transport-level requests
      group.handlePeerRemove(key);

      res.status(204).end();
      return;
    }

    // DELETE /_groupcache/{group}?keys=k1,k2
    if (method === 'DELETE' && parts.length === 1) {
      const [groupName] = parts as [string];
      const group = cache.getGroup(groupName);

      if (!group) {
        res.status(404).send('Group not found');
        return;
      }

      const keysParam = query.get('keys') ?? req.query?.['keys'];
      if (!keysParam) {
        res.status(400).send('Missing keys parameter');
        return;
      }

      const keys = (typeof keysParam === 'string' ? keysParam : keysParam[0] ?? '')
        .split(',')
        .map((k) => decodeURIComponent(k));

      // Use handlePeerRemoveMany for transport-level requests
      group.handlePeerRemoveMany(keys);

      res.status(204).end();
      return;
    }

    res.status(404).send('Not Found');
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).send('Not Found');
      return;
    }

    throw error;
  }
}

/**
 * Read request body as Buffer
 */
function readBody(req: ExpressRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Creates a simple caching middleware that caches responses
 *
 * @param cache - The GroupCache instance
 * @param groupName - The cache group to use
 * @param options - Caching options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * // Cache API responses for 5 minutes
 * app.get('/api/products/:id', createCacheMiddleware(cache, 'products', {
 *   keyExtractor: (req) => req.params.id,
 *   ttl: 300000,
 * }), productHandler);
 * ```
 */
export function createCacheMiddleware(
  cache: GroupCache,
  groupName: string,
  options: {
    /** Function to extract cache key from request */
    keyExtractor: (req: ExpressRequest) => string;
    /** TTL in milliseconds */
    ttl?: number;
    /** Skip caching for certain requests */
    skip?: (req: ExpressRequest) => boolean;
  },
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => void {
  const group = cache.getGroup(groupName);

  if (!group) {
    throw new Error(`Group "${groupName}" not found`);
  }

  return (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => {
    // Skip caching if configured
    if (options.skip?.(req)) {
      return next();
    }

    const key = options.keyExtractor(req);

    group
      .get(key)
      .then((value) => {
        // Serve cached response
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Cache', 'HIT');
        // Serialize if needed
        const body = typeof value === 'string' ? value : JSON.stringify(value);
        res.status(200).send(body);
      })
      .catch(() => {
        // Not in cache, proceed to handler
        // The getter should populate the cache
        next();
      });
  };
}
