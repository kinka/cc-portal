import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { UserDirectory } from '../crossSession/UserDirectory';
import { requireUserContext } from '../middleware/auth';

export function registerCrossUserRoutes(
  fastify: FastifyInstance,
  directory: UserDirectory,
): void {
  /**
   * GET /users
   * Search for users. Query: ?query=xxx&by=id|name|auto
   */
  fastify.get('/users', async (request: FastifyRequest) => {
    requireUserContext(request);
    const q = request.query as { query?: string; by?: 'id' | 'name' | 'auto' };
    if (!q.query) return { users: [] };
    const users = directory.findUser(q.query, q.by ?? 'auto');
    return {
      users: users.map(u => ({
        userId: u.userId,
        displayName: u.displayName,
        skills: u.skills,
        currentProjects: u.currentProjects,
      })),
    };
  });

  /**
   * GET /users/:userId/profile
   * Get a user's public profile.
   */
  fastify.get('/users/:userId/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    requireUserContext(request);
    const { userId } = request.params as { userId: string };
    const profile = directory.getProfile(userId);
    if (!profile) {
      reply.status(404);
      return { error: 'User not found' };
    }
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      skills: profile.skills,
      currentProjects: profile.currentProjects,
    };
  });

  /**
   * PUT /me/profile
   * Update the current user's profile.
   */
  fastify.put('/me/profile', async (request: FastifyRequest) => {
    const { userId } = requireUserContext(request);
    const body = request.body as {
      displayName?: string;
      skills?: string[];
      currentProjects?: string[];
    };
    const profile = directory.upsertProfile(userId, body);
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      skills: profile.skills,
      currentProjects: profile.currentProjects,
    };
  });
}
