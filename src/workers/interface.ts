/**
 * Worker Thread Support - Types and Interfaces
 *
 * Provides type definitions for worker pool operations.
 */

/**
 * Worker pool configuration options
 */
export interface WorkerPoolOptions {
  /**
   * Number of worker threads in the pool.
   * Defaults to the number of CPU cores minus 1 (minimum 1).
   */
  size?: number;

  /**
   * Minimum payload size in bytes before offloading to workers.
   * Payloads smaller than this threshold will be processed in the main thread.
   * Defaults to 102400 (100KB).
   */
  threshold?: number;

  /**
   * Maximum number of tasks waiting in the queue.
   * If the queue is full, new tasks will be rejected.
   * Defaults to 1000.
   */
  maxQueueSize?: number;

  /**
   * Task distribution strategy.
   * - 'round-robin': Distribute tasks evenly across workers.
   * - 'least-busy': Send task to worker with shortest queue.
   * Defaults to 'least-busy'.
   */
  distribution?: 'round-robin' | 'least-busy';

  /**
   * Timeout for individual tasks in milliseconds.
   * Tasks that exceed this timeout will be rejected.
   * Defaults to 30000 (30 seconds).
   */
  taskTimeout?: number;

  /**
   * Whether to automatically restart crashed workers.
   * Defaults to true.
   */
  autoRestart?: boolean;
}

/**
 * Types of tasks that can be executed by workers
 */
export type WorkerTaskType =
  | 'serialize'
  | 'deserialize'
  | 'compress'
  | 'decompress'
  | 'msgpack-encode'
  | 'msgpack-decode';

/**
 * Base worker task structure
 */
export interface WorkerTaskBase {
  /** Unique task identifier */
  id: string;
  /** Type of operation to perform */
  type: WorkerTaskType;
  /** Optional timeout override for this task */
  timeout?: number | undefined;
}

/**
 * Task for JSON serialization
 */
export interface SerializeTask extends WorkerTaskBase {
  type: 'serialize';
  payload: unknown;
}

/**
 * Task for JSON deserialization
 */
export interface DeserializeTask extends WorkerTaskBase {
  type: 'deserialize';
  payload: Buffer | Uint8Array;
}

/**
 * Task for gzip compression
 */
export interface CompressTask extends WorkerTaskBase {
  type: 'compress';
  payload: Buffer | Uint8Array;
  /** Compression level (1-9). Defaults to 6. */
  level?: number | undefined;
}

/**
 * Task for gzip decompression
 */
export interface DecompressTask extends WorkerTaskBase {
  type: 'decompress';
  payload: Buffer | Uint8Array;
}

/**
 * Task for MessagePack encoding
 */
export interface MsgPackEncodeTask extends WorkerTaskBase {
  type: 'msgpack-encode';
  payload: unknown;
}

/**
 * Task for MessagePack decoding
 */
export interface MsgPackDecodeTask extends WorkerTaskBase {
  type: 'msgpack-decode';
  payload: Buffer | Uint8Array;
}

/**
 * Union of all worker task types
 */
export type WorkerTask =
  | SerializeTask
  | DeserializeTask
  | CompressTask
  | DecompressTask
  | MsgPackEncodeTask
  | MsgPackDecodeTask;

/**
 * Successful task result
 */
export interface WorkerResultSuccess {
  id: string;
  success: true;
  data: Buffer | unknown;
  /** Time taken to process in milliseconds */
  duration: number;
}

/**
 * Failed task result
 */
export interface WorkerResultError {
  id: string;
  success: false;
  error: string;
  /** Time taken before failure in milliseconds */
  duration: number;
}

/**
 * Union of success and error results
 */
export type WorkerResult = WorkerResultSuccess | WorkerResultError;

/**
 * Statistics about a single worker
 */
export interface WorkerStats {
  /** Worker ID */
  id: number;
  /** Number of tasks currently queued for this worker */
  queuedTasks: number;
  /** Total tasks completed by this worker */
  tasksCompleted: number;
  /** Total tasks failed by this worker */
  tasksFailed: number;
  /** Average task duration in milliseconds */
  avgDuration: number;
  /** Whether the worker is currently processing a task */
  busy: boolean;
  /** Whether the worker is alive */
  alive: boolean;
}

/**
 * Overall pool statistics
 */
export interface WorkerPoolStats {
  /** Number of workers in the pool */
  poolSize: number;
  /** Number of active (alive) workers */
  activeWorkers: number;
  /** Total tasks in all queues */
  queuedTasks: number;
  /** Total tasks completed across all workers */
  tasksCompleted: number;
  /** Total tasks failed across all workers */
  tasksFailed: number;
  /** Total tasks timed out */
  tasksTimedOut: number;
  /** Average task duration in milliseconds */
  avgDuration: number;
  /** Total bytes processed */
  bytesProcessed: number;
  /** Individual worker statistics */
  workers: WorkerStats[];
}

/**
 * Internal message sent from main thread to worker
 */
export interface WorkerMessage {
  task: WorkerTask;
}

/**
 * Internal message sent from worker to main thread
 */
export interface WorkerResponse {
  result: WorkerResult;
}

/**
 * Worker thread interface for type safety
 */
export interface WorkerThread {
  postMessage(message: WorkerMessage): void;
  on(event: 'message', listener: (response: WorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}
