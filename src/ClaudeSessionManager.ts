import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, normalize, isAbsolute } from 'node:path';
import { ClaudeSession } from './ClaudeSession';
import { createLogger } from './logger';
import type { DatabaseManager } from './db';

const log = createLogger({ module: 'SessionManager' });

export interface CreateSessionOptions {
  ownerId: string;
  path?: string;
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

export interface SessionInfo {
  id: string;
  path: string;
  createdAt: string;
  ownerId: string;
}

interface ActiveSessionEntry {
  session: ClaudeSession;
  ownerId: string;
  metadata: {
    id: string;
    path: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
  };
}

export class ClaudeSessionManager {
  private sessions = new Map<string, ActiveSessionEntry>();
  private usersDir: string;
  private sessionLoadingLocks = new Map<string, Promise<ClaudeSession | undefined>>();

  constructor(
    private db: DatabaseManager,
    options: { usersDir?: string } = {}
  ) {
    this.usersDir = resolve(options.usersDir || process.env.USERS_DIR || './users');
    this.loadActiveSessionsFromDb();
  }

  private loadActiveSessionsFromDb() {
    const activeSessions = this.db.getActiveSessions();
    for (const metadata of activeSessions) {
      this.sessions.set(metadata.id, {
        session: null as unknown as ClaudeSession,
        ownerId: metadata.ownerId,
        metadata: {
          id: metadata.id,
          path: metadata.path,
          model: metadata.model,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        },
      });
    }
    log.info({ count: activeSessions.length }, 'Loaded active sessions from database');
  }

  private async resolveUserPath(ownerId: string, path?: string): Promise<string> {
    if (ownerId === 'legacy') {
      if (!path) {
        throw new Error('path is required');
      }
      const targetPath = normalize(resolve(path));
      await mkdir(targetPath, { recursive: true });
      return targetPath;
    }

    const userDir = resolve(this.usersDir, ownerId);
    await mkdir(userDir, { recursive: true });

    let targetPath: string;

    if (!path) {
      targetPath = userDir;
    } else if (isAbsolute(path)) {
      targetPath = normalize(path);
    } else {
      targetPath = normalize(resolve(userDir, path));
    }

    const normalizedUserDir = normalize(userDir);
    if (!targetPath.startsWith(normalizedUserDir)) {
      throw new Error(`Path "${path}" is outside of user directory`);
    }

    await mkdir(targetPath, { recursive: true });
    return targetPath;
  }

  async createSession(options: CreateSessionOptions): Promise<ClaudeSession> {
    const { ownerId } = options;

    const userSessionCount = this.db.getUserSessionCount(ownerId);
    const user = this.db.getUser(ownerId);
    const maxSessions = user?.maxSessions || 5;

    if (userSessionCount >= maxSessions) {
      throw new Error(`Session quota exceeded. Max ${maxSessions} sessions allowed.`);
    }

    const sessionId = randomUUID();
    const resolvedPath = await this.resolveUserPath(ownerId, options.path);

    this.db.createSession(
      sessionId,
      ownerId,
      resolvedPath,
      options.model
    );

    try {
      const session = new ClaudeSession({
        id: sessionId,
        path: resolvedPath,
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

      this.sessions.set(sessionId, {
        session,
        ownerId,
        metadata: {
          id: sessionId,
          path: resolvedPath,
          model: options.model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      log.info({ sessionId, ownerId, path: resolvedPath }, 'Session created');

      return session;
    } catch (error) {
      this.db.deleteSession(sessionId);
      throw error;
    }
  }

  async getSession(sessionId: string, userId: string): Promise<ClaudeSession | undefined> {
    const entry = this.sessions.get(sessionId);

    // If session exists and is valid, return it
    if (entry) {
      if (entry.ownerId !== userId) {
        return undefined;
      }
      if (entry.session instanceof ClaudeSession) {
        return entry.session;
      }
    }

    // Check if another request is already loading this session
    const existingLock = this.sessionLoadingLocks.get(sessionId);
    if (existingLock) {
      log.debug({ sessionId }, 'Waiting for existing session load');
      return existingLock;
    }

    // Need to lazy load
    let loadPromise: Promise<ClaudeSession | undefined>;

    if (!entry) {
      // Load from database
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || dbSession.ownerId !== userId) {
        return undefined;
      }
      loadPromise = Promise.resolve(this.lazyLoadSession({ ...dbSession, status: 'active' }));
      this.db.updateSessionStatus(sessionId, 'active');
    } else {
      // Entry exists but session not loaded
      loadPromise = Promise.resolve(this.lazyLoadSession({
        id: entry.metadata.id,
        ownerId: entry.ownerId,
        path: entry.metadata.path,
        model: entry.metadata.model,
        status: 'active',
        createdAt: entry.metadata.createdAt,
        updatedAt: entry.metadata.updatedAt,
      }));
    }

    // Store the lock
    this.sessionLoadingLocks.set(sessionId, loadPromise);
    loadPromise.finally(() => this.sessionLoadingLocks.delete(sessionId));

    return loadPromise;
  }

  private async lazyLoadSession(metadata: {
    id: string;
    ownerId: string;
    path: string;
    model?: string;
    status: 'active' | 'stopped' | 'error';
    createdAt: string;
    updatedAt: string;
  }): Promise<ClaudeSession> {
    log.info({ sessionId: metadata.id, ownerId: metadata.ownerId }, 'Lazy loading session from database');

    const session = new ClaudeSession({
      id: metadata.id,
      path: metadata.path,
      model: metadata.model,
    });

    // Sync history from Claude CLI
    await session.syncHistory();

    this.sessions.set(metadata.id, {
      session,
      ownerId: metadata.ownerId,
      metadata: {
        id: metadata.id,
        path: metadata.path,
        model: metadata.model,
        createdAt: metadata.createdAt,
        updatedAt: new Date().toISOString(),
      },
    });

    return session;
  }

  listSessions(userId: string): SessionInfo[] {
    const dbSessions = this.db.listUserSessions(userId);
    return dbSessions.map((s) => ({
      id: s.id,
      path: s.path,
      createdAt: s.createdAt,
      ownerId: s.ownerId,
    }));
  }

  deleteSession(sessionId: string, userId: string): boolean {
    const entry = this.sessions.get(sessionId);

    if (!entry || entry.ownerId !== userId) {
      const dbSession = this.db.getSession(sessionId);
      if (!dbSession || dbSession.ownerId !== userId) {
        return false;
      }
    }

    if (entry?.session && entry.session instanceof ClaudeSession) {
      entry.session.destroy();
    }

    this.sessions.delete(sessionId);
    this.db.deleteSession(sessionId);

    log.info({ sessionId, userId }, 'Session deleted');
    return true;
  }

  destroyAllSessions(): void {
    for (const [sessionId, entry] of this.sessions.entries()) {
      if (entry.session && entry.session instanceof ClaudeSession) {
        entry.session.destroy();
      }
    }
    log.info('All sessions destroyed');
  }

  getUserSessionCount(userId: string): number {
    return this.db.getUserSessionCount(userId);
  }

  isSessionOwner(sessionId: string, userId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      return entry.ownerId === userId;
    }
    const dbSession = this.db.getSession(sessionId);
    return dbSession?.ownerId === userId;
  }
}