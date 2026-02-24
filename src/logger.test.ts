import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import pino from 'pino';

describe('logger', () => {
  describe('pino basic functionality', () => {
    test('should create logger with correct level', () => {
      const logger = pino({ level: 'info' });
      expect(logger.level).toBe('info');
    });

    test('should create child logger with context', () => {
      const logger = pino({ level: 'debug' });
      const child = logger.child({ module: 'test' });
      expect(child).toBeDefined();
    });
  });

  describe('createLogger', () => {
    test('should create child logger with context', async () => {
      const { createLogger } = await import('./logger');
      const log = createLogger({ module: 'TestModule' });
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.debug).toBe('function');
    });
  });

  describe('logger methods', () => {
    test('should have all required methods', async () => {
      const { logger } = await import('./logger');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.child).toBe('function');
    });
  });
});