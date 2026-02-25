import { test, describe, expect } from 'bun:test';
import { buildApp } from '../src/app';
import { ClaudeSession } from '../src/ClaudeSession';
import { ClaudeSessionManager } from '../src/ClaudeSessionManager';
import { DatabaseManager } from '../src/db';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runE2E = !!process.env.RUN_E2E;

describe('ClaudeSession.buildPrompt', () => {
  test('no from: content unchanged', () => {
    expect(ClaudeSession.buildPrompt('hello')).toBe('hello');
    expect(ClaudeSession.buildPrompt('hello', undefined)).toBe('hello');
  });

  test('empty from: content unchanged', () => {
    expect(ClaudeSession.buildPrompt('hello', '')).toBe('hello');
  });

  test('from is prepended as [from]: content', () => {
    expect(ClaudeSession.buildPrompt('你好', 'alice')).toBe('[alice]: 你好');
    expect(ClaudeSession.buildPrompt('hello', 'bob')).toBe('[bob]: hello');
  });

  test('from with spaces in content', () => {
    expect(ClaudeSession.buildPrompt('what is 2+2?', 'alice')).toBe('[alice]: what is 2+2?');
  });

  test('multiline content preserves newlines', () => {
    expect(ClaudeSession.buildPrompt('line1\nline2', 'alice')).toBe('[alice]: line1\nline2');
  });

  test('multi-user: injects session context header', () => {
    const ctx = {
      apiBaseUrl: 'http://localhost:3333',
      userId: 'alice',
      sessionId: 'sid-123',
      ownerId: 'alice',
      participants: ['alice', 'bob'],
    };
    const result = ClaudeSession.buildPrompt('hello', 'bob', ctx);
    expect(result).toContain('[Session Context]');
    expect(result).toContain('CC-Agents API: http://localhost:3333');
    expect(result).toContain('Auth header: X-User-ID: alice');
    expect(result).toContain('Your session ID: sid-123');
    expect(result).toContain('Participants: alice, bob');
    expect(result).toContain('Current speaker: bob');
    expect(result).toContain('[bob]: hello');
  });

  test('single-user: no context header even if context provided', () => {
    const ctx = {
      apiBaseUrl: 'http://localhost:3333',
      userId: 'alice',
      sessionId: 'sid-123',
      ownerId: 'alice',
      participants: ['alice'],
    };
    const result = ClaudeSession.buildPrompt('hello', 'alice', ctx);
    expect(result).toBe('[alice]: hello');
    expect(result).not.toContain('[Session Context]');
  });

  test('no context: behaves like original buildPrompt', () => {
    expect(ClaudeSession.buildPrompt('hello', 'alice', undefined)).toBe('[alice]: hello');
    expect(ClaudeSession.buildPrompt('hello', undefined, undefined)).toBe('hello');
  });
});

