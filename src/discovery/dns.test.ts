import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DnsSrvPeerDiscovery } from './dns.js';
import * as dns from 'node:dns/promises';

// Mock dns module
vi.mock('node:dns/promises', () => ({
  resolveSrv: vi.fn(),
  resolve4: vi.fn(),
  getServers: vi.fn().mockReturnValue(['8.8.8.8']),
  Resolver: vi.fn().mockImplementation(() => ({
    setServers: vi.fn(),
  })),
}));

describe('DnsSrvPeerDiscovery', () => {
  let discovery: DnsSrvPeerDiscovery;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (discovery) {
      await discovery.stop();
    }
  });

  describe('constructor', () => {
    it('should create with required options', () => {
      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
      });

      expect(discovery).toBeInstanceOf(DnsSrvPeerDiscovery);
    });

    it('should accept all options', () => {
      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        protocol: 'https',
        refreshInterval: 60000,
        timeout: 10000,
        resolveTargets: false,
      });

      expect(discovery).toBeInstanceOf(DnsSrvPeerDiscovery);
    });
  });

  describe('start', () => {
    it('should lookup SRV records and create peers', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 8080, name: 'pod1.myapp.local.' },
        { priority: 10, weight: 50, port: 8080, name: 'pod2.myapp.local.' },
      ]);

      (dns.resolve4 as ReturnType<typeof vi.fn>).mockImplementation((hostname: string) => {
        if (hostname === 'pod1.myapp.local') return Promise.resolve(['10.0.0.1']);
        if (hostname === 'pod2.myapp.local') return Promise.resolve(['10.0.0.2']);
        return Promise.reject(new Error('Not found'));
      });

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(2);
      expect(peers[0]!.address).toBe('http://10.0.0.1:8080');
      expect(peers[1]!.address).toBe('http://10.0.0.2:8080');
    });

    it('should sort by priority and weight', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 20, weight: 100, port: 8080, name: 'low-priority.local.' },
        { priority: 10, weight: 25, port: 8080, name: 'high-priority-low-weight.local.' },
        { priority: 10, weight: 75, port: 8080, name: 'high-priority-high-weight.local.' },
      ]);

      (dns.resolve4 as ReturnType<typeof vi.fn>).mockImplementation((hostname: string) => {
        return Promise.resolve([hostname.replace('.local', '.ip')]);
      });

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(3);

      // Should be sorted: priority 10 first, then by weight (higher first)
      expect(peers[0]!.address).toContain('high-priority-high-weight');
      expect(peers[1]!.address).toContain('high-priority-low-weight');
      expect(peers[2]!.address).toContain('low-priority');
    });

    it('should remove trailing dot from hostname', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 8080, name: 'pod1.myapp.local.' },
      ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.address).toBe('http://pod1.myapp.local:8080');
    });

    it('should use https protocol when specified', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 443, name: 'secure.local.' },
      ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        protocol: 'https',
        resolveTargets: false,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.address).toBe('https://secure.local:443');
    });

    it('should keep hostname if IP resolution fails', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 8080, name: 'unresolvable.local.' },
      ]);

      (dns.resolve4 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NXDOMAIN'));

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: true,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.address).toBe('http://unresolvable.local:8080');
    });

    it('should include metadata', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 5, weight: 100, port: 8080, name: 'pod1.local.' },
      ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.weight).toBe(100);
      expect(peers[0]!.metadata).toEqual({
        priority: '5',
        srvName: 'pod1.local.',
      });
    });

    it('should be idempotent', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
      });

      await discovery.start();
      await discovery.start();
      await discovery.start();

      // Should only call once (initial lookup)
      expect(dns.resolveSrv).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should stop cleanly', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
      });

      await discovery.start();
      await discovery.stop();
      await discovery.stop();
    });
  });

  describe('refresh', () => {
    it('should update peers on refresh', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { priority: 10, weight: 50, port: 8080, name: 'pod1.local.' },
        ])
        .mockResolvedValueOnce([
          { priority: 10, weight: 50, port: 8080, name: 'pod1.local.' },
          { priority: 10, weight: 50, port: 8080, name: 'pod2.local.' },
        ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();
      expect(discovery.getPeers()).toHaveLength(1);

      await discovery.refresh();
      expect(discovery.getPeers()).toHaveLength(2);
    });
  });

  describe('getLastRecords', () => {
    it('should return last resolved records', async () => {
      const records = [
        { priority: 10, weight: 50, port: 8080, name: 'pod1.local.' },
        { priority: 10, weight: 50, port: 8080, name: 'pod2.local.' },
      ];

      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue(records);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();

      const lastRecords = discovery.getLastRecords();
      expect(lastRecords).toEqual(records);
    });

    it('should return copy of records', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 8080, name: 'pod1.local.' },
      ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      await discovery.start();

      const records1 = discovery.getLastRecords();
      const records2 = discovery.getLastRecords();

      expect(records1).not.toBe(records2);
      expect(records1).toEqual(records2);
    });
  });

  describe('error handling', () => {
    it('should emit error on DNS failure', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DNS error'));

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
      });

      const errorCallback = vi.fn();
      discovery.onError(errorCallback);

      await discovery.start();

      expect(errorCallback).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('callbacks', () => {
    it('should notify on peer changes', async () => {
      (dns.resolveSrv as ReturnType<typeof vi.fn>).mockResolvedValue([
        { priority: 10, weight: 50, port: 8080, name: 'pod1.local.' },
      ]);

      discovery = new DnsSrvPeerDiscovery({
        service: '_groupcache._tcp.myapp.local',
        resolveTargets: false,
      });

      const callback = vi.fn();
      discovery.onPeersChanged(callback);

      await discovery.start();

      expect(callback).toHaveBeenCalledWith([
        expect.objectContaining({
          address: 'http://pod1.local:8080',
        }),
      ]);
    });
  });
});
