import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { logger } from './logger';

describe('logger', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    delete process.env.DEBUG;
  });

  describe('info', () => {
    test('should log info message', () => {
      logger.info('test message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[INFO]');
      expect(call[1]).toBe('test message');
    });

    test('should log multiple arguments', () => {
      logger.info('message', { key: 'value' }, 123);
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[1]).toBe('message');
      expect(call[2]).toEqual({ key: 'value' });
      expect(call[3]).toBe(123);
    });
  });

  describe('error', () => {
    test('should log error message', () => {
      logger.error('error message');
      expect(consoleErrorSpy).toHaveBeenCalled();
      const call = consoleErrorSpy.mock.calls[0];
      expect(call[0]).toContain('[ERROR]');
      expect(call[1]).toBe('error message');
    });
  });

  describe('warn', () => {
    test('should log warning message', () => {
      logger.warn('warning message');
      expect(consoleWarnSpy).toHaveBeenCalled();
      const call = consoleWarnSpy.mock.calls[0];
      expect(call[0]).toContain('[WARN]');
      expect(call[1]).toBe('warning message');
    });
  });

  describe('debug', () => {
    test('should not log debug message when DEBUG is not set', () => {
      logger.debug('debug message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    test('should log debug message when DEBUG is set', () => {
      process.env.DEBUG = 'true';
      logger.debug('debug message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[DEBUG]');
      expect(call[1]).toBe('debug message');
    });
  });

  describe('success', () => {
    test('should log success message', () => {
      logger.success('success message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const call = consoleLogSpy.mock.calls[0];
      expect(call[0]).toContain('[SUCCESS]');
      expect(call[1]).toBe('success message');
    });
  });
});
