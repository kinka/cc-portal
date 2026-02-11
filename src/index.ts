import Fastify from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { logger } from './logger';

const fastify = Fastify({
  logger: false,
});

const sessionManager = new ClaudeSessionManager();

// Request/Response schemas
const CreateSessionRequest = z.object({
  path: z.string().describe('Working directory for Claude Code'),
  initialMessage: z.string().optional().describe('Optional initial message to send'),
  model: z.string().optional().describe('Model to use (e.g., claude-sonnet-4-5-20250929)'),
  allowedTools: z.array(z.string()).optional().describe('List of allowed tools'),
  disallowedTools: z.array(z.string()).optional().describe('List of disallowed tools'),
  envVars: z.record(z.string()).optional().describe('Environment variables'),
  customSystemPrompt: z.string().optional().describe('Custom system prompt'),
  appendSystemPrompt: z.string().optional().describe('Append to system prompt'),
  maxTurns: z.number().optional().describe('Maximum turns per query'),
  mcpServers: z.record(z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })).optional().describe('MCP server configurations'),
});

const SendMessageRequest = z.object({
  sessionId: z.string().describe('Session ID'),
  message: z.string().describe('Message to send to Claude'),
});

const SessionResponse = z.object({
  sessionId: z.string(),
  status: z.enum(['starting', 'running', 'stopped', 'error']),
  path: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string().optional(),
});

// Routes

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// List all sessions
fastify.get('/sessions', async () => {
  const sessions = sessionManager.listSessions();
  return { sessions };
});

// Create new session
fastify.post('/sessions', {
  schema: {
    body: CreateSessionRequest,
  },
  handler: async (request, reply) => {
    const body = request.body as z.infer<typeof CreateSessionRequest>;

    try {
      const session = await sessionManager.createSession(body);

      return {
        sessionId: session.id,
        status: session.status,
        path: session.path,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt?.toISOString(),
      };
    } catch (error) {
      logger.error('Failed to create session:', error);
      reply.status(500);
      return { error: 'Failed to create session', message: String(error) };
    }
  },
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
    lastActivityAt: session.lastActivityAt?.toISOString(),
    messages: session.getMessages(),
  };
});

// Send message to session
fastify.post('/sessions/:sessionId/messages', {
  schema: {
    body: z.object({ message: z.string() }),
  },
  handler: async (request, reply) => {
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
  },
});

// Stream messages (SSE)
fastify.get('/sessions/:sessionId/stream', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    reply.status(404);
    return { error: 'Session not found' };
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const unsubscribe = session.onMessage((message) => {
    reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
  });

  request.raw.on('close', () => {
    unsubscribe();
  });
});

// Stop session
fastify.post('/sessions/:sessionId/stop', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    await sessionManager.stopSession(sessionId);
    return { sessionId, status: 'stopped' };
  } catch (error) {
    logger.error('Failed to stop session:', error);
    reply.status(500);
    return { error: 'Failed to stop session', message: String(error) };
  }
});

// Delete session
fastify.delete('/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    await sessionManager.deleteSession(sessionId);
    return { sessionId, status: 'deleted' };
  } catch (error) {
    logger.error('Failed to delete session:', error);
    reply.status(500);
    return { error: 'Failed to delete session', message: String(error) };
  }
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
    logger.info('  GET  /sessions/:id/stream   - Stream messages (SSE)');
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
  await sessionManager.stopAllSessions();
  await fastify.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await sessionManager.stopAllSessions();
  await fastify.close();
  process.exit(0);
});

start();
