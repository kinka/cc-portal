import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseManager } from '../db';
import { requireUserContext } from '../middleware/auth';
import { createLogger } from '../logger';

const log = createLogger({ module: 'SessionParticipants' });

export function registerParticipantRoutes(fastify: FastifyInstance, db: DatabaseManager): void {
  /**
   * POST /sessions/:sessionId/participants
   * Directly add a user as a joined participant (no confirmation needed).
   * Only the session owner can do this.
   */
  fastify.post('/sessions/:sessionId/participants', async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const { userId: targetUserId } = request.body as { userId?: string };

    if (!targetUserId) {
      reply.status(400);
      return { error: 'userId is required' };
    }

    const session = db.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (session.ownerId !== userContext.userId) {
      reply.status(403);
      return { error: 'Only session owner can add participants' };
    }

    if (session.ownerId === targetUserId) {
      reply.status(400);
      return { error: 'Cannot add yourself as participant' };
    }

    const success = db.addParticipant(sessionId, targetUserId);
    if (!success) {
      reply.status(500);
      return { error: 'Failed to add participant' };
    }

    log.info({ sessionId, owner: userContext.userId, participant: targetUserId }, 'Participant added directly');
    return { success: true };
  });

  /**
   * POST /sessions/:sessionId/invite
   * Invite a user to join the session
   */
  fastify.post('/sessions/:sessionId/invite', async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };
    const { userId: targetUserId } = request.body as { userId: string };

    // Check if user is the owner
    const session = db.getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (session.ownerId !== userContext.userId) {
      reply.status(403);
      return { error: 'Only session owner can invite participants' };
    }

    if (session.ownerId === targetUserId) {
      reply.status(400);
      return { error: 'Cannot invite yourself' };
    }

    const success = db.inviteParticipant(sessionId, targetUserId);
    if (!success) {
      reply.status(409);
      return { error: 'User already invited' };
    }

    log.info({ sessionId, inviter: userContext.userId, invitee: targetUserId }, 'User invited to session');
    return { success: true, message: 'Invitation sent' };
  });

  /**
   * POST /sessions/:sessionId/join
   * Accept invitation and join the session
   */
  fastify.post('/sessions/:sessionId/join', async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    const success = db.acceptInvitation(sessionId, userContext.userId);
    if (!success) {
      reply.status(404);
      return { error: 'Invitation not found' };
    }

    log.info({ sessionId, userId: userContext.userId }, 'User joined session');
    return { success: true, message: 'Joined session' };
  });

  /**
   * GET /sessions/:sessionId/participants
   * List all participants
   */
  fastify.get('/sessions/:sessionId/participants', async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = requireUserContext(request);
    const { sessionId } = request.params as { sessionId: string };

    // Check access
    if (!db.canAccessSession(sessionId, userContext.userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const session = db.getSession(sessionId);
    const participants = db.getSessionParticipants(sessionId);

    return {
      ownerId: session?.ownerId,
      participants: participants.filter((p) => p.status === 'joined'),
      pending: participants.filter((p) => p.status === 'pending'),
    };
  });

  /**
   * GET /my/shared-sessions
   * Get sessions the user is participating in (not owned)
   */
  fastify.get('/my/shared-sessions', async (request: FastifyRequest) => {
    const userContext = requireUserContext(request);
    const sessionIds = db.getUserParticipatingSessions(userContext.userId);

    const sessions = sessionIds
      .map((id) => db.getSession(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);

    return { sessions };
  });
}
