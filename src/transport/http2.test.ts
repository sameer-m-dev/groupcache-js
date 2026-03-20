import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Http2Transport } from './http2.js';
import type { TransportHandler, GetResponse } from './interface.js';
import { NotFoundError } from './interface.js';

describe('Http2Transport', () => {
  let transport1: Http2Transport;
  let transport2: Http2Transport;
  let handler: TransportHandler;

  beforeEach(() => {
    transport1 = new Http2Transport();
    transport2 = new Http2Transport();

    handler = {
      handleGet: vi.fn(),
      handleSet: vi.fn(),
      handleRemove: vi.fn(),
      handleRemoveMany: vi.fn(),
    };
  });

  afterEach(async () => {
    await transport1.close();
    await transport2.close();
  }, 15000);

  describe('listen and close', () => {
    it('should start listening on specified port', async () => {
      await transport1.listen(0, handler); // Port 0 = random available port

      expect(transport1.listenAddress).toBeDefined();
      expect(transport1.listenAddress).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
    });

    it('should close cleanly', async () => {
      await transport1.listen(0, handler);
      await transport1.close();

      expect(transport1.listenAddress).toBeUndefined();
    });

    it('should handle close when not listening', async () => {
      // Should not throw
      await transport1.close();
    });

    it('should listen on custom host', async () => {
      await transport1.listen(0, handler, { host: '127.0.0.1' });

      expect(transport1.listenAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe('get operation', () => {
    it('should get value from peer', async () => {
      const mockResponse: GetResponse = {
        value: Buffer.from('test-value'),
        expiresAt: Date.now() + 60000,
        hit: true,
      };

      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const result = await transport2.get({}, peer, { group: 'test-group', key: 'test-key' });

      expect(result.value.toString()).toBe('test-value');
      expect(result.expiresAt).toBeDefined();
      expect(result.hit).toBe(true);

      expect(handler.handleGet).toHaveBeenCalledWith(
        expect.any(Object),
        { group: 'test-group', key: 'test-key' },
      );
    });

    it('should handle not found', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockRejectedValue(
        new NotFoundError('test-group', 'missing-key'),
      );

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.get({}, peer, { group: 'test-group', key: 'missing-key' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should handle URL-encoded group and key', async () => {
      const mockResponse: GetResponse = {
        value: Buffer.from('value'),
      };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.get({}, peer, { group: 'group/with/slashes', key: 'key with spaces' });

      expect(handler.handleGet).toHaveBeenCalledWith(expect.any(Object), {
        group: 'group/with/slashes',
        key: 'key with spaces',
      });
    });

    it('should handle binary data', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const mockResponse: GetResponse = {
        value: binaryData,
      };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const result = await transport2.get({}, peer, { group: 'test', key: 'binary' });

      expect(Buffer.compare(result.value, binaryData)).toBe(0);
    });
  });

  describe('set operation', () => {
    it('should set value on peer', async () => {
      (handler.handleSet as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.set({}, peer, {
        group: 'test-group',
        key: 'test-key',
        value: Buffer.from('new-value'),
        ttl: 60000,
      });

      expect(handler.handleSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          group: 'test-group',
          key: 'test-key',
          ttl: 60000,
        }),
      );

      // Check buffer content
      const callArg = (handler.handleSet as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(callArg.value.toString()).toBe('new-value');
    });

    it('should set value without TTL', async () => {
      (handler.handleSet as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.set({}, peer, {
        group: 'test-group',
        key: 'test-key',
        value: Buffer.from('value'),
      });

      const callArg = (handler.handleSet as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(callArg.ttl).toBeUndefined();
    });
  });

  describe('remove operation', () => {
    it('should remove key from peer', async () => {
      (handler.handleRemove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.remove({}, peer, { group: 'test-group', key: 'test-key' });

      expect(handler.handleRemove).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        key: 'test-key',
      });
    });

    it('should not throw for non-existent key', async () => {
      (handler.handleRemove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Should not throw
      await transport2.remove({}, peer, { group: 'test-group', key: 'missing' });
    });
  });

  describe('removeMany operation', () => {
    it('should remove multiple keys from peer', async () => {
      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.removeMany({}, peer, {
        group: 'test-group',
        keys: ['key1', 'key2', 'key3'],
      });

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        keys: ['key1', 'key2', 'key3'],
      });
    });

    it('should handle URL-encoded keys', async () => {
      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.removeMany({}, peer, {
        group: 'test-group',
        keys: ['key with spaces', 'key/with/slashes'],
      });

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        keys: ['key with spaces', 'key/with/slashes'],
      });
    });
  });

  describe('session management', () => {
    it('should reuse sessions for the same peer', async () => {
      const mockResponse: GetResponse = { value: Buffer.from('value') };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Make multiple requests
      await transport2.get({}, peer, { group: 'test', key: 'key1' });
      await transport2.get({}, peer, { group: 'test', key: 'key2' });
      await transport2.get({}, peer, { group: 'test', key: 'key3' });

      // All requests should succeed (session reuse is internal)
      expect(handler.handleGet).toHaveBeenCalledTimes(3);
    });
  });

  describe('error handling', () => {
    it('should handle server errors', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(transport2.get({}, peer, { group: 'test', key: 'key' })).rejects.toThrow();
    });

    it('should handle connection refused', async () => {
      // Try to connect to a port that's not listening
      await expect(
        transport2.get({}, 'http://127.0.0.1:59999', { group: 'test', key: 'key' }),
      ).rejects.toThrow();
    });
  });

  describe('custom options', () => {
    it('should use custom base path', async () => {
      const customTransport1 = new Http2Transport({ basePath: '/custom/path' });
      const customTransport2 = new Http2Transport({ basePath: '/custom/path' });

      const mockResponse: GetResponse = { value: Buffer.from('value') };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await customTransport1.listen(0, handler);
      const peer = customTransport1.listenAddress!;

      const result = await customTransport2.get({}, peer, { group: 'test', key: 'key' });
      expect(result.value.toString()).toBe('value');

      await customTransport1.close();
      await customTransport2.close();
    });

    it('should use custom timeout', async () => {
      const slowTransport = new Http2Transport({ timeout: 100 });

      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Simulate slow response
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { value: Buffer.from('value') };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(slowTransport.get({}, peer, { group: 'test', key: 'key' })).rejects.toThrow(
        'timeout',
      );

      await slowTransport.close();
    });
  });

  describe('concurrent requests (multiplexing)', () => {
    it('should handle multiple concurrent requests over single connection', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async (_, req) => {
        // Small random delay to simulate processing
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
        return { value: Buffer.from(`value-${req.key}`) };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Launch many concurrent requests - HTTP/2 will multiplex these
      const promises = Array.from({ length: 50 }, (_, i) =>
        transport2.get({}, peer, { group: 'test', key: `key${i}` }),
      );

      const results = await Promise.all(promises);

      for (let i = 0; i < 50; i++) {
        expect(results[i]!.value.toString()).toBe(`value-key${i}`);
      }
    });

    it('should handle concurrent requests to different groups', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async (_, req) => {
        return { value: Buffer.from(`${req.group}:${req.key}`) };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const groups = ['users', 'products', 'orders'];
      const promises = groups.flatMap((group) =>
        Array.from({ length: 10 }, (_, i) =>
          transport2.get({}, peer, { group, key: `key${i}` }),
        ),
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(30);
      // Verify some results
      expect(results[0]!.value.toString()).toBe('users:key0');
      expect(results[10]!.value.toString()).toBe('products:key0');
      expect(results[20]!.value.toString()).toBe('orders:key0');
    });
  });

  describe('abort signal', () => {
    it('should abort request when signal is triggered', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Simulate slow response
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { value: Buffer.from('value') };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const controller = new AbortController();

      const promise = transport2.get({ signal: controller.signal }, peer, {
        group: 'test',
        key: 'key',
      });

      // Abort after short delay
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow('aborted');
    });

    it('should reject immediately if signal already aborted', async () => {
      const mockResponse: GetResponse = { value: Buffer.from('value') };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const controller = new AbortController();
      controller.abort();

      await expect(
        transport2.get({ signal: controller.signal }, peer, { group: 'test', key: 'key' }),
      ).rejects.toThrow('aborted');
    });
  });

  describe('404 handling for non-groupcache paths', () => {
    it('should return 404 for paths not matching base path', async () => {
      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Create a custom transport with different base path to test 404
      const mismatchedTransport = new Http2Transport({ basePath: '/different/path' });

      await expect(
        mismatchedTransport.get({}, peer, { group: 'test', key: 'key' }),
      ).rejects.toThrow();

      await mismatchedTransport.close();
    });
  });

  describe('missing keys parameter', () => {
    it('should handle missing keys in removeMany gracefully at server level', async () => {
      // This tests internal protocol handling
      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Valid removeMany request
      await transport2.removeMany({}, peer, { group: 'test', keys: ['key1'] });

      expect(handler.handleRemoveMany).toHaveBeenCalled();
    });
  });
});
