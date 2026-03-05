import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CLISessionStorage } from '../CLISessionStorage';
import type { ClaudeSessionManager } from '../ClaudeSessionManager';
import { requireUserContext } from '../middleware/auth';
import { createLogger } from '../logger';

const log = createLogger({ module: 'SessionParticipants' });

export function registerParticipantRoutes(
  fastify: FastifyInstance,
  storage: CLISessionStorage,
  manager?: ClaudeSessionManager,
): void {
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

    const sessionOwner = await storage.getSessionOwner(sessionId);
    if (!sessionOwner) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (sessionOwner !== userContext.userId) {
      reply.status(403);
      return { error: 'Only session owner can add participants' };
    }

    if (sessionOwner === targetUserId) {
      reply.status(400);
      return { error: 'Cannot add yourself as participant' };
    }

    const success = await storage.addParticipant(sessionId, targetUserId);
    if (!success) {
      reply.status(500);
      return { error: 'Failed to add participant' };
    }

    // Sync in-memory session state so subsequent messages see the updated participants list
    manager?.getSessionDirect(sessionId)?.addParticipant(targetUserId);

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
    const sessionOwner = await storage.getSessionOwner(sessionId);
    if (!sessionOwner) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    if (sessionOwner !== userContext.userId) {
      reply.status(403);
      return { error: 'Only session owner can invite participants' };
    }

    if (sessionOwner === targetUserId) {
      reply.status(400);
      return { error: 'Cannot invite yourself' };
    }

    // For simplicity, directly add as participant instead of invitation flow
    const success = await storage.addParticipant(sessionId, targetUserId);
    if (!success) {
      reply.status(409);
      return { error: 'Failed to invite user' };
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

    // For simplicity, check if the user can access the session
    const canAccess = await storage.canAccessSession(sessionId, userContext.userId);
    if (!canAccess) {
      // Try to add as participant
      const success = await storage.addParticipant(sessionId, userContext.userId);
      if (!success) {
        reply.status(404);
        return { error: 'Cannot join session' };
      }
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
    const canAccess = await storage.canAccessSession(sessionId, userContext.userId);
    if (!canAccess) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const sessionOwner = await storage.getSessionOwner(sessionId);
    const participants = await storage.getSessionParticipants(sessionId);

    return {
      ownerId: sessionOwner,
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
    const sessionIds = await storage.getUserParticipatingSessions(userContext.userId);

    const sessions = await Promise.all(
      sessionIds.map(async (id) => {
        const info = await storage.getSessionInfo(id);
        const ownerId = await storage.getSessionOwner(id);
        return info ? { ...info, ownerId } : null;
      })
    );

    return { sessions: sessions.filter((s): s is NonNullable<typeof s> => s !== null) };
  });
}
