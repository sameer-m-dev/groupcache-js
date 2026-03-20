/**
 * OpenTelemetry Tracing Integration
 *
 * Provides distributed tracing for groupcache operations using the OpenTelemetry API.
 */

/**
 * Span kind enumeration
 */
export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;

export type SpanKindType = (typeof SpanKind)[keyof typeof SpanKind];

/**
 * Span status code
 */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type SpanStatusCodeType = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

/**
 * Span interface (subset of OpenTelemetry Span)
 */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): Span;
  setStatus(status: { code: SpanStatusCodeType; message?: string }): Span;
  recordException(exception: Error): Span;
  end(): void;
}

/**
 * Tracer interface (subset of OpenTelemetry Tracer)
 */
export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

/**
 * Span options
 */
export interface SpanOptions {
  kind?: SpanKindType;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Groupcache tracer wrapper
 */
export class GroupCacheTracer {
  constructor(private readonly tracer: Tracer | null = null) {}

  /**
   * Trace a cache get operation
   */
  traceGet<T>(
    group: string,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan('groupcache.get', {
      kind: SpanKind.CLIENT,
      attributes: {
        'groupcache.group': group,
        'groupcache.key': key,
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Trace a local load operation
   */
  traceLoad<T>(
    group: string,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan('groupcache.load', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'groupcache.group': group,
        'groupcache.key': key,
        'groupcache.source': 'local',
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Trace a peer fetch operation
   */
  tracePeerFetch<T>(
    group: string,
    key: string,
    peerAddress: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan('groupcache.peer_fetch', {
      kind: SpanKind.CLIENT,
      attributes: {
        'groupcache.group': group,
        'groupcache.key': key,
        'groupcache.peer': peerAddress,
        'groupcache.source': 'peer',
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Trace a cache set operation
   */
  traceSet<T>(
    group: string,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan('groupcache.set', {
      kind: SpanKind.CLIENT,
      attributes: {
        'groupcache.group': group,
        'groupcache.key': key,
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Trace a cache remove operation
   */
  traceRemove<T>(
    group: string,
    keys: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan('groupcache.remove', {
      kind: SpanKind.CLIENT,
      attributes: {
        'groupcache.group': group,
        'groupcache.key_count': keys.length,
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Trace handling an incoming peer request
   */
  traceHandlePeerRequest<T>(
    operation: string,
    group: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer) {
      return fn();
    }

    const span = this.tracer.startSpan(`groupcache.handle_${operation}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'groupcache.group': group,
        'groupcache.operation': operation,
      },
    });

    return fn()
      .then((result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      })
      .catch((error) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      })
      .finally(() => {
        span.end();
      });
  }
}

/**
 * No-op tracer for when tracing is disabled
 */
export const noopTracer = new GroupCacheTracer(null);
