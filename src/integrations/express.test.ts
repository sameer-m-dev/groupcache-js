import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createExpressMiddleware,
  createCacheMiddleware,
  type ExpressRequest,
  type ExpressResponse,
  type ExpressNextFunction,
} from './express.js';
import type { GroupCache } from '../groupcache.js';
import type { Group } from '../group.js';

// Mock request factory
function createMockRequest(options: {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: Buffer;
}): ExpressRequest {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const req = {
    method: options.method ?? 'GET',
    path: options.path ?? options.url?.split('?')[0],
    url: options.url ?? options.path,
    headers: options.headers ?? {},
    query: options.query ?? {},
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(listener);

      // Simulate data/end events for body
      if (event === 'data' && options.body) {
        setTimeout(() => listener(options.body), 0);
      }
      if (event === 'end') {
        setTimeout(() => listener(), 0);
      }
      return req;
    }),
  } as ExpressRequest;

  return req;
}

// Mock response factory
function createMockResponse(): ExpressResponse & { statusCode: number; body: Buffer | string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: Buffer | string | null = null;

  return {
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
    status: vi.fn(function (this: ExpressResponse, code: number) {
      statusCode = code;
      return this;
    }),
    set: vi.fn(function (this: ExpressResponse, header: string, value: string) {
      headers[header] = value;
      return this;
    }),
    setHeader: vi.fn((name: string, value: string | number | readonly string[]) => {
      headers[name] = String(value);
    }),
    send: vi.fn(function (this: ExpressResponse, data?: Buffer | string) {
      body = data ?? null;
      return this;
    }),
    end: vi.fn(function (this: ExpressResponse, data?: string | Buffer) {
      if (data) body = data;
      return this;
    }),
  };
}

// Mock GroupCache factory
function createMockGroupCache(groups: Record<string, Partial<Group>>): GroupCache {
  return {
    getGroup: vi.fn((name: string) => groups[name] as Group | undefined),
  } as unknown as GroupCache;
}

describe('createExpressMiddleware', () => {
  let middleware: (req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => void;
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
    middleware = createExpressMiddleware(mockCache);
  });

  describe('path matching', () => {
    it('should pass through non-groupcache requests', () => {
      const req = createMockRequest({ path: '/api/users' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockCache.getGroup).not.toHaveBeenCalled();
    });

    it('should handle groupcache requests', async () => {
      const req = createMockRequest({ method: 'GET', path: '/_groupcache/test-group/test-key' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(next).not.toHaveBeenCalled();
      expect(mockGroup.handlePeerGet).toHaveBeenCalled();
    });

    it('should use custom base path', async () => {
      middleware = createExpressMiddleware(mockCache, { basePath: '/cache' });

      const req = createMockRequest({ method: 'GET', path: '/cache/test-group/test-key' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGroup.handlePeerGet).toHaveBeenCalled();
    });
  });

  describe('GET operation', () => {
    it('should get value from cache', async () => {
      const req = createMockRequest({ method: 'GET', path: '/_groupcache/test-group/test-key' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(res.statusCode).toBe(200);
      expect(res.body?.toString()).toBe('test-value');
      expect(res.headers['X-GroupCache-Hit']).toBe('true');
    });

    it('should return 404 for missing group', async () => {
      const req = createMockRequest({ method: 'GET', path: '/_groupcache/missing-group/key' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(res.statusCode).toBe(404);
    });

    it('should decode URL-encoded keys', async () => {
      const req = createMockRequest({
        method: 'GET',
        path: '/_groupcache/test-group/key%20with%20spaces',
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGroup.handlePeerGet).toHaveBeenCalledWith(expect.any(Object), 'key with spaces');
    });
  });

  describe('PUT operation', () => {
    it('should set value in cache', async () => {
      const body = Buffer.from('new-value');
      const req = createMockRequest({
        method: 'PUT',
        path: '/_groupcache/test-group/test-key',
        body,
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockGroup.handlePeerSet).toHaveBeenCalledWith(
        'test-key',
        body,
        undefined,
      );
      expect(res.statusCode).toBe(204);
    });

    it('should set value with TTL', async () => {
      const body = Buffer.from('value');
      const req = createMockRequest({
        method: 'PUT',
        path: '/_groupcache/test-group/test-key',
        headers: { 'x-groupcache-ttl': '60000' },
        body,
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockGroup.handlePeerSet).toHaveBeenCalledWith(
        'test-key',
        body,
        60000,
      );
    });
  });

  describe('DELETE operation', () => {
    it('should remove single key', async () => {
      const req = createMockRequest({
        method: 'DELETE',
        path: '/_groupcache/test-group/test-key',
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGroup.handlePeerRemove).toHaveBeenCalledWith('test-key');
      expect(res.statusCode).toBe(204);
    });

    it('should remove multiple keys', async () => {
      const req = createMockRequest({
        method: 'DELETE',
        url: '/_groupcache/test-group?keys=key1,key2,key3',
        path: '/_groupcache/test-group',
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockGroup.handlePeerRemoveMany).toHaveBeenCalledWith(
        ['key1', 'key2', 'key3'],
      );
    });

    it('should return 400 for missing keys parameter', async () => {
      const req = createMockRequest({
        method: 'DELETE',
        path: '/_groupcache/test-group',
        url: '/_groupcache/test-group',
      });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(res.statusCode).toBe(400);
    });
  });
});

describe('createCacheMiddleware', () => {
  it('should throw if group not found', () => {
    const mockCache = createMockGroupCache({});

    expect(() =>
      createCacheMiddleware(mockCache, 'missing', {
        keyExtractor: () => 'key',
      }),
    ).toThrow('Group "missing" not found');
  });

  it('should serve cached value on hit', async () => {
    const mockGroup = {
      get: vi.fn().mockResolvedValue({
        value: Buffer.from(JSON.stringify({ id: 1 })),
        hit: true,
      }),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const middleware = createCacheMiddleware(mockCache, 'users', {
      keyExtractor: (req) => (req.query as Record<string, string>)['id'] ?? '',
    });

    const req = createMockRequest({
      method: 'GET',
      path: '/api/users',
      query: { id: '123' },
    });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Cache']).toBe('HIT');
  });

  it('should call next on cache miss', async () => {
    const mockGroup = {
      get: vi.fn().mockRejectedValue(new Error('Not found')),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const middleware = createCacheMiddleware(mockCache, 'users', {
      keyExtractor: () => 'key',
    });

    const req = createMockRequest({ path: '/api/users' });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(next).toHaveBeenCalled();
  });

  it('should skip caching when skip returns true', () => {
    const mockGroup = {
      get: vi.fn(),
    };
    const mockCache = createMockGroupCache({ users: mockGroup as Partial<Group> });

    const middleware = createCacheMiddleware(mockCache, 'users', {
      keyExtractor: () => 'key',
      skip: () => true,
    });

    const req = createMockRequest({ path: '/api/users' });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockGroup.get).not.toHaveBeenCalled();
  });
});
