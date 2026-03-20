import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fastifyGroupCache,
  createCachedHandler,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from './fastify.js';
import type { GroupCache } from '../groupcache.js';
import type { Group } from '../group.js';

// Mock GroupCache factory
function createMockGroupCache(groups: Record<string, Partial<Group>>): GroupCache {
  return {
    getGroup: vi.fn((name: string) => groups[name] as Group | undefined),
  } as unknown as GroupCache;
}

// Mock Fastify instance factory
function createMockFastify(): {
  instance: FastifyInstance;
  routes: Record<string, (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>>;
} {
  const routes: Record<string, (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>> = {};

  const instance: FastifyInstance = {
    get: vi.fn((path: string, handler) => {
      routes[`GET:${path}`] = handler;
    }),
    put: vi.fn((path: string, _opts, handler) => {
      routes[`PUT:${path}`] = handler;
    }),
    delete: vi.fn((path: string, handler) => {
      routes[`DELETE:${path}`] = handler;
    }),
    addContentTypeParser: vi.fn(),
    decorate: vi.fn(),
  };

  return { instance, routes };
}

// Mock request factory
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Buffer;
}): FastifyRequest {
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    query: options.query ?? {},
    params: options.params ?? {},
    body: options.body,
  };
}

// Mock reply factory
function createMockReply(): FastifyReply & { statusCode: number; sentBody: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let sentBody: unknown = null;

  const reply: FastifyReply & { statusCode: number; sentBody: unknown; headers: Record<string, string> } = {
    get statusCode() {
      return statusCode;
    },
    get sentBody() {
      return sentBody;
    },
    get headers() {
      return headers;
    },
    code: vi.fn(function (this: FastifyReply, code: number) {
      statusCode = code;
      return this;
    }),
    status: vi.fn(function (this: FastifyReply, code: number) {
      statusCode = code;
      return this;
    }),
    header: vi.fn(function (this: FastifyReply, key: string, value: string | number) {
      headers[key] = String(value);
      return this;
    }),
    type: vi.fn(function (this: FastifyReply) {
      return this;
    }),
    send: vi.fn(function (this: FastifyReply, payload?: unknown) {
      sentBody = payload;
      return this;
    }),
  };

  return reply;
}

