/**
 * Complete Benchmark Suite
 *
 * Runs all benchmarks and generates a comprehensive report.
 */

import { LRUCache } from '../src/cache/lru.js';
import { LFUCache } from '../src/cache/lfu.js';
import { ARCCache } from '../src/cache/arc.js';
import { HttpTransport } from '../src/transport/http.js';
import { Http2Transport } from '../src/transport/http2.js';
import { WorkerPool } from '../src/workers/pool.js';
import type { Transport, TransportHandler, GetResponse } from '../src/transport/interface.js';
import type { CacheEntry } from '../src/types.js';

interface BenchResult {
  category: string;
  test: string;
  variant: string;
  opsPerSec: number;
  latencyMs: number;
  extraInfo?: string;
}

const results: BenchResult[] = [];

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}K`;
  return n.toFixed(0);
}

// ============================================================================
// CACHE BENCHMARKS
// ============================================================================

function benchCaches() {
  console.log('\n' + '='.repeat(60));
  console.log('CACHE BACKEND BENCHMARKS');
  console.log('='.repeat(60));

  const cacheSize = 10 * 1024 * 1024; // 10MB
  const iterations = 100000;

  const caches = [
    { name: 'LRU', cache: new LRUCache<Buffer>({ maxSize: cacheSize }) },
    { name: 'LFU', cache: new LFUCache<Buffer>({ maxSize: cacheSize }) },
    { name: 'ARC', cache: new ARCCache<Buffer>({ maxSize: cacheSize }) },
  ];

  // Write benchmark
  console.log('\n### Write Performance');
  for (const { name, cache } of caches) {
    cache.clear();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const entry: CacheEntry<Buffer> = {
        value: Buffer.from(`value-${i}`),
        size: 10,
        createdAt: Date.now(),
      };
      cache.set(`key-${i % 10000}`, entry);
    }
    const duration = performance.now() - start;
    const opsPerSec = (iterations / duration) * 1000;
    console.log(`  ${name}: ${formatNumber(opsPerSec)} ops/sec`);
    results.push({
      category: 'Cache',
      test: 'Write',
      variant: name,
      opsPerSec,
      latencyMs: duration / iterations,
    });
  }

  // Read benchmark
  console.log('\n### Read Performance');
  for (const { name, cache } of caches) {
    // Pre-populate
    for (let i = 0; i < 10000; i++) {
      cache.set(`key-${i}`, {
        value: Buffer.from(`value-${i}`),
        size: 10,
        createdAt: Date.now(),
      });
    }

    const start = performance.now();
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      if (cache.get(`key-${i % 10000}`)) hits++;
    }
    const duration = performance.now() - start;
    const opsPerSec = (iterations / duration) * 1000;
    console.log(`  ${name}: ${formatNumber(opsPerSec)} ops/sec (${((hits / iterations) * 100).toFixed(1)}% hit rate)`);
    results.push({
      category: 'Cache',
      test: 'Read',
      variant: name,
      opsPerSec,
      latencyMs: duration / iterations,
      extraInfo: `${((hits / iterations) * 100).toFixed(1)}% hits`,
    });
  }

  // Mixed workload (Zipf distribution)
  console.log('\n### Zipf Distribution (Real-world pattern)');
  for (const { name, cache } of caches) {
    cache.clear();
    for (let i = 0; i < 10000; i++) {
      cache.set(`key-${i}`, {
        value: Buffer.from(`value-${i}`),
        size: 10,
        createdAt: Date.now(),
      });
    }

    const start = performance.now();
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      // Zipf: most accesses to small set of keys
      const rank = Math.floor(Math.pow(Math.random(), 2) * 10000);
      if (cache.get(`key-${rank}`)) hits++;
    }
    const duration = performance.now() - start;
    const opsPerSec = (iterations / duration) * 1000;
    console.log(`  ${name}: ${formatNumber(opsPerSec)} ops/sec (${((hits / iterations) * 100).toFixed(1)}% hit rate)`);
    results.push({
      category: 'Cache',
      test: 'Zipf',
      variant: name,
      opsPerSec,
      latencyMs: duration / iterations,
      extraInfo: `${((hits / iterations) * 100).toFixed(1)}% hits`,
    });
  }
}

// ============================================================================
// TRANSPORT BENCHMARKS
// ============================================================================

async function benchTransports() {
  console.log('\n' + '='.repeat(60));
  console.log('TRANSPORT BENCHMARKS');
  console.log('='.repeat(60));

  const handler: TransportHandler = {
    async handleGet(): Promise<GetResponse> {
      return { value: Buffer.from('x'.repeat(100)), hit: true };
    },
    async handleSet(): Promise<void> {},
    async handleRemove(): Promise<void> {},
    async handleRemoveMany(): Promise<void> {},
  };

  const transports: { name: string; server: Transport; client: Transport }[] = [
    {
      name: 'HTTP/1.1',
      server: new HttpTransport(),
      client: new HttpTransport(),
    },
    {
      name: 'HTTP/2',
      server: new Http2Transport(),
      client: new Http2Transport(),
    },
  ];

  // Try gRPC
  try {
    const { GrpcTransport } = await import('../src/transport/grpc.js');
    transports.push({
      name: 'gRPC',
      server: new GrpcTransport(),
      client: new GrpcTransport(),
    });
  } catch {
    console.log('\nNote: gRPC not available (optional dependency)\n');
  }

  // Start servers
  let port = 51000;
  const servers: { name: string; address: string; server: Transport; client: Transport }[] = [];

  for (const t of transports) {
    await t.server.listen(port++, handler);
    servers.push({ ...t, address: t.server.listenAddress! });
  }

  const iterations = 2000;
  const concurrency = 50;

  console.log(`\n### Sequential Requests (${iterations} ops)`);
  for (const { name, address, client } of servers) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await client.get({}, address, { group: 'test', key: `k${i}` });
    }
    const duration = performance.now() - start;
    const opsPerSec = (iterations / duration) * 1000;
    console.log(`  ${name}: ${formatNumber(opsPerSec)} ops/sec (${(duration / iterations).toFixed(2)}ms avg)`);
    results.push({
      category: 'Transport',
      test: 'Sequential',
      variant: name,
      opsPerSec,
      latencyMs: duration / iterations,
    });
  }

  console.log(`\n### Concurrent Requests (${iterations} ops, ${concurrency} concurrent)`);
  for (const { name, address, client } of servers) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += concurrency) {
      const batch = Math.min(concurrency, iterations - i);
      await Promise.all(
        Array.from({ length: batch }, (_, j) =>
          client.get({}, address, { group: 'test', key: `k${i + j}` }),
        ),
      );
    }
    const duration = performance.now() - start;
    const opsPerSec = (iterations / duration) * 1000;
    console.log(`  ${name}: ${formatNumber(opsPerSec)} ops/sec (${(duration / iterations).toFixed(2)}ms avg)`);
    results.push({
      category: 'Transport',
      test: 'Concurrent',
      variant: name,
      opsPerSec,
      latencyMs: duration / iterations,
    });
  }

  // Cleanup
  for (const { server, client } of servers) {
    await client.close();
    await server.close();
  }
}

