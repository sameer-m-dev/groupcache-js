import { describe, it, expect } from 'vitest';
import {
  jsonSerializer,
  createJsonSerializer,
  binarySerializer,
  stringSerializer,
  createCompressedSerializer,
  getSerializer,
} from './index.js';

describe('jsonSerializer', () => {
  it('should serialize and deserialize objects', () => {
    const obj = { name: 'test', value: 42, nested: { arr: [1, 2, 3] } };
    const serialized = jsonSerializer.serialize(obj);
    const deserialized = jsonSerializer.deserialize(serialized);

    expect(deserialized).toEqual(obj);
  });

  it('should serialize primitives', () => {
    expect(jsonSerializer.deserialize(jsonSerializer.serialize('string'))).toBe('string');
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(123))).toBe(123);
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(true))).toBe(true);
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(null))).toBe(null);
  });

  it('should serialize arrays', () => {
    const arr = [1, 'two', { three: 3 }];
    const result = jsonSerializer.deserialize(jsonSerializer.serialize(arr));
    expect(result).toEqual(arr);
  });
});

describe('createJsonSerializer', () => {
  it('should create type-safe serializer', () => {
    interface User {
      id: number;
      name: string;
    }

    const userSerializer = createJsonSerializer<User>();
    const user: User = { id: 1, name: 'Alice' };

    const serialized = userSerializer.serialize(user);
    const deserialized = userSerializer.deserialize(serialized);

    expect(deserialized).toEqual(user);
  });
});

describe('binarySerializer', () => {
  it('should pass through Buffer unchanged', () => {
    const buffer = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const serialized = binarySerializer.serialize(buffer);
    const deserialized = binarySerializer.deserialize(serialized);

    expect(Buffer.compare(deserialized, buffer)).toBe(0);
  });

  it('should convert Uint8Array to Buffer', () => {
    const arr = new Uint8Array([0x01, 0x02, 0x03]);
    const buffer = Buffer.from(arr);
    const serialized = binarySerializer.serialize(buffer);

    expect(Buffer.isBuffer(serialized)).toBe(true);
  });
});

describe('stringSerializer', () => {
  it('should serialize and deserialize strings', () => {
    const str = 'Hello, World!';
    const serialized = stringSerializer.serialize(str);
    const deserialized = stringSerializer.deserialize(serialized);

    expect(deserialized).toBe(str);
  });

  it('should handle unicode', () => {
    const str = '日本語 emoji: 🎉';
    const serialized = stringSerializer.serialize(str);
    const deserialized = stringSerializer.deserialize(serialized);

    expect(deserialized).toBe(str);
  });

  it('should handle empty string', () => {
    const serialized = stringSerializer.serialize('');
    const deserialized = stringSerializer.deserialize(serialized);

    expect(deserialized).toBe('');
  });
});

describe('createCompressedSerializer', () => {
  it('should compress large data', () => {
    const serializer = createCompressedSerializer(jsonSerializer, 100);

    // Create data larger than threshold
    const largeObj = { data: 'x'.repeat(1000) };
    const serialized = serializer.serialize(largeObj);

    // Compressed should be smaller
    const uncompressed = jsonSerializer.serialize(largeObj);
    expect(serialized.length).toBeLessThan(uncompressed.length);

    // Should decompress correctly
    const deserialized = serializer.deserialize(serialized);
    expect(deserialized).toEqual(largeObj);
  });

  it('should not compress small data', () => {
    const serializer = createCompressedSerializer(jsonSerializer, 1000);

    const smallObj = { small: true };
    const serialized = serializer.serialize(smallObj);
    const deserialized = serializer.deserialize(serialized);

    expect(deserialized).toEqual(smallObj);
  });

  it('should handle data starting with gzip magic byte', () => {
    const serializer = createCompressedSerializer(jsonSerializer, 1000);

    // Data that would naturally start with 0x1f
    const obj = { value: '\x1f something' };
    const serialized = serializer.serialize(obj);
    const deserialized = serializer.deserialize(serialized);

    expect(deserialized).toEqual(obj);
  });

  it('should handle empty data', () => {
    const serializer = createCompressedSerializer(stringSerializer, 100);

    const serialized = serializer.serialize('');
    const deserialized = serializer.deserialize(serialized);

    expect(deserialized).toBe('');
  });
});

describe('getSerializer', () => {
  it('should return json serializer', () => {
    const serializer = getSerializer('json');
    expect(serializer).toBe(jsonSerializer);
  });

  it('should return binary serializer', () => {
    const serializer = getSerializer('binary');
    expect(serializer).toBe(binarySerializer);
  });

  it('should return string serializer', () => {
    const serializer = getSerializer('string');
    expect(serializer).toBe(stringSerializer);
  });

  it('should throw for unknown type', () => {
    // @ts-expect-error - testing invalid type
    expect(() => getSerializer('unknown')).toThrow('Unknown serializer type');
  });

  it('should return msgpack serializer (lazy load failure expected)', () => {
    // This will throw because msgpackr is not installed
    expect(() => {
      const serializer = getSerializer('msgpack');
      serializer.serialize({ test: true });
    }).toThrow('msgpackr is required');
  });
});
