import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http.js';
import type { TransportHandler, GetResponse } from './interface.js';
import { NotFoundError } from './interface.js';

describe('HttpTransport', () => {
  let transport1: HttpTransport;
  let transport2: HttpTransport;
  let handler: TransportHandler;

  beforeEach(() => {
    transport1 = new HttpTransport();
    transport2 = new HttpTransport();

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
  });

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
        new NotFoundError('test-group', 'missing-key')
      );

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.get({}, peer, { group: 'test-group', key: 'missing-key' })
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

      expect(handler.handleGet).toHaveBeenCalledWith(
        expect.any(Object),
        { group: 'group/with/slashes', key: 'key with spaces' },
      );
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

      expect(handler.handleRemove).toHaveBeenCalledWith(
        expect.any(Object),
        { group: 'test-group', key: 'test-key' },
      );
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

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(
        expect.any(Object),
        { group: 'test-group', keys: ['key1', 'key2', 'key3'] },
      );
    });

    it('should handle URL-encoded keys', async () => {
      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.removeMany({}, peer, {
        group: 'test-group',
        keys: ['key with spaces', 'key/with/slashes'],
      });

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(
        expect.any(Object),
        { group: 'test-group', keys: ['key with spaces', 'key/with/slashes'] },
      );
    });
  });

  describe('error handling', () => {
    it('should handle server errors', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.get({}, peer, { group: 'test', key: 'key' })
      ).rejects.toThrow();
    });

    it('should handle connection refused', async () => {
      // Try to connect to a port that's not listening
      await expect(
        transport2.get({}, 'http://127.0.0.1:59999', { group: 'test', key: 'key' })
      ).rejects.toThrow();
    });
  });

  describe('custom options', () => {
    it('should use custom base path', async () => {
      const customTransport1 = new HttpTransport({ basePath: '/custom/path' });
      const customTransport2 = new HttpTransport({ basePath: '/custom/path' });

      const mockResponse: GetResponse = { value: Buffer.from('value') };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await customTransport1.listen(0, handler);
      const peer = customTransport1.listenAddress!;

      const result = await customTransport2.get({}, peer, { group: 'test', key: 'key' });
      expect(result.value.toString()).toBe('value');

      await customTransport1.close();
      await customTransport2.close();
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async (_, req) => {
        return { value: Buffer.from(`value-${req.key}`) };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const promises = Array.from({ length: 20 }, (_, i) =>
        transport2.get({}, peer, { group: 'test', key: `key${i}` })
      );

      const results = await Promise.all(promises);

      for (let i = 0; i < 20; i++) {
        expect(results[i]!.value.toString()).toBe(`value-key${i}`);
      }
    });
  });

  describe('abort signal', () => {
    it('should abort request when signal is triggered', async () => {
      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Simulate slow response
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { value: Buffer.from('value') };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const controller = new AbortController();

      const promise = transport2.get(
        { signal: controller.signal },
        peer,
        { group: 'test', key: 'key' }
      );

      // Abort after short delay
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow('aborted');
    });
  });
});
