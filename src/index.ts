import { buildApp } from './app';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { CLISessionStorage } from './CLISessionStorage';
import { logger } from './logger';
import { WeComChannel } from './channels/WeComChannel';

const start = async () => {
  const port = parseInt(process.env.PORT || '9033', 10);
  const agentApiBaseUrl = process.env.CC_AGENTS_URL || `http://localhost:${port}`;
  const usersDir = process.env.USERS_DIR || './users';

  // Initialize CLI-based storage (replaces database)
  const storage = new CLISessionStorage(usersDir);

  // Initialize session manager with CLI storage
  const manager = new ClaudeSessionManager(storage, {
    usersDir,
    agentApiBaseUrl,
  });

  // Build Fastify app with CLI storage and session manager
  const fastify = buildApp({ sessionManager: manager, storage });

  const startServer = async () => {
    try {
      const host = process.env.HOST || '0.0.0.0';

      await fastify.listen({ port: port, host });
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
      logger.info('  DELETE /sessions/:id                       - Delete session');
      logger.info('');
      logger.info('Admin endpoints (requires X-Admin-Token):');
      logger.info('  GET  /admin/users                          - List all users');
      logger.info('  PUT  /admin/users/:userId/quota            - Update user quota');
      logger.info('  DELETE /admin/users/:userId                - Delete user');
      logger.info('  GET  /admin/sessions                       - List all sessions');
      logger.info('  GET  /admin/stats                          - Service statistics');
      logger.info('');
      logger.info('Session storage: CLI-based (~/.claude/projects/)');

      // 若配置了企业微信机器人，启动长连接渠道
      const wecomBotId = process.env.WECOM_BOT_ID;
      const wecomSecret = process.env.WECOM_BOT_SECRET;
      if (wecomBotId && wecomSecret) {
        const wecomChannel = new WeComChannel({
          botId: wecomBotId,
          secret: wecomSecret,
          manager,
          storage,
          usersDir,
          welcomeMsg: process.env.WECOM_WELCOME_MSG,
        });
        wecomChannel.connect();
        logger.info({ botId: wecomBotId }, '📱 WeCom channel enabled');
      } else {
        logger.info('📱 WeCom channel disabled (set WECOM_BOT_ID and WECOM_BOT_SECRET to enable)');
      }
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
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully');
    manager.destroyAllSessions();
    await fastify.close();
    process.exit(0);
  });

  await startServer();
};

start().catch((err) => {
  logger.error({ err: String(err) }, 'Failed to start application');
  process.exit(1);
});
