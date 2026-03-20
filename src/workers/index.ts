/**
 * Worker Thread Support Module
 *
 * Provides worker pool functionality for offloading CPU-intensive operations
 * (serialization, compression) to background threads.
 *
 * @example
 * ```typescript
 * import { WorkerPool } from 'groupcache-js/workers';
 *
 * const pool = new WorkerPool({ size: 4, threshold: 102400 });
 *
 * // Serialize large objects in worker threads
 * const serialized = await pool.serialize(largeObject);
 *
 * // Compress data in worker threads
 * const compressed = await pool.compress(buffer);
 *
 * // Get pool statistics
 * const stats = pool.getStats();
 *
 * // Gracefully shutdown
 * await pool.shutdown();
 * ```
 */

export { WorkerPool } from './pool.js';

export type {
  WorkerPoolOptions,
  WorkerPoolStats,
  WorkerStats,
  WorkerTaskType,
  WorkerTask,
  WorkerTaskBase,
  SerializeTask,
  DeserializeTask,
  CompressTask,
  DecompressTask,
  MsgPackEncodeTask,
  MsgPackDecodeTask,
  WorkerResult,
  WorkerResultSuccess,
  WorkerResultError,
} from './interface.js';
