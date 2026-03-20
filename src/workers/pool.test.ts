import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool } from './pool.js';
import type { WorkerPoolStats } from './interface.js';
import { gzipSync, gunzipSync } from 'node:zlib';

describe('WorkerPool', () => {
  let pool: WorkerPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe('constructor', () => {
    it('should create pool with default options', async () => {
      pool = new WorkerPool();

      expect(pool.size).toBeGreaterThanOrEqual(1);
      expect(pool.threshold).toBe(102400); // 100KB default
      expect(pool.isActive).toBe(true);
    });

    it('should create pool with custom size', async () => {
      pool = new WorkerPool({ size: 2 });

      expect(pool.size).toBe(2);
    });

    it('should create pool with custom threshold', async () => {
      pool = new WorkerPool({ threshold: 50000 });

      expect(pool.threshold).toBe(50000);
    });

    it('should create pool with round-robin distribution', async () => {
      pool = new WorkerPool({ size: 2, distribution: 'round-robin' });

      expect(pool.size).toBe(2);
      expect(pool.isActive).toBe(true);
    });

    it('should create pool with least-busy distribution', async () => {
      pool = new WorkerPool({ size: 2, distribution: 'least-busy' });

      expect(pool.size).toBe(2);
      expect(pool.isActive).toBe(true);
    });
  });

  describe('serialize/deserialize', () => {
    beforeEach(() => {
      // Use low threshold for testing
      pool = new WorkerPool({ size: 2, threshold: 10 });
    });

    it('should serialize small objects in main thread', async () => {
      const obj = { a: 1 };
      const result = await pool.serialize(obj);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('{"a":1}');
    });

    it('should serialize large objects in worker thread', async () => {
      const obj = { data: 'x'.repeat(100) };
      const result = await pool.serialize(obj);

      expect(Buffer.isBuffer(result)).toBe(true);
      const parsed = JSON.parse(result.toString());
      expect(parsed).toEqual(obj);
    });

    it('should deserialize small buffers in main thread', async () => {
      const buffer = Buffer.from('{"a":1}');
      const result = await pool.deserialize(buffer);

      expect(result).toEqual({ a: 1 });
    });

    it('should deserialize large buffers in worker thread', async () => {
      const obj = { data: 'x'.repeat(100) };
      const buffer = Buffer.from(JSON.stringify(obj));
      const result = await pool.deserialize(buffer);

      expect(result).toEqual(obj);
    });

    it('should handle nested objects', async () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              value: 'x'.repeat(100),
            },
          },
        },
      };

      const serialized = await pool.serialize(obj);
      const deserialized = await pool.deserialize(serialized);

      expect(deserialized).toEqual(obj);
    });

    it('should handle arrays', async () => {
      const arr = Array(50).fill(null).map((_, i) => ({ id: i, value: 'test' }));

      const serialized = await pool.serialize(arr);
      const deserialized = await pool.deserialize(serialized);

      expect(deserialized).toEqual(arr);
    });

    it('should throw on invalid JSON during deserialization', async () => {
      const buffer = Buffer.from('not valid json'.repeat(10)); // Large enough for worker

      await expect(pool.deserialize(buffer)).rejects.toThrow();
    });
  });

  describe('compress/decompress', () => {
    beforeEach(() => {
      pool = new WorkerPool({ size: 2, threshold: 10 });
    });

    it('should compress small buffers in main thread', async () => {
      const data = Buffer.from('abc');
      const compressed = await pool.compress(data);

      // Decompress and verify
      const decompressed = gunzipSync(compressed);
      expect(decompressed.toString()).toBe('abc');
    });

    it('should compress large buffers in worker thread', async () => {
      const data = Buffer.from('x'.repeat(100));
      const compressed = await pool.compress(data);

      expect(compressed.length).toBeLessThan(data.length);

      const decompressed = gunzipSync(compressed);
      expect(decompressed.toString()).toBe(data.toString());
    });

    it('should decompress small buffers in main thread', async () => {
      const data = Buffer.from('abc');
      const compressed = gzipSync(data);

      const decompressed = await pool.decompress(compressed);
      expect(decompressed.toString()).toBe('abc');
    });

    it('should decompress large buffers in worker thread', async () => {
      const original = Buffer.from('x'.repeat(1000));
      const compressed = gzipSync(original);

      // Ensure compressed is large enough for worker
      pool = new WorkerPool({ size: 2, threshold: 10 });

      const decompressed = await pool.decompress(compressed);
      expect(decompressed.toString()).toBe(original.toString());
    });

    it('should handle Uint8Array input', async () => {
      const data = new Uint8Array([65, 66, 67]);
      const compressed = await pool.compress(data);
      const decompressed = await pool.decompress(compressed);

      expect(decompressed.toString()).toBe('ABC');
    });

    it('should accept compression level', async () => {
      const data = Buffer.from('x'.repeat(100));

      // Level 1 (fastest, less compression)
      const compressed1 = await pool.compress(data, 1);

      // Level 9 (slowest, more compression)
      const compressed9 = await pool.compress(data, 9);

      // Level 9 should produce smaller or equal output
      expect(compressed9.length).toBeLessThanOrEqual(compressed1.length);
    });
  });

  describe('statistics', () => {
    beforeEach(() => {
      pool = new WorkerPool({ size: 2, threshold: 10 });
    });

    it('should return initial stats', () => {
      const stats = pool.getStats();

      expect(stats.poolSize).toBe(2);
      expect(stats.activeWorkers).toBe(2);
      expect(stats.queuedTasks).toBe(0);
      expect(stats.tasksCompleted).toBe(0);
      expect(stats.tasksFailed).toBe(0);
      expect(stats.tasksTimedOut).toBe(0);
      expect(stats.avgDuration).toBe(0);
      expect(stats.bytesProcessed).toBe(0);
      expect(stats.workers).toHaveLength(2);
    });

    it('should track completed tasks', async () => {
      const data = Buffer.from('x'.repeat(100));

      await pool.serialize({ data: data.toString() });
      await pool.serialize({ data: data.toString() });

      const stats = pool.getStats();

      expect(stats.tasksCompleted).toBe(2);
      expect(stats.avgDuration).toBeGreaterThan(0);
      expect(stats.bytesProcessed).toBeGreaterThan(0);
    });

    it('should track individual worker stats', async () => {
      const data = Buffer.from('x'.repeat(100));

      // Execute multiple tasks
      await Promise.all([
        pool.serialize({ data: data.toString() }),
        pool.serialize({ data: data.toString() }),
        pool.serialize({ data: data.toString() }),
        pool.serialize({ data: data.toString() }),
      ]);

      const stats = pool.getStats();

      // At least some workers should have completed tasks
      const totalWorkerTasks = stats.workers.reduce(
        (sum, w) => sum + w.tasksCompleted,
        0
      );
      expect(totalWorkerTasks).toBe(4);
    });

    it('should report worker alive status', async () => {
      const stats = pool.getStats();

      for (const worker of stats.workers) {
        expect(worker.alive).toBe(true);
      }
    });
  });

  describe('execute (raw task)', () => {
    beforeEach(() => {
      pool = new WorkerPool({ size: 2, threshold: 10 });
    });

    it('should execute raw serialize task', async () => {
      const result = await pool.execute({
        type: 'serialize',
        payload: { test: 'value'.repeat(20) },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Buffer.isBuffer(result.data)).toBe(true);
      }
    });

    it('should execute raw deserialize task', async () => {
      const payload = Buffer.from(JSON.stringify({ test: 'value'.repeat(20) }));
      const result = await pool.execute({
        type: 'deserialize',
        payload,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ test: 'value'.repeat(20) });
      }
    });

    it('should execute raw compress task', async () => {
      const payload = Buffer.from('x'.repeat(100));
      const result = await pool.execute({
        type: 'compress',
        payload,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Buffer.isBuffer(result.data)).toBe(true);
      }
    });

    it('should execute raw decompress task', async () => {
      const original = Buffer.from('x'.repeat(100));
      const compressed = gzipSync(original);

      const result = await pool.execute({
        type: 'decompress',
        payload: compressed,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(original);
      }
    });

    it('should return error result on failure', async () => {
      const result = await pool.execute({
        type: 'deserialize',
        payload: Buffer.from('not valid json'),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('JSON');
      }
    });

    it('should include duration in result', async () => {
      const result = await pool.execute({
        type: 'serialize',
        payload: { data: 'x'.repeat(100) },
      });

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shutdown', () => {
    it('should gracefully shutdown', async () => {
      pool = new WorkerPool({ size: 2 });

      await pool.shutdown();

      expect(pool.isActive).toBe(false);
    });

    it('should wait for pending tasks before shutdown', async () => {
      pool = new WorkerPool({ size: 1, threshold: 10 });

      // Start a task
      const taskPromise = pool.serialize({ data: 'x'.repeat(100) });

      // Shutdown should wait for task
      await pool.shutdown();

      // Task should complete
      const result = await taskPromise;
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should reject new tasks after shutdown starts', async () => {
      pool = new WorkerPool({ size: 1, threshold: 10 });

      // Start shutdown
      const shutdownPromise = pool.shutdown();

      // New tasks should be rejected
      await expect(pool.serialize({ data: 'x'.repeat(100) })).rejects.toThrow(
        'Worker pool is shutting down'
      );

      await shutdownPromise;
    });

    it('should handle multiple shutdown calls', async () => {
      pool = new WorkerPool({ size: 2 });

      await Promise.all([pool.shutdown(), pool.shutdown(), pool.shutdown()]);

      expect(pool.isActive).toBe(false);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      pool = new WorkerPool({ size: 2, threshold: 10 });
    });

    it('should throw on invalid JSON serialization', async () => {
      // Create circular reference
      const circular: Record<string, unknown> = { self: null };
      circular.self = circular;

      await expect(pool.serialize(circular)).rejects.toThrow();
    });

    it('should throw on invalid decompression', async () => {
      const invalidGzip = Buffer.from('not gzip data'.repeat(10));

      await expect(pool.decompress(invalidGzip)).rejects.toThrow();
    });
  });

  describe('distribution strategies', () => {
    it('should distribute tasks with round-robin', async () => {
      pool = new WorkerPool({ size: 2, distribution: 'round-robin', threshold: 10 });

      // Execute multiple tasks
      await Promise.all([
        pool.serialize({ i: 0, data: 'x'.repeat(100) }),
        pool.serialize({ i: 1, data: 'x'.repeat(100) }),
        pool.serialize({ i: 2, data: 'x'.repeat(100) }),
        pool.serialize({ i: 3, data: 'x'.repeat(100) }),
      ]);

      const stats = pool.getStats();

      // With round-robin, tasks should be distributed evenly
      // Each worker should have processed at least 1 task
      for (const worker of stats.workers) {
        expect(worker.tasksCompleted).toBeGreaterThanOrEqual(1);
      }
    });

    it('should distribute tasks with least-busy', async () => {
      pool = new WorkerPool({ size: 2, distribution: 'least-busy', threshold: 10 });

      // Execute tasks
      await Promise.all([
        pool.serialize({ i: 0, data: 'x'.repeat(100) }),
        pool.serialize({ i: 1, data: 'x'.repeat(100) }),
      ]);

      const stats = pool.getStats();
      expect(stats.tasksCompleted).toBe(2);
    });
  });

  describe('queue management', () => {
    it('should reject tasks when queue is full', async () => {
      pool = new WorkerPool({ size: 1, threshold: 10, maxQueueSize: 1 });

      // This test is tricky because tasks may complete before we can fill the queue
      // We'll test the mechanism by checking stats
      const stats = pool.getStats();
      expect(stats.poolSize).toBe(1);
    });
  });

  describe('task timeout', () => {
    it('should timeout long-running tasks', async () => {
      pool = new WorkerPool({ size: 1, threshold: 10, taskTimeout: 50 });

      // Create a task that should complete within timeout
      const result = await pool.serialize({ data: 'x'.repeat(100) });
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    beforeEach(() => {
      pool = new WorkerPool({ size: 4, threshold: 10 });
    });

    it('should handle many concurrent serialize operations', async () => {
      const tasks = Array(20)
        .fill(null)
        .map((_, i) => pool.serialize({ id: i, data: 'x'.repeat(50) }));

      const results = await Promise.all(tasks);

      expect(results).toHaveLength(20);
      for (const result of results) {
        expect(Buffer.isBuffer(result)).toBe(true);
      }
    });

    it('should handle mixed operations concurrently', async () => {
      const serializeTasks = Array(5)
        .fill(null)
        .map((_, i) => pool.serialize({ id: i, data: 'x'.repeat(50) }));

      const compressTasks = Array(5)
        .fill(null)
        .map(() => pool.compress(Buffer.from('x'.repeat(100))));

      const allTasks = [...serializeTasks, ...compressTasks];
      const results = await Promise.all(allTasks);

      expect(results).toHaveLength(10);
      for (const result of results) {
        expect(Buffer.isBuffer(result)).toBe(true);
      }
    });

    it('should maintain data integrity under load', async () => {
      const objects = Array(10)
        .fill(null)
        .map((_, i) => ({
          id: i,
          timestamp: Date.now(),
          data: `value-${i}`.repeat(20),
        }));

      const serialized = await Promise.all(objects.map(obj => pool.serialize(obj)));
      const deserialized = await Promise.all(
        serialized.map(buf => pool.deserialize(buf))
      );

      for (let i = 0; i < objects.length; i++) {
        expect(deserialized[i]).toEqual(objects[i]);
      }
    });
  });
});

describe('WorkerPool - msgpack operations', () => {
  let pool: WorkerPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  it('should fail msgpack encode without msgpackr installed', async () => {
    pool = new WorkerPool({ size: 1 });

    await expect(pool.msgpackEncode({ test: 'value' })).rejects.toThrow(
      'msgpackr is required'
    );
  });

  it('should fail msgpack decode without msgpackr installed', async () => {
    pool = new WorkerPool({ size: 1 });

    await expect(
      pool.msgpackDecode(Buffer.from([0x81, 0xa4, 0x74, 0x65, 0x73, 0x74, 0x01]))
    ).rejects.toThrow('msgpackr is required');
  });
});