describe('API (no claude)', () => {
  test('GET /health returns ok', async () => {
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; timestamp: string };
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    } finally {
      await app.close();
    }
  });

  test('GET /sessions returns empty array initially', async () => {
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('POST /sessions without path returns 400', async () => {
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('path');
    } finally {
      await app.close();
    }
  });

  test('GET /sessions/:id for non-existent returns 404', async () => {
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('Session not found');
    } finally {
      await app.close();
    }
  });

  test('create session then get session details', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const createBody = (await createRes.json()) as {
        sessionId: string;
        path: string;
        createdAt: string;
      };
      expect(createBody.sessionId).toBeDefined();
      const dirReal = realpathSync.native(dir);
      expect(createBody.path).toBe(dirReal);

      const listRes = await fetch(`${base}/sessions`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        sessions: Array<{ sessionId: string; path: string; createdAt: string }>;
      };
      expect(listBody.sessions.length).toBe(1);
      expect(listBody.sessions[0].sessionId).toBe(createBody.sessionId);
      expect(listBody.sessions[0].path).toBe(dirReal);

      const getRes = await fetch(`${base}/sessions/${createBody.sessionId}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        sessionId: string;
        path: string;
        createdAt: string;
        messages: Array<{ id: string; role: string; content: string; timestamp: string }>;
      };
      expect(getBody.sessionId).toBe(createBody.sessionId);
      expect(getBody.path).toBe(dirReal);
      expect(getBody.createdAt).toBeDefined();
      expect(Array.isArray(getBody.messages)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('GET /sessions/:id/stream returns SSE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const streamRes = await fetch(`${base}/sessions/${sessionId}/stream`);
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('Content-Type')).toContain('text/event-stream');
      await Promise.race([
        streamRes.text(),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('stream read timeout')), 3000)),
      ]).catch(() => {});
    } finally {
      await app.close();
    }
  });

  test('GET /sessions/:id/pending-permissions returns empty when no pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const permRes = await fetch(`${base}/sessions/${sessionId}/pending-permissions`);
      expect(permRes.status).toBe(200);
      const permBody = (await permRes.json()) as { pending: unknown[] };
      expect(permBody.pending).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('POST /sessions/:id/permissions/:requestId for unknown returns 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const permRes = await fetch(`${base}/sessions/${sessionId}/permissions/fake-request-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false }),
      });
      expect(permRes.status).toBe(404);
      const body = (await permRes.json()) as { error?: string };
      expect(body.error).toBeDefined();
    } finally {
      await app.close();
    }
  });

  test('delete session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const delRes = await fetch(`${base}/sessions/${sessionId}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const delBody = (await delRes.json()) as { sessionId: string; status: string };
      expect(delBody.sessionId).toBe(sessionId);
      expect(delBody.status).toBe('deleted');

      const getRes = await fetch(`${base}/sessions/${sessionId}`);
      expect(getRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('E2E (real claude)', () => {
  test.skipIf(!runE2E)('create session and single turn message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const msgRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Reply with exactly one word: OK' }),
      });
      expect(msgRes.status).toBe(200);
      const msgBody = (await msgRes.json()) as { response: string };
      expect(typeof msgBody.response).toBe('string');
      expect(msgBody.response.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  }, 120_000);

  test.skipIf(!runE2E)('multi-turn: same session two messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-e2e-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Remember my name is TestUser. Reply only: Got it.' }),
      });

      const secondRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is my name? Reply in one short sentence.' }),
      });
      expect(secondRes.status).toBe(200);
      const secondBody = (await secondRes.json()) as { response: string };
      expect(secondBody.response.toLowerCase()).toContain('testuser');
    } finally {
      await app.close();
    }
  }, 120_000);

  test.skipIf(!runE2E)('multi-user: Claude is aware of who is speaking via [from] prefix', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'alice-multiuser';
    const participant = 'bob-multiuser';

    try {
      // Create session and add participant
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });

      // Alice introduces herself
      const aliceRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ message: 'My name is Alice. Reply with only: Got it, Alice.', from: owner }),
      });
      expect(aliceRes.status).toBe(200);

      // Bob introduces himself from the same session
      const bobRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': participant },
        body: JSON.stringify({ message: 'My name is Bob. Reply with only: Got it, Bob.', from: participant }),
      });
      expect(bobRes.status).toBe(200);

      // Ask Claude who the participants are — Claude should know both names
      const queryRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({
          message: 'List the names of everyone who has spoken to you in this conversation. One name per line.',
          from: owner,
        }),
      });
      expect(queryRes.status).toBe(200);
      const { response } = (await queryRes.json()) as { response: string };
      const lower = response.toLowerCase();
      expect(lower).toContain('alice');
      expect(lower).toContain('bob');

      // Verify stored history: content is original (no prefix), from field is set
      const histRes = await fetch(`${base}/sessions/${sessionId}`, {
        headers: { 'X-User-ID': owner },
      });
      const { messages } = (await histRes.json()) as {
        messages: Array<{ role: string; content: string; from?: string }>;
      };
      const aliceMsg = messages.find(m => m.from === owner && m.role === 'user');
      const bobMsg   = messages.find(m => m.from === participant && m.role === 'user');

      // Stored content should be original (without prefix)
      expect(aliceMsg?.content).not.toContain('[alice-multiuser]:');
      expect(bobMsg?.content).not.toContain('[bob-multiuser]:');
      // from field correctly set
      expect(aliceMsg?.from).toBe(owner);
      expect(bobMsg?.from).toBe(participant);
    } finally {
      await app.close();
    }
  }, 120_000);

  test.skipIf(!runE2E)('session auto-resume after server restart', async () => {
    const dbPath = join(tmpdir(), 'cc-agents-restart-test.db');
    const dir = mkdtempSync(join(tmpdir(), 'cc-agents-restart-'));
    const userId = 'restart-test-user';

    // First app instance
    const db1 = new DatabaseManager(dbPath);
    const manager1 = new ClaudeSessionManager(db1, { usersDir: dir });
    const app1 = buildApp({ sessionManager: manager1, db: db1 });
    await app1.listen({ port: 0, host: '127.0.0.1' });
    const port1 = (app1.server!.address() as { port: number }).port;
    const base1 = `http://127.0.0.1:${port1}`;

    try {
      // Create session with first app
      const createRes = await fetch(`${base1}/sessions?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Stop the session (simulating server shutdown)
      const stopRes = await fetch(`${base1}/sessions/${sessionId}/stop?userId=${userId}`, { method: 'POST' });
      expect(stopRes.status).toBe(200);

      // Close first app
      await app1.close();
      db1.close();

      // Second app instance (simulating restart)
      const db2 = new DatabaseManager(dbPath);
      const manager2 = new ClaudeSessionManager(db2, { usersDir: dir });
      const app2 = buildApp({ sessionManager: manager2, db: db2 });
      await app2.listen({ port: 0, host: '127.0.0.1' });
      const port2 = (app2.server!.address() as { port: number }).port;
      const base2 = `http://127.0.0.1:${port2}`;

      try {
        // Access the session (should auto-resume)
        const getRes = await fetch(`${base2}/sessions/${sessionId}?userId=${userId}`);
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as { sessionId: string; status: string };
        expect(getBody.sessionId).toBe(sessionId);
        // Should be accessible (auto-resumed)
        expect(getBody.status).toBe('running');

        // Cleanup
        await fetch(`${base2}/sessions/${sessionId}?userId=${userId}`, { method: 'DELETE' });
      } finally {
        await app2.close();
        db2.close();
      }
    } finally {
      // Cleanup database file
      try { rmSync(dbPath); } catch {}
    }
  }, 120_000);
});

