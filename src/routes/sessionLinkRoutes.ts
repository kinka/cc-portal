import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionLinkManager } from '../crossSession/SessionLinkManager';
import type { LinkedMessage } from '../crossSession/SessionLinkManager';
import type { SessionRegistry } from '../crossSession/SessionRegistry';
import type { UserDirectory } from '../crossSession/UserDirectory';
import { requireUserContext } from '../middleware/auth';

export function registerSessionLinkRoutes(
  fastify: FastifyInstance,
  linkManager: SessionLinkManager,
  registry: SessionRegistry,
  directory: UserDirectory,
): void {
  /**
   * POST /sessions/:sessionId/links
   * Initiate a direct-connect invitation to a target user.
   */
  fastify.post('/sessions/:sessionId/links', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    const reg = registry.getSession(sessionId);
    if (!reg || reg.userId !== userId) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    const body = request.body as {
      targetUserId: string;
      mode?: 'bidirectional' | 'readonly';
      initialMessage?: string;
    };

    if (!body.targetUserId) {
      reply.status(400);
      return { error: 'targetUserId is required' };
    }

    const link = linkManager.createLink(
      sessionId,
      userId,
      body.targetUserId,
      body.mode ?? 'bidirectional',
      body.initialMessage,
    );

    return { link };
  });

  /**
   * GET /sessions/:sessionId/links
   * Get all links for a session. Query: ?status=active|pending|all
   */
  fastify.get('/sessions/:sessionId/links', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const statusParam = (request.query as Record<string, string>).status as
      | 'active'
      | 'pending'
      | 'all'
      | undefined;

    const reg = registry.getSession(sessionId);
    if (!reg || reg.userId !== userId) {
      reply.status(404);
      return { error: 'Session not found or access denied' };
    }

    const links = linkManager.getLinks(sessionId, statusParam ?? 'all');
    return { links };
  });

  /**
   * DELETE /sessions/:sessionId/links/:linkId
   * Disconnect a link.
   */
  fastify.delete(
    '/sessions/:sessionId/links/:linkId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { sessionId, linkId } = request.params as { sessionId: string; linkId: string };

      const reg = registry.getSession(sessionId);
      if (!reg || reg.userId !== userId) {
        reply.status(404);
        return { error: 'Session not found or access denied' };
      }

      const ok = linkManager.disconnect(linkId);
      if (!ok) {
        reply.status(404);
        return { error: 'Link not found or already disconnected' };
      }
      return { ok: true };
    },
  );

  /**
   * POST /sessions/:sessionId/links/:linkId/messages
   * Send a message through an active link.
   */
  fastify.post(
    '/sessions/:sessionId/links/:linkId/messages',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { sessionId, linkId } = request.params as { sessionId: string; linkId: string };

      const reg = registry.getSession(sessionId);
      if (!reg || reg.userId !== userId) {
        reply.status(404);
        return { error: 'Session not found or access denied' };
      }

      const body = request.body as { content: string };
      if (!body.content) {
        reply.status(400);
        return { error: 'content is required' };
      }

      const profile = directory.getProfile(userId);
      const mentions = SessionLinkManager.parseMentions(body.content);

      const message: LinkedMessage = {
        fromSessionId: sessionId,
        fromUserId: userId,
        fromUserName: profile?.displayName ?? userId,
        content: body.content,
        timestamp: new Date(),
        isMention: mentions.length > 0,
      };

      const ok = linkManager.sendLinkedMessage(linkId, message);
      if (!ok) {
        reply.status(404);
        return { error: 'Link not found or not active' };
      }
      return { ok: true, mentions };
    },
  );

  /**
   * GET /me/links/invitations
   * Get pending link invitations for the current user.
   */
  fastify.get('/me/links/invitations', async (request: FastifyRequest) => {
    const { userId } = requireUserContext(request);
    const invitations = linkManager.getPendingInvitations(userId);
    return { invitations };
  });

  /**
   * POST /me/links/invitations/:linkId/accept
   * Accept a pending link invitation.
   * Body: { sessionId } — the accepting user's current session ID.
   */
  fastify.post(
    '/me/links/invitations/:linkId/accept',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { linkId } = request.params as { linkId: string };
      const body = request.body as { sessionId: string };

      if (!body.sessionId) {
        reply.status(400);
        return { error: 'sessionId is required' };
      }

      // Verify the provided sessionId belongs to this user
      const reg = registry.getSession(body.sessionId);
      if (!reg || reg.userId !== userId) {
        reply.status(400);
        return { error: 'sessionId not found or does not belong to you' };
      }

      const ok = linkManager.acceptLink(linkId, body.sessionId);
      if (!ok) {
        reply.status(404);
        return { error: 'Invitation not found or already handled' };
      }
      return { ok: true };
    },
  );

  /**
   * POST /me/links/invitations/:linkId/decline
   * Decline a pending link invitation.
   */
  fastify.post(
    '/me/links/invitations/:linkId/decline',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = requireUserContext(request);
      const { linkId } = request.params as { linkId: string };

      // Verify the invitation targets this user
      const invitations = linkManager.getPendingInvitations(userId);
      if (!invitations.find(inv => inv.id === linkId)) {
        reply.status(404);
        return { error: 'Invitation not found' };
      }

      const ok = linkManager.declineLink(linkId);
      if (!ok) {
        reply.status(404);
        return { error: 'Invitation not found or already handled' };
      }
      return { ok: true };
    },
  );
}
