import { buildApp } from './app';
import { logger } from './logger';

const fastify = buildApp();

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
