import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CLISessionStorage } from './CLISessionStorage';
import { createLogger } from './logger';

const log = createLogger({ module: 'AdminRoutes' });

export function registerAdminRoutes(fastify: FastifyInstance, storage: CLISessionStorage) {
  const adminToken = process.env.ADMIN_TOKEN || 'change-me-in-production';

  // Admin authentication middleware
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/admin')) {
      return;
    }

    const providedToken = request.headers['x-admin-token'];

    if (!providedToken || providedToken !== adminToken) {
      reply.status(403);
      return { error: 'Forbidden: Invalid or missing X-Admin-Token header' };
    }
  });

  // GET /admin/users - List all users
  fastify.get('/admin/users', async () => {
    const users = await storage.listUsers();
    const result = [];

    for (const user of users) {
      const sessionCount = await storage.getUserSessionCount(user.id);
      result.push({
        userId: user.id,
        maxSessions: user.maxSessions,
        activeSessions: sessionCount,
      });
    }

    return { users: result };
  });

  // GET /admin/sessions - List all sessions from CLI storage
  fastify.get('/admin/sessions', async () => {
    const sessions = await storage.discoverSessions();
    const userSessions: Array<{ sessionId: string; ownerId?: string; projectPath: string; lastModified: string; createdAt: string }> = [];
    
    for (const session of sessions) {
      const ownerId = await storage.getSessionOwner(session.id);
      userSessions.push({
        sessionId: session.id,
        ownerId,
        projectPath: session.projectPath,
        lastModified: session.lastModified.toISOString(),
        createdAt: session.createdAt.toISOString(),
      });
    }
    
    return { sessions: userSessions };
  });

  // GET /admin/stats - Service statistics
  fastify.get('/admin/stats', async () => {
    const users = await storage.listUsers();
    const sessions = await storage.discoverSessions();

    return {
      users: {
        total: users.length,
      },
      sessions: {
        total: sessions.length,
        byProject: sessions.reduce((acc, s) => {
          const path = s.projectPath;
          acc[path] = (acc[path] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
    };
  });
}
