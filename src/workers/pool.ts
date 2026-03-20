/**
 * Worker Pool Management
 *
 * Provides a pool of worker threads for offloading CPU-intensive operations.
 * Features:
 * - Configurable pool size
 * - Task queue with round-robin or least-busy distribution
 * - Graceful shutdown
 * - Error handling and worker crash recovery
 * - Statistics tracking
 */

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import type {
  WorkerPoolOptions,
  WorkerPoolStats,
  WorkerStats,
  WorkerTask,
  WorkerResult,
  WorkerMessage,
  WorkerResponse,
} from './interface.js';

/**
 * Inline worker script code
 * This allows the worker pool to work without a separate worker file
 */
const WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');
const { gzipSync, gunzipSync } = require('node:zlib');

let msgpackr = null;

function tryLoadMsgPack() {
  if (msgpackr !== null) return true;
  try {
    const { Packr } = require('msgpackr');
    msgpackr = new Packr();
    return true;
  } catch {
    return false;
  }
}

function processTask(task) {
  const startTime = performance.now();

  try {
    let data;

    switch (task.type) {
      case 'serialize': {
        const json = JSON.stringify(task.payload);
        data = Buffer.from(json);
        break;
      }

      case 'deserialize': {
        const buffer = Buffer.isBuffer(task.payload)
          ? task.payload
          : Buffer.from(task.payload);
        data = JSON.parse(buffer.toString('utf-8'));
        break;
      }

      case 'compress': {
        const buffer = Buffer.isBuffer(task.payload)
          ? task.payload
          : Buffer.from(task.payload);
        const level = task.level ?? 6;
        data = gzipSync(buffer, { level });
        break;
      }

      case 'decompress': {
        const buffer = Buffer.isBuffer(task.payload)
          ? task.payload
          : Buffer.from(task.payload);
        data = gunzipSync(buffer);
        break;
      }

      case 'msgpack-encode': {
        if (!tryLoadMsgPack()) {
          throw new Error(
            'msgpackr is required for MessagePack encoding. Install with: npm install msgpackr'
          );
        }
        data = msgpackr.pack(task.payload);
        break;
      }

      case 'msgpack-decode': {
        if (!tryLoadMsgPack()) {
          throw new Error(
            'msgpackr is required for MessagePack decoding. Install with: npm install msgpackr'
          );
        }
        const buffer = Buffer.isBuffer(task.payload)
          ? task.payload
          : Buffer.from(task.payload);
        data = msgpackr.unpack(buffer);
        break;
      }

      default: {
        throw new Error('Unknown task type: ' + task.type);
      }
    }

    return {
      id: task.id,
      success: true,
      data,
      duration: performance.now() - startTime,
    };
  } catch (error) {
    return {
      id: task.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: performance.now() - startTime,
    };
  }
}

