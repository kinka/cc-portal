import { buildApp } from './app';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { DatabaseManager } from './db';
import { logger } from './logger';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const start = async () => {
  // Ensure database directory exists
  const dbPath = process.env.DATABASE_URL || './data/app.db';
  await mkdir(dirname(dbPath), { recursive: true });

  // Initialize database
  const db = new DatabaseManager(dbPath);

  // Initialize session manager
  const manager = new ClaudeSessionManager(db, {
    usersDir: process.env.USERS_DIR || './users',
  });

  // Build Fastify app with database and session manager
  const fastify = buildApp({ sessionManager: manager, db });

  const startServer = async () => {
    try {
      const port = parseInt(process.env.PORT || '3333', 10);
      const host = process.env.HOST || '0.0.0.0';

      await fastify.listen({ port, host });
      logger.info({ host, port }, 'Claude Agent HTTP Service running');
      logger.info('Available endpoints:');
      logger.info('  GET  /health                               - Health check');
      logger.info('  GET  /sessions                             - List all sessions (requires X-User-ID)');
      logger.info('  POST /sessions                             - Create new session (requires X-User-ID)');
      logger.info('  GET  /sessions/:id                         - Get session details');
      logger.info('  POST /sessions/:id/messages                - Send message');
      logger.info('  GET  /sessions/:id/stream                  - Stream message (SSE)');
      logger.info('  GET  /sessions/:id/pending-permissions     - List pending approvals (SSE with ?stream=1)');
      logger.info('  POST /sessions/:id/permissions/:requestId  - Approve/deny tool');
      // logger.info('  POST /sessions/:id/stop                    - Stop session'); // Removed: sessions auto-resume via session-id
      logger.info('  DELETE /sessions/:id                       - Delete session');
      logger.info('');
      logger.info('Admin endpoints (requires X-Admin-Token):');
      logger.info('  GET  /admin/users                          - List all users');
      logger.info('  PUT  /admin/users/:userId/quota            - Update user quota');
      logger.info('  DELETE /admin/users/:userId                - Delete user');
      logger.info('  GET  /admin/sessions                       - List all sessions');
      logger.info('  GET  /admin/stats                          - Service statistics');
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to start server');
      process.exit(1);
    }
  };

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    manager.destroyAllSessions();
    await fastify.close();
    db.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully');
    manager.destroyAllSessions();
    await fastify.close();
    db.close();
    process.exit(0);
  });

  await startServer();
};

start().catch((err) => {
  logger.error({ err: String(err) }, 'Failed to start application');
  process.exit(1);
});
