import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, jsonSerializer } from './group.js';
import type { GroupDependencies } from './group.js';
import type { Context, PeerInfo } from './types.js';
import { ConsistentHash } from './hash/consistent.js';
import type { Transport, GetResponse } from './transport/interface.js';
import { NotFoundError } from './transport/interface.js';

// Mock transport
function createMockTransport(): Transport {
  return {
    listen: vi.fn(),
    close: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    removeMany: vi.fn(),
    listenAddress: 'http://localhost:8080',
  };
}

// Create dependencies
function createDeps(
  selfAddress: string,
  peers: PeerInfo[],
  transport?: Transport,
): GroupDependencies {
  const hashRing = new ConsistentHash();
  hashRing.add(...peers.map((p) => p.address));

  return {
    hashRing,
    transport: transport ?? createMockTransport(),
    selfAddress,
    getPeers: () => peers,
  };
}

describe('Group', () => {
  describe('constructor', () => {
    it('should create group with basic options', () => {
      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter: async () => 'value',
      });

      expect(group.name).toBe('test');
    });

    it('should accept numeric maxSize', () => {
      const group = new Group({
        name: 'test',
        maxSize: 1024 * 1024,
        getter: async () => 'value',
      });

      expect(group.name).toBe('test');
    });
  });

  describe('get (standalone mode)', () => {
    it('should call getter on cache miss', async () => {
      const getter = vi.fn().mockResolvedValue('loaded-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const result = await group.get('key1');

      expect(result).toBe('loaded-value');
      expect(getter).toHaveBeenCalledWith(expect.any(Object), 'key1');
    });

    it('should return cached value on cache hit', async () => {
      const getter = vi.fn().mockResolvedValue('loaded-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.get('key1');
      const result = await group.get('key1');

      expect(result).toBe('loaded-value');
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent requests', async () => {
      let resolveGetter: (value: string) => void;
      const getter = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolveGetter = resolve;
        });
      });

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      // Start multiple concurrent requests
      const p1 = group.get('key1');
      const p2 = group.get('key1');
      const p3 = group.get('key1');

      // Getter should only be called once
      expect(getter).toHaveBeenCalledTimes(1);

      // Resolve
      resolveGetter!('shared-value');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toBe('shared-value');
      expect(r2).toBe('shared-value');
      expect(r3).toBe('shared-value');
    });

    it('should track statistics', async () => {
      const getter = vi.fn().mockResolvedValue('value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.get('key1');
      await group.get('key1'); // Hit
      await group.get('key2');

      const stats = group.getStats();

      expect(stats.gets).toBe(3);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.loads).toBe(2);
    });

    it('should handle getter errors', async () => {
      const getter = vi.fn().mockRejectedValue(new Error('Load failed'));

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      try {
        await group.get('key1');
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toBe('Load failed');
      }

      const stats = group.getStats();
      expect(stats.localLoadErrors).toBe(1);
    });

    it('should support getter returning result with TTL', async () => {
      vi.useFakeTimers();

      const getter = vi.fn().mockResolvedValue({
        value: 'expiring-value',
        ttl: 1000,
      });

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.get('key1');

      // Should be cached
      await group.get('key1');
      expect(getter).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Should reload
      await group.get('key1');
      expect(getter).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('get (distributed mode)', () => {
    it('should fetch from peer when not owner', async () => {
      const getter = vi.fn().mockResolvedValue('local-value');
      const transport = createMockTransport();

      (transport.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: Buffer.from(JSON.stringify('peer-value')),
        hit: true,
      } as GetResponse);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const peers: PeerInfo[] = [
        { address: 'http://peer1:8080', isSelf: false },
        { address: 'http://self:8080', isSelf: true },
      ];

      const deps = createDeps('http://self:8080', peers, transport);
      group.setDependencies(deps);

      // Get a key that hashes to peer1
      // We need to find a key that goes to the non-self peer
      let testKey = 'key1';
      for (let i = 0; i < 100; i++) {
        const owner = deps.hashRing.get(`key${i}`);
        if (owner === 'http://peer1:8080') {
          testKey = `key${i}`;
          break;
        }
      }

      const result = await group.get(testKey);

      expect(result).toBe('peer-value');
      expect(transport.get).toHaveBeenCalled();
      // Getter should NOT be called since we fetched from peer
      expect(getter).not.toHaveBeenCalled();
    });

    it('should fall back to local on peer error', async () => {
      const getter = vi.fn().mockResolvedValue('fallback-value');
      const transport = createMockTransport();

      (transport.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection failed'));

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const peers: PeerInfo[] = [
        { address: 'http://peer1:8080', isSelf: false },
        { address: 'http://self:8080', isSelf: true },
      ];

      const deps = createDeps('http://self:8080', peers, transport);
      group.setDependencies(deps);

      // Find a key that goes to peer1
      let testKey = 'key1';
      for (let i = 0; i < 100; i++) {
        const owner = deps.hashRing.get(`key${i}`);
        if (owner === 'http://peer1:8080') {
          testKey = `key${i}`;
          break;
        }
      }

      const result = await group.get(testKey);

      expect(result).toBe('fallback-value');
      expect(getter).toHaveBeenCalled();

      const stats = group.getStats();
      expect(stats.peerErrors).toBe(1);
    });

    it('should store in hot cache when fetching from peer', async () => {
      const getter = vi.fn().mockResolvedValue('local-value');
      const transport = createMockTransport();

      (transport.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: Buffer.from(JSON.stringify('peer-value')),
      } as GetResponse);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const peers: PeerInfo[] = [
        { address: 'http://peer1:8080', isSelf: false },
        { address: 'http://self:8080', isSelf: true },
      ];

      const deps = createDeps('http://self:8080', peers, transport);
      group.setDependencies(deps);

      // Find key that goes to peer1
      let testKey = 'key1';
      for (let i = 0; i < 100; i++) {
        const owner = deps.hashRing.get(`key${i}`);
        if (owner === 'http://peer1:8080') {
          testKey = `key${i}`;
          break;
        }
      }

      await group.get(testKey);

      // Second request should hit hot cache
      (transport.get as ReturnType<typeof vi.fn>).mockClear();
      await group.get(testKey);

      expect(transport.get).not.toHaveBeenCalled();

      const stats = group.getStats();
      expect(stats.hotCacheHits).toBe(1);
    });
  });

  describe('set', () => {
    it('should store value in cache', async () => {
      const getter = vi.fn().mockResolvedValue('getter-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'set-value');
      const result = await group.get('key1');

      expect(result).toBe('set-value');
      expect(getter).not.toHaveBeenCalled();
    });

    it('should respect TTL option', async () => {
      vi.useFakeTimers();

      const getter = vi.fn().mockResolvedValue('reloaded');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'value', { ttl: 1000 });

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Should trigger reload
      const result = await group.get('key1');
      expect(result).toBe('reloaded');
      expect(getter).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should respect expireAt option', async () => {
      vi.useFakeTimers();

      const getter = vi.fn().mockResolvedValue('reloaded');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const expireAt = new Date(Date.now() + 1000);
      await group.set('key1', 'value', { expireAt });

      vi.advanceTimersByTime(1001);

      const result = await group.get('key1');
      expect(result).toBe('reloaded');

      vi.useRealTimers();
    });
  });

  describe('remove', () => {
    it('should remove value from cache', async () => {
      const getter = vi.fn().mockResolvedValue('new-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'old-value');
      await group.remove('key1');

      const result = await group.get('key1');

      expect(result).toBe('new-value');
      expect(getter).toHaveBeenCalled();
    });

    it('should propagate removal to peers', async () => {
      const transport = createMockTransport();
      (transport.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter: async () => 'value',
      });

      const peers: PeerInfo[] = [
        { address: 'http://peer1:8080', isSelf: false },
        { address: 'http://peer2:8080', isSelf: false },
        { address: 'http://self:8080', isSelf: true },
      ];

      const deps = createDeps('http://self:8080', peers, transport);
      group.setDependencies(deps);

      await group.remove('key1');

      expect(transport.remove).toHaveBeenCalledTimes(2); // peer1 and peer2
    });
  });

  describe('removeMany', () => {
    it('should remove multiple values from cache', async () => {
      let callCount = 0;
      const getter = vi.fn().mockImplementation(() => `value${++callCount}`);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'old1');
      await group.set('key2', 'old2');
      await group.set('key3', 'old3');

      await group.removeMany(['key1', 'key2']);

      // key1 and key2 should reload
      expect(await group.get('key1')).toBe('value1');
      expect(await group.get('key2')).toBe('value2');

      // key3 should still be cached
      expect(await group.get('key3')).toBe('old3');
    });

    it('should propagate removal to peers', async () => {
      const transport = createMockTransport();
      (transport.removeMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter: async () => 'value',
      });

      const peers: PeerInfo[] = [
        { address: 'http://peer1:8080', isSelf: false },
        { address: 'http://self:8080', isSelf: true },
      ];

      const deps = createDeps('http://self:8080', peers, transport);
      group.setDependencies(deps);

      await group.removeMany(['key1', 'key2', 'key3']);

      expect(transport.removeMany).toHaveBeenCalledWith(
        expect.any(Object),
        'http://peer1:8080',
        { group: 'test', keys: ['key1', 'key2', 'key3'] },
      );
    });
  });

  describe('clear', () => {
    it('should clear all cached values', async () => {
      let callCount = 0;
      const getter = vi.fn().mockImplementation(() => `value${++callCount}`);

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.get('key1');
      await group.get('key2');

      group.clear();

      expect(await group.get('key1')).toBe('value3');
      expect(await group.get('key2')).toBe('value4');
    });
  });

  describe('peer request handlers', () => {
    it('handlePeerGet should return cached value', async () => {
      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter: async () => 'loaded',
      });

      // First load
      await group.get('key1');

      // Peer request
      const response = await group.handlePeerGet({}, 'key1');

      expect(JSON.parse(response.value.toString())).toBe('loaded');
      expect(response.hit).toBe(true);
    });

    it('handlePeerGet should load on miss', async () => {
      const getter = vi.fn().mockResolvedValue('loaded-for-peer');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const response = await group.handlePeerGet({}, 'key1');

      expect(JSON.parse(response.value.toString())).toBe('loaded-for-peer');
      expect(response.hit).toBe(false);
    });

    it('handlePeerSet should store value', async () => {
      const getter = vi.fn().mockResolvedValue('getter-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      group.handlePeerSet('key1', Buffer.from(JSON.stringify('peer-value')));

      const result = await group.get('key1');
      expect(result).toBe('peer-value');
      expect(getter).not.toHaveBeenCalled();
    });

    it('handlePeerRemove should remove value', async () => {
      const getter = vi.fn().mockResolvedValue('new-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'old-value');
      group.handlePeerRemove('key1');

      const result = await group.get('key1');
      expect(result).toBe('new-value');
    });

    it('handlePeerRemoveMany should remove values', async () => {
      const getter = vi.fn().mockResolvedValue('new-value');

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.set('key1', 'old1');
      await group.set('key2', 'old2');

      group.handlePeerRemoveMany(['key1', 'key2']);

      expect(getter).toHaveBeenCalledTimes(0);

      // Both should reload
      await group.get('key1');
      await group.get('key2');

      expect(getter).toHaveBeenCalledTimes(2);
    });
  });

  describe('serialization', () => {
    it('should use custom serializer', async () => {
      const customSerializer = {
        serialize: vi.fn().mockImplementation((v) => Buffer.from(String(v))),
        deserialize: vi.fn().mockImplementation((b) => parseInt(b.toString())),
      };

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter: async () => 42,
        serializer: customSerializer,
      });

      await group.get('key1');
      const result = await group.get('key1');

      expect(customSerializer.serialize).toHaveBeenCalled();
      expect(customSerializer.deserialize).toHaveBeenCalled();
      expect(result).toBe(42);
    });
  });

  describe('statistics', () => {
    it('should track all statistics correctly', async () => {
      const getter = vi.fn()
        .mockResolvedValueOnce('value1')
        .mockResolvedValueOnce('value2')
        .mockRejectedValueOnce(new Error('fail'));

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      await group.get('key1'); // Miss, load
      await group.get('key1'); // Hit
      await group.get('key2'); // Miss, load
      await group.get('key1'); // Hit (key1 is still cached)
      try {
        await group.get('key3'); // Miss, error
      } catch {
        // Expected
      }

      const stats = group.getStats();

      expect(stats.gets).toBe(5);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(3);
      expect(stats.loads).toBe(3);
      expect(stats.localLoads).toBe(3);
      expect(stats.localLoadErrors).toBe(1);
    });

    it('should track deduplication', async () => {
      let resolveGetter: () => void;
      const getter = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveGetter = () => resolve('value');
        });
      });

      const group = new Group({
        name: 'test',
        maxSize: '1MB',
        getter,
      });

      const promises = [
        group.get('key1'),
        group.get('key1'),
        group.get('key1'),
      ];

      resolveGetter!();
      await Promise.all(promises);

      const stats = group.getStats();
      expect(stats.loadsDeduped).toBe(2); // 2 waited, 1 executed
    });
  });
});

describe('jsonSerializer', () => {
  it('should serialize and deserialize objects', () => {
    const obj = { name: 'test', value: 42 };
    const serialized = jsonSerializer.serialize(obj);
    const deserialized = jsonSerializer.deserialize(serialized);

    expect(deserialized).toEqual(obj);
  });

  it('should handle arrays', () => {
    const arr = [1, 2, 3, 'a', 'b'];
    const serialized = jsonSerializer.serialize(arr);
    const deserialized = jsonSerializer.deserialize(serialized);

    expect(deserialized).toEqual(arr);
  });

  it('should handle primitives', () => {
    expect(jsonSerializer.deserialize(jsonSerializer.serialize('string'))).toBe('string');
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(42))).toBe(42);
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(true))).toBe(true);
    expect(jsonSerializer.deserialize(jsonSerializer.serialize(null))).toBe(null);
  });
});
