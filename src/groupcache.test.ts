import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupCache } from './groupcache.js';
import { HttpTransport } from './transport/http.js';
import { StaticPeerDiscovery } from './discovery/static.js';

describe('GroupCache', () => {
  let cache: GroupCache;

  afterEach(async () => {
    if (cache) {
      await cache.shutdown();
    }
  });

  describe('constructor', () => {
    it('should create instance with minimal options', () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      expect(cache).toBeInstanceOf(GroupCache);
    });

    it('should create instance with all options', () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
        transport: new HttpTransport(),
        discovery: new StaticPeerDiscovery(['http://localhost:8080']),
        hashReplicas: 100,
        defaultTtl: 60000,
        defaultMaxSize: '128MB',
      });

      expect(cache).toBeInstanceOf(GroupCache);
    });

    it('should use static peers when provided', () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
        peers: ['http://peer1:8080', 'http://peer2:8080'],
      });

      // Peers won't be populated until start()
      expect(cache).toBeInstanceOf(GroupCache);
    });
  });

  describe('start and shutdown', () => {
    it('should start and shutdown cleanly', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0); // Port 0 = random available port
      await cache.shutdown();
    });

    it('should be idempotent for start', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0);
      await cache.start(0);
      await cache.start(0);
    });

    it('should be idempotent for shutdown', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0);
      await cache.shutdown();
      await cache.shutdown();
      await cache.shutdown();
    });
  });

  describe('newGroup', () => {
    it('should create a new group', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      const group = cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async (ctx, key) => ({ id: key, name: 'Test' }),
      });

      expect(group.name).toBe('users');
    });

    it('should throw on duplicate group name', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async () => 'value',
      });

      expect(() => {
        cache.newGroup({
          name: 'users',
          maxSize: '10MB',
          getter: async () => 'value',
        });
      }).toThrow('Group "users" already exists');
    });

    it('should use default maxSize and TTL', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
        defaultTtl: 60000,
        defaultMaxSize: '32MB',
      });

      const group = cache.newGroup({
        name: 'test',
        getter: async () => 'value',
      });

      expect(group).toBeDefined();
    });
  });

  describe('getGroup', () => {
    it('should return existing group', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async () => 'value',
      });

      const group = cache.getGroup('users');
      expect(group).toBeDefined();
      expect(group?.name).toBe('users');
    });

    it('should return undefined for non-existent group', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      const group = cache.getGroup('nonexistent');
      expect(group).toBeUndefined();
    });
  });

  describe('removeGroup', () => {
    it('should remove existing group', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async () => 'value',
      });

      const result = cache.removeGroup('users');
      expect(result).toBe(true);
      expect(cache.getGroup('users')).toBeUndefined();
    });

    it('should return false for non-existent group', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      const result = cache.removeGroup('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getGroupNames', () => {
    it('should return all group names', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      cache.newGroup({ name: 'users', maxSize: '1MB', getter: async () => 'v' });
      cache.newGroup({ name: 'products', maxSize: '1MB', getter: async () => 'v' });
      cache.newGroup({ name: 'sessions', maxSize: '1MB', getter: async () => 'v' });

      const names = cache.getGroupNames();
      expect(names.sort()).toEqual(['products', 'sessions', 'users']);
    });

    it('should return empty array when no groups', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      expect(cache.getGroupNames()).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return instance statistics', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0);

      cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async () => 'value',
      });

      const stats = cache.getStats();

      expect(stats.groups.has('users')).toBe(true);
      expect(stats.peerCount).toBeGreaterThanOrEqual(1);
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getHealth', () => {
    it('should return healthy status when started', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0);

      const health = cache.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.peers.total).toBeGreaterThanOrEqual(1);
      expect(health.groups).toEqual([]);
    });

    it('should include group information', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      await cache.start(0);

      cache.newGroup({
        name: 'users',
        maxSize: '10MB',
        getter: async () => 'value',
      });

      const health = cache.getHealth();

      expect(health.groups.length).toBe(1);
      expect(health.groups[0]!.name).toBe('users');
      expect(health.groups[0]!.utilizationPercent).toBe(0);
    });
  });

  describe('getPeers', () => {
    it('should return current peers', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
        peers: ['http://localhost:8080', 'http://peer1:8080'],
      });

      await cache.start(0);

      const peers = cache.getPeers();
      expect(peers.length).toBe(2);
    });
  });

  describe('isKeyOwner', () => {
    it('should determine key ownership', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
        peers: ['http://localhost:8080'],
      });

      await cache.start(0);

      // With only one peer, we own all keys
      expect(cache.isKeyOwner('test', 'key1')).toBe(true);
      expect(cache.isKeyOwner('test', 'key2')).toBe(true);
    });
  });

  describe('distributed operation', () => {
    let cache1: GroupCache;
    let cache2: GroupCache;

    afterEach(async () => {
      await cache1?.shutdown();
      await cache2?.shutdown();
    });

    it('should communicate between peers', async () => {
      // Start first cache
      cache1 = new GroupCache({
        self: 'http://127.0.0.1:9001',
      });
      await cache1.start(9001);

      // Create group on cache1
      const group1 = cache1.newGroup({
        name: 'test',
        maxSize: '1MB',
        getter: async (ctx, key) => `value-from-cache1-${key}`,
      });

      // Preload a value
      await group1.get('shared-key');

      // Start second cache with peer list
      cache2 = new GroupCache({
        self: 'http://127.0.0.1:9002',
        peers: ['http://127.0.0.1:9001', 'http://127.0.0.1:9002'],
      });
      await cache2.start(9002);

      // Create group on cache2
      const group2 = cache2.newGroup({
        name: 'test',
        maxSize: '1MB',
        getter: async (ctx, key) => `value-from-cache2-${key}`,
      });

      // Update cache1 peer list to include cache2
      const discovery1 = (cache1 as unknown as { discovery: StaticPeerDiscovery }).discovery;
      if (discovery1 instanceof StaticPeerDiscovery) {
        discovery1.updatePeers(['http://127.0.0.1:9001', 'http://127.0.0.1:9002']);
      }

      // Get a key - will route based on consistent hashing
      const result = await group2.get('test-key');

      // Should get a value (either from cache1 or cache2 depending on hash)
      expect(result).toMatch(/^value-from-cache[12]-test-key$/);
    });
  });

  describe('error handling', () => {
    it('should handle getter errors', async () => {
      cache = new GroupCache({
        self: 'http://localhost:8080',
      });

      const group = cache.newGroup({
        name: 'test',
        maxSize: '1MB',
        getter: async () => {
          throw new Error('Getter error');
        },
      });

      try {
        await group.get('key');
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toBe('Getter error');
      }
    });
  });
});
