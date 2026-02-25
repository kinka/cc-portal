import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { MessageRouter, SessionMessage } from '../crossSession/MessageRouter';
import type { SessionRegistry } from '../crossSession/SessionRegistry';
import { requireUserContext } from '../middleware/auth';

export function registerCrossSessionRoutes(
  fastify: FastifyInstance,
  router: MessageRouter,
  registry: SessionRegistry,
): void {
  /**
   * GET /my-sessions
   * Returns all active sessions for the current user (from registry).
   */
  fastify.get('/my-sessions', async (request: FastifyRequest) => {
    const { userId } = requireUserContext(request);
    const sessions = registry.getSessionsByUser(userId);
    return { sessions };
  });

  /**
   * GET /sessions/:sessionId/inbox
   * Returns messages received by a session.
   * Query: ?unread=1 to filter unread only.
   */
  fastify.get('/sessions/:sessionId/inbox', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const unreadOnly = (request.query as Record<string, string>).unread === '1';

    const reg = registry.getSession(sessionId);
    if (!reg || reg.userId !== userId) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    const messages = unreadOnly ? router.getUnreadMessages(sessionId) : router.getMessages(sessionId);
    return { messages, unread: messages.filter(m => !m.readAt).length };
  });

  /**
   * POST /sessions/:sessionId/inbox/:messageId/read
   * Mark a message as read.
   */
  fastify.post(
    '/sessions/:sessionId/inbox/:messageId/read',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { sessionId, messageId } = request.params as { sessionId: string; messageId: string };

      const reg = registry.getSession(sessionId);
      if (!reg || reg.userId !== userId) {
        reply.status(404);
        return { error: 'Session not found or access denied' };
      }

      const ok = router.markAsRead(messageId);
      if (!ok) {
        reply.status(404);
        return { error: 'Message not found' };
      }
      return { ok: true };
    },
  );

  /**
   * POST /sessions/:sessionId/send
   * Send a message from this session to another session.
   * The target session must belong to the same user.
   */
  fastify.post('/sessions/:sessionId/send', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    const reg = registry.getSession(sessionId);
    if (!reg || reg.userId !== userId) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    const body = request.body as {
      targetSessionId: string;
      type: SessionMessage['type'];
      content: string;
      payload?: Record<string, unknown>;
      requireResponse?: boolean;
      timeoutMs?: number;
    };

    if (!body.targetSessionId || !body.type || !body.content) {
      reply.status(400);
      return { error: 'targetSessionId, type and content are required' };
    }

    const target = registry.getSession(body.targetSessionId);
    if (!target || target.userId !== userId) {
      reply.status(404);
      return { error: 'Target session not found or not owned by you' };
    }

    const messageId = router.sendMessage({
      fromSessionId: sessionId,
      targetSessionId: body.targetSessionId,
      fromUserId: userId,
      type: body.type,
      content: body.content,
      payload: body.payload,
      requireResponse: body.requireResponse ?? false,
      timeoutMs: body.timeoutMs,
    });

    return { messageId };
  });

  /**
   * POST /sessions/:sessionId/broadcast
   * Broadcast a message to all other sessions of the same user.
   */
  fastify.post(
    '/sessions/:sessionId/broadcast',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { sessionId } = request.params as { sessionId: string };

      const reg = registry.getSession(sessionId);
      if (!reg || reg.userId !== userId) {
        reply.status(404);
        return { error: 'Session not found or access denied' };
      }

      const body = request.body as {
        type: SessionMessage['type'];
        content: string;
        excludeSessionIds?: string[];
      };

      if (!body.type || !body.content) {
        reply.status(400);
        return { error: 'type and content are required' };
      }

      const messageIds = router.broadcastToUser(
        sessionId,
        userId,
        body.type,
        body.content,
        body.excludeSessionIds,
      );

      return { messageIds, count: messageIds.length };
    },
  );
}
