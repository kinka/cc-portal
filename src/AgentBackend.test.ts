import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentBackend } from './AgentBackend';

describe('AgentBackend Types', () => {
  describe('AgentMessage', () => {
    it('should accept model-output message', () => {
      const msg: AgentMessage = {
        type: 'model-output',
        textDelta: 'Hello',
        fullText: 'Hello world',
      };
      expect(msg.type).toBe('model-output');
    });

    it('should accept status message', () => {
      const msg: AgentMessage = {
        type: 'status',
        status: 'running',
        detail: 'Processing',
      };
      expect(msg.type).toBe('status');
    });

    it('should accept tool-call message', () => {
      const msg: AgentMessage = {
        type: 'tool-call',
        toolName: 'Read',
        args: { path: '/tmp/file' },
        callId: 'call-123',
      };
      expect(msg.type).toBe('tool-call');
    });

    it('should accept tool-result message', () => {
      const msg: AgentMessage = {
        type: 'tool-result',
        toolName: 'Read',
        result: 'file content',
        callId: 'call-123',
      };
      expect(msg.type).toBe('tool-result');
    });

    it('should accept error message', () => {
      const msg: AgentMessage = {
        type: 'error',
        error: 'Something went wrong',
      };
      expect(msg.type).toBe('error');
    });

    it('should accept permission-request message', () => {
      const msg: AgentMessage = {
        type: 'permission-request',
        id: 'perm-123',
        reason: 'Tool call: Bash',
        payload: { toolName: 'Bash' },
      };
      expect(msg.type).toBe('permission-request');
    });

    it('should accept permission-response message', () => {
      const msg: AgentMessage = {
        type: 'permission-response',
        id: 'perm-123',
        approved: true,
      };
      expect(msg.type).toBe('permission-response');
    });

    it('should accept terminal-output message', () => {
      const msg: AgentMessage = {
        type: 'terminal-output',
        data: 'ls -la',
      };
      expect(msg.type).toBe('terminal-output');
    });

    it('should accept event message', () => {
      const msg: AgentMessage = {
        type: 'event',
        name: 'custom-event',
        payload: { key: 'value' },
      };
      expect(msg.type).toBe('event');
    });
  });
});
