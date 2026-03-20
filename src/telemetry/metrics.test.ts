import { describe, it, expect, vi } from 'vitest';
import {
  createMetrics,
  noopMetrics,
  withTiming,
  type Meter,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from './metrics.js';

// Create mock meter
function createMockMeter(): Meter & {
  counters: Map<string, Counter>;
  histograms: Map<string, Histogram>;
  gauges: Map<string, ObservableGauge>;
} {
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  const gauges = new Map<string, ObservableGauge & { callbacks: Function[] }>();

  return {
    counters,
    histograms,
    gauges,

    createCounter(name: string) {
      const counter: Counter = {
        add: vi.fn(),
      };
      counters.set(name, counter);
      return counter;
    },

    createHistogram(name: string) {
      const histogram: Histogram = {
        record: vi.fn(),
      };
      histograms.set(name, histogram);
      return histogram;
    },

    createObservableGauge(name: string) {
      const gauge: ObservableGauge & { callbacks: Function[] } = {
        callbacks: [],
        addCallback(callback: Function) {
          gauge.callbacks.push(callback);
        },
      };
      gauges.set(name, gauge);
      return gauge;
    },
  };
}

describe('createMetrics', () => {
  it('should create all metrics', () => {
    const meter = createMockMeter();
    const callback = vi.fn().mockReturnValue({
      cacheSize: new Map(),
      cacheItems: new Map(),
      peerCount: 0,
    });

    const metrics = createMetrics({ meter }, callback);

    expect(metrics.gets).toBeDefined();
    expect(metrics.hits).toBeDefined();
    expect(metrics.misses).toBeDefined();
    expect(metrics.loads).toBeDefined();
    expect(metrics.loadsDeduped).toBeDefined();
    expect(metrics.peerLoads).toBeDefined();
    expect(metrics.peerErrors).toBeDefined();
    expect(metrics.loadDuration).toBeDefined();
    expect(metrics.peerRequestDuration).toBeDefined();
    expect(metrics.cacheSize).toBeDefined();
    expect(metrics.cacheItems).toBeDefined();
    expect(metrics.peerCount).toBeDefined();
  });

  it('should use custom prefix', () => {
    const meter = createMockMeter();
    const callback = vi.fn().mockReturnValue({
      cacheSize: new Map(),
      cacheItems: new Map(),
      peerCount: 0,
    });

    createMetrics({ meter, prefix: 'myapp.cache' }, callback);

    expect(meter.counters.has('myapp.cache.gets')).toBe(true);
    expect(meter.counters.has('myapp.cache.hits')).toBe(true);
  });

  it('should register observable callbacks', () => {
    const meter = createMockMeter();
    const callback = vi.fn().mockReturnValue({
      cacheSize: new Map([['users', 1024], ['products', 2048]]),
      cacheItems: new Map([['users', 10], ['products', 20]]),
      peerCount: 3,
    });

    createMetrics({ meter }, callback);

    // Check that callbacks were registered
    expect(meter.gauges.get('groupcache.cache_size')!.callbacks.length).toBe(1);
    expect(meter.gauges.get('groupcache.cache_items')!.callbacks.length).toBe(1);
    expect(meter.gauges.get('groupcache.peer_count')!.callbacks.length).toBe(1);
  });

  it('should call observable callbacks with result', () => {
    const meter = createMockMeter();
    const callback = vi.fn().mockReturnValue({
      cacheSize: new Map([['users', 1024]]),
      cacheItems: new Map([['users', 10]]),
      peerCount: 3,
    });

    createMetrics({ meter }, callback);

    // Simulate OpenTelemetry calling the callback
    const cacheSizeGauge = meter.gauges.get('groupcache.cache_size')!;
    const mockResult = { observe: vi.fn() };
    cacheSizeGauge.callbacks[0]!(mockResult);

    expect(callback).toHaveBeenCalled();
    expect(mockResult.observe).toHaveBeenCalledWith(1024, { group: 'users' });
  });
});

describe('noopMetrics', () => {
  it('should have all metric types', () => {
    expect(noopMetrics.gets).toBeDefined();
    expect(noopMetrics.hits).toBeDefined();
    expect(noopMetrics.misses).toBeDefined();
    expect(noopMetrics.loads).toBeDefined();
    expect(noopMetrics.loadsDeduped).toBeDefined();
    expect(noopMetrics.peerLoads).toBeDefined();
    expect(noopMetrics.peerErrors).toBeDefined();
    expect(noopMetrics.loadDuration).toBeDefined();
    expect(noopMetrics.peerRequestDuration).toBeDefined();
    expect(noopMetrics.cacheSize).toBeDefined();
    expect(noopMetrics.cacheItems).toBeDefined();
    expect(noopMetrics.peerCount).toBeDefined();
  });

  it('should not throw when called', () => {
    expect(() => noopMetrics.gets.add(1)).not.toThrow();
    expect(() => noopMetrics.hits.add(1, { group: 'test' })).not.toThrow();
    expect(() => noopMetrics.loadDuration.record(100)).not.toThrow();
    expect(() => noopMetrics.cacheSize.addCallback(() => {})).not.toThrow();
  });
});

describe('withTiming', () => {
  it('should record timing for successful operation', async () => {
    const histogram: Histogram = {
      record: vi.fn(),
    };

    const result = await withTiming(
      histogram,
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'success';
      },
      { operation: 'test' },
    );

    expect(result).toBe('success');
    expect(histogram.record).toHaveBeenCalledWith(
      expect.any(Number),
      { operation: 'test' },
    );

    const recordedDuration = (histogram.record as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Allow for timer precision variance
    expect(recordedDuration).toBeGreaterThanOrEqual(9);
  });

  it('should record timing for failed operation', async () => {
    const histogram: Histogram = {
      record: vi.fn(),
    };

    await expect(
      withTiming(histogram, async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    expect(histogram.record).toHaveBeenCalled();
  });

  it('should pass through return value', async () => {
    const histogram: Histogram = {
      record: vi.fn(),
    };

    const complexResult = { data: [1, 2, 3], nested: { value: 'test' } };
    const result = await withTiming(histogram, async () => complexResult);

    expect(result).toBe(complexResult);
  });
});
