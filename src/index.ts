import Fastify from 'fastify';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { logger } from './logger';

const fastify = Fastify({
  logger: false,
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
    envVars?: Record<string, string>;
  };

  if (!body.path) {
    reply.status(400);
    return { error: 'path is required' };
  }

  try {
    const session = sessionManager.createSession({
      path: body.path,
      initialMessage: body.initialMessage,
      model: body.model,
      allowedTools: body.allowedTools,
      envVars: body.envVars,
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
    const port = parseInt(process.env.PORT || '3456', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    logger.info(`🚀 Claude Agent HTTP Service running at http://${host}:${port}`);
    logger.info('Available endpoints:');
    logger.info('  GET  /health           - Health check');
    logger.info('  GET  /sessions         - List all sessions');
    logger.info('  POST /sessions         - Create new session');
    logger.info('  GET  /sessions/:id     - Get session details');
    logger.info('  POST /sessions/:id/messages - Send message');
    logger.info('  POST /sessions/:id/stop     - Stop session');
    logger.info('  DELETE /sessions/:id   - Delete session');
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
