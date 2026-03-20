import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaticPeerDiscovery } from './static.js';

describe('StaticPeerDiscovery', () => {
  let discovery: StaticPeerDiscovery;

  afterEach(async () => {
    if (discovery) {
      await discovery.stop();
    }
  });

  describe('constructor', () => {
    it('should accept array of strings', () => {
      discovery = new StaticPeerDiscovery([
        'http://peer1:8080',
        'http://peer2:8080',
      ]);

      // Not started yet, should be empty
      expect(discovery.getPeers()).toEqual([]);
    });

    it('should accept array of PeerInfo', () => {
      discovery = new StaticPeerDiscovery([
        { address: 'http://peer1:8080', weight: 1 },
        { address: 'http://peer2:8080', weight: 2 },
      ]);

      expect(discovery.getPeers()).toEqual([]);
    });

    it('should accept options object', () => {
      discovery = new StaticPeerDiscovery({
        peers: ['http://peer1:8080'],
        healthCheckInterval: 5000,
      });

      expect(discovery.getPeers()).toEqual([]);
    });
  });

  describe('start', () => {
    it('should populate peers on start', async () => {
      discovery = new StaticPeerDiscovery([
        'http://peer1:8080',
        'http://peer2:8080',
      ]);

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(2);
      expect(peers[0]!.address).toBe('http://peer1:8080');
      expect(peers[1]!.address).toBe('http://peer2:8080');
    });

    it('should be idempotent', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      await discovery.start();
      await discovery.start();

      expect(discovery.getPeers()).toHaveLength(1);
    });

    it('should notify callbacks on start', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      const callback = vi.fn();
      discovery.onPeersChanged(callback);

      await discovery.start();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        { address: 'http://peer1:8080', isSelf: false },
      ]);
    });
  });

  describe('stop', () => {
    it('should stop cleanly', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      await discovery.stop();

      // Should be able to call stop multiple times
      await discovery.stop();
    });
  });

  describe('setSelf', () => {
    it('should mark self peer', async () => {
      discovery = new StaticPeerDiscovery([
        'http://peer1:8080',
        'http://peer2:8080',
      ]);

      await discovery.start();
      discovery.setSelf('http://peer1:8080');

      const peers = discovery.getPeers();
      expect(peers[0]!.isSelf).toBe(true);
      expect(peers[1]!.isSelf).toBe(false);
    });

    it('should notify callbacks when self is set', async () => {
      discovery = new StaticPeerDiscovery([
        'http://peer1:8080',
        'http://peer2:8080',
      ]);

      await discovery.start();

      const callback = vi.fn();
      discovery.onPeersChanged(callback);

      discovery.setSelf('http://peer1:8080');

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('updatePeers', () => {
    it('should update peer list', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.updatePeers(['http://peer2:8080', 'http://peer3:8080']);

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(2);
      expect(peers[0]!.address).toBe('http://peer2:8080');
      expect(peers[1]!.address).toBe('http://peer3:8080');
    });

    it('should notify callbacks on update', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();

      const callback = vi.fn();
      discovery.onPeersChanged(callback);

      discovery.updatePeers(['http://peer2:8080']);

      expect(callback).toHaveBeenCalled();
    });

    it('should preserve self marking after update', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.setSelf('http://peer1:8080');

      discovery.updatePeers(['http://peer1:8080', 'http://peer2:8080']);

      const peers = discovery.getPeers();
      expect(peers[0]!.isSelf).toBe(true);
    });
  });

  describe('addPeer', () => {
    it('should add a new peer', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.addPeer('http://peer2:8080');

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(2);
    });

    it('should not add duplicate peer', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.addPeer('http://peer1:8080');

      expect(discovery.getPeers()).toHaveLength(1);
    });

    it('should accept PeerInfo object', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.addPeer({ address: 'http://peer2:8080', weight: 2 });

      const peers = discovery.getPeers();
      expect(peers[1]!.weight).toBe(2);
    });
  });

  describe('removePeer', () => {
    it('should remove an existing peer', async () => {
      discovery = new StaticPeerDiscovery([
        'http://peer1:8080',
        'http://peer2:8080',
      ]);

      await discovery.start();
      discovery.removePeer('http://peer1:8080');

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0]!.address).toBe('http://peer2:8080');
    });

    it('should do nothing for non-existent peer', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();
      discovery.removePeer('http://nonexistent:8080');

      expect(discovery.getPeers()).toHaveLength(1);
    });
  });

  describe('callbacks', () => {
    it('should support multiple callbacks', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      discovery.onPeersChanged(callback1);
      discovery.onPeersChanged(callback2);

      await discovery.start();

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should allow removing callbacks', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      const callback = vi.fn();
      discovery.onPeersChanged(callback);
      discovery.offPeersChanged(callback);

      await discovery.start();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      const errorCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const goodCallback = vi.fn();

      discovery.onPeersChanged(errorCallback);
      discovery.onPeersChanged(goodCallback);

      // Should not throw
      await discovery.start();

      // Good callback should still be called
      expect(goodCallback).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should support error callbacks', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      const errorCallback = vi.fn();
      discovery.onError(errorCallback);

      // Error callbacks are only called by implementations that can have errors
      // StaticPeerDiscovery doesn't have async errors normally
      await discovery.start();
    });
  });

  describe('getPeers', () => {
    it('should return a copy of peers', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();

      const peers1 = discovery.getPeers();
      const peers2 = discovery.getPeers();

      // Should be different array instances
      expect(peers1).not.toBe(peers2);
      // But same content
      expect(peers1).toEqual(peers2);
    });

    it('should not be affected by external mutations', async () => {
      discovery = new StaticPeerDiscovery(['http://peer1:8080']);

      await discovery.start();

      const peers = discovery.getPeers();
      peers.push({ address: 'http://mutated:8080' });

      // Original should not be affected
      expect(discovery.getPeers()).toHaveLength(1);
    });
  });
});
