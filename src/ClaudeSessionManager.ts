import { randomUUID } from 'node:crypto';
import { ClaudeSession, ClaudeSessionOptions } from './ClaudeSession';
import { logger } from './logger';

export interface CreateSessionOptions {
  path: string;
  initialMessage?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  envVars?: Record<string, string>;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

export class ClaudeSessionManager {
  private sessions: Map<string, ClaudeSession> = new Map();

  async createSession(options: CreateSessionOptions): Promise<ClaudeSession> {
    const id = randomUUID();

    const sessionOptions: ClaudeSessionOptions = {
      id,
      path: options.path,
      model: options.model,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      envVars: options.envVars,
      initialMessage: options.initialMessage,
      customSystemPrompt: options.customSystemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: options.maxTurns,
      mcpServers: options.mcpServers,
    };

    const session = new ClaudeSession(sessionOptions);

    // Store session
    this.sessions.set(id, session);

    // Handle session events
    session.on('exit', () => {
      logger.info(`[Session ${id}] Process exited`);
    });

    session.on('error', (error) => {
      logger.error(`[Session ${id}] Error:`, error);
    });

    // Start the session
    await session.start();

    return session;
  }

  getSession(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Array<{
    id: string;
    status: string;
    path: string;
    createdAt: string;
    lastActivityAt?: string;
  }> {
    const result = [];
    for (const [id, session] of this.sessions) {
      result.push({
        id,
        status: session.status,
        path: session.path,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt?.toISOString(),
      });
    }
    return result;
  }

  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    await session.stop();
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    await session.stop();
    session.cleanup();
    this.sessions.delete(id);
    logger.info(`[Session ${id}] Deleted`);
  }

  async stopAllSessions(): Promise<void> {
    logger.info(`Stopping all ${this.sessions.size} sessions...`);
    const promises: Promise<void>[] = [];

    for (const [id, session] of this.sessions) {
      promises.push(
        session.stop().catch((error) => {
          logger.error(`[Session ${id}] Error stopping:`, error);
        })
      );
    }

    await Promise.all(promises);
    logger.info('All sessions stopped');
  }
}
