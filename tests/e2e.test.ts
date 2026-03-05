import { test, describe, expect, beforeEach, afterEach } from 'bun:test';
import { buildApp } from '../src/app';
import { ClaudeSession } from '../src/ClaudeSession';
import { ClaudeSessionManager } from '../src/ClaudeSessionManager';
import { CLISessionStorage } from '../src/CLISessionStorage';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const runE2E = !!process.env.RUN_E2E;

// Helper to create app with isolated storage for testing
function createTestApp() {
  const testUsersDir = mkdtempSync(join(tmpdir(), 'cc-portal-test-'));
  const storage = new CLISessionStorage(testUsersDir);
  const manager = new ClaudeSessionManager(storage, { usersDir: testUsersDir });
  const app = buildApp({ sessionManager: manager, storage });
  return { app, testUsersDir };
}

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
    expect(result).toContain('CC-Portal API: http://localhost:3333');
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
    const { app, testUsersDir } = createTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions`, {
        headers: { 'X-User-ID': 'test-user' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[] };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(0);
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('POST /sessions without path creates session in user directory', async () => {
    const { app, testUsersDir } = createTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': 'test-user' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; path: string };
      expect(body.sessionId).toBeDefined();
      // Path should be the user's directory
      expect(body.path).toContain('test-user');
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('GET /sessions/:id for non-existent returns 404', async () => {
    const { app, testUsersDir } = createTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/sessions/00000000-0000-0000-0000-000000000000`, {
        headers: { 'X-User-ID': 'test-user' },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('Session not found');
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });
  test('create session then get session details', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
    const { app, testUsersDir } = createTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': 'test-user' },
        body: JSON.stringify({ path: dir }),
      });
      expect(createRes.status).toBe(200);
      const createBody = (await createRes.json()) as {
        sessionId: string;
        path: string;
        createdAt: string;
      };
      expect(createBody.sessionId).toBeDefined();
      // Path should contain the temp directory name
      expect(createBody.path).toContain('cc-portal-e2e-');

      const listRes = await fetch(`${base}/sessions`, {
        headers: { 'X-User-ID': 'test-user' },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        sessions: Array<{ sessionId: string; path: string; createdAt: string }>;
      };
      expect(listBody.sessions.length).toBe(1);
      expect(listBody.sessions[0].sessionId).toBe(createBody.sessionId);

      const getRes = await fetch(`${base}/sessions/${createBody.sessionId}`, {
        headers: { 'X-User-ID': 'test-user' },
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        sessionId: string;
        path: string;
        createdAt: string;
      };
      expect(getBody.sessionId).toBe(createBody.sessionId);
      expect(getBody.createdAt).toBeDefined();
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test.skipIf(!runE2E)('GET /sessions/:id/stream returns SSE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-'));
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
    const { app, testUsersDir } = createTestApp();
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
      const histRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        headers: { 'X-User-ID': owner },
      });
      const histBody = (await histRes.json()) as {
        messages: Array<{ role: string; content: string; from?: string }>;
      };
      const messages = histBody.messages || [];
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
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-restart-'));
    const userId = 'restart-test-user';
    const testUsersDir = mkdtempSync(join(tmpdir(), 'cc-portal-users-'));

    // First app instance
    const storage1 = new CLISessionStorage(testUsersDir);
    const manager1 = new ClaudeSessionManager(storage1, { usersDir: dir });
    const app1 = buildApp({ sessionManager: manager1, storage: storage1 });
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

      // Second app instance (simulating restart)
      const storage2 = new CLISessionStorage(testUsersDir);
      const manager2 = new ClaudeSessionManager(storage2, { usersDir: dir });
      const app2 = buildApp({ sessionManager: manager2, storage: storage2 });
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
        expect(getBody.status).toBe('active');

        // Cleanup
        await fetch(`${base2}/sessions/${sessionId}?userId=${userId}`, { method: 'DELETE' });
      } finally {
        await app2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  }, 120_000);
});


describe('User Directory', () => {
  test('search users returns empty when no users', async () => {
    const { app, testUsersDir } = createTestApp();
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
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('create user profile and search for users', async () => {
    const { app, testUsersDir } = createTestApp();
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
          currentProjects: ['cc-portal'],
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
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });
});

describe('Shared Session (direct participant add)', () => {
  async function makeApp() {
    const testUsersDir = mkdtempSync(join(tmpdir(), 'cc-portal-shared-'));
    const storage = new CLISessionStorage(testUsersDir);
    await storage.initialize(); // Ensure storage is ready
    const manager = new ClaudeSessionManager(storage, { usersDir: testUsersDir });
    const app = buildApp({ sessionManager: manager, storage });
    return { storage, manager, app, testUsersDir };
  }

  test('owner can add participant directly without invite/join flow', async () => {
    const { app, testUsersDir } = await makeApp();
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
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('participant can read session history immediately after being added', async () => {
    const { app, testUsersDir } = await makeApp();
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

      // Participant reads session history via GET /sessions/:id/messages
      const getRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        headers: { 'X-User-ID': participant },
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { sessionId: string; messages: unknown[] };
      expect(getBody.sessionId).toBe(sessionId);
      expect(Array.isArray(getBody.messages)).toBe(true);
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('non-participant cannot access session messages', async () => {
    const { app, testUsersDir } = await makeApp();
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

      // Stranger tries to read messages via GET /sessions/:id/messages
      const getRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        headers: { 'X-User-ID': stranger },
      });
      expect(getRes.status).toBe(404);
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('only owner can add participants', async () => {
    const { app, testUsersDir } = await makeApp();
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
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('added participant appears in /my/shared-sessions', async () => {
    const { app, testUsersDir, storage } = await makeApp();
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

      const addRes = await fetch(`${base}/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': owner },
        body: JSON.stringify({ userId: participant }),
      });
      expect(addRes.status).toBe(200);

      // Verify participant was added in storage
      const participants = await storage.getSessionParticipants(sessionId);
      expect(participants.some(p => p.userId === participant)).toBe(true);

      const sharedRes = await fetch(`${base}/my/shared-sessions`, {
        headers: { 'X-User-ID': participant },
      });
      expect(sharedRes.status).toBe(200);
      const sharedBody = (await sharedRes.json()) as { sessions: Array<{ id: string }> };
      expect(sharedBody.sessions.some(s => s.id === sessionId)).toBe(true);
    } finally {
      await app.close();
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });
  test('adding same participant twice is idempotent', async () => {
    const { app, testUsersDir } = await makeApp();
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
      rmSync(testUsersDir, { recursive: true, force: true });
    }
  });

  test('permission request: stream returns permission_request and can be approved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-portal-permission-'));
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const userId = 'permission-test-user';

    try {
      // Create session with permissionMode: 'default' (requires approval)
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({
          path: dir,
          permissionMode: 'default',
        }),
      });
      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Initially no pending permissions
      const permRes1 = await fetch(`${base}/sessions/${sessionId}/pending-permissions`, {
        headers: { 'X-User-ID': userId },
      });
      const permBody1 = (await permRes1.json()) as { pending: unknown[] };
      expect(permBody1.pending.length).toBe(0);

      // Approving non-existent request returns 404
      const fakeApproveRes = await fetch(`${base}/sessions/${sessionId}/permissions/fake-request-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-ID': userId },
        body: JSON.stringify({ approved: true }),
      });
      expect(fakeApproveRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

