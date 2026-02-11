import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from './logger';

describe('logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEBUG;
  });

  describe('info', () => {
    it('should log info message', () => {
      logger.info('test message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[INFO]');
      expect(call[1]).toBe('test message');
    });

    it('should log multiple arguments', () => {
      logger.info('message', { key: 'value' }, 123);
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[1]).toBe('message');
      expect(call[2]).toEqual({ key: 'value' });
      expect(call[3]).toBe(123);
    });
  });

  describe('error', () => {
    it('should log error message', () => {
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalled();
      const call = consoleErrorSpy.mock.calls[0];
      expect(call[0]).toContain('[ERROR]');
      expect(call[1]).toBe('error message');
    });
  });

  describe('warn', () => {
    it('should log warning message', () => {
      logger.warn('warning message');
      expect(consoleWarnSpy).toHaveBeenCalled();
      const call = consoleWarnSpy.mock.calls[0];
      expect(call[0]).toContain('[WARN]');
      expect(call[1]).toBe('warning message');
    });
  });

  describe('debug', () => {
    it('should not log debug message when DEBUG is not set', () => {
      logger.debug('debug message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should log debug message when DEBUG is set', () => {
      process.env.DEBUG = 'true';
      logger.debug('debug message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[DEBUG]');
      expect(call[1]).toBe('debug message');
    });
  });

  describe('success', () => {
    it('should log success message', () => {
      logger.success('success message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[SUCCESS]');
      expect(call[1]).toBe('success message');
    });
  });
});
