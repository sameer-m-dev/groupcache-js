import { describe, it, expect, vi } from 'vitest';
import {
  GroupCacheTracer,
  noopTracer,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Span,
} from './tracing.js';

// Create mock span
function createMockSpan(): Span & { ended: boolean } {
  return {
    ended: false,
    setAttribute: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    recordException: vi.fn().mockReturnThis(),
    end: vi.fn(function (this: Span & { ended: boolean }) {
      this.ended = true;
    }),
  };
}

// Create mock tracer
function createMockTracer(): Tracer & { spans: Span[] } {
  const spans: Span[] = [];

  return {
    spans,
    startSpan: vi.fn(() => {
      const span = createMockSpan();
      spans.push(span);
      return span;
    }),
  };
}

describe('GroupCacheTracer', () => {
  describe('traceGet', () => {
    it('should trace successful get operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      const result = await tracer.traceGet('users', 'user:123', async () => 'value');

      expect(result).toBe('value');
      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.get', {
        kind: SpanKind.CLIENT,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.key': 'user:123',
        },
      });

      const span = mockTracer.spans[0]!;
      expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(span.end).toHaveBeenCalled();
    });

    it('should trace failed get operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);
      const error = new Error('Not found');

      await expect(
        tracer.traceGet('users', 'user:123', async () => {
          throw error;
        }),
      ).rejects.toThrow('Not found');

      const span = mockTracer.spans[0]!;
      expect(span.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Error: Not found',
      });
      expect(span.recordException).toHaveBeenCalledWith(error);
      expect(span.end).toHaveBeenCalled();
    });

    it('should pass through when tracer is null', async () => {
      const tracer = new GroupCacheTracer(null);

      const result = await tracer.traceGet('users', 'user:123', async () => 'value');

      expect(result).toBe('value');
    });
  });

  describe('traceLoad', () => {
    it('should trace load operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      await tracer.traceLoad('users', 'user:123', async () => 'loaded');

      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.load', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.key': 'user:123',
          'groupcache.source': 'local',
        },
      });
    });
  });

  describe('tracePeerFetch', () => {
    it('should trace peer fetch operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      await tracer.tracePeerFetch(
        'users',
        'user:123',
        'http://peer1:8080',
        async () => 'fetched',
      );

      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.peer_fetch', {
        kind: SpanKind.CLIENT,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.key': 'user:123',
          'groupcache.peer': 'http://peer1:8080',
          'groupcache.source': 'peer',
        },
      });
    });
  });

  describe('traceSet', () => {
    it('should trace set operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      await tracer.traceSet('users', 'user:123', async () => undefined);

      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.set', {
        kind: SpanKind.CLIENT,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.key': 'user:123',
        },
      });
    });
  });

  describe('traceRemove', () => {
    it('should trace remove operation', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      await tracer.traceRemove('users', ['key1', 'key2', 'key3'], async () => undefined);

      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.remove', {
        kind: SpanKind.CLIENT,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.key_count': 3,
        },
      });
    });
  });

  describe('traceHandlePeerRequest', () => {
    it('should trace incoming peer request', async () => {
      const mockTracer = createMockTracer();
      const tracer = new GroupCacheTracer(mockTracer);

      await tracer.traceHandlePeerRequest('get', 'users', async () => 'response');

      expect(mockTracer.startSpan).toHaveBeenCalledWith('groupcache.handle_get', {
        kind: SpanKind.SERVER,
        attributes: {
          'groupcache.group': 'users',
          'groupcache.operation': 'get',
        },
      });
    });
  });
});

describe('noopTracer', () => {
  it('should be a GroupCacheTracer instance', () => {
    expect(noopTracer).toBeInstanceOf(GroupCacheTracer);
  });

  it('should pass through without tracing', async () => {
    const result = await noopTracer.traceGet('users', 'key', async () => 'value');
    expect(result).toBe('value');
  });

  it('should propagate errors', async () => {
    await expect(
      noopTracer.traceLoad('users', 'key', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
  });
});