if (parentPort) {
  parentPort.on('message', (message) => {
    const result = processTask(message.task);
    parentPort.postMessage({ result });
  });
}
`;

/**
 * Internal worker wrapper with queue and statistics
 */
interface WorkerWrapper {
  id: number;
  worker: Worker;
  queue: Map<string, {
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
    startTime: number;
  }>;
  tasksCompleted: number;
  tasksFailed: number;
  totalDuration: number;
  alive: boolean;
}

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Worker pool for offloading CPU-intensive operations
 */
export class WorkerPool {
  private readonly options: Required<WorkerPoolOptions>;
  private readonly workers: WorkerWrapper[] = [];
  private roundRobinIndex = 0;
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private totalTasksTimedOut = 0;
  private totalBytesProcessed = 0;
  private totalDuration = 0;
  private isShuttingDown = false;

  constructor(options: WorkerPoolOptions = {}) {
    const numCpus = cpus().length;

    this.options = {
      size: options.size ?? Math.max(1, numCpus - 1),
      threshold: options.threshold ?? 102400, // 100KB
      maxQueueSize: options.maxQueueSize ?? 1000,
      distribution: options.distribution ?? 'least-busy',
      taskTimeout: options.taskTimeout ?? 30000,
      autoRestart: options.autoRestart ?? true,
    };

    this.initializeWorkers();
  }

  /**
   * Initialize all worker threads
   */
  private initializeWorkers(): void {
    for (let i = 0; i < this.options.size; i++) {
      this.createWorker(i);
    }
  }

  /**
   * Create a single worker
   */
  private createWorker(id: number): void {
    // Use inline worker script via eval
    const worker = new Worker(WORKER_SCRIPT, { eval: true });

    const wrapper: WorkerWrapper = {
      id,
      worker,
      queue: new Map(),
      tasksCompleted: 0,
      tasksFailed: 0,
      totalDuration: 0,
      alive: true,
    };

    // Handle messages from worker
    worker.on('message', (response: WorkerResponse) => {
      this.handleWorkerResponse(wrapper, response);
    });

    // Handle worker errors
    worker.on('error', (error: Error) => {
      this.handleWorkerError(wrapper, error);
    });

    // Handle worker exit
    worker.on('exit', (code: number) => {
      this.handleWorkerExit(wrapper, code);
    });

    this.workers[id] = wrapper;
  }

  /**
   * Handle response from worker
   */
  private handleWorkerResponse(wrapper: WorkerWrapper, response: WorkerResponse): void {
    const { result } = response;
    const pending = wrapper.queue.get(result.id);

    if (!pending) {
      // Task might have been timed out or cancelled
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeoutId);
    wrapper.queue.delete(result.id);

    // Update statistics
    const duration = result.duration;
    wrapper.totalDuration += duration;
    this.totalDuration += duration;

    if (result.success) {
      wrapper.tasksCompleted++;
      this.totalTasksCompleted++;

      // Convert Uint8Array back to Buffer (worker threads serialize Buffers as Uint8Array)
      const data = result.data;
      if (data instanceof Uint8Array && !Buffer.isBuffer(data)) {
        (result as { data: Buffer | unknown }).data = Buffer.from(data);
        this.totalBytesProcessed += data.length;
      } else if (Buffer.isBuffer(data)) {
        this.totalBytesProcessed += data.length;
      }
    } else {
      wrapper.tasksFailed++;
      this.totalTasksFailed++;
    }

    pending.resolve(result);
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(wrapper: WorkerWrapper, error: Error): void {
    wrapper.alive = false;

    // Reject all pending tasks
    for (const [taskId, pending] of wrapper.queue) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Worker error: ${error.message}`));
      wrapper.queue.delete(taskId);
      wrapper.tasksFailed++;
      this.totalTasksFailed++;
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(wrapper: WorkerWrapper, code: number): void {
    wrapper.alive = false;

    // Reject all pending tasks
    for (const [taskId, pending] of wrapper.queue) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Worker exited with code ${code}`));
      wrapper.queue.delete(taskId);
      wrapper.tasksFailed++;
      this.totalTasksFailed++;
    }

    // Auto-restart if enabled and not shutting down
    if (this.options.autoRestart && !this.isShuttingDown) {
      this.createWorker(wrapper.id);
    }
  }

  /**
   * Get the next worker based on distribution strategy
   */
  private getNextWorker(): WorkerWrapper | null {
    const aliveWorkers = this.workers.filter(w => w.alive);
    if (aliveWorkers.length === 0) {
      return null;
    }

    if (this.options.distribution === 'round-robin') {
      // Find next alive worker starting from current index
      for (let i = 0; i < this.workers.length; i++) {
        const idx = (this.roundRobinIndex + i) % this.workers.length;
        const worker = this.workers[idx];
        if (worker?.alive) {
          this.roundRobinIndex = (idx + 1) % this.workers.length;
          return worker;
        }
      }
      return null;
    }

    // Least-busy: pick worker with smallest queue
    return aliveWorkers.reduce((min, current) =>
      current.queue.size < min.queue.size ? current : min
    );
  }

  /**
   * Execute a task in the worker pool
   */
  private async executeTask(task: WorkerTask): Promise<WorkerResult> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    const worker = this.getNextWorker();
    if (!worker) {
      throw new Error('No available workers');
    }

    // Check queue size
    const totalQueued = this.workers.reduce((sum, w) => sum + w.queue.size, 0);
    if (totalQueued >= this.options.maxQueueSize) {
      throw new Error('Worker pool queue is full');
    }

    return new Promise((resolve, reject) => {
      const timeout = task.timeout ?? this.options.taskTimeout;

      const timeoutId = setTimeout(() => {
        worker.queue.delete(task.id);
        this.totalTasksTimedOut++;
        reject(new Error(`Task ${task.id} timed out after ${timeout}ms`));
      }, timeout);

      worker.queue.set(task.id, {
        resolve,
        reject,
        timeoutId,
        startTime: performance.now(),
      });

      const message: WorkerMessage = { task };
      worker.worker.postMessage(message);
    });
  }

  /**
   * Serialize an object to a Buffer using JSON
   *
   * @param value - The value to serialize
   * @returns Serialized buffer
   */
  async serialize(value: unknown): Promise<Buffer> {
    // Check if we should offload based on estimated size
    const estimated = JSON.stringify(value);
    if (estimated.length < this.options.threshold) {
      // Process in main thread
      return Buffer.from(estimated);
    }

    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'serialize',
      payload: value,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as Buffer;
  }

  /**
   * Deserialize a Buffer to an object using JSON
   *
   * @param buffer - The buffer to deserialize
   * @returns Deserialized value
   */
  async deserialize<T = unknown>(buffer: Buffer | Uint8Array): Promise<T> {
    if (buffer.length < this.options.threshold) {
      // Process in main thread
      const str = Buffer.isBuffer(buffer) ? buffer.toString() : Buffer.from(buffer).toString();
      return JSON.parse(str) as T;
    }

    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'deserialize',
      payload: buffer,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as T;
  }

  /**
   * Compress a buffer using gzip
   *
   * @param buffer - The buffer to compress
   * @param level - Compression level (1-9, default: 6)
   * @returns Compressed buffer
   */
  async compress(buffer: Buffer | Uint8Array, level?: number): Promise<Buffer> {
    if (buffer.length < this.options.threshold) {
      // Process in main thread
      const { gzipSync } = await import('node:zlib');
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return gzipSync(buf, { level: level ?? 6 });
    }

    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'compress',
      payload: buffer,
      level,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as Buffer;
  }

  /**
   * Decompress a gzip buffer
   *
   * @param buffer - The buffer to decompress
   * @returns Decompressed buffer
   */
  async decompress(buffer: Buffer | Uint8Array): Promise<Buffer> {
    if (buffer.length < this.options.threshold) {
      // Process in main thread
      const { gunzipSync } = await import('node:zlib');
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return gunzipSync(buf);
    }

    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'decompress',
      payload: buffer,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as Buffer;
  }

  /**
   * Encode a value using MessagePack (requires msgpackr)
   *
   * @param value - The value to encode
   * @returns Encoded buffer
   */
  async msgpackEncode(value: unknown): Promise<Buffer> {
    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'msgpack-encode',
      payload: value,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as Buffer;
  }

  /**
   * Decode a MessagePack buffer (requires msgpackr)
   *
   * @param buffer - The buffer to decode
   * @returns Decoded value
   */
  async msgpackDecode<T = unknown>(buffer: Buffer | Uint8Array): Promise<T> {
    const task: WorkerTask = {
      id: generateTaskId(),
      type: 'msgpack-decode',
      payload: buffer,
    };

    const result = await this.executeTask(task);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data as T;
  }

  /**
   * Execute a raw task in the pool
   *
   * @param task - The task to execute
   * @returns Task result
   */
  async execute(task: Omit<WorkerTask, 'id'>): Promise<WorkerResult> {
    const fullTask = { ...task, id: generateTaskId() } as WorkerTask;
    return this.executeTask(fullTask);
  }

  /**
   * Get pool statistics
   */
  getStats(): WorkerPoolStats {
    const workerStats: WorkerStats[] = this.workers.map(w => ({
      id: w.id,
      queuedTasks: w.queue.size,
      tasksCompleted: w.tasksCompleted,
      tasksFailed: w.tasksFailed,
      avgDuration: w.tasksCompleted > 0 ? w.totalDuration / w.tasksCompleted : 0,
      busy: w.queue.size > 0,
      alive: w.alive,
    }));

    return {
      poolSize: this.options.size,
      activeWorkers: this.workers.filter(w => w.alive).length,
      queuedTasks: this.workers.reduce((sum, w) => sum + w.queue.size, 0),
      tasksCompleted: this.totalTasksCompleted,
      tasksFailed: this.totalTasksFailed,
      tasksTimedOut: this.totalTasksTimedOut,
      avgDuration: this.totalTasksCompleted > 0
        ? this.totalDuration / this.totalTasksCompleted
        : 0,
      bytesProcessed: this.totalBytesProcessed,
      workers: workerStats,
    };
  }

  /**
   * Get the threshold value
   */
  get threshold(): number {
    return this.options.threshold;
  }

  /**
   * Get the pool size
   */
  get size(): number {
    return this.options.size;
  }

  /**
   * Check if the pool is active
   */
  get isActive(): boolean {
    return !this.isShuttingDown && this.workers.some(w => w.alive);
  }

  /**
   * Gracefully shutdown the worker pool
   *
   * Waits for all pending tasks to complete before terminating workers.
   *
   * @param timeout - Maximum time to wait for pending tasks (default: 5000ms)
   */
  async shutdown(timeout: number = 5000): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    // Wait for pending tasks with timeout
    const startTime = Date.now();
    const waitForPending = async (): Promise<void> => {
      const hasPending = this.workers.some(w => w.queue.size > 0);
      if (!hasPending || Date.now() - startTime > timeout) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return waitForPending();
    };

    await waitForPending();

    // Reject any remaining tasks
    for (const wrapper of this.workers) {
      for (const [taskId, pending] of wrapper.queue) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Worker pool is shutting down'));
        wrapper.queue.delete(taskId);
      }
    }

    // Terminate all workers
    await Promise.all(
      this.workers.map(w => w.worker.terminate())
    );
  }
}
