/**
 * OpenTelemetry Metrics Integration
 *
 * Provides metrics instrumentation for groupcache using the OpenTelemetry API.
 * Supports any OpenTelemetry-compatible backend (Prometheus, Datadog, etc.)
 */

/**
 * Meter interface (subset of OpenTelemetry Meter)
 */
export interface Meter {
  createCounter(name: string, options?: MetricOptions): Counter;
  createHistogram(name: string, options?: MetricOptions): Histogram;
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge;
}

export interface MetricOptions {
  description?: string;
  unit?: string;
}

export interface Counter {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface Histogram {
  record(value: number, attributes?: Record<string, string>): void;
}

export interface ObservableGauge {
  addCallback(callback: (result: ObservableResult) => void): void;
}

export interface ObservableResult {
  observe(value: number, attributes?: Record<string, string>): void;
}

/**
 * Groupcache metrics
 */
export interface GroupCacheMetrics {
  /** Total get requests */
  gets: Counter;
  /** Cache hits (main + hot) */
  hits: Counter;
  /** Cache misses */
  misses: Counter;
  /** Loads from getter */
  loads: Counter;
  /** Loads deduplicated by singleflight */
  loadsDeduped: Counter;
  /** Loads from peer nodes */
  peerLoads: Counter;
  /** Errors loading from peers */
  peerErrors: Counter;
  /** Load duration histogram */
  loadDuration: Histogram;
  /** Peer request duration histogram */
  peerRequestDuration: Histogram;
  /** Cache size gauge */
  cacheSize: ObservableGauge;
  /** Number of cached items gauge */
  cacheItems: ObservableGauge;
  /** Number of peers gauge */
  peerCount: ObservableGauge;
}

/**
 * Options for creating metrics
 */
export interface MetricsOptions {
  /** Meter instance from OpenTelemetry */
  meter: Meter;
  /** Metric name prefix (default: "groupcache") */
  prefix?: string;
}

/**
 * Callback for observable metrics
 */
export type ObservableCallback = () => {
  cacheSize: Map<string, number>;
  cacheItems: Map<string, number>;
  peerCount: number;
};

/**
 * Create groupcache metrics
 */
export function createMetrics(
  options: MetricsOptions,
  observableCallback: ObservableCallback,
): GroupCacheMetrics {
  const prefix = options.prefix ?? 'groupcache';
  const meter = options.meter;

  const metrics: GroupCacheMetrics = {
    gets: meter.createCounter(`${prefix}.gets`, {
      description: 'Total number of get requests',
      unit: '{request}',
    }),

    hits: meter.createCounter(`${prefix}.hits`, {
      description: 'Number of cache hits',
      unit: '{hit}',
    }),

    misses: meter.createCounter(`${prefix}.misses`, {
      description: 'Number of cache misses',
      unit: '{miss}',
    }),

    loads: meter.createCounter(`${prefix}.loads`, {
      description: 'Number of loads from getter',
      unit: '{load}',
    }),

    loadsDeduped: meter.createCounter(`${prefix}.loads_deduped`, {
      description: 'Number of loads deduplicated by singleflight',
      unit: '{load}',
    }),

    peerLoads: meter.createCounter(`${prefix}.peer_loads`, {
      description: 'Number of loads from peer nodes',
      unit: '{load}',
    }),

    peerErrors: meter.createCounter(`${prefix}.peer_errors`, {
      description: 'Number of errors loading from peers',
      unit: '{error}',
    }),

    loadDuration: meter.createHistogram(`${prefix}.load_duration`, {
      description: 'Duration of load operations',
      unit: 'ms',
    }),

    peerRequestDuration: meter.createHistogram(`${prefix}.peer_request_duration`, {
      description: 'Duration of peer requests',
      unit: 'ms',
    }),

    cacheSize: meter.createObservableGauge(`${prefix}.cache_size`, {
      description: 'Current cache size in bytes',
      unit: 'By',
    }),

    cacheItems: meter.createObservableGauge(`${prefix}.cache_items`, {
      description: 'Number of items in cache',
      unit: '{item}',
    }),

    peerCount: meter.createObservableGauge(`${prefix}.peer_count`, {
      description: 'Number of known peers',
      unit: '{peer}',
    }),
  };

  // Register observable callbacks
  metrics.cacheSize.addCallback((result) => {
    const data = observableCallback();
    for (const [group, size] of data.cacheSize) {
      result.observe(size, { group });
    }
  });

  metrics.cacheItems.addCallback((result) => {
    const data = observableCallback();
    for (const [group, items] of data.cacheItems) {
      result.observe(items, { group });
    }
  });

  metrics.peerCount.addCallback((result) => {
    const data = observableCallback();
    result.observe(data.peerCount);
  });

  return metrics;
}

/**
 * No-op counter for when metrics are disabled
 */
const noopCounter: Counter = {
  add: () => {},
};

/**
 * No-op histogram for when metrics are disabled
 */
const noopHistogram: Histogram = {
  record: () => {},
};

/**
 * No-op observable gauge for when metrics are disabled
 */
const noopObservableGauge: ObservableGauge = {
  addCallback: () => {},
};

/**
 * No-op metrics for when metrics are disabled
 */
export const noopMetrics: GroupCacheMetrics = {
  gets: noopCounter,
  hits: noopCounter,
  misses: noopCounter,
  loads: noopCounter,
  loadsDeduped: noopCounter,
  peerLoads: noopCounter,
  peerErrors: noopCounter,
  loadDuration: noopHistogram,
  peerRequestDuration: noopHistogram,
  cacheSize: noopObservableGauge,
  cacheItems: noopObservableGauge,
  peerCount: noopObservableGauge,
};

/**
 * Record a metric with timing
 */
export function withTiming<T>(
  histogram: Histogram,
  fn: () => Promise<T>,
  attributes?: Record<string, string>,
): Promise<T> {
  const start = performance.now();

  return fn().finally(() => {
    const duration = performance.now() - start;
    histogram.record(duration, attributes);
  });
}
