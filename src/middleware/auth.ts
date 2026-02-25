import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseManager } from '../db';
import { createLogger } from '../logger';

const log = createLogger({ module: 'Auth' });

declare module 'fastify' {
  interface FastifyRequest {
    userContext?: {
      userId: string;
      maxSessions: number;
    };
  }
}

interface AuthOptions {
  db: DatabaseManager;
  defaultMaxSessions?: number;
}

export function registerAuthMiddleware(fastify: FastifyInstance, options: AuthOptions) {
  const { db, defaultMaxSessions = 200 } = options;

fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check, admin routes, and OPTIONS (CORS preflight)
    if (request.url === '/health' || request.url.startsWith('/admin') || request.method === 'OPTIONS') {
      return;
    }

    // Support both header and query parameter for userId
    const headerUserId = request.headers['x-user-id'];
    const queryUserId = (request.query as Record<string, string>)['userId'];
    const userId = headerUserId || queryUserId;

    if (!userId || typeof userId !== 'string') {
      return reply.status(401).send({ error: 'Missing or invalid X-User-ID header or userId query parameter' });
    }

    // Get or create user
    const user = db.getOrCreateUser(userId, defaultMaxSessions);

    // Inject user context into request
    request.userContext = {
      userId: user.id,
      maxSessions: user.maxSessions,
    };

    log.debug({ userId: user.id, path: request.url }, 'User authenticated');
  });
}

export function requireUserContext(request: FastifyRequest): { userId: string; maxSessions: number } {
  if (!request.userContext) {
    throw new Error('User context not found - auth middleware not applied');
  }
  return request.userContext;
}