describe('Cross-Session Messaging', () => {
  test('GET /my-sessions returns empty initially', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-1';

    try {
      const res = await fetch(`${base}/my-sessions`, {
        headers: { 'X-User-ID': userId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('create sessions and list them via /my-sessions', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-2';

    try {
      // Create first session (no path - uses userDir)
      const res1 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({ project: 'project-a' }),
      });
      expect(res1.status).toBe(200);
      const session1 = (await res1.json()) as { sessionId: string };

      // Create second session
      const res2 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({ project: 'project-b' }),
      });
      expect(res2.status).toBe(200);
      const session2 = (await res2.json()) as { sessionId: string };

      // List sessions via /my-sessions
      const listRes = await fetch(`${base}/my-sessions`, {
        headers: { 'X-User-ID': userId },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        sessions: Array<{ sessionId: string; userId: string; project?: string }>;
      };
      expect(listBody.sessions.length).toBe(2);
      expect(listBody.sessions.map(s => s.sessionId).sort()).toEqual(
        [session1.sessionId, session2.sessionId].sort(),
      );
    } finally {
      await app.close();
    }
  });

  test('send message between sessions of same user', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-3';

    try {
      // Create two sessions (no path)
      const res1 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({}),
      });
      const session1 = (await res1.json()) as { sessionId: string };

      const res2 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({}),
      });
      const session2 = (await res2.json()) as { sessionId: string };

      // Send message from session1 to session2
      const sendRes = await fetch(`${base}/sessions/${session1.sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({
          targetSessionId: session2.sessionId,
          type: 'task',
          content: 'Hello from session1!',
        }),
      });
      expect(sendRes.status).toBe(200);
      const sendBody = (await sendRes.json()) as { messageId: string };
      expect(sendBody.messageId).toBeDefined();

      // Check inbox of session2
      const inboxRes = await fetch(`${base}/sessions/${session2.sessionId}/inbox`, {
        headers: { 'X-User-ID': userId },
      });
      expect(inboxRes.status).toBe(200);
      const inboxBody = (await inboxRes.json()) as {
        messages: Array<{ id: string; content: string; fromSessionId: string }>;
        unread: number;
      };
      expect(inboxBody.messages.length).toBe(1);
      expect(inboxBody.messages[0].content).toBe('Hello from session1!');
      expect(inboxBody.messages[0].fromSessionId).toBe(session1.sessionId);
      expect(inboxBody.unread).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('mark message as read', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-4';

    try {
      // Create two sessions and send a message
      const res1 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({}),
      });
      const session1 = (await res1.json()) as { sessionId: string };

      const res2 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({}),
      });
      const session2 = (await res2.json()) as { sessionId: string };

      await fetch(`${base}/sessions/${session1.sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({
          targetSessionId: session2.sessionId,
          type: 'message',
          content: 'Test message',
        }),
      });

      // Get inbox to find messageId
      const inboxRes = await fetch(`${base}/sessions/${session2.sessionId}/inbox`, {
        headers: { 'X-User-ID': userId },
      });
      const inboxBody = (await inboxRes.json()) as {
        messages: Array<{ id: string; readAt?: string }>;
        unread: number;
      };
      const messageId = inboxBody.messages[0].id;
      expect(inboxBody.unread).toBe(1);

      // Mark as read
      const readRes = await fetch(`${base}/sessions/${session2.sessionId}/inbox/${messageId}/read`, {
        method: 'POST',
        headers: { 'X-User-ID': userId },
      });
      expect(readRes.status).toBe(200);

      // Verify unread count decreased
      const inboxRes2 = await fetch(`${base}/sessions/${session2.sessionId}/inbox?unread=1`, {
        headers: { 'X-User-ID': userId },
      });
      const inboxBody2 = (await inboxRes2.json()) as { messages: unknown[]; unread: number };
      expect(inboxBody2.messages.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('broadcast message to all user sessions', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-5';

    try {
      // Create three sessions (no path)
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
          body: JSON.stringify({}),
        });
        sessions.push((await res.json()) as { sessionId: string });
      }

      const [session1, session2, session3] = sessions;

      // Broadcast from session1 to all other sessions
      const broadcastRes = await fetch(`${base}/sessions/${session1.sessionId}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({
          type: 'announcement',
          content: 'Broadcast to all!',
        }),
      });
      expect(broadcastRes.status).toBe(200);
      const broadcastBody = (await broadcastRes.json()) as { count: number };
      expect(broadcastBody.count).toBe(2); // Sent to session2 and session3

      // Verify session2 received the message
      const inbox2 = await fetch(`${base}/sessions/${session2.sessionId}/inbox`, {
        headers: { 'X-User-ID': userId },
      });
      const inbox2Body = (await inbox2.json()) as { messages: Array<{ content: string }> };
      expect(inbox2Body.messages.length).toBe(1);
      expect(inbox2Body.messages[0].content).toBe('Broadcast to all!');

      // Verify session3 received the message
      const inbox3 = await fetch(`${base}/sessions/${session3.sessionId}/inbox`, {
        headers: { 'X-User-ID': userId },
      });
      const inbox3Body = (await inbox3.json()) as { messages: Array<{ content: string }> };
      expect(inbox3Body.messages.length).toBe(1);

      // Verify session1 (sender) did NOT receive the broadcast
      const inbox1 = await fetch(`${base}/sessions/${session1.sessionId}/inbox`, {
        headers: { 'X-User-ID': userId },
      });
      const inbox1Body = (await inbox1.json()) as { messages: unknown[] };
      expect(inbox1Body.messages.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('cannot send message to session of different user', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId1 = 'test-user-a';
    const userId2 = 'test-user-b';

    try {
      // Create sessions for different users
      const res1 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId1 },
        body: JSON.stringify({}),
      });
      const session1 = (await res1.json()) as { sessionId: string };

      const res2 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId2 },
        body: JSON.stringify({}),
      });
      const session2 = (await res2.json()) as { sessionId: string };

      // Try to send from user1's session to user2's session (should fail)
      const sendRes = await fetch(`${base}/sessions/${session1.sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId1 },
        body: JSON.stringify({
          targetSessionId: session2.sessionId,
          type: 'message',
          content: 'Trying to send to another user',
        }),
      });
      expect(sendRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('User Directory', () => {
  test('search users returns empty when no users', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'test-user-1';

    try {
      const res = await fetch(`${base}/users?query=test`, {
        headers: { 'X-User-ID': userId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: unknown[] };
      expect(body.users).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('create user profile and search for users', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId1 = 'alice';
    const userId2 = 'bob';

    try {
      // Create profiles
      await fetch(`${base}/me/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId1 },
        body: JSON.stringify({
          displayName: 'Alice Smith',
          skills: ['typescript', 'rust'],
          currentProjects: ['cc-agents'],
        }),
      });

      await fetch(`${base}/me/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId2 },
        body: JSON.stringify({
          displayName: 'Bob Jones',
          skills: ['python', 'go'],
          currentProjects: ['backend-service'],
        }),
      });

      // Search for Alice
      const searchRes = await fetch(`${base}/users?query=alice`, {
        headers: { 'X-User-ID': userId2 },
      });
      const searchBody = (await searchRes.json()) as {
        users: Array<{ userId: string; displayName: string }>;
      };
      expect(searchBody.users.length).toBe(1);
      expect(searchBody.users[0].userId).toBe('alice');
      expect(searchBody.users[0].displayName).toBe('Alice Smith');

      // Get Alice's profile
      const profileRes = await fetch(`${base}/users/alice/profile`, {
        headers: { 'X-User-ID': userId2 },
      });
      const profileBody = (await profileRes.json()) as {
        userId: string;
        displayName: string;
        skills: string[];
      };
      expect(profileBody.userId).toBe('alice');
      expect(profileBody.skills).toEqual(['typescript', 'rust']);
    } finally {
      await app.close();
    }
  });

});

describe('Shared Session (direct participant add)', () => {
  function makeApp() {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    return { db, manager, app };
  }

  test('owner can add participant directly without invite/join flow', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-1';
    const participant = 'sp-participant-1';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // One step: owner directly adds participant
      const addRes = await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });
      expect(addRes.status).toBe(200);
      const addBody = (await addRes.json()) as { success: boolean };
      expect(addBody.success).toBe(true);

      // Participant appears in the list as joined
      const listRes = await fetch(`${base}/sessions/${sessionId}/participants`, {
        headers: { 'X-User-ID': owner },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        ownerId: string;
        participants: Array<{ userId: string; status: string }>;
      };
      expect(listBody.ownerId).toBe(owner);
      expect(listBody.participants.some(p => p.userId === participant)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('participant can read session history immediately after being added', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-2';
    const participant = 'sp-participant-2';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });

      // Participant reads session history via GET /sessions/:id
      const getRes = await fetch(`${base}/sessions/${sessionId}`, {
        headers: { 'X-User-ID': participant },
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { sessionId: string; messages: unknown[] };
      expect(getBody.sessionId).toBe(sessionId);
      expect(Array.isArray(getBody.messages)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('non-participant cannot access session', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-3';
    const stranger = 'sp-stranger-3';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const getRes = await fetch(`${base}/sessions/${sessionId}`, {
        headers: { 'X-User-ID': stranger },
      });
      expect(getRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  test('only owner can add participants', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-4';
    const nonOwner = 'sp-nonowner-4';
    const target = 'sp-target-4';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const addRes = await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': nonOwner },
        body: JSON.stringify({ userId: target }),
      });
      expect(addRes.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  test('added participant appears in /my/shared-sessions', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-5';
    const participant = 'sp-participant-5';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });

      const sharedRes = await fetch(`${base}/my/shared-sessions`, {
        headers: { 'X-User-ID': participant },
      });
      expect(sharedRes.status).toBe(200);
      const sharedBody = (await sharedRes.json()) as { sessions: Array<{ id: string }> };
      expect(sharedBody.sessions.some(s => s.id === sessionId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('adding same participant twice is idempotent', async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const owner = 'sp-owner-6';
    const participant = 'sp-participant-6';

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({}),
      });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Add twice - should both succeed (idempotent)
      const add1 = await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });
      expect(add1.status).toBe(200);

      const add2 = await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });
      expect(add2.status).toBe(200);

      // Still only one entry in participant list
      const listRes = await fetch(`${base}/sessions/${sessionId}/participants`, {
        headers: { 'X-User-ID': owner },
      });
      const listBody = (await listRes.json()) as {
        participants: Array<{ userId: string }>;
      };
      expect(listBody.participants.filter(p => p.userId === participant).length).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('Session Links', () => {
  test('create link invitation and accept', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userA = 'user-a';
    const userB = 'user-b';

    try {
      // Create sessions for both users (no path)
      const resA = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({}),
      });
      const sessionA = (await resA.json()) as { sessionId: string };

      const resB = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({}),
      });
      const sessionB = (await resB.json()) as { sessionId: string };

      // UserA creates link invitation to UserB
      const linkRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({
          targetUserId: userB,
          mode: 'bidirectional',
          initialMessage: 'Let\'s collaborate!',
        }),
      });
      expect(linkRes.status).toBe(200);
      const linkBody = (await linkRes.json()) as {
        link: { id: string; status: string };
      };
      expect(linkBody.link.status).toBe('pending');

      // UserB checks invitations
      const inviteRes = await fetch(`${base}/me/links/invitations`, {
        headers: { 'X-User-ID': userB },
      });
      expect(inviteRes.status).toBe(200);
      const inviteBody = (await inviteRes.json()) as {
        invitations: Array<{ id: string; initiatorUserId: string }>;
      };
      expect(inviteBody.invitations.length).toBe(1);
      expect(inviteBody.invitations[0].initiatorUserId).toBe(userA);

      // UserB accepts the invitation
      const acceptRes = await fetch(`${base}/me/links/invitations/${linkBody.link.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({ sessionId: sessionB.sessionId }),
      });
      expect(acceptRes.status).toBe(200);

      // Verify link is active for UserA
      const linksRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        headers: { 'X-User-ID': userA },
      });
      const linksBody = (await linksRes.json()) as {
        links: Array<{ status: string; targetSessionId: string }>;
      };
      expect(linksBody.links.length).toBe(1);
      expect(linksBody.links[0].status).toBe('active');
    } finally {
      await app.close();
    }
  });

  test('decline link invitation', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userA = 'user-a-decline';
    const userB = 'user-b-decline';

    try {
      // Create sessions
      const resA = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({}),
      });
      const sessionA = (await resA.json()) as { sessionId: string };

      const resB = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({}),
      });
      const sessionB = (await resB.json()) as { sessionId: string };

      // Create invitation
      const linkRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({ targetUserId: userB }),
      });
      const linkBody = (await linkRes.json()) as { link: { id: string } };

      // UserB declines
      const declineRes = await fetch(`${base}/me/links/invitations/${linkBody.link.id}/decline`, {
        method: 'POST',
        headers: { 'X-User-ID': userB },
      });
      expect(declineRes.status).toBe(200);

      // Verify no pending invitations
      const inviteRes = await fetch(`${base}/me/links/invitations`, {
        headers: { 'X-User-ID': userB },
      });
      const inviteBody = (await inviteRes.json()) as { invitations: unknown[] };
      expect(inviteBody.invitations.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('send message through active link', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userA = 'user-a-msg';
    const userB = 'user-b-msg';

    try {
      // Setup profiles
      await fetch(`${base}/me/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({ displayName: 'User A' }),
      });

      // Create sessions
      const resA = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({}),
      });
      const sessionA = (await resA.json()) as { sessionId: string };

      const resB = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({}),
      });
      const sessionB = (await resB.json()) as { sessionId: string };

      // Create and accept link
      const linkRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({ targetUserId: userB }),
      });
      const linkBody = (await linkRes.json()) as { link: { id: string } };

      await fetch(`${base}/me/links/invitations/${linkBody.link.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({ sessionId: sessionB.sessionId }),
      });

      // Send message through link
      const msgRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links/${linkBody.link.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({ content: 'Hello through link!' }),
      });
      expect(msgRes.status).toBe(200);
      const msgBody = (await msgRes.json()) as { ok: boolean; mentions: string[] };
      expect(msgBody.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('disconnect link', async () => {
    const db = new DatabaseManager(':memory:');
    const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userA = 'user-a-disconnect';
    const userB = 'user-b-disconnect';

    try {
      // Create sessions
      const resA = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({}),
      });
      const sessionA = (await resA.json()) as { sessionId: string };

      const resB = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({}),
      });
      const sessionB = (await resB.json()) as { sessionId: string };

      // Create and accept link
      const linkRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userA },
        body: JSON.stringify({ targetUserId: userB }),
      });
      const linkBody = (await linkRes.json()) as { link: { id: string } };

      await fetch(`${base}/me/links/invitations/${linkBody.link.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userB },
        body: JSON.stringify({ sessionId: sessionB.sessionId }),
      });

      // Disconnect
      const disconnectRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links/${linkBody.link.id}`, {
        method: 'DELETE',
        headers: { 'X-User-ID': userA },
      });
      expect(disconnectRes.status).toBe(200);

      // Verify link is disconnected
      const linksRes = await fetch(`${base}/sessions/${sessionA.sessionId}/links`, {
        headers: { 'X-User-ID': userA },
      });
      const linksBody = (await linksRes.json()) as { links: Array<{ status: string }> };
      const activeLinks = linksBody.links.filter(l => l.status === 'active');
      expect(activeLinks.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});