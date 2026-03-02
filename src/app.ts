import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { realpathSync } from 'node:fs';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { DatabaseManager } from './db';
import type { PermissionResult } from './sdk-types';
import { logger, isDev } from './logger';
import { registerAuthMiddleware, requireUserContext } from './middleware/auth';
import { registerAdminRoutes } from './admin-routes';
import { UserDirectory } from './crossSession/UserDirectory';
import { registerCrossUserRoutes } from './routes/crossUserRoutes';
import { registerParticipantRoutes } from './routes/participantRoutes';
interface BuildAppOptions {
  sessionManager?: ClaudeSessionManager;
  db?: DatabaseManager;
}

export function buildApp(options?: BuildAppOptions): FastifyInstance {
  if (!options) {
    return buildLegacyApp();
  }

  const manager = options.sessionManager;
  const db = options.db;

  const userDirectory = new UserDirectory();

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
    requestIdLogLabel: 'reqId',
    genReqId: () => crypto.randomUUID(),
  });

  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Token');
    return payload;
  });

  fastify.options('*', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID, X-Admin-Token');
    reply.status(204).send();
  });

  if (db) {
    registerAuthMiddleware(fastify, {
      db,
      defaultMaxSessions: parseInt(process.env.DEFAULT_MAX_SESSIONS || '200', 10),
    });
    registerAdminRoutes(fastify, db);
  }

  registerCrossUserRoutes(fastify, userDirectory);

  // Register participant routes
  if (db) {
    registerParticipantRoutes(fastify, db, manager ?? undefined);
  }

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!db || !manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const sessions = manager.listSessions(userContext.userId);

    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        path: s.path,
        createdAt: s.createdAt,
      })),
      quota: {
        max: userContext.maxSessions,
        used: manager.getUserSessionCount(userContext.userId),
      },
    };
  });

  fastify.post('/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!db || !manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);

    const body = request.body as {
      ownerId?: string;
      path?: string;
      project?: string;
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

    // Allow caller to create a session on behalf of another user (agent delegation)
    const ownerId = body.ownerId ?? userContext.userId;

    try {
      const currentCount = manager.getUserSessionCount(ownerId);
      const targetUser = db.getUser(ownerId);
      const maxSessions = targetUser?.maxSessions ?? userContext.maxSessions;
      if (currentCount >= maxSessions) {
        reply.status(429);
        return {
          error: 'Session quota exceeded',
          message: `User ${ownerId} has reached the maximum of ${maxSessions} sessions`,
          quota: {
            max: maxSessions,
            used: currentCount,
          },
        };
      }

      const session = await manager.createSession({
        ownerId,
        path: body.path,
        project: body.project,
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

      // Auto-touch user in directory
      userDirectory.upsertProfile(ownerId);

      return {
        sessionId: session.id,
        path: session.path,
        createdAt: session.createdAt.toISOString(),
        quota: {
          max: userContext.maxSessions,
          used: currentCount + 1,
        },
      };
    } catch (error) {
      logger.error({ error, userId: userContext.userId }, 'Failed to create session');

      if (error instanceof Error && error.message.includes('quota')) {
        reply.status(429);
        return { error: 'Session quota exceeded', message: error.message };
      }

      reply.status(500);
      return { error: 'Failed to create session', message: String(error) };
    }
  });

  fastify.get('/sessions/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager || !db) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    const session = await manager.getSession(sessionId, userContext.userId);

    if (!session) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    // Return session metadata only (use /messages endpoint for history)
    return {
      sessionId: session.id,
      path: session.path,
      createdAt: session.createdAt.toISOString(),
      status: 'active',
    };
  });

  fastify.post('/sessions/:sessionId/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager || !db) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const { message, from } = request.body as { message: string; from?: string };

    const session = await manager.getSession(sessionId, userContext.userId);
    if (!session) {
      // Debug: check if session exists but user doesn't have access
      const dbSession = db.getSession(sessionId);
      if (dbSession) {
        return {
          error: 'Session not found or access denied',
          debug: {
            sessionExists: true,
            sessionOwner: dbSession.ownerId,
            requestingUser: userContext.userId,
            isOwner: dbSession.ownerId === userContext.userId,
          },
        };
      }
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    try {
      const response = await session.sendMessage(message, from || userContext.userId);
      return {
        sessionId,
        response,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to send message');
      reply.status(500);
      return { error: 'Failed to send message', message: String(error) };
    }
  });

  /**
   * GET /sessions/:sessionId/messages - Get message history
   * Query params:
   * - detailed: if true, returns full history including tool calls
   * - limit: max number of messages to return (default: all)
   */
  fastify.get('/sessions/:sessionId/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager || !db) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const { detailed, limit } = request.query as { detailed?: string; limit?: string };

    const session = await manager.getSession(sessionId, userContext.userId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    // Load from CLI storage (source of truth)
    const history = await session.loadHistoryFromCLI(detailed === '1' || detailed === 'true');

    // Apply limit if specified
    let messages = history;
    if (limit && typeof limit === 'string') {
      const limitNum = parseInt(limit, 10);
      if (!isNaN(limitNum) && limitNum > 0) {
        messages = history.slice(-limitNum);
      }
    }

    return {
      sessionId,
      source: 'cli',
      detailed: detailed === '1' || detailed === 'true',
      count: messages.length,
      messages,
    };
  });

  fastify.get('/sessions/:sessionId/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const message = (request.query as { message?: string }).message;

    const session = await manager.getSession(sessionId, userContext.userId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    try {
      const stream = session.sendMessageStream(message, userContext.userId);

      for await (const chunk of stream) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      logger.error({ error: String(error), sessionId }, 'Stream error');
      reply.raw.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
      reply.raw.end();
    }
  });

  fastify.get('/sessions/:sessionId/pending-permissions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const useStream = (request.query as { stream?: string }).stream === '1';

    const session = await manager.getSession(sessionId, userContext.userId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
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

  fastify.post('/sessions/:sessionId/permissions/:requestId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId, requestId } = request.params as { sessionId: string; requestId: string };
    const body = request.body as {
      approved: boolean;
      updatedInput?: Record<string, unknown>;
      message?: string;
    };

    const session = await manager.getSession(sessionId, userContext.userId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
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

  fastify.delete('/sessions/:sessionId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!manager) {
      reply.status(503);
      return { error: 'Service not fully initialized' };
    }

    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    const success = manager.deleteSession(sessionId, userContext.userId);
    if (!success) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    return { sessionId, status: 'deleted' };
  });

  return fastify;
}

export function buildLegacyApp(): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    requestIdLogLabel: 'reqId',
    genReqId: () => crypto.randomUUID(),
  });

  const db = new DatabaseManager(':memory:');
  const manager = new ClaudeSessionManager(db, { usersDir: './test-users' });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/sessions', async () => {
    const sessions = manager.listSessions('legacy');
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
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
      logger.info({ path: body.path, realPath }, 'Creating session');

      const session = await manager.createSession({
        ownerId: 'legacy',
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
        path: session.path,
        createdAt: session.createdAt.toISOString(),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to create session');
      reply.status(500);
      return { error: 'Failed to create session', message: String(error) };
    }
  });

  fastify.get('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await manager.getSession(sessionId, 'legacy');

    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    return {
      sessionId: session.id,
      path: session.path,
      createdAt: session.createdAt.toISOString(),
      messages: session.getMessages(),
    };
  });

  fastify.post('/sessions/:sessionId/messages', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { message } = request.body as { message: string };

    const session = await manager.getSession(sessionId, 'legacy');
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
      logger.error({ error, sessionId }, 'Failed to send message');
      reply.status(500);
      return { error: 'Failed to send message', message: String(error) };
    }
  });

  fastify.get('/sessions/:sessionId/stream', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const message = (request.query as { message?: string }).message;

    const session = await manager.getSession(sessionId, 'legacy');
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const stream = session.sendMessageStream(message);

      for await (const chunk of stream) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      logger.error({ error: String(error), sessionId }, 'Stream error');
      reply.raw.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
      reply.raw.end();
    }
  });

  fastify.get('/sessions/:sessionId/pending-permissions', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const useStream = (request.query as { stream?: string }).stream === '1';

    const session = await manager.getSession(sessionId, 'legacy');
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (useStream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
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
    const session = await manager.getSession(sessionId, 'legacy');
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

  fastify.delete('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = await manager.getSession(sessionId, 'legacy');
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    manager.deleteSession(sessionId, 'legacy');
    return { sessionId, status: 'deleted' };
  });

  return fastify;
}
