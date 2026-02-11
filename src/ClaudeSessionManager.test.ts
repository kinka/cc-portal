import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeSessionManager } from './ClaudeSessionManager';

describe('ClaudeSessionManager', () => {
  let manager: ClaudeSessionManager;

  beforeEach(() => {
    manager = new ClaudeSessionManager();
  });

  afterEach(async () => {
    await manager.stopAllSessions();
  });

  describe('createSession', () => {
    it('should create a session with basic options', async () => {
      const session = await manager.createSession({
        path: '/tmp/test',
        initialMessage: 'Hello',
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.path).toBe('/tmp/test');
      // Note: status may be 'starting' initially, then 'running'
      expect(['starting', 'running']).toContain(session.status);
    }, 10000); // 10 second timeout

    it('should create a session with all options', async () => {
      const session = await manager.createSession({
        path: '/tmp/test',
        initialMessage: 'Hello',
        model: 'claude-sonnet-4.5',
        allowedTools: ['Read', 'Edit'],
        disallowedTools: ['Bash'],
        envVars: { KEY: 'value' },
        customSystemPrompt: 'Custom prompt',
        appendSystemPrompt: 'Append prompt',
        maxTurns: 50,
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: { SERVER_KEY: 'value' },
          },
        },
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
    }, 10000);
  });

  describe('getSession', () => {
    it('should return session by id', async () => {
      const session = await manager.createSession({
        path: '/tmp/test',
      });

      const retrieved = manager.getSession(session.id);
      expect(retrieved).toBe(session);
    }, 10000);

    it('should return undefined for non-existent session', () => {
      const retrieved = manager.getSession('non-existent-id');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('should return empty array initially', () => {
      const sessions = manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should list all sessions', async () => {
      const session1 = await manager.createSession({ path: '/tmp/test1' });
      const session2 = await manager.createSession({ path: '/tmp/test2' });

      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain(session1.id);
      expect(sessions.map(s => s.id)).toContain(session2.id);
    }, 20000);
  });

  describe('stopSession', () => {
    it('should stop a running session', async () => {
      const session = await manager.createSession({ path: '/tmp/test' });
      expect(['starting', 'running']).toContain(session.status);

      await manager.stopSession(session.id);
      expect(session.status).toBe('stopped');
    }, 10000);

    it('should throw error for non-existent session', async () => {
      await expect(manager.stopSession('non-existent-id')).rejects.toThrow('Session non-existent-id not found');
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const session = await manager.createSession({ path: '/tmp/test' });
      const id = session.id;

      await manager.deleteSession(id);
      expect(manager.getSession(id)).toBeUndefined();
    }, 10000);

    it('should throw error for non-existent session', async () => {
      await expect(manager.deleteSession('non-existent-id')).rejects.toThrow('Session non-existent-id not found');
    });
  });

  describe('stopAllSessions', () => {
    it('should stop all sessions', async () => {
      const session1 = await manager.createSession({ path: '/tmp/test1' });
      const session2 = await manager.createSession({ path: '/tmp/test2' });

      await manager.stopAllSessions();

      expect(session1.status).toBe('stopped');
      expect(session2.status).toBe('stopped');
    }, 20000);
  });
});