// ============================================================================
// WORKER THREAD BENCHMARKS
// ============================================================================

async function benchWorkers() {
  console.log('\n' + '='.repeat(60));
  console.log('WORKER THREAD BENCHMARKS');
  console.log('='.repeat(60));

  const pool = new WorkerPool({ size: 4, threshold: 0 });

  const payloads = [
    { name: '1KB', data: { arr: Array(20).fill('x'.repeat(50)) } },
    { name: '10KB', data: { arr: Array(200).fill('x'.repeat(50)) } },
    { name: '100KB', data: { arr: Array(2000).fill('x'.repeat(50)) } },
  ];

  for (const { name: sizeName, data } of payloads) {
    console.log(`\n### Payload: ${sizeName}`);
    const iterations = sizeName === '100KB' ? 200 : 1000;

    // Main thread
    const mainStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const json = JSON.stringify(data);
      JSON.parse(json);
    }
    const mainDuration = performance.now() - mainStart;
    const mainOps = (iterations / mainDuration) * 1000;

    // Worker pool
    const workerStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      const buf = await pool.serialize(data);
      await pool.deserialize(buf);
    }
    const workerDuration = performance.now() - workerStart;
    const workerOps = (iterations / workerDuration) * 1000;

    console.log(`  Main Thread: ${formatNumber(mainOps)} ops/sec`);
    console.log(`  Worker Pool: ${formatNumber(workerOps)} ops/sec`);

    const ratio = workerOps / mainOps;
    console.log(`  ${ratio > 1 ? 'Workers faster by' : 'Main thread faster by'} ${Math.abs(ratio - 1) * 100 > 100 ? (ratio > 1 ? ratio : 1 / ratio).toFixed(1) + 'x' : Math.abs((ratio - 1) * 100).toFixed(0) + '%'}`);

    results.push({
      category: 'Workers',
      test: `Serialize ${sizeName}`,
      variant: 'Main Thread',
      opsPerSec: mainOps,
      latencyMs: mainDuration / iterations,
    });
    results.push({
      category: 'Workers',
      test: `Serialize ${sizeName}`,
      variant: 'Worker Pool',
      opsPerSec: workerOps,
      latencyMs: workerDuration / iterations,
    });
  }

  await pool.shutdown();
}

