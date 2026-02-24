import { randomUUID } from 'node:crypto';
import { ClaudeSession } from './ClaudeSession';
import { createLogger } from './logger';

const log = createLogger({ module: 'SessionManager' });

export interface CreateSessionOptions {
  path: string;
  initialMessage?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Timeout in ms for HTTP tool approval when permissionMode is not bypass. Default 300000. */
  permissionTimeoutMs?: number;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  maxTurns?: number;
  envVars?: Record<string, string>;
  /** @deprecated use permissionMode: 'bypassPermissions' */
  bypassPermission?: boolean;
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
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode,
      permissionTimeoutMs: options.permissionTimeoutMs,
      mcpServers: options.mcpServers,
      maxTurns: options.maxTurns,
      envVars: options.envVars,
      initialMessage: options.initialMessage,
      bypassPermission: options.bypassPermission,
    });

    this.sessions.set(id, session);
    log.info({ sessionId: id }, 'Session created');

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
    log.info({ sessionId: id }, 'Session deleted');
  }

  stopAllSessions(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    log.info('All sessions stopped');
  }
}
