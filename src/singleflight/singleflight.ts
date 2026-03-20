/**
 * Singleflight Implementation
 *
 * Provides request deduplication - when multiple concurrent requests
 * come in for the same key, only one executes and all waiters receive
 * the same result.
 *
 * This prevents the "thundering herd" problem where a cache miss
 * triggers many simultaneous expensive operations (e.g., database queries).
 */

/**
 * Represents an in-flight call
 */
interface Call<T> {
  /** Promise that all waiters are waiting on */
  promise: Promise<T>;
  /** Resolve function (called when fn completes) */
  resolve: (value: T) => void;
  /** Reject function (called when fn throws) */
  reject: (error: unknown) => void;
  /** Number of waiters (including original caller) */
  waiters: number;
}

/**
 * Result from a singleflight call
 */
export interface SingleflightResult<T> {
  /** The value returned by the function */
  value: T;
  /** Whether this caller was the one that executed the function */
  executed: boolean;
  /** Number of waiters that shared this result (including executor) */
  shared: number;
}

/**
 * Singleflight deduplicates concurrent function calls for the same key
 */
export class Singleflight {
  private readonly calls: Map<string, Call<unknown>> = new Map();

  /**
   * Execute a function with deduplication for the given key.
   * If there's already an in-flight call for this key, wait for it.
   * Otherwise, execute the function and share the result with any
   * other callers that arrive while it's running.
   *
   * @param key - Unique identifier for this operation
   * @param fn - Function to execute
   * @returns Promise resolving to the function result
   */
  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.doWithInfo(key, fn);
    return result.value;
  }

  /**
   * Same as do(), but returns additional information about
   * whether this caller executed the function or waited.
   */
  async doWithInfo<T>(key: string, fn: () => Promise<T>): Promise<SingleflightResult<T>> {
    // Check if there's already an in-flight call
    const existing = this.calls.get(key) as Call<T> | undefined;
    if (existing) {
      existing.waiters++;
      try {
        const value = await existing.promise;
        return {
          value,
          executed: false,
          shared: existing.waiters,
        };
      } finally {
        // Don't decrement waiters here - the executor handles cleanup
      }
    }

    // Create new call
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const call: Call<T> = {
      promise,
      resolve,
      reject,
      waiters: 1,
    };

    this.calls.set(key, call as Call<unknown>);

    try {
      const value = await fn();
      call.resolve(value);
      return {
        value,
        executed: true,
        shared: call.waiters,
      };
    } catch (error) {
      call.reject(error);
      throw error;
    } finally {
      this.calls.delete(key);
    }
  }

  /**
   * Check if there's an in-flight call for the given key
   */
  isInFlight(key: string): boolean {
    return this.calls.has(key);
  }

  /**
   * Get the number of currently in-flight calls
   */
  get inFlightCount(): number {
    return this.calls.size;
  }

  /**
   * Forget an in-flight call, allowing the next caller to execute.
   * Note: This does NOT cancel the in-flight call - it just allows
   * a new call to start. Use with caution.
   */
  forget(key: string): boolean {
    return this.calls.delete(key);
  }

  /**
   * Clear all in-flight tracking.
   * Note: This does NOT cancel in-flight calls.
   */
  clear(): void {
    this.calls.clear();
  }
}

/**
 * Global singleflight instance for convenience
 */
export const globalSingleflight = new Singleflight();