// ============================================================================
// FINAL REPORT
// ============================================================================

function printReport() {
  console.log('\n\n');
  console.log('='.repeat(80));
  console.log('                         FINAL BENCHMARK REPORT');
  console.log('='.repeat(80));

  // Group results by category
  const categories = [...new Set(results.map((r) => r.category))];

  for (const category of categories) {
    console.log(`\n## ${category}\n`);
    const categoryResults = results.filter((r) => r.category === category);
    const tests = [...new Set(categoryResults.map((r) => r.test))];

    for (const test of tests) {
      console.log(`### ${test}`);
      const testResults = categoryResults.filter((r) => r.test === test);
      const best = Math.max(...testResults.map((r) => r.opsPerSec));

      for (const r of testResults) {
        const isBest = r.opsPerSec === best;
        const bar = '█'.repeat(Math.round((r.opsPerSec / best) * 30));
        console.log(
          `  ${r.variant.padEnd(12)} ${bar.padEnd(32)} ${formatNumber(r.opsPerSec).padStart(10)} ops/sec ${isBest ? '★' : ' '} ${r.extraInfo || ''}`,
        );
      }
      console.log('');
    }
  }

  // Summary recommendations
  console.log('='.repeat(80));
  console.log('                           RECOMMENDATIONS');
  console.log('='.repeat(80));

  console.log(`
## Cache Backend Selection

  • LRU: Best for simple use cases, lowest memory overhead
         Choose when: Access patterns are unknown or uniform

  • LFU: Best for stable, predictable hot keys
         Choose when: You have a known set of frequently accessed items

  • ARC: Best for mixed/changing workloads, scan-resistant
         Choose when: Access patterns vary or you have periodic scans

## Transport Selection

  • HTTP/1.1: Maximum compatibility, simple debugging
              Choose when: Compatibility is priority, low concurrency

  • HTTP/2:   Best balance of performance and compatibility
              Choose when: High concurrency, multiplexing benefits needed

  • gRPC:     Lowest latency, best throughput
              Choose when: Microservices, polyglot environment, max performance

## Worker Thread Usage

  • Small payloads (<10KB):  Use main thread
                             Worker overhead exceeds benefits

  • Medium payloads (10-100KB): Use workers under high load
                                 Benefits at high concurrency

  • Large payloads (>100KB): Always use workers
                             Prevents event loop blocking

## General Recommendations

  1. Start with LRU + HTTP/2 for most use cases
  2. Enable worker threads only for large payloads
  3. Use ARC if you experience cache pollution from scans
  4. Consider gRPC for internal microservice communication
`);
}

async function main() {
  console.log('groupcache-js Benchmark Suite');
  console.log('=============================');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);

  benchCaches();
  await benchTransports();
  await benchWorkers();
  printReport();
}

main().catch(console.error);
