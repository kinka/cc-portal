import { test, describe, expect } from 'bun:test';
import { buildApp } from '../src/app';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runE2E = !!process.env.RUN_E2E;

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
        status: string;
        path: string;
        createdAt: string;
      };
      expect(createBody.sessionId).toBeDefined();
      expect(createBody.status).toBe('running');
      const dirReal = realpathSync.native(dir);
      expect(createBody.path).toBe(dirReal);

      const listRes = await fetch(`${base}/sessions`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        sessions: Array<{ sessionId: string; status: string; path: string; createdAt: string }>;
      };
      expect(listBody.sessions.length).toBe(1);
      expect(listBody.sessions[0].sessionId).toBe(createBody.sessionId);
      expect(listBody.sessions[0].status).toBe('running');
      expect(listBody.sessions[0].path).toBe(dirReal);

      const getRes = await fetch(`${base}/sessions/${createBody.sessionId}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        sessionId: string;
        status: string;
        path: string;
        createdAt: string;
        messages: Array<{ id: string; role: string; content: string; timestamp: string }>;
      };
      expect(getBody.sessionId).toBe(createBody.sessionId);
      expect(getBody.status).toBe('running');
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

  test('stop session then delete', async () => {
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

      const stopRes = await fetch(`${base}/sessions/${sessionId}/stop`, { method: 'POST' });
      expect(stopRes.status).toBe(200);
      const stopBody = (await stopRes.json()) as { status: string };
      expect(stopBody.status).toBe('stopped');

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
});
