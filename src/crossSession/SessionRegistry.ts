import { EventEmitter } from 'node:events';
import { createLogger } from '../logger';

const log = createLogger({ module: 'SessionRegistry' });

export interface RegisteredSession {
  sessionId: string;
  userId: string;
  project?: string;
  status: 'active' | 'idle';
  registeredAt: Date;
}

/**
 * In-memory registry of all active Claude sessions.
 * Required for cross-session discovery and A2A message routing.
 * All data is lost on service restart (consistent with existing session behavior).
 */
export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, RegisteredSession>();

  register(sessionId: string, userId: string, project?: string): void {
    const entry: RegisteredSession = {
      sessionId,
      userId,
      project,
      status: 'active',
      registeredAt: new Date(),
    };
    this.sessions.set(sessionId, entry);
    log.debug({ sessionId, userId, project }, 'Session registered');
    this.emit('registered', entry);
  }

  unregister(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    log.debug({ sessionId }, 'Session unregistered');
    this.emit('unregistered', { sessionId, userId: entry.userId });
  }

  getSession(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionsByUser(userId: string): RegisteredSession[] {
    return Array.from(this.sessions.values()).filter(s => s.userId === userId);
  }

  getSessionsByProject(project: string): RegisteredSession[] {
    return Array.from(this.sessions.values()).filter(s => s.project === project);
  }

  updateStatus(sessionId: string, status: 'active' | 'idle'): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.status = status;
    this.emit('statusChanged', { sessionId, status });
  }

  getAllSessions(): RegisteredSession[] {
    return Array.from(this.sessions.values());
  }
}