describe('fastifyGroupCache', () => {
  let mockCache: GroupCache;
  let mockGroup: Partial<Group>;

  beforeEach(() => {
    mockGroup = {
      get: vi.fn().mockResolvedValue({ name: 'test' }),
      handlePeerGet: vi.fn().mockResolvedValue({
        value: Buffer.from('test-value'),
        expiresAt: Date.now() + 60000,
        hit: true,
      }),
      handlePeerSet: vi.fn(),
      handlePeerRemove: vi.fn(),
      handlePeerRemoveMany: vi.fn(),
    };

    mockCache = createMockGroupCache({ 'test-group': mockGroup });
  });

  describe('plugin registration', () => {
    it('should register routes', async () => {
      const { instance } = createMockFastify();

      await fastifyGroupCache(instance, { cache: mockCache });

      expect(instance.get).toHaveBeenCalledWith(
        '/_groupcache/:group/:key',
        expect.any(Function),
      );
      expect(instance.put).toHaveBeenCalledWith(
        '/_groupcache/:group/:key',
        expect.any(Object),
        expect.any(Function),
      );
      expect(instance.delete).toHaveBeenCalledTimes(2); // single and batch
    });

    it('should use custom base path', async () => {
      const { instance } = createMockFastify();

      await fastifyGroupCache(instance, { cache: mockCache, basePath: '/cache' });

      expect(instance.get).toHaveBeenCalledWith('/cache/:group/:key', expect.any(Function));
    });

    it('should decorate fastify instance by default', async () => {
      const { instance } = createMockFastify();

      await fastifyGroupCache(instance, { cache: mockCache });

      expect(instance.decorate).toHaveBeenCalledWith('groupcache', mockCache);
    });

    it('should not decorate when disabled', async () => {
      const { instance } = createMockFastify();

      await fastifyGroupCache(instance, { cache: mockCache, decorate: false });

      expect(instance.decorate).not.toHaveBeenCalled();
    });

    it('should add content type parser', async () => {
      const { instance } = createMockFastify();

      await fastifyGroupCache(instance, { cache: mockCache });

      expect(instance.addContentTypeParser).toHaveBeenCalledWith(
        'application/octet-stream',
        { parseAs: 'buffer' },
        expect.any(Function),
      );
    });
  });

  describe('GET handler', () => {
    it('should get value from cache', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['GET:/_groupcache/:group/:key']!;
      const req = createMockRequest({
        params: { group: 'test-group', key: 'test-key' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerGet).toHaveBeenCalledWith(expect.any(Object), 'test-key');
      expect(reply.statusCode).toBe(200);
      expect((reply.sentBody as Buffer).toString()).toBe('test-value');
    });

    it('should return 404 for missing group', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['GET:/_groupcache/:group/:key']!;
      const req = createMockRequest({
        params: { group: 'missing', key: 'key' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(reply.statusCode).toBe(404);
    });

    it('should decode URL-encoded keys', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['GET:/_groupcache/:group/:key']!;
      const req = createMockRequest({
        params: { group: 'test-group', key: 'key%20with%20spaces' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerGet).toHaveBeenCalledWith(expect.any(Object), 'key with spaces');
    });

    it('should set response headers', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['GET:/_groupcache/:group/:key']!;
      const req = createMockRequest({
        params: { group: 'test-group', key: 'key' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(reply.headers['X-GroupCache-Hit']).toBe('true');
      expect(reply.headers['X-GroupCache-Expires-At']).toBeDefined();
    });
  });

  describe('PUT handler', () => {
    it('should set value in cache', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['PUT:/_groupcache/:group/:key']!;
      const body = Buffer.from('new-value');
      const req = createMockRequest({
        params: { group: 'test-group', key: 'test-key' },
        body,
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerSet).toHaveBeenCalledWith(
        'test-key',
        body,
        undefined,
      );
      expect(reply.statusCode).toBe(204);
    });

    it('should set value with TTL', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['PUT:/_groupcache/:group/:key']!;
      const body = Buffer.from('value');
      const req = createMockRequest({
        params: { group: 'test-group', key: 'key' },
        headers: { 'x-groupcache-ttl': '60000' },
        body,
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerSet).toHaveBeenCalledWith(
        'key',
        body,
        60000,
      );
    });
  });

  describe('DELETE handler (single)', () => {
    it('should remove key', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['DELETE:/_groupcache/:group/:key']!;
      const req = createMockRequest({
        params: { group: 'test-group', key: 'test-key' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerRemove).toHaveBeenCalledWith('test-key');
      expect(reply.statusCode).toBe(204);
    });
  });

  describe('DELETE handler (batch)', () => {
    it('should remove multiple keys', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['DELETE:/_groupcache/:group']!;
      const req = createMockRequest({
        params: { group: 'test-group' },
        query: { keys: 'key1,key2,key3' },
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(mockGroup.handlePeerRemoveMany).toHaveBeenCalledWith(
        ['key1', 'key2', 'key3'],
      );
    });

    it('should return 400 for missing keys parameter', async () => {
      const { instance, routes } = createMockFastify();
      await fastifyGroupCache(instance, { cache: mockCache });

      const handler = routes['DELETE:/_groupcache/:group']!;
      const req = createMockRequest({
        params: { group: 'test-group' },
        query: {},
      });
      const reply = createMockReply();

      await handler(req, reply);

      expect(reply.statusCode).toBe(400);
    });
  });
});

describe('createCachedHandler', () => {
  it('should throw if group not found', () => {
    const mockCache = createMockGroupCache({});

    expect(() =>
      createCachedHandler(mockCache, 'missing', {
        keyExtractor: () => 'key',
      }),
    ).toThrow('Group "missing" not found');
  });

  it('should return cached value on hit', async () => {
    const cachedValue = { id: 1, name: 'Cached User' };
    const mockGroup = {
      get: vi.fn().mockResolvedValue(cachedValue),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const wrapper = createCachedHandler(mockCache, 'users', {
      keyExtractor: (req) => req.params['id'] ?? '',
    });

    const originalHandler = vi.fn().mockResolvedValue({ id: 1, name: 'Fresh User' });
    const wrappedHandler = wrapper(originalHandler);

    const req = createMockRequest({
      params: { id: '123' },
    });
    const reply = createMockReply();

    const result = await wrappedHandler(req, reply);

    expect(result).toEqual(cachedValue);
    expect(reply.headers['X-Cache']).toBe('HIT');
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it('should call original handler on cache miss', async () => {
    const mockGroup = {
      get: vi.fn().mockRejectedValue(new Error('Not found')),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const wrapper = createCachedHandler(mockCache, 'users', {
      keyExtractor: (req) => req.params['id'] ?? '',
    });

    const originalHandler = vi.fn().mockResolvedValue({ id: 1, name: 'Test' });
    const wrappedHandler = wrapper(originalHandler);

    const req = createMockRequest({
      params: { id: '123' },
    });
    const reply = createMockReply();

    const result = await wrappedHandler(req, reply);

    expect(result).toEqual({ id: 1, name: 'Test' });
    expect(reply.headers['X-Cache']).toBe('MISS');
    expect(originalHandler).toHaveBeenCalled();
  });

  it('should skip caching when skip returns true', async () => {
    const mockGroup = {
      get: vi.fn(),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const wrapper = createCachedHandler(mockCache, 'users', {
      keyExtractor: () => 'key',
      skip: () => true,
    });

    const originalHandler = vi.fn().mockResolvedValue({ data: 'test' });
    const wrappedHandler = wrapper(originalHandler);

    const req = createMockRequest({});
    const reply = createMockReply();

    await wrappedHandler(req, reply);

    expect(mockGroup.get).not.toHaveBeenCalled();
    expect(originalHandler).toHaveBeenCalled();
  });
});
