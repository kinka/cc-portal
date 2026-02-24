import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseManager } from './db';
import { createLogger } from './logger';

const log = createLogger({ module: 'AdminRoutes' });

export function registerAdminRoutes(fastify: FastifyInstance, db: DatabaseManager) {
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

  // GET /admin/users - List all users with quota info
  fastify.get('/admin/users', async () => {
    const users = db.listUsers();
    const result = [];

    for (const user of users) {
      const sessionCount = db.getUserSessionCount(user.id);
      result.push({
        userId: user.id,
        maxSessions: user.maxSessions,
        activeSessions: sessionCount,
        createdAt: user.createdAt,
      });
    }

    return { users: result };
  });

  // PUT /admin/users/:userId/quota - Update user quota
  fastify.put('/admin/users/:userId/quota', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const body = request.body as { maxSessions?: number };

    if (typeof body.maxSessions !== 'number' || body.maxSessions < 1) {
      reply.status(400);
      return { error: 'Invalid maxSessions value' };
    }

    const updated = db.updateUserQuota(userId, body.maxSessions);

    if (!updated) {
      reply.status(404);
      return { error: 'User not found' };
    }

    log.info({ userId, maxSessions: body.maxSessions }, 'User quota updated');

    return {
      userId,
      maxSessions: body.maxSessions,
      updated: true,
    };
  });

  // DELETE /admin/users/:userId - Delete user and associated data
  fastify.delete('/admin/users/:userId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };

    // Check if user exists
    const user = db.getUser(userId);
    if (!user) {
      reply.status(404);
      return { error: 'User not found' };
    }

    // Note: We don't stop running sessions here - they will be cleaned up
    // when the service restarts or when the SessionManager notices they're gone

    const deleted = db.deleteUser(userId);

    if (!deleted) {
      reply.status(500);
      return { error: 'Failed to delete user' };
    }

    log.info({ userId }, 'User deleted');

    return {
      userId,
      deleted: true,
    };
  });

  // GET /admin/sessions - List all sessions
  fastify.get('/admin/sessions', async () => {
    const sessions = db.listAllSessions();
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        ownerId: s.ownerId,
        path: s.path,
        model: s.model,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    };
  });

  // GET /admin/stats - Service statistics
  fastify.get('/admin/stats', async () => {
    const users = db.listUsers();
    const sessions = db.listAllSessions();

    const activeSessions = sessions.filter((s) => s.status === 'active');
    const stoppedSessions = sessions.filter((s) => s.status === 'stopped');

    return {
      users: {
        total: users.length,
      },
      sessions: {
        total: sessions.length,
        active: activeSessions.length,
        stopped: stoppedSessions.length,
      },
    };
  });
}
