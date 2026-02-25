import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { UserDirectory } from '../crossSession/UserDirectory';
import type { CrossUserNotifier, UserNotification } from '../crossSession/CrossUserNotifier';
import { requireUserContext } from '../middleware/auth';

export function registerCrossUserRoutes(
  fastify: FastifyInstance,
  directory: UserDirectory,
  notifier: CrossUserNotifier,
): void {
  /**
   * GET /users
   * Search for users. Query: ?query=xxx&by=id|name|auto
   */
  fastify.get('/users', async (request: FastifyRequest) => {
    requireUserContext(request); // must be authenticated
    const q = request.query as { query?: string; by?: 'id' | 'name' | 'auto' };
    if (!q.query) return { users: [] };
    const users = directory.findUser(q.query, q.by ?? 'auto');
    // Return only public fields
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
      messagePermission?: 'everyone' | 'contacts' | 'project_members' | 'none';
    };
    const profile = directory.upsertProfile(userId, body);
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      skills: profile.skills,
      currentProjects: profile.currentProjects,
      messagePermission: profile.messagePermission,
    };
  });

  /**
   * POST /users/:userId/notify
   * Send a notification to another user.
   */
  fastify.post('/users/:userId/notify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId: fromUserId } = requireUserContext(request);
    const { userId: targetUserId } = request.params as { userId: string };

    const body = request.body as {
      type: UserNotification['type'];
      content: string;
      payload?: UserNotification['payload'];
    };

    if (!body.type || !body.content) {
      reply.status(400);
      return { error: 'type and content are required' };
    }

    // Auto-register sender in directory if not present
    directory.upsertProfile(fromUserId);

    const notificationId = notifier.notifyUser({
      fromUserId,
      targetUserId,
      type: body.type,
      content: body.content,
      payload: body.payload,
    });

    if (!notificationId) {
      reply.status(403);
      return { error: 'Notification blocked by target user permission settings' };
    }

    return { notificationId };
  });

  /**
   * POST /projects/:projectName/notify-members
   * Notify all members of a project.
   */
  fastify.post(
    '/projects/:projectName/notify-members',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId: fromUserId } = requireUserContext(request);
      const { projectName } = request.params as { projectName: string };

      const body = request.body as {
        type: UserNotification['type'];
        content: string;
        excludeUserIds?: string[];
      };

      if (!body.type || !body.content) {
        reply.status(400);
        return { error: 'type and content are required' };
      }

      directory.upsertProfile(fromUserId);

      const notificationIds = notifier.notifyProjectMembers(
        fromUserId,
        projectName,
        body.type,
        body.content,
        body.excludeUserIds,
      );

      return { notificationIds, count: notificationIds.length };
    },
  );

  /**
   * GET /me/notifications
   * Get current user's notifications. Query: ?unread=1
   */
  fastify.get('/me/notifications', async (request: FastifyRequest) => {
    const { userId } = requireUserContext(request);
    const unreadOnly = (request.query as Record<string, string>).unread === '1';
    const notifications = notifier.getNotifications(userId, unreadOnly);
    return {
      notifications,
      unread: notifications.filter(n => !n.readAt).length,
    };
  });

  /**
   * POST /me/notifications/:notificationId/read
   * Mark a notification as read.
   */
  fastify.post(
    '/me/notifications/:notificationId/read',
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireUserContext(request);
      const { notificationId } = request.params as { notificationId: string };
      const ok = notifier.markAsRead(notificationId);
      if (!ok) {
        reply.status(404);
        return { error: 'Notification not found' };
      }
      return { ok: true };
    },
  );
}
