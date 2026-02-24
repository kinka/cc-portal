import Fastify from 'fastify';
import { realpathSync } from 'node:fs';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import type { PermissionResult } from './sdk-types';
import { logger } from './logger';

const fastify = Fastify({
  logger: false,
});

// CORS 支持
fastify.addHook('onSend', async (request, reply, payload) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return payload;
});

// 处理 OPTIONS 预检请求
fastify.options('*', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  reply.status(204).send();
});

const sessionManager = new ClaudeSessionManager();

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// List all sessions
fastify.get('/sessions', async () => {
  const sessions = sessionManager.listSessions();
  return {
    sessions: sessions.map(s => ({
      sessionId: s.id,
      status: s.status,
      path: s.path,
      createdAt: s.createdAt,
    }))
  };
});

// Create new session
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
    // 解析符号链接，获取真实路径（处理 macOS /tmp -> /private/tmp 等问题）
    const realPath = realpathSync(body.path);
    logger.info(`[Session] Creating session with path: ${body.path} -> ${realPath}`);

    const session = sessionManager.createSession({
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

// Get session details
fastify.get('/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const session = sessionManager.getSession(sessionId);

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

// Send message to session
fastify.post('/sessions/:sessionId/messages', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const { message } = request.body as { message: string };

  const session = sessionManager.getSession(sessionId);
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

// Stream message to session (SSE - Server Sent Events)
fastify.get('/sessions/:sessionId/stream', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const message = (request.query as { message: string }).message;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    reply.status(404);
    return { error: 'Session not found' };
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    const stream = await session.sendMessageStream(message);

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

// List pending tool approval requests (HTTP tool approval flow)
// Supports SSE with ?stream=1 for real-time updates
fastify.get('/sessions/:sessionId/pending-permissions', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const useStream = (request.query as { stream?: string }).stream === '1';

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    reply.status(404);
    return { error: 'Session not found' };
  }

  // SSE mode: real-time push of permission requests
  if (useStream) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial pending list
    const initialPending = session.listPendingPermissions();
    reply.raw.write(`data: ${JSON.stringify({ type: 'initial', pending: initialPending })}

`);

    // Set up event listeners
    const onPending = (data: { requestId: string; toolName: string; input: unknown; createdAt: string }) => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'pending', ...data })}

`);
    };

    const onResolved = (data: { requestId: string; result: PermissionResult }) => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'resolved', ...data })}

`);
    };

    session.on('permissionPending', onPending);
    session.on('permissionResolved', onResolved);

    // Clean up on client disconnect
    request.raw.on('close', () => {
      session.off('permissionPending', onPending);
      session.off('permissionResolved', onResolved);
      reply.raw.end();
    });

    return;
  }

  // Regular JSON mode
  const pending = session.listPendingPermissions();
  return { pending };
});

// Respond to a tool approval request (HTTP tool approval flow)
fastify.post('/sessions/:sessionId/permissions/:requestId', async (request, reply) => {
  const { sessionId, requestId } = request.params as { sessionId: string; requestId: string };
  const body = request.body as {
    approved: boolean;
    updatedInput?: Record<string, unknown>;
    message?: string;
  };
  const session = sessionManager.getSession(sessionId);
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

// Stop session
fastify.post('/sessions/:sessionId/stop', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    reply.status(404);
    return { error: 'Session not found' };
  }

  session.stop();
  return { sessionId, status: 'stopped' };
});

// Delete session
fastify.delete('/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    reply.status(404);
    return { error: 'Session not found' };
  }

  session.stop();
  sessionManager.deleteSession(sessionId);
  return { sessionId, status: 'deleted' };
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3333', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    logger.info(`🚀 Claude Agent HTTP Service running at http://${host}:${port}`);
    logger.info('Available endpoints:');
    logger.info('  GET  /health                               - Health check');
    logger.info('  GET  /sessions                             - List all sessions');
    logger.info('  POST /sessions                             - Create new session');
    logger.info('  GET  /sessions/:id                         - Get session details');
    logger.info('  POST /sessions/:id/messages                - Send message');
    logger.info('  GET  /sessions/:id/stream                  - Stream message (SSE)');
    logger.info('  GET  /sessions/:id/pending-permissions     - List pending approvals (SSE with ?stream=1)');
    logger.info('  POST /sessions/:id/permissions/:requestId  - Approve/deny tool');
    logger.info('  POST /sessions/:id/stop                    - Stop session');
    logger.info('  DELETE /sessions/:id                       - Delete session');
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await fastify.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await fastify.close();
  process.exit(0);
});

start();
