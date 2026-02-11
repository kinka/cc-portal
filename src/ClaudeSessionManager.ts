import { randomUUID } from 'node:crypto';
import { ClaudeSession } from './ClaudeSession';
import { logger } from './logger';

export interface CreateSessionOptions {
  path: string;
  initialMessage?: string;
  model?: string;
  allowedTools?: string[];
  envVars?: Record<string, string>;
}

export class ClaudeSessionManager {
  private sessions = new Map<string, ClaudeSession>();

  createSession(options: CreateSessionOptions): ClaudeSession {
    const id = randomUUID();

    const session = new ClaudeSession({
      id,
      path: options.path,
      model: options.model,
      allowedTools: options.allowedTools,
      envVars: options.envVars,
      initialMessage: options.initialMessage,
    });

    this.sessions.set(id, session);
    logger.info(`[Session ${id}] Created`);

    return session;
  }

  getSession(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      status: s.status,
      path: s.path,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  stopSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.stop();
  }

  deleteSession(id: string): void {
    this.stopSession(id);
    this.sessions.delete(id);
    logger.info(`[Session ${id}] Deleted`);
  }

  stopAllSessions(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    logger.info('All sessions stopped');
  }
}
