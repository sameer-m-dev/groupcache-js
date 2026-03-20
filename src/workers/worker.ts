/**
 * Worker Thread Script
 *
 * This file runs in a worker thread and handles CPU-intensive operations:
 * - JSON serialization/deserialization
 * - Gzip compression/decompression
 * - MessagePack encoding/decoding (if available)
 */

import { parentPort } from 'node:worker_threads';
import { gzipSync, gunzipSync } from 'node:zlib';
import type {
  WorkerMessage,
  WorkerResponse,
  WorkerResult,
  WorkerTask,
} from './interface.js';

// MessagePack support (optional)
let msgpackr: {
  pack: (value: unknown) => Buffer;
  unpack: (buffer: Buffer) => unknown;
} | null = null;

function tryLoadMsgPack(): boolean {
  if (msgpackr !== null) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Packr } = require('msgpackr') as {
      Packr: new () => typeof msgpackr;
    };
    msgpackr = new Packr();
    return true;
  } catch {
    return false;
  }
}

/**
 * Process a task and return the result
 */
function processTask(task: WorkerTask): WorkerResult {
  const startTime = performance.now();

  try {
    let data: Buffer | unknown;

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
        data = msgpackr!.pack(task.payload);
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
        data = msgpackr!.unpack(buffer);
        break;
      }

      default: {
        // TypeScript exhaustive check
        const _exhaustive: never = task;
        throw new Error(`Unknown task type: ${(_exhaustive as WorkerTask).type}`);
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

// Main worker loop
if (parentPort) {
  parentPort.on('message', (message: WorkerMessage) => {
    const result = processTask(message.task);
    const response: WorkerResponse = { result };
    parentPort!.postMessage(response);
  });
}

// Export for testing purposes
export { processTask };
