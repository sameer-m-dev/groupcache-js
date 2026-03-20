/**
 * Transport Benchmarks
 *
 * Compares HTTP/1.1, HTTP/2, and gRPC transport performance.
 */

import { HttpTransport } from '../src/transport/http.js';
import { Http2Transport } from '../src/transport/http2.js';
import type { Transport, TransportHandler, GetResponse } from '../src/transport/interface.js';

interface BenchmarkResult {
  name: string;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

async function runBenchmark(
  name: string,
  transport: Transport,
  peerAddress: string,
  iterations: number,
  concurrency: number,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let errors = 0;

  // Warm up
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    try {
      await transport.get({}, peerAddress, { group: 'bench', key: `warmup-${i}` });
    } catch {
      // ignore warmup errors
    }
  }

  const start = performance.now();

  // Run concurrent operations
  const runOp = async (i: number) => {
    const opStart = performance.now();
    try {
      await transport.get({}, peerAddress, { group: 'bench', key: `key-${i}` });
      latencies.push(performance.now() - opStart);
    } catch {
      errors++;
      latencies.push(performance.now() - opStart);
    }
  };

  // Process in batches of concurrency
  for (let i = 0; i < iterations; i += concurrency) {
    const batch = Math.min(concurrency, iterations - i);
    await Promise.all(Array.from({ length: batch }, (_, j) => runOp(i + j)));
  }

  const end = performance.now();
  const durationMs = end - start;

  return {
    name,
    operations: iterations,
    durationMs,
    opsPerSecond: (iterations / durationMs) * 1000,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p99LatencyMs: percentile(latencies, 99),
    errorRate: errors / iterations,
  };
}

function createHandler(): TransportHandler {
  const cache = new Map<string, Buffer>();

  // Pre-populate cache
  for (let i = 0; i < 10000; i++) {
    cache.set(`bench/key-${i}`, Buffer.from(`value-${i}-${'x'.repeat(100)}`));
  }

  return {
    async handleGet(_ctx, req): Promise<GetResponse> {
      const key = `${req.group}/${req.key}`;
      const value = cache.get(key);
      if (value) {
        return { value, hit: true };
      }
      // Return a default value for benchmark
      return { value: Buffer.from('default-value'), hit: false };
    },
    async handleSet(_ctx, req): Promise<void> {
      cache.set(`${req.group}/${req.key}`, req.value);
    },
    async handleRemove(_ctx, req): Promise<void> {
      cache.delete(`${req.group}/${req.key}`);
    },
    async handleRemoveMany(_ctx, req): Promise<void> {
      for (const key of req.keys) {
        cache.delete(`${req.group}/${key}`);
      }
    },
  };
}

function printResults(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(100));
  console.log(
    '| ' +
      'Transport'.padEnd(15) +
      ' | ' +
      'Ops/sec'.padStart(12) +
      ' | ' +
      'Avg Latency'.padStart(12) +
      ' | ' +
      'P99 Latency'.padStart(12) +
      ' | ' +
      'Error Rate'.padStart(12) +
      ' | ' +
      'Duration'.padStart(10) +
      ' |',
  );
  console.log('='.repeat(100));

  for (const r of results) {
    console.log(
      '| ' +
        r.name.padEnd(15) +
        ' | ' +
        formatNumber(r.opsPerSecond).padStart(12) +
        ' | ' +
        `${r.avgLatencyMs.toFixed(2)} ms`.padStart(12) +
        ' | ' +
        `${r.p99LatencyMs.toFixed(2)} ms`.padStart(12) +
        ' | ' +
        `${(r.errorRate * 100).toFixed(2)}%`.padStart(12) +
        ' | ' +
        `${(r.durationMs / 1000).toFixed(2)}s`.padStart(10) +
        ' |',
    );
  }
  console.log('='.repeat(100));
}

async function main() {
  console.log('Transport Benchmarks');
  console.log('====================\n');

  const iterations = 5000;
  const concurrencies = [1, 10, 50, 100];

  const handler = createHandler();

  // Setup transports
  const transports: { name: string; transport: Transport }[] = [
    { name: 'HTTP/1.1', transport: new HttpTransport() },
    { name: 'HTTP/2', transport: new Http2Transport() },
  ];

  // Try to load gRPC transport (optional dependency)
  try {
    const { GrpcTransport } = await import('../src/transport/grpc.js');
    transports.push({ name: 'gRPC', transport: new GrpcTransport() });
  } catch {
    console.log('Note: gRPC transport not available (install @grpc/grpc-js @grpc/proto-loader)\n');
  }

  // Start all servers
  const servers: { transport: Transport; address: string }[] = [];
  let port = 50000;

  for (const { name, transport } of transports) {
    await transport.listen(port, handler);
    servers.push({ transport, address: transport.listenAddress! });
    console.log(`Started ${name} server on ${transport.listenAddress}`);
    port++;
  }

  console.log('');

  // Run benchmarks at different concurrency levels
  for (const concurrency of concurrencies) {
    console.log(`\n### Concurrency: ${concurrency}`);
    console.log(`Iterations: ${formatNumber(iterations)}\n`);

    const results: BenchmarkResult[] = [];

    for (let i = 0; i < transports.length; i++) {
      const { name, transport } = transports[i]!;
      const { address } = servers[i]!;

      // Create a client transport for making requests
      const clientTransport = i === 0
        ? new HttpTransport()
        : i === 1
          ? new Http2Transport()
          : transports[i]!.transport; // gRPC can use same instance

      const result = await runBenchmark(name, clientTransport, address, iterations, concurrency);
      results.push(result);

      // Close client if different from server
      if (clientTransport !== transport) {
        await clientTransport.close();
      }
    }

    printResults(results);
  }

  // Cleanup
  console.log('\nShutting down servers...');
  for (const { transport } of servers) {
    await transport.close();
  }

  console.log('\n### Summary');
  console.log('- HTTP/1.1: Simple, widely compatible, connection per request');
  console.log('- HTTP/2: Multiplexed streams, better for high concurrency');
  console.log('- gRPC: Binary protocol, lowest latency, best for microservices');
}

main().catch(console.error);
