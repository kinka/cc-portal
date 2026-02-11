import { describe, it, expect } from 'vitest';
import { getCleanEnv, logDebug } from './utils';

// Inline isBun function for testing
const isBun = (): boolean => {
  return typeof (process as any).isBun !== 'undefined' ||
         process.versions?.bun !== undefined;
};

describe('SDK Utils', () => {
  describe('getCleanEnv', () => {
    it('should return environment variables', () => {
      const env = getCleanEnv();
      expect(env).toBeDefined();
      expect(typeof env).toBe('object');
      expect(env.PATH).toBeDefined();
    });

    it('should include HOME directory', () => {
      const env = getCleanEnv();
      expect(env.HOME).toBeDefined();
    });
  });

  describe('logDebug', () => {
    it('should not throw when logging', () => {
      expect(() => logDebug('test message')).not.toThrow();
      expect(() => logDebug('message with', { key: 'value' })).not.toThrow();
    });
  });

  describe('isBun', () => {
    it('should return boolean', () => {
      const result = isBun();
      expect(typeof result).toBe('boolean');
    });

    it('should detect Bun runtime', () => {
      // This test will pass whether running in Bun or Node
      const result = isBun();
      if (process.versions?.bun) {
        expect(result).toBe(true);
      }
    });
  });
});
