import { describe, it, expect } from 'vitest';
import { ConsistentHash, fnv1aHash } from './consistent.js';

describe('fnv1aHash', () => {
  it('should return consistent hash for same input', () => {
    const hash1 = fnv1aHash('test');
    const hash2 = fnv1aHash('test');
    expect(hash1).toBe(hash2);
  });

  it('should return different hash for different input', () => {
    const hash1 = fnv1aHash('test1');
    const hash2 = fnv1aHash('test2');
    expect(hash1).not.toBe(hash2);
  });

  it('should return positive number', () => {
    expect(fnv1aHash('test')).toBeGreaterThanOrEqual(0);
    expect(fnv1aHash('')).toBeGreaterThanOrEqual(0);
    expect(fnv1aHash('a'.repeat(1000))).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty string', () => {
    const hash = fnv1aHash('');
    expect(typeof hash).toBe('number');
    expect(hash).toBeGreaterThanOrEqual(0);
  });

  it('should handle unicode', () => {
    const hash = fnv1aHash('日本語テスト');
    expect(typeof hash).toBe('number');
    expect(hash).toBeGreaterThanOrEqual(0);
  });
});

describe('ConsistentHash', () => {
  describe('constructor', () => {
    it('should create with default options', () => {
      const ch = new ConsistentHash();
      expect(ch.size).toBe(0);
      expect(ch.ringSize).toBe(0);
    });

    it('should create with custom replicas', () => {
      const ch = new ConsistentHash({ replicas: 50 });
      ch.add('node1');
      expect(ch.ringSize).toBe(50);
    });

    it('should throw for invalid replicas', () => {
      expect(() => new ConsistentHash({ replicas: 0 })).toThrow('replicas must be at least 1');
      expect(() => new ConsistentHash({ replicas: -1 })).toThrow('replicas must be at least 1');
    });

    it('should use custom hash function', () => {
      const customHash = (s: string) => s.length;
      const ch = new ConsistentHash({ hashFn: customHash, replicas: 1 });
      ch.add('node1');
      // All keys of same length should go to same node
      expect(ch.get('aaa')).toBe(ch.get('bbb'));
    });
  });

  describe('add', () => {
    it('should add single node', () => {
      const ch = new ConsistentHash();
      ch.add('node1');
      expect(ch.size).toBe(1);
      expect(ch.has('node1')).toBe(true);
    });

    it('should add multiple nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');
      expect(ch.size).toBe(3);
    });

    it('should add nodes incrementally', () => {
      const ch = new ConsistentHash();
      ch.add('node1');
      ch.add('node2');
      expect(ch.size).toBe(2);
    });

    it('should ignore duplicate nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1');
      ch.add('node1');
      expect(ch.size).toBe(1);
    });

    it('should create virtual nodes', () => {
      const ch = new ConsistentHash({ replicas: 100 });
      ch.add('node1', 'node2');
      expect(ch.ringSize).toBe(200); // 100 replicas * 2 nodes
    });
  });

  describe('remove', () => {
    it('should remove existing node', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2');
      const result = ch.remove('node1');
      expect(result).toBe(true);
      expect(ch.size).toBe(1);
      expect(ch.has('node1')).toBe(false);
    });

    it('should return false for non-existent node', () => {
      const ch = new ConsistentHash();
      const result = ch.remove('nonexistent');
      expect(result).toBe(false);
    });

    it('should remove all virtual nodes', () => {
      const ch = new ConsistentHash({ replicas: 100 });
      ch.add('node1', 'node2');
      ch.remove('node1');
      expect(ch.ringSize).toBe(100);
    });
  });

  describe('get', () => {
    it('should return undefined for empty ring', () => {
      const ch = new ConsistentHash();
      expect(ch.get('key1')).toBeUndefined();
    });

    it('should return node for key', () => {
      const ch = new ConsistentHash();
      ch.add('node1');
      expect(ch.get('key1')).toBe('node1');
    });

    it('should return consistent results', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');

      const node1 = ch.get('mykey');
      const node2 = ch.get('mykey');
      expect(node1).toBe(node2);
    });

    it('should distribute keys across nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');

      const nodes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const node = ch.get(`key${i}`);
        if (node) nodes.add(node);
      }

      // All nodes should receive some keys
      expect(nodes.size).toBe(3);
    });

    it('should minimize key movement when adding node', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2');

      // Record initial assignments
      const initial = new Map<string, string>();
      for (let i = 0; i < 1000; i++) {
        const key = `key${i}`;
        initial.set(key, ch.get(key)!);
      }

      // Add new node
      ch.add('node3');

      // Count moved keys
      let moved = 0;
      for (let i = 0; i < 1000; i++) {
        const key = `key${i}`;
        if (initial.get(key) !== ch.get(key)) {
          moved++;
        }
      }

      // Approximately 1/3 of keys should move to new node
      // Allow some variance due to hash distribution
      expect(moved).toBeLessThan(500); // Less than 50% moved
      expect(moved).toBeGreaterThan(100); // More than 10% moved (adjusted for variance)
    });

    it('should minimize key movement when removing node', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');

      // Record initial assignments
      const initial = new Map<string, string>();
      for (let i = 0; i < 1000; i++) {
        const key = `key${i}`;
        initial.set(key, ch.get(key)!);
      }

      // Remove node3
      ch.remove('node3');

      // Only keys that were on node3 should move
      let moved = 0;
      for (let i = 0; i < 1000; i++) {
        const key = `key${i}`;
        if (initial.get(key) !== ch.get(key)) {
          moved++;
          // Moved key should have been on node3
          expect(initial.get(key)).toBe('node3');
        }
      }

      // Approximately 1/3 of keys should move
      expect(moved).toBeLessThan(500);
    });
  });

  describe('getN', () => {
    it('should return empty array for empty ring', () => {
      const ch = new ConsistentHash();
      expect(ch.getN('key', 3)).toEqual([]);
    });

    it('should return empty array for n <= 0', () => {
      const ch = new ConsistentHash();
      ch.add('node1');
      expect(ch.getN('key', 0)).toEqual([]);
      expect(ch.getN('key', -1)).toEqual([]);
    });

    it('should return single node when n=1', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');
      const result = ch.getN('key', 1);
      expect(result.length).toBe(1);
    });

    it('should return distinct nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');
      const result = ch.getN('key', 3);

      expect(result.length).toBe(3);
      expect(new Set(result).size).toBe(3); // All distinct
    });

    it('should return all nodes when n >= node count', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2');
      const result = ch.getN('key', 5);

      expect(result.length).toBe(2);
      expect(result).toContain('node1');
      expect(result).toContain('node2');
    });

    it('should be consistent for same key', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');

      const result1 = ch.getN('mykey', 2);
      const result2 = ch.getN('mykey', 2);

      expect(result1).toEqual(result2);
    });
  });

  describe('getNodes', () => {
    it('should return all nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');

      const nodes = ch.getNodes();
      expect(nodes.sort()).toEqual(['node1', 'node2', 'node3']);
    });

    it('should return empty array when no nodes', () => {
      const ch = new ConsistentHash();
      expect(ch.getNodes()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all nodes', () => {
      const ch = new ConsistentHash();
      ch.add('node1', 'node2', 'node3');
      ch.clear();

      expect(ch.size).toBe(0);
      expect(ch.ringSize).toBe(0);
      expect(ch.get('key')).toBeUndefined();
    });
  });

  describe('distribution quality', () => {
    it('should have relatively even distribution', () => {
      const ch = new ConsistentHash({ replicas: 150 });
      ch.add('node1', 'node2', 'node3', 'node4');

      const sampleKeys = Array.from({ length: 10000 }, (_, i) => `key${i}`);
      const distribution = ch.getDistribution(sampleKeys);

      // Each node should get roughly 25% (2500 keys)
      // Allow 15% variance (between 10% and 40%)
      for (const [node, count] of distribution) {
        expect(count).toBeGreaterThan(1000); // > 10%
        expect(count).toBeLessThan(4000); // < 40%
      }
    });

    it('should improve distribution with more replicas', () => {
      const ch1 = new ConsistentHash({ replicas: 10 });
      const ch2 = new ConsistentHash({ replicas: 200 });

      const nodes = ['node1', 'node2', 'node3', 'node4'];
      ch1.add(...nodes);
      ch2.add(...nodes);

      const sampleKeys = Array.from({ length: 10000 }, (_, i) => `key${i}`);
      const dist1 = ch1.getDistribution(sampleKeys);
      const dist2 = ch2.getDistribution(sampleKeys);

      // Calculate standard deviation
      const calcStdDev = (dist: Map<string, number>) => {
        const values = [...dist.values()];
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
        return Math.sqrt(variance);
      };

      const stdDev1 = calcStdDev(dist1);
      const stdDev2 = calcStdDev(dist2);

      // More replicas should have lower standard deviation
      expect(stdDev2).toBeLessThan(stdDev1);
    });
  });

  describe('edge cases', () => {
    it('should handle single node', () => {
      const ch = new ConsistentHash();
      ch.add('node1');

      for (let i = 0; i < 100; i++) {
        expect(ch.get(`key${i}`)).toBe('node1');
      }
    });

    it('should handle node names with special characters', () => {
      const ch = new ConsistentHash();
      ch.add('node:8080', 'http://node2.local:3000', 'node#3');

      expect(ch.size).toBe(3);
      expect(ch.get('key')).toBeDefined();
    });

    it('should handle rapid add/remove', () => {
      const ch = new ConsistentHash({ replicas: 50 });

      for (let i = 0; i < 100; i++) {
        ch.add(`node${i}`);
      }

      for (let i = 0; i < 50; i++) {
        ch.remove(`node${i}`);
      }

      expect(ch.size).toBe(50);
      expect(ch.ringSize).toBe(50 * 50);

      // Should still work correctly
      for (let i = 0; i < 100; i++) {
        const node = ch.get(`key${i}`);
        expect(node).toBeDefined();
        expect(parseInt(node!.replace('node', ''))).toBeGreaterThanOrEqual(50);
      }
    });
  });
});
