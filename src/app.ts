import Fastify, { type FastifyInstance } from 'fastify';
import { realpathSync } from 'node:fs';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import type { PermissionResult } from './sdk-types';
import { logger } from './logger';

/**
 * Build Fastify app with all routes. Optional sessionManager for testing.
 */
export function buildApp(sessionManager?: ClaudeSessionManager): FastifyInstance {
  const manager = sessionManager ?? new ClaudeSessionManager();
  const fastify = Fastify({ logger: false });

  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return payload;
  });

  fastify.options('*', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.status(204).send();
  });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/sessions', async () => {
    const sessions = manager.listSessions();
    return {
      sessions: sessions.map(s => ({
        sessionId: s.id,
        status: s.status,
        path: s.path,
        createdAt: s.createdAt,
      })),
    };
  });

  fastify.post('/sessions', async (request, reply) => {
    const body = request.body as {
      path: string;
      initialMessage?: string;
      model?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
      permissionTimeoutMs?: number;
      mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
      maxTurns?: number;
      envVars?: Record<string, string>;
      bypassPermission?: boolean;
    };

    if (!body.path) {
      reply.status(400);
      return { error: 'path is required' };
    }

    try {
      const realPath = realpathSync(body.path);
      logger.info(`[Session] Creating session with path: ${body.path} -> ${realPath}`);

      const session = manager.createSession({
        path: realPath,
        initialMessage: body.initialMessage,
        model: body.model,
        allowedTools: body.allowedTools,
        disallowedTools: body.disallowedTools,
        permissionMode: body.permissionMode,
        permissionTimeoutMs: body.permissionTimeoutMs,
        mcpServers: body.mcpServers,
        maxTurns: body.maxTurns,
        envVars: body.envVars,
        bypassPermission: body.bypassPermission,
      });

      return {
        sessionId: session.id,
        status: session.status,
        path: session.path,
        createdAt: session.createdAt.toISOString(),
      };
    } catch (error) {
      logger.error('Failed to create session:', error);
      reply.status(500);
      return { error: 'Failed to create session', message: String(error) };
    }
  });

  fastify.get('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = manager.getSession(sessionId);

    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    return {
      sessionId: session.id,
      status: session.status,
      path: session.path,
      createdAt: session.createdAt.toISOString(),
      messages: session.getMessages(),
    };
  });

  fastify.post('/sessions/:sessionId/messages', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { message } = request.body as { message: string };

    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    try {
      const response = await session.sendMessage(message);
      return {
        sessionId,
        response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to send message:', error);
      reply.status(500);
      return { error: 'Failed to send message', message: String(error) };
    }
  });

  fastify.get('/sessions/:sessionId/stream', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const message = (request.query as { message?: string }).message;

    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      const stream = session.sendMessageStream(message);

      for await (const chunk of stream) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      logger.error('Stream error:', error);
      reply.raw.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
      reply.raw.end();
    }
  });

  fastify.get('/sessions/:sessionId/pending-permissions', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const useStream = (request.query as { stream?: string }).stream === '1';

    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (useStream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const initialPending = session.listPendingPermissions();
      reply.raw.write(`data: ${JSON.stringify({ type: 'initial', pending: initialPending })}\n\n`);

      const onPending = (data: { requestId: string; toolName: string; input: unknown; createdAt: string }) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'pending', ...data })}\n\n`);
      };

      const onResolved = (data: { requestId: string; result: PermissionResult }) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'resolved', ...data })}\n\n`);
      };

      session.on('permissionPending', onPending);
      session.on('permissionResolved', onResolved);

      request.raw.on('close', () => {
        session.off('permissionPending', onPending);
        session.off('permissionResolved', onResolved);
        reply.raw.end();
      });

      return;
    }

    const pending = session.listPendingPermissions();
    return { pending };
  });

  fastify.post('/sessions/:sessionId/permissions/:requestId', async (request, reply) => {
    const { sessionId, requestId } = request.params as { sessionId: string; requestId: string };
    const body = request.body as {
      approved: boolean;
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }
    const result = body.approved
      ? { behavior: 'allow' as const, updatedInput: body.updatedInput ?? {} }
      : { behavior: 'deny' as const, message: body.message ?? 'Denied by user' };
    const ok = session.respondToPermission(requestId, result);
    if (!ok) {
      reply.status(404);
      return { error: 'request_not_found_or_already_responded' };
    }
    return { ok: true };
  });

  fastify.post('/sessions/:sessionId/stop', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    session.stop();
    return { sessionId, status: 'stopped' };
  });

  fastify.delete('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = manager.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    session.stop();
    manager.deleteSession(sessionId);
    return { sessionId, status: 'deleted' };
  });

  return fastify;
}
