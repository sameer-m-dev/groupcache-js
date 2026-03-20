/**
 * Serialization Module
 *
 * Provides different serialization strategies for cache values.
 * - JSON: Human-readable, widely compatible (default)
 * - MessagePack: Binary, faster, smaller
 * - Custom: Implement the Serializer interface
 */

/**
 * Serializer interface for encoding/decoding values
 */
export interface Serializer<T = unknown> {
  /** Serialize a value to a buffer */
  serialize(value: T): Buffer;
  /** Deserialize a buffer to a value */
  deserialize(buffer: Buffer): T;
}

/**
 * JSON serializer - human-readable, widely compatible
 */
export const jsonSerializer: Serializer = {
  serialize: (value) => Buffer.from(JSON.stringify(value)),
  deserialize: (buffer) => JSON.parse(buffer.toString()),
};

/**
 * Create a type-safe JSON serializer
 */
export function createJsonSerializer<T>(): Serializer<T> {
  return {
    serialize: (value: T) => Buffer.from(JSON.stringify(value)),
    deserialize: (buffer: Buffer) => JSON.parse(buffer.toString()) as T,
  };
}

/**
 * MessagePack serializer options
 */
export interface MsgPackOptions {
  /** Maximum string length (default: 2^30) */
  maxStrLength?: number;
  /** Maximum binary length (default: 2^30) */
  maxBinLength?: number;
  /** Maximum array length (default: 2^30) */
  maxArrayLength?: number;
  /** Maximum map length (default: 2^30) */
  maxMapLength?: number;
}

/**
 * Create a MessagePack serializer
 *
 * Note: Requires 'msgpackr' to be installed:
 *   npm install msgpackr
 *
 * @param options - MessagePack options
 * @returns MessagePack serializer
 */
export function createMsgPackSerializer<T = unknown>(
  options: MsgPackOptions = {},
): Serializer<T> {
  // Lazy load msgpackr to make it optional
  let packr: {
    pack: (value: T) => Buffer;
    unpack: (buffer: Buffer) => T;
  } | null = null;

  const getPackr = () => {
    if (!packr) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Packr } = require('msgpackr') as { Packr: new (options?: MsgPackOptions) => typeof packr };
        packr = new Packr({
          maxStrLength: options.maxStrLength ?? 2 ** 30,
          maxBinLength: options.maxBinLength ?? 2 ** 30,
          maxArrayLength: options.maxArrayLength ?? 2 ** 30,
          maxMapLength: options.maxMapLength ?? 2 ** 30,
        });
      } catch {
        throw new Error(
          'msgpackr is required for MessagePack serialization. Install with: npm install msgpackr',
        );
      }
    }
    return packr;
  };

  return {
    serialize: (value: T) => {
      const p = getPackr();
      return p!.pack(value);
    },
    deserialize: (buffer: Buffer) => {
      const p = getPackr();
      return p!.unpack(buffer);
    },
  };
}

/**
 * Binary serializer for Buffer/Uint8Array values
 * No transformation, just pass through
 */
export const binarySerializer: Serializer<Buffer> = {
  serialize: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
  deserialize: (buffer) => buffer,
};

/**
 * String serializer for string values
 */
export const stringSerializer: Serializer<string> = {
  serialize: (value) => Buffer.from(value, 'utf-8'),
  deserialize: (buffer) => buffer.toString('utf-8'),
};

/**
 * Create a compressed serializer wrapper
 *
 * @param baseSerializer - The underlying serializer
 * @param compressionThreshold - Only compress if size > threshold (default: 1024)
 */
export function createCompressedSerializer<T>(
  baseSerializer: Serializer<T>,
  compressionThreshold: number = 1024,
): Serializer<T> {
  // Lazy load zlib
  let zlib: {
    gzipSync: (buffer: Buffer) => Buffer;
    gunzipSync: (buffer: Buffer) => Buffer;
  } | null = null;

  const getZlib = () => {
    if (!zlib) {
      zlib = require('node:zlib') as typeof zlib;
    }
    return zlib!;
  };

  // Magic byte to identify compressed data
  const COMPRESSED_MAGIC = 0x1f; // gzip magic byte

  return {
    serialize: (value: T) => {
      const data = baseSerializer.serialize(value);

      if (data.length > compressionThreshold) {
        return getZlib().gzipSync(data);
      }

      // Prepend 0x00 to indicate uncompressed
      if (data[0] === COMPRESSED_MAGIC) {
        const result = Buffer.allocUnsafe(data.length + 1);
        result[0] = 0x00;
        data.copy(result, 1);
        return result;
      }

      return data;
    },
    deserialize: (buffer: Buffer) => {
      if (buffer.length === 0) {
        return baseSerializer.deserialize(buffer);
      }

      // Check for gzip magic bytes
      if (buffer[0] === COMPRESSED_MAGIC && buffer[1] === 0x8b) {
        const decompressed = getZlib().gunzipSync(buffer);
        return baseSerializer.deserialize(decompressed);
      }

      // Check for escaped uncompressed data
      if (buffer[0] === 0x00) {
        return baseSerializer.deserialize(buffer.subarray(1));
      }

      return baseSerializer.deserialize(buffer);
    },
  };
}

/**
 * Serializer type name
 */
export type SerializerType = 'json' | 'msgpack' | 'binary' | 'string';

/**
 * Get a built-in serializer by name
 */
export function getSerializer<T = unknown>(type: SerializerType): Serializer<T> {
  switch (type) {
    case 'json':
      return jsonSerializer as Serializer<T>;
    case 'msgpack':
      return createMsgPackSerializer<T>();
    case 'binary':
      return binarySerializer as Serializer<T>;
    case 'string':
      return stringSerializer as Serializer<T>;
    default:
      throw new Error(`Unknown serializer type: ${type}`);
  }
}
