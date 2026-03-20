/**
 * Fastify Integration
 *
 * Provides a Fastify plugin for groupcache peer communication.
 * This allows groupcache to be embedded into existing Fastify
 * applications without running a separate HTTP server.
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify';
 * import { GroupCache, fastifyGroupCache } from 'groupcache-js';
 *
 * const app = Fastify();
 * const cache = new GroupCache({ self: 'http://localhost:3000' });
 *
 * // Register groupcache plugin
 * app.register(fastifyGroupCache, { cache });
 *
 * // Your other routes
 * app.get('/api/users/:id', async (request) => {
 *   return cache.getGroup('users').get(request.params.id);
 * });
 * ```
 */

import type { GroupCache } from '../groupcache.js';
import type { Context } from '../types.js';
import { NotFoundError } from '../transport/interface.js';

/**
 * Fastify-compatible request interface (minimal subset)
 */
export interface FastifyRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  body?: Buffer | string | unknown;
}

/**
 * Fastify-compatible reply interface (minimal subset)
 */
export interface FastifyReply {
  code(statusCode: number): this;
  status(statusCode: number): this;
  header(key: string, value: string | number): this;
  type(contentType: string): this;
  send(payload?: Buffer | string | object): this;
}

/**
 * Fastify-compatible instance interface (minimal subset)
 */
export interface FastifyInstance {
  get(
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): void;
  put(
    path: string,
    opts: { config?: { rawBody?: boolean } },
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): void;
  delete(
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): void;
  addContentTypeParser(
    type: string | string[],
    opts: { parseAs?: 'buffer' | 'string' },
    parser: (req: unknown, payload: Buffer, done: (err: Error | null, body?: Buffer) => void) => void,
  ): void;
  decorate(name: string, value: unknown): void;
}

/**
 * Options for Fastify plugin
 */
export interface FastifyGroupCacheOptions {
  /** The GroupCache instance */
  cache: GroupCache;
  /** Base path for groupcache endpoints (default: "/_groupcache") */
  basePath?: string;
  /** Decorate fastify instance with cache (default: true) */
  decorate?: boolean;
}

/**
 * Fastify plugin for groupcache
 *
 * This is designed to work with Fastify's plugin system.
 * Register it like any other Fastify plugin.
 */
export async function fastifyGroupCache(
  fastify: FastifyInstance,
  options: FastifyGroupCacheOptions,
): Promise<void> {
  const { cache, basePath = '/_groupcache', decorate = true } = options;

  // Optionally decorate fastify instance with cache
  if (decorate) {
    fastify.decorate('groupcache', cache);
  }

  // Add content type parser for raw body
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, payload, done) => {
      done(null, payload);
    },
  );

  // GET /_groupcache/:group/:key
  fastify.get(
    `${basePath}/:group/:key`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { group: groupName, key } = request.params as { group: string; key: string };
      const group = cache.getGroup(groupName);

      if (!group) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const ctx: Context = {};

      try {
        // Use handlePeerGet for transport-level requests
        const result = await group.handlePeerGet(ctx, decodeURIComponent(key));

        reply.header('Content-Type', 'application/octet-stream');
        if (result.expiresAt !== undefined) {
          reply.header('X-GroupCache-Expires-At', result.expiresAt);
        }
        reply.header('X-GroupCache-Hit', result.hit ? 'true' : 'false');

        return reply.code(200).send(result.value);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return reply.code(404).send({ error: 'Not found' });
        }
        throw error;
      }
    },
  );

  // PUT /_groupcache/:group/:key
  fastify.put(
    `${basePath}/:group/:key`,
    { config: { rawBody: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { group: groupName, key } = request.params as { group: string; key: string };
      const group = cache.getGroup(groupName);

      if (!group) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const body = request.body as Buffer;
      const ttlHeader = request.headers['x-groupcache-ttl'];
      const ttl = ttlHeader ? parseInt(ttlHeader as string, 10) : undefined;

      // Use handlePeerSet for transport-level requests
      group.handlePeerSet(decodeURIComponent(key), body, ttl);

      return reply.code(204).send();
    },
  );

  // DELETE /_groupcache/:group/:key
  fastify.delete(
    `${basePath}/:group/:key`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { group: groupName, key } = request.params as { group: string; key: string };
      const group = cache.getGroup(groupName);

      if (!group) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      // Use handlePeerRemove for transport-level requests
      group.handlePeerRemove(decodeURIComponent(key));

      return reply.code(204).send();
    },
  );

  // DELETE /_groupcache/:group?keys=k1,k2
  fastify.delete(
    `${basePath}/:group`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { group: groupName } = request.params as { group: string };
      const group = cache.getGroup(groupName);

      if (!group) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const keysParam = request.query['keys'];
      if (!keysParam) {
        return reply.code(400).send({ error: 'Missing keys parameter' });
      }

      const keys = (typeof keysParam === 'string' ? keysParam : keysParam[0] ?? '')
        .split(',')
        .map((k) => decodeURIComponent(k));

      // Use handlePeerRemoveMany for transport-level requests
      group.handlePeerRemoveMany(keys);

      return reply.code(204).send();
    },
  );
}

/**
 * Hook to create cached route handlers
 *
 * @example
 * ```typescript
 * const cachedHandler = createCachedHandler(cache, 'users', {
 *   keyExtractor: (request) => request.params.id,
 *   ttl: 300000,
 * });
 *
 * app.get('/api/users/:id', cachedHandler(async (request, reply) => {
 *   // This runs only on cache miss
 *   const user = await fetchUser(request.params.id);
 *   return user;
 * }));
 * ```
 */
export function createCachedHandler<T, R>(
  cache: GroupCache,
  groupName: string,
  options: {
    keyExtractor: (request: FastifyRequest) => string;
    ttl?: number;
    skip?: (request: FastifyRequest) => boolean;
  },
): (
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<R>,
) => (request: FastifyRequest, reply: FastifyReply) => Promise<T | R> {
  const group = cache.getGroup(groupName);

  if (!group) {
    throw new Error(`Group "${groupName}" not found`);
  }

  return (handler) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      // Skip caching if configured
      if (options.skip?.(request)) {
        return handler(request, reply);
      }

      const key = options.keyExtractor(request);

      try {
        const value = (await group.get(key)) as T;
        reply.header('X-Cache', 'HIT');
        return value;
      } catch {
        // Cache miss - run the handler
        const result = await handler(request, reply);
        reply.header('X-Cache', 'MISS');
        return result;
      }
    };
  };
}
