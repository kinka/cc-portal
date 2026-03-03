import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access, cp } from 'node:fs/promises';
import { resolve, normalize, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeSession } from './ClaudeSession';
import { createLogger } from './logger';
import type { DatabaseManager } from './db';

const log = createLogger({ module: 'SessionManager' });

// 获取当前文件所在目录
const __dirname = dirname(fileURLToPath(import.meta.url));
const usersClaudeMdTemplate = join(__dirname, 'users-CLAUDE.md');

export interface CreateSessionOptions {
  ownerId: string;
  path?: string;
  /** Project name to associate with this session */
  project?: string;
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
  /** Tool name patterns to auto-allow without approval (e.g. Read, mcp__*__get*). */
  autoAllowToolPatterns?: string[];
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
  private agentApiBaseUrl?: string;
  private sessionLoadingLocks = new Map<string, Promise<ClaudeSession | undefined>>();
  private usersDirInitialized = false;

  constructor(
    private db: DatabaseManager,
    options: { usersDir?: string; agentApiBaseUrl?: string } = {}
  ) {
    this.usersDir = resolve(options.usersDir || process.env.USERS_DIR || './users');
    this.agentApiBaseUrl = options.agentApiBaseUrl;
    this.loadActiveSessionsFromDb();
  }

  /**
   * 初始化 users 根目录
   * - 复制 CLAUDE.md 模板到 users/CLAUDE.md（所有用户共享）
   */
  private async initUsersRootDirectory(): Promise<void> {
    if (this.usersDirInitialized) return;

    const claudeMdPath = join(this.usersDir, 'CLAUDE.md');

    try {
      // 确保 users 目录存在
      await mkdir(this.usersDir, { recursive: true });

      // 检查 CLAUDE.md 是否已存在
      await access(claudeMdPath);
    } catch {
      // 不存在，从模板复制
      try {
        await cp(usersClaudeMdTemplate, claudeMdPath);
        log.info({ usersDir: this.usersDir }, 'Created users/CLAUDE.md from template');
      } catch (err) {
        log.warn({ err }, 'Failed to copy CLAUDE.md template, creating default');
        // 如果模板不存在，创建一个基础的 CLAUDE.md
        await writeFile(claudeMdPath, `# CLAUDE.md\n\n用户工作目录配置\n`);
      }
    }

    this.usersDirInitialized = true;
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

    // 初始化 users 根目录（复制 CLAUDE.md 模板）
    await this.initUsersRootDirectory();

    const userDir = resolve(this.usersDir, ownerId);
    let targetPath: string;

    if (!path) {
      // If no path provided, use the user directory as default
      targetPath = userDir;
    } else if (isAbsolute(path)) {
      // If absolute path provided, use it directly (no restriction)
      targetPath = normalize(path);
    } else {
      // If relative path provided, resolve it relative to user directory
      targetPath = normalize(resolve(userDir, path));
    }

    await mkdir(targetPath, { recursive: true });

    // 在用户目录下创建空的 .git 目录（用于 Claude Code auto memory 存储）
    await this.initUserGitDirectory(userDir);

    return targetPath;
  }

  /**
   * 在用户目录下创建空的 .git 目录
   * 用于 Claude Code auto memory 存储位置识别
   */
  private async initUserGitDirectory(userDir: string): Promise<void> {
    const gitDir = join(userDir, '.git');

    try {
      await access(gitDir);
    } catch {
      await mkdir(gitDir, { recursive: true });
      log.info({ userDir }, 'Created .git directory for memory storage');
    }
  }

  async createSession(options: CreateSessionOptions): Promise<ClaudeSession> {
    const { ownerId } = options;

    const userSessionCount = this.db.getUserSessionCount(ownerId);
    const user = this.db.getUser(ownerId);
    const maxSessions = user?.maxSessions || 200;

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
        autoAllowToolPatterns: options.autoAllowToolPatterns,
        ownerId,
        sessionContext: this.agentApiBaseUrl
          ? { apiBaseUrl: this.agentApiBaseUrl, userId: ownerId }
          : undefined,
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

  /** Get an active session directly without permission checks. For internal use only. */
  getSessionDirect(sessionId: string): ClaudeSession | undefined {
    const entry = this.sessions.get(sessionId);
    return entry?.session instanceof ClaudeSession ? entry.session : undefined;
  }

  async getSession(sessionId: string, userId: string): Promise<ClaudeSession | undefined> {
    // Check if user can access this session (owner or participant)
    if (!this.db.canAccessSession(sessionId, userId)) {
      return undefined;
    }

    const entry = this.sessions.get(sessionId);

    // If session exists and is valid, return it
    if (entry) {
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

    const dbSession = this.db.getSession(sessionId);
    if (!dbSession) {
      return undefined;
    }

    if (!entry) {
      // Load from database
      loadPromise = Promise.resolve(this.lazyLoadSession({ ...dbSession, status: 'active' }));
      this.db.updateSessionStatus(sessionId, 'active');
    } else {
      // Entry exists but session not loaded
      loadPromise = Promise.resolve(this.lazyLoadSession({
        id: entry.metadata.id,
        ownerId: dbSession.ownerId,
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
      isNewSession: false,
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
