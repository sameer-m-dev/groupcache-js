import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KubernetesPeerDiscovery, getPodIP, getCurrentNamespace } from './kubernetes.js';
import * as fs from 'node:fs/promises';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock fs module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('KubernetesPeerDiscovery', () => {
  let discovery: KubernetesPeerDiscovery;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for credentials
    (fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path.includes('namespace')) {
        return Promise.resolve('default');
      }
      if (path.includes('token')) {
        return Promise.resolve('test-token');
      }
      return Promise.reject(new Error(`Unknown path: ${path}`));
    });
  });

  afterEach(async () => {
    if (discovery) {
      await discovery.stop();
    }
  });

  describe('constructor', () => {
    it('should create with required options', () => {
      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      expect(discovery).toBeInstanceOf(KubernetesPeerDiscovery);
    });

    it('should accept all options', () => {
      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
        namespace: 'production',
        protocol: 'https',
        apiServer: 'https://custom-api:6443',
        resyncInterval: 60000,
      });

      expect(discovery).toBeInstanceOf(KubernetesPeerDiscovery);
    });
  });

  describe('start', () => {
    it('should load credentials and list pods', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [
          {
            metadata: { name: 'pod-1', namespace: 'default', uid: 'uid-1' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          {
            metadata: { name: 'pod-2', namespace: 'default', uid: 'uid-2' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.2',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };

      // Mock initial list request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPodList),
      });

      // Mock watch request (never resolves, we'll stop before it matters)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}), // Never resolves
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(2);
      expect(peers[0]!.address).toBe('http://10.0.0.1:8080');
      expect(peers[1]!.address).toBe('http://10.0.0.2:8080');
    });

    it('should filter out non-ready pods', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [
          {
            metadata: { name: 'pod-ready', namespace: 'default', uid: 'uid-1' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          {
            metadata: { name: 'pod-not-ready', namespace: 'default', uid: 'uid-2' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.2',
              conditions: [{ type: 'Ready', status: 'False' }],
            },
          },
          {
            metadata: { name: 'pod-pending', namespace: 'default', uid: 'uid-3' },
            status: {
              phase: 'Pending',
              conditions: [],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPodList),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0]!.address).toBe('http://10.0.0.1:8080');
    });

    it('should include pod metadata', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [
          {
            metadata: { name: 'my-pod', namespace: 'production', uid: 'unique-id' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPodList),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.metadata).toEqual({
        podName: 'my-pod',
        namespace: 'production',
        uid: 'unique-id',
      });
    });

    it('should use https protocol when specified', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [
          {
            metadata: { name: 'pod-1', namespace: 'default', uid: 'uid-1' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPodList),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
        protocol: 'https',
      });

      await discovery.start();

      const peers = discovery.getPeers();
      expect(peers[0]!.address).toBe('https://10.0.0.1:8080');
    });

    it('should throw if credentials cannot be loaded', async () => {
      (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('File not found'));

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await expect(discovery.start()).rejects.toThrow('Failed to read namespace');
    });

    it('should be idempotent', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPodList),
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await discovery.start();
      await discovery.start();
      await discovery.start();

      // Should only call credentials once
      expect(fs.readFile).toHaveBeenCalledTimes(2); // namespace + token
    });
  });

  describe('stop', () => {
    it('should stop cleanly', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPodList),
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      await discovery.start();
      await discovery.stop();

      // Should be able to stop multiple times
      await discovery.stop();
    });
  });

  describe('callbacks', () => {
    it('should notify on peer changes', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [
          {
            metadata: { name: 'pod-1', namespace: 'default', uid: 'uid-1' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPodList),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
      });

      const callback = vi.fn();
      discovery.onPeersChanged(callback);

      await discovery.start();

      expect(callback).toHaveBeenCalledWith([
        expect.objectContaining({
          address: 'http://10.0.0.1:8080',
        }),
      ]);
    });
  });

  describe('API URL building', () => {
    it('should encode label selector', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPodList),
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp,env=prod',
        port: 8080,
      });

      await discovery.start();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('labelSelector=app%3Dmyapp%2Cenv%3Dprod'),
        expect.any(Object),
      );
    });

    it('should use provided namespace', async () => {
      const mockPodList = {
        kind: 'PodList',
        apiVersion: 'v1',
        metadata: { resourceVersion: '12345' },
        items: [],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPodList),
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
          }),
        },
      });

      discovery = new KubernetesPeerDiscovery({
        labelSelector: 'app=myapp',
        port: 8080,
        namespace: 'custom-namespace',
      });

      await discovery.start();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/namespaces/custom-namespace/pods'),
        expect.any(Object),
      );
    });
  });
});

describe('getPodIP', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return POD_IP environment variable', () => {
    process.env['POD_IP'] = '10.0.0.5';
    expect(getPodIP()).toBe('10.0.0.5');
  });

  it('should return MY_POD_IP as fallback', () => {
    delete process.env['POD_IP'];
    process.env['MY_POD_IP'] = '10.0.0.6';
    expect(getPodIP()).toBe('10.0.0.6');
  });

  it('should return undefined if not set', () => {
    delete process.env['POD_IP'];
    delete process.env['MY_POD_IP'];
    expect(getPodIP()).toBeUndefined();
  });
});

describe('getCurrentNamespace', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return POD_NAMESPACE environment variable', async () => {
    process.env['POD_NAMESPACE'] = 'my-namespace';
    expect(await getCurrentNamespace()).toBe('my-namespace');
  });

  it('should return MY_POD_NAMESPACE as fallback', async () => {
    delete process.env['POD_NAMESPACE'];
    process.env['MY_POD_NAMESPACE'] = 'other-namespace';
    expect(await getCurrentNamespace()).toBe('other-namespace');
  });

  it('should read from service account file', async () => {
    delete process.env['POD_NAMESPACE'];
    delete process.env['MY_POD_NAMESPACE'];

    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue('file-namespace\n');

    expect(await getCurrentNamespace()).toBe('file-namespace');
  });

  it('should return undefined if all methods fail', async () => {
    delete process.env['POD_NAMESPACE'];
    delete process.env['MY_POD_NAMESPACE'];

    (fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    expect(await getCurrentNamespace()).toBeUndefined();
  });
});
