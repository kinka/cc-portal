import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Stream } from './stream';

describe('Stream', () => {
  let stream: Stream<string>;

  beforeEach(() => {
    stream = new Stream<string>();
  });

  describe('push and iteration', () => {
    it('should push values and iterate over them', async () => {
      const values = ['a', 'b', 'c'];

      // Push values
      for (const value of values) {
        stream.enqueue(value);
      }
      stream.done();

      // Collect values
      const collected: string[] = [];
      for await (const value of stream) {
        collected.push(value);
      }

      expect(collected).toEqual(values);
    });

    it('should handle empty stream', async () => {
      stream.done();

      const collected: string[] = [];
      for await (const value of stream) {
        collected.push(value);
      }

      expect(collected).toEqual([]);
    });

    it('should handle async iteration', async () => {
      const promise = (async () => {
        const collected: string[] = [];
        for await (const value of stream) {
          collected.push(value);
        }
        return collected;
      })();

      // Push values after iteration starts
      stream.enqueue('x');
      stream.enqueue('y');
      stream.done();

      const result = await promise;
      expect(result).toEqual(['x', 'y']);
    });
  });

  describe('error handling', () => {
    it('should handle errors', async () => {
      const error = new Error('test error');

      const promise = (async () => {
        const collected: string[] = [];
        for await (const value of stream) {
          collected.push(value);
        }
        return collected;
      })();

      stream.error(error);

      await expect(promise).rejects.toThrow('test error');
    });
  });

  describe('Symbol.asyncIterator', () => {
    it('should implement async iterator protocol', () => {
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    });
  });
});
