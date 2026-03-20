/**
 * Worker Thread Benchmarks
 *
 * Compares performance with and without worker thread offloading.
 */

import { WorkerPool } from '../src/workers/pool.js';

interface BenchmarkResult {
  name: string;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  avgLatencyMs: number;
  payloadSize: string;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function generatePayload(size: number): object {
  const data: Record<string, unknown> = {
    id: Math.random().toString(36),
    timestamp: Date.now(),
    nested: {
      array: Array.from({ length: Math.floor(size / 100) }, (_, i) => ({
        index: i,
        value: 'x'.repeat(50),
      })),
    },
  };
  return data;
}

async function benchMainThread(
  name: string,
  payload: object,
  iterations: number,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];

  // Warm up
  for (let i = 0; i < 10; i++) {
    const json = JSON.stringify(payload);
    JSON.parse(json);
  }

  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const opStart = performance.now();
    const json = JSON.stringify(payload);
    JSON.parse(json);
    latencies.push(performance.now() - opStart);
  }

  const end = performance.now();
  const durationMs = end - start;

  return {
    name,
    operations: iterations,
    durationMs,
    opsPerSecond: (iterations / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    payloadSize: formatSize(JSON.stringify(payload).length),
  };
}

async function benchWorkerPool(
  name: string,
  pool: WorkerPool,
  payload: object,
  iterations: number,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];

  // Warm up
  for (let i = 0; i < 10; i++) {
    const buf = await pool.serialize(payload);
    await pool.deserialize(buf);
  }

  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const opStart = performance.now();
    const buf = await pool.serialize(payload);
    await pool.deserialize(buf);
    latencies.push(performance.now() - opStart);
  }

  const end = performance.now();
  const durationMs = end - start;

  return {
    name,
    operations: iterations,
    durationMs,
    opsPerSecond: (iterations / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    payloadSize: formatSize(JSON.stringify(payload).length),
  };
}

async function benchCompression(
  name: string,
  pool: WorkerPool | null,
  data: Buffer,
  iterations: number,
): Promise<BenchmarkResult> {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const latencies: number[] = [];

  const start = performance.now();

  if (pool) {
    // Worker pool compression
    for (let i = 0; i < iterations; i++) {
      const opStart = performance.now();
      const compressed = await pool.compress(data);
      await pool.decompress(compressed);
      latencies.push(performance.now() - opStart);
    }
  } else {
    // Main thread compression
    for (let i = 0; i < iterations; i++) {
      const opStart = performance.now();
      const compressed = gzipSync(data);
      gunzipSync(compressed);
      latencies.push(performance.now() - opStart);
    }
  }

  const end = performance.now();
  const durationMs = end - start;

  return {
    name,
    operations: iterations,
    durationMs,
    opsPerSecond: (iterations / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    payloadSize: formatSize(data.length),
  };
}

async function benchConcurrentOps(
  name: string,
  pool: WorkerPool | null,
  payload: object,
  iterations: number,
  concurrency: number,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];

  const runOp = async () => {
    const opStart = performance.now();
    if (pool) {
      const buf = await pool.serialize(payload);
      await pool.deserialize(buf);
    } else {
      const json = JSON.stringify(payload);
      JSON.parse(json);
    }
    latencies.push(performance.now() - opStart);
  };

  const start = performance.now();

  for (let i = 0; i < iterations; i += concurrency) {
    const batch = Math.min(concurrency, iterations - i);
    await Promise.all(Array.from({ length: batch }, () => runOp()));
  }

  const end = performance.now();
  const durationMs = end - start;

  return {
    name,
    operations: iterations,
    durationMs,
    opsPerSecond: (iterations / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    payloadSize: formatSize(JSON.stringify(payload).length),
  };
}

function printResults(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(95));
  console.log(
    '| ' +
      'Test'.padEnd(25) +
      ' | ' +
      'Ops/sec'.padStart(12) +
      ' | ' +
      'Avg Latency'.padStart(12) +
      ' | ' +
      'Payload'.padStart(10) +
      ' | ' +
      'Duration'.padStart(10) +
      ' |',
  );
  console.log('='.repeat(95));

  for (const r of results) {
    console.log(
      '| ' +
        r.name.padEnd(25) +
        ' | ' +
        formatNumber(r.opsPerSecond).padStart(12) +
        ' | ' +
        `${r.avgLatencyMs.toFixed(3)} ms`.padStart(12) +
        ' | ' +
        r.payloadSize.padStart(10) +
        ' | ' +
        `${(r.durationMs / 1000).toFixed(2)}s`.padStart(10) +
        ' |',
    );
  }
  console.log('='.repeat(95));
}

