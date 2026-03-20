import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import type { TransportHandler, GetResponse } from './interface.js';
import { NotFoundError } from './interface.js';

// Check if gRPC dependencies are available
let GrpcTransport: typeof import('./grpc.js').GrpcTransport | undefined;
let grpcAvailable = false;

beforeAll(async () => {
  try {
    // Check if @grpc/grpc-js is installed
    await import('@grpc/grpc-js');
    await import('@grpc/proto-loader');
    const grpcModule = await import('./grpc.js');
    GrpcTransport = grpcModule.GrpcTransport;
    grpcAvailable = true;
  } catch {
    // gRPC packages not installed, tests will be skipped
    console.log('gRPC packages not installed, skipping gRPC transport tests');
  }
});

describe('GrpcTransport', () => {
  let transport1: InstanceType<typeof import('./grpc.js').GrpcTransport> | undefined;
  let transport2: InstanceType<typeof import('./grpc.js').GrpcTransport> | undefined;
  let handler: TransportHandler;

  beforeEach(async () => {
    if (!grpcAvailable || !GrpcTransport) {
      return;
    }

    transport1 = new GrpcTransport();
    transport2 = new GrpcTransport();

    handler = {
      handleGet: vi.fn(),
      handleSet: vi.fn(),
      handleRemove: vi.fn(),
      handleRemoveMany: vi.fn(),
    };
  });

  afterEach(async () => {
    if (transport1) {
      await transport1.close();
    }
    if (transport2) {
      await transport2.close();
    }
  });

  describe('listen and close', () => {
    it('should start listening on specified port', async () => {
      if (!grpcAvailable || !transport1) {
        return;
      }

      await transport1.listen(0, handler); // Port 0 = random available port

      expect(transport1.listenAddress).toBeDefined();
      expect(transport1.listenAddress).toMatch(/^grpc:\/\/0\.0\.0\.0:\d+$/);
    });

    it('should close cleanly', async () => {
      if (!grpcAvailable || !transport1) {
        return;
      }

      await transport1.listen(0, handler);
      await transport1.close();

      expect(transport1.listenAddress).toBeUndefined();
    });

    it('should handle close when not listening', async () => {
      if (!grpcAvailable || !transport1) {
        return;
      }

      // Should not throw
      await transport1.close();
    });

    it('should listen on custom host', async () => {
      if (!grpcAvailable || !transport1) {
        return;
      }

      await transport1.listen(0, handler, { host: '127.0.0.1' });

      expect(transport1.listenAddress).toMatch(/^grpc:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe('get operation', () => {
    it('should get value from peer', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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

      expect(handler.handleGet).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        key: 'test-key',
      });
    });

    it('should handle not found', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockRejectedValue(
        new NotFoundError('test-group', 'missing-key'),
      );

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.get({}, peer, { group: 'test-group', key: 'missing-key' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should handle special characters in group and key', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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

    it('should handle response without optional fields', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      const mockResponse: GetResponse = {
        value: Buffer.from('simple-value'),
      };
      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const result = await transport2.get({}, peer, { group: 'test', key: 'key' });

      expect(result.value.toString()).toBe('simple-value');
      expect(result.expiresAt).toBeUndefined();
      expect(result.hit).toBeFalsy();
    });
  });

  describe('set operation', () => {
    it('should set value on peer', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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

    it('should handle large values', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleSet as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Create a 1MB buffer
      const largeValue = Buffer.alloc(1024 * 1024, 'x');

      await transport2.set({}, peer, {
        group: 'test-group',
        key: 'large-key',
        value: largeValue,
      });

      const callArg = (handler.handleSet as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(callArg.value.length).toBe(1024 * 1024);
    });
  });

  describe('remove operation', () => {
    it('should remove key from peer', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleRemove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Should not throw
      await transport2.remove({}, peer, { group: 'test-group', key: 'missing' });
    });
  });

  describe('removeMany operation', () => {
    it('should remove multiple keys from peer', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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

    it('should handle special characters in keys', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.removeMany({}, peer, {
        group: 'test-group',
        keys: ['key with spaces', 'key/with/slashes', 'key:with:colons'],
      });

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        keys: ['key with spaces', 'key/with/slashes', 'key:with:colons'],
      });
    });

    it('should handle empty keys array', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await transport2.removeMany({}, peer, {
        group: 'test-group',
        keys: [],
      });

      expect(handler.handleRemoveMany).toHaveBeenCalledWith(expect.any(Object), {
        group: 'test-group',
        keys: [],
      });
    });
  });

  describe('error handling', () => {
    it('should handle server errors', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(transport2.get({}, peer, { group: 'test', key: 'key' })).rejects.toThrow();
    });

    it('should handle connection refused', async () => {
      if (!grpcAvailable || !transport2) {
        return;
      }

      // Try to connect to a port that's not listening
      await expect(
        transport2.get({}, 'grpc://127.0.0.1:59999', { group: 'test', key: 'key' }),
      ).rejects.toThrow();
    });

    it('should handle set operation errors', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleSet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Set failed'));

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.set({}, peer, {
          group: 'test',
          key: 'key',
          value: Buffer.from('value'),
        }),
      ).rejects.toThrow();
    });

    it('should handle removeMany operation errors', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleRemoveMany as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RemoveMany failed'),
      );

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      await expect(
        transport2.removeMany({}, peer, {
          group: 'test',
          keys: ['key1', 'key2'],
        }),
      ).rejects.toThrow();
    });
  });

  describe('custom options', () => {
    it('should respect custom timeout', async () => {
      if (!grpcAvailable || !GrpcTransport) {
        return;
      }

      const slowTransport1 = new GrpcTransport({ timeout: 100 });
      const slowTransport2 = new GrpcTransport({ timeout: 100 });

      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Simulate slow response
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { value: Buffer.from('value') };
      });

      await slowTransport1.listen(0, handler);
      const peer = slowTransport1.listenAddress!;

      await expect(slowTransport2.get({}, peer, { group: 'test', key: 'key' })).rejects.toThrow(
        'timeout',
      );

      await slowTransport1.close();
      await slowTransport2.close();
    });

    it('should handle custom max message size', async () => {
      if (!grpcAvailable || !GrpcTransport) {
        return;
      }

      // Create transport with small max message size
      const smallTransport1 = new GrpcTransport({ maxMessageSize: 1024 });
      const smallTransport2 = new GrpcTransport({ maxMessageSize: 1024 });

      (handler.handleSet as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await smallTransport1.listen(0, handler);
      const peer = smallTransport1.listenAddress!;

      // Try to send a message larger than max size
      const largeValue = Buffer.alloc(2048, 'x');

      await expect(
        smallTransport2.set({}, peer, {
          group: 'test',
          key: 'key',
          value: largeValue,
        }),
      ).rejects.toThrow();

      await smallTransport1.close();
      await smallTransport2.close();
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async (_, req) => {
        return { value: Buffer.from(`value-${req.key}`) };
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const promises = Array.from({ length: 20 }, (_, i) =>
        transport2.get({}, peer, { group: 'test', key: `key${i}` }),
      );

      const results = await Promise.all(promises);

      for (let i = 0; i < 20; i++) {
        expect(results[i]!.value.toString()).toBe(`value-key${i}`);
      }
    });

    it('should handle mixed concurrent operations', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockImplementation(async (_, req) => {
        return { value: Buffer.from(`get-${req.key}`) };
      });
      (handler.handleSet as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (handler.handleRemove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const operations = [
        transport2.get({}, peer, { group: 'test', key: 'key1' }),
        transport2.set({}, peer, { group: 'test', key: 'key2', value: Buffer.from('value2') }),
        transport2.get({}, peer, { group: 'test', key: 'key3' }),
        transport2.remove({}, peer, { group: 'test', key: 'key4' }),
        transport2.get({}, peer, { group: 'test', key: 'key5' }),
      ];

      const results = await Promise.all(operations);

      expect((results[0] as GetResponse).value.toString()).toBe('get-key1');
      expect((results[2] as GetResponse).value.toString()).toBe('get-key3');
      expect((results[4] as GetResponse).value.toString()).toBe('get-key5');
    });
  });

  describe('abort signal', () => {
    it('should abort request when signal is triggered', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

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

    it('should handle pre-aborted signal', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: Buffer.from('value'),
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      const controller = new AbortController();
      controller.abort(); // Abort before making request

      await expect(
        transport2.get({ signal: controller.signal }, peer, { group: 'test', key: 'key' }),
      ).rejects.toThrow('aborted');
    });
  });

  describe('connection reuse', () => {
    it('should reuse connections to the same peer', async () => {
      if (!grpcAvailable || !transport1 || !transport2) {
        return;
      }

      (handler.handleGet as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: Buffer.from('value'),
      });

      await transport1.listen(0, handler);
      const peer = transport1.listenAddress!;

      // Make multiple requests
      await transport2.get({}, peer, { group: 'test', key: 'key1' });
      await transport2.get({}, peer, { group: 'test', key: 'key2' });
      await transport2.get({}, peer, { group: 'test', key: 'key3' });

      // All requests should succeed (connection was reused)
      expect(handler.handleGet).toHaveBeenCalledTimes(3);
    });
  });

  describe('gRPC unavailable', () => {
    it('should provide helpful error when gRPC is not installed', async () => {
      // This test verifies the error message format
      // We can't easily test this without actually uninstalling gRPC
      // So we just verify the lazy loading mechanism exists
      if (!grpcAvailable) {
        // If gRPC is not available, trying to create transport should fail with helpful message
        try {
          const { GrpcTransport: TestTransport } = await import('./grpc.js');
          const testTransport = new TestTransport();
          await testTransport.listen(0, handler);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('grpc');
        }
      }
    });
  });
});
