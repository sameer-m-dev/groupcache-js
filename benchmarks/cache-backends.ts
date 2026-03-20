/**
 * Cache Backend Benchmarks
 *
 * Compares LRU, LFU, and ARC cache performance across different workloads.
 */

import { LRUCache } from '../src/cache/lru.js';
import { LFUCache } from '../src/cache/lfu.js';
import { ARCCache } from '../src/cache/arc.js';
import type { CacheEntry } from '../src/types.js';

interface BenchmarkResult {
  name: string;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  hitRate?: number;
  memoryUsedMB?: number;
}

interface CacheBackend {
  get(key: string): CacheEntry<Buffer> | undefined;
  set(key: string, entry: CacheEntry<Buffer>): void;
  delete(key: string): boolean;
  clear(): void;
}

function createEntry(value: string, size?: number): CacheEntry<Buffer> {
  const buf = Buffer.from(value);
  return {
    value: buf,
    size: size ?? buf.length,
    createdAt: Date.now(),
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function runBenchmark(
  name: string,
  cache: CacheBackend,
  fn: () => { hits?: number; total?: number },
  iterations: number,
): BenchmarkResult {
  // Warm up
  for (let i = 0; i < Math.min(1000, iterations / 10); i++) {
    fn();
  }
  cache.clear();

  // Force GC if available
  if (global.gc) global.gc();

  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  let totalHits = 0;
  let totalOps = 0;

  for (let i = 0; i < iterations; i++) {
    const result = fn();
    if (result.hits !== undefined) totalHits += result.hits;
    if (result.total !== undefined) totalOps += result.total;
  }

  const end = performance.now();
  const memAfter = process.memoryUsage().heapUsed;

  const durationMs = end - start;
  const operations = totalOps || iterations;

  return {
    name,
    operations,
    durationMs,
    opsPerSecond: (operations / durationMs) * 1000,
    hitRate: totalOps > 0 ? totalHits / totalOps : undefined,
    memoryUsedMB: (memAfter - memBefore) / 1024 / 1024,
  };
}

// Benchmark: Sequential writes
function benchSequentialWrites(cache: CacheBackend, count: number): BenchmarkResult {
  return runBenchmark(
    'Sequential Writes',
    cache,
    () => {
      for (let i = 0; i < 100; i++) {
        cache.set(`key:${Math.floor(Math.random() * count)}`, createEntry(`value-${i}`));
      }
      return { total: 100 };
    },
    count / 100,
  );
}

// Benchmark: Sequential reads
function benchSequentialReads(cache: CacheBackend, count: number): BenchmarkResult {
  // Pre-populate
  for (let i = 0; i < count; i++) {
    cache.set(`key:${i}`, createEntry(`value-${i}`));
  }

  return runBenchmark(
    'Sequential Reads',
    cache,
    () => {
      let hits = 0;
      for (let i = 0; i < 100; i++) {
        if (cache.get(`key:${Math.floor(Math.random() * count)}`)) hits++;
      }
      return { hits, total: 100 };
    },
    count / 100,
  );
}

// Benchmark: Mixed read/write (80% read, 20% write)
function benchMixedWorkload(cache: CacheBackend, count: number): BenchmarkResult {
  // Pre-populate
  for (let i = 0; i < count / 2; i++) {
    cache.set(`key:${i}`, createEntry(`value-${i}`));
  }

  return runBenchmark(
    'Mixed 80/20 Read/Write',
    cache,
    () => {
      let hits = 0;
      for (let i = 0; i < 100; i++) {
        const key = `key:${Math.floor(Math.random() * count)}`;
        if (Math.random() < 0.8) {
          if (cache.get(key)) hits++;
        } else {
          cache.set(key, createEntry(`value-${i}`));
        }
      }
      return { hits, total: 100 };
    },
    count / 100,
  );
}

// Benchmark: Zipf distribution (simulates real-world access patterns)
function benchZipfWorkload(cache: CacheBackend, count: number): BenchmarkResult {
  // Pre-populate
  for (let i = 0; i < count; i++) {
    cache.set(`key:${i}`, createEntry(`value-${i}`));
  }

  // Generate Zipf-distributed keys
  const zipfKeys: number[] = [];
  for (let i = 0; i < count; i++) {
    // Zipf distribution: probability proportional to 1/rank
    const rank = Math.floor(Math.pow(Math.random(), 2) * count);
    zipfKeys.push(rank);
  }

  let keyIndex = 0;
  return runBenchmark(
    'Zipf Distribution (Hot Keys)',
    cache,
    () => {
      let hits = 0;
      for (let i = 0; i < 100; i++) {
        const key = `key:${zipfKeys[keyIndex++ % zipfKeys.length]}`;
        if (cache.get(key)) hits++;
      }
      return { hits, total: 100 };
    },
    count / 100,
  );
}

// Benchmark: Scan resistance (sequential scan followed by random access)
function benchScanResistance(cache: CacheBackend, count: number): BenchmarkResult {
  const cacheSize = count / 10; // Cache can hold 10% of total keys
  const hotKeys = Math.floor(cacheSize * 0.3); // 30% of cache is hot data

  // Pre-populate with hot keys
  for (let i = 0; i < hotKeys; i++) {
    cache.set(`hot:${i}`, createEntry(`hot-value-${i}`));
  }

  let phase = 0;
  let scanIndex = 0;

  return runBenchmark(
    'Scan Resistance',
    cache,
    () => {
      let hits = 0;
      for (let i = 0; i < 100; i++) {
        if (phase === 0) {
          // Sequential scan (should not evict hot keys in ARC)
          cache.get(`scan:${scanIndex++}`);
          cache.set(`scan:${scanIndex}`, createEntry(`scan-value`));
          if (scanIndex >= count) {
            phase = 1;
            scanIndex = 0;
          }
        } else {
          // Random access to hot keys
          if (cache.get(`hot:${Math.floor(Math.random() * hotKeys)}`)) hits++;
        }
      }
      return { hits, total: phase === 1 ? 100 : 0 };
    },
    count / 50,
  );
}

function printResults(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(90));
  console.log(
    '| ' +
      'Benchmark'.padEnd(30) +
      ' | ' +
      'Ops/sec'.padStart(12) +
      ' | ' +
      'Duration'.padStart(10) +
      ' | ' +
      'Hit Rate'.padStart(10) +
      ' | ' +
      'Memory'.padStart(10) +
      ' |',
  );
  console.log('='.repeat(90));

  for (const r of results) {
    const hitRate = r.hitRate !== undefined ? `${(r.hitRate * 100).toFixed(1)}%` : 'N/A';
    const memory = r.memoryUsedMB !== undefined ? `${r.memoryUsedMB.toFixed(2)} MB` : 'N/A';
    console.log(
      '| ' +
        r.name.padEnd(30) +
        ' | ' +
        formatNumber(r.opsPerSecond).padStart(12) +
        ' | ' +
        `${r.durationMs.toFixed(0)} ms`.padStart(10) +
        ' | ' +
        hitRate.padStart(10) +
        ' | ' +
        memory.padStart(10) +
        ' |',
    );
  }
  console.log('='.repeat(90));
}

async function main() {
  const cacheSize = 1024 * 1024 * 10; // 10MB
  const iterations = 100000;

  console.log('Cache Backend Benchmarks');
  console.log('========================\n');
  console.log(`Cache Size: ${cacheSize / 1024 / 1024}MB`);
  console.log(`Iterations: ${formatNumber(iterations)}\n`);

  const caches = [
    { name: 'LRU', factory: () => new LRUCache<Buffer>({ maxSize: cacheSize }) },
    { name: 'LFU', factory: () => new LFUCache<Buffer>({ maxSize: cacheSize }) },
    { name: 'ARC', factory: () => new ARCCache<Buffer>({ maxSize: cacheSize }) },
  ];

  const benchmarks = [
    { name: 'Sequential Writes', fn: benchSequentialWrites },
    { name: 'Sequential Reads', fn: benchSequentialReads },
    { name: 'Mixed 80/20', fn: benchMixedWorkload },
    { name: 'Zipf Distribution', fn: benchZipfWorkload },
    { name: 'Scan Resistance', fn: benchScanResistance },
  ];

  for (const bench of benchmarks) {
    console.log(`\n### ${bench.name}`);

    const results: BenchmarkResult[] = [];
    for (const { name, factory } of caches) {
      const cache = factory();
      const result = bench.fn(cache as unknown as CacheBackend, iterations);
      result.name = `${name}`;
      results.push(result);
    }

    printResults(results);
  }

  console.log('\n\n### Summary');
  console.log('- LRU: Best for simple workloads, lowest memory overhead');
  console.log('- LFU: Best for stable hot key patterns');
  console.log('- ARC: Best for mixed/unpredictable workloads, scan-resistant');
}

main().catch(console.error);