async function main() {
  console.log('Worker Thread Benchmarks');
  console.log('========================\n');

  const pool = new WorkerPool({ size: 4, threshold: 0 }); // Always offload for benchmark

  // Test different payload sizes
  const payloadSizes = [
    { name: 'Small (1KB)', size: 1024 },
    { name: 'Medium (10KB)', size: 10 * 1024 },
    { name: 'Large (100KB)', size: 100 * 1024 },
    { name: 'XLarge (1MB)', size: 1024 * 1024 },
  ];

  // Serialization benchmarks
  console.log('\n### Serialization (JSON stringify/parse)');
  console.log('Comparing main thread vs worker thread offloading\n');

  for (const { name, size } of payloadSizes) {
    console.log(`\n#### Payload: ${name}`);

    const payload = generatePayload(size);
    const iterations = size > 100000 ? 100 : 1000;

    const results: BenchmarkResult[] = [
      await benchMainThread('Main Thread', payload, iterations),
      await benchWorkerPool('Worker Pool', pool, payload, iterations),
    ];

    printResults(results);

    // Show speedup/slowdown
    const mainOps = results[0]!.opsPerSecond;
    const workerOps = results[1]!.opsPerSecond;
    const ratio = workerOps / mainOps;
    console.log(
      `\n  ${ratio > 1 ? 'Worker is' : 'Main thread is'} ${Math.abs(1 - ratio) * 100 > 100 ? (ratio > 1 ? ratio : 1 / ratio).toFixed(1) + 'x' : Math.abs((1 - ratio) * 100).toFixed(0) + '%'} ${ratio > 1 ? 'faster' : 'faster'}`,
    );
  }

  // Compression benchmarks
  console.log('\n\n### Compression (gzip)');
  console.log('Comparing main thread vs worker thread compression\n');

  for (const { name, size } of payloadSizes) {
    console.log(`\n#### Payload: ${name}`);

    const data = Buffer.alloc(size, 'x');
    const iterations = size > 100000 ? 50 : 500;

    const results: BenchmarkResult[] = [
      await benchCompression('Main Thread', null, data, iterations),
      await benchCompression('Worker Pool', pool, data, iterations),
    ];

    printResults(results);
  }

  // Concurrent operations
  console.log('\n\n### Concurrent Operations');
  console.log('Testing throughput under concurrent load\n');

  const concurrency = 50;
  const payload = generatePayload(50 * 1024); // 50KB
  const iterations = 500;

  console.log(`Concurrency: ${concurrency}, Iterations: ${iterations}`);

  const concurrentResults: BenchmarkResult[] = [
    await benchConcurrentOps('Main Thread', null, payload, iterations, concurrency),
    await benchConcurrentOps('Worker Pool', pool, payload, iterations, concurrency),
  ];

  printResults(concurrentResults);

  // Show pool stats
  const stats = pool.getStats();
  console.log('\n### Worker Pool Stats');
  console.log(`  Tasks Completed: ${formatNumber(stats.totalTasksCompleted)}`);
  console.log(`  Tasks Failed: ${stats.totalTasksFailed}`);
  console.log(`  Avg Duration: ${stats.averageTaskDuration.toFixed(2)}ms`);
  console.log(`  Bytes Processed: ${formatSize(stats.totalBytesProcessed)}`);

  // Cleanup
  await pool.shutdown();

  console.log('\n\n### Recommendations');
  console.log('- Small payloads (<10KB): Use main thread (worker overhead not worth it)');
  console.log('- Medium payloads (10-100KB): Workers beneficial under high concurrency');
  console.log('- Large payloads (>100KB): Always use workers to avoid blocking event loop');
  console.log('- Compression: Always offload to workers (CPU-intensive)');
}

main().catch(console.error);
