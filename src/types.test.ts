import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withTimeout,
  withSignal,
  parseSize,
  noopLogger,
  consoleLogger,
} from './types.js';

describe('Context utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('withTimeout', () => {
    it('should create context with abort signal', () => {
      const ctx = withTimeout(1000);

      expect(ctx.signal).toBeDefined();
      expect(ctx.signal?.aborted).toBe(false);
      expect(ctx.deadline).toBeGreaterThan(Date.now());
    });

    it('should abort after timeout', async () => {
      const ctx = withTimeout(100);

      expect(ctx.signal?.aborted).toBe(false);

      vi.advanceTimersByTime(100);

      expect(ctx.signal?.aborted).toBe(true);
    });

    it('should set correct deadline', () => {
      const now = Date.now();
      const ctx = withTimeout(5000);

      expect(ctx.deadline).toBeGreaterThanOrEqual(now + 5000);
      expect(ctx.deadline).toBeLessThanOrEqual(now + 5100);
    });
  });

  describe('withSignal', () => {
    it('should create context with provided signal', () => {
      const controller = new AbortController();
      const ctx = withSignal(controller.signal);

      expect(ctx.signal).toBe(controller.signal);
    });

    it('should reflect abort state of provided signal', () => {
      const controller = new AbortController();
      const ctx = withSignal(controller.signal);

      expect(ctx.signal?.aborted).toBe(false);

      controller.abort();

      expect(ctx.signal?.aborted).toBe(true);
    });
  });
});

describe('parseSize', () => {
  it('should return number as-is', () => {
    expect(parseSize(1024)).toBe(1024);
    expect(parseSize(0)).toBe(0);
    expect(parseSize(999999)).toBe(999999);
  });

  it('should parse bytes', () => {
    expect(parseSize('100B')).toBe(100);
    expect(parseSize('100b')).toBe(100);
    expect(parseSize('100')).toBe(100);
  });

  it('should parse kilobytes', () => {
    expect(parseSize('1KB')).toBe(1024);
    expect(parseSize('1kb')).toBe(1024);
    expect(parseSize('10KB')).toBe(10 * 1024);
  });

  it('should parse megabytes', () => {
    expect(parseSize('1MB')).toBe(1024 * 1024);
    expect(parseSize('64MB')).toBe(64 * 1024 * 1024);
    expect(parseSize('256mb')).toBe(256 * 1024 * 1024);
  });

  it('should parse gigabytes', () => {
    expect(parseSize('1GB')).toBe(1024 * 1024 * 1024);
    expect(parseSize('2GB')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('should parse terabytes', () => {
    expect(parseSize('1TB')).toBe(1024 * 1024 * 1024 * 1024);
  });

  it('should handle decimal values', () => {
    expect(parseSize('1.5MB')).toBe(Math.floor(1.5 * 1024 * 1024));
    expect(parseSize('0.5GB')).toBe(Math.floor(0.5 * 1024 * 1024 * 1024));
  });

  it('should handle whitespace', () => {
    expect(parseSize('64 MB')).toBe(64 * 1024 * 1024);
    expect(parseSize('1 GB')).toBe(1024 * 1024 * 1024);
  });

  it('should throw for invalid format', () => {
    expect(() => parseSize('invalid')).toThrow('Invalid size format');
    expect(() => parseSize('MB')).toThrow('Invalid size format');
    expect(() => parseSize('-1MB')).toThrow('Invalid size format');
    expect(() => parseSize('1XB')).toThrow('Invalid size format');
  });
});

describe('Logger implementations', () => {
  describe('noopLogger', () => {
    it('should have all log methods', () => {
      expect(noopLogger.debug).toBeTypeOf('function');
      expect(noopLogger.info).toBeTypeOf('function');
      expect(noopLogger.warn).toBeTypeOf('function');
      expect(noopLogger.error).toBeTypeOf('function');
    });

    it('should not throw when called', () => {
      expect(() => noopLogger.debug('test')).not.toThrow();
      expect(() => noopLogger.info('test', { key: 'value' })).not.toThrow();
      expect(() => noopLogger.warn('test')).not.toThrow();
      expect(() => noopLogger.error('test')).not.toThrow();
    });
  });

  describe('consoleLogger', () => {
    let debugSpy: ReturnType<typeof vi.spyOn>;
    let infoSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should call console.debug', () => {
      consoleLogger.debug('test message');
      expect(debugSpy).toHaveBeenCalledWith('[DEBUG] test message', '');
    });

    it('should call console.info with meta', () => {
      consoleLogger.info('test message', { key: 'value' });
      expect(infoSpy).toHaveBeenCalledWith('[INFO] test message', { key: 'value' });
    });

    it('should call console.warn', () => {
      consoleLogger.warn('warning');
      expect(warnSpy).toHaveBeenCalledWith('[WARN] warning', '');
    });

    it('should call console.error', () => {
      consoleLogger.error('error', { code: 500 });
      expect(errorSpy).toHaveBeenCalledWith('[ERROR] error', { code: 500 });
    });
  });
});
