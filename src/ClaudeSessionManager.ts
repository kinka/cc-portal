import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access, cp } from 'node:fs/promises';
import { resolve, normalize, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeSession } from './ClaudeSession';
import { CLISessionStorage } from './CLISessionStorage';
import { createLogger } from './logger';

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

/**
 * ClaudeSessionManager - CLI-based session management
 * 
 * Sessions are stored in Claude Code CLI's storage (~/.claude/projects/)
 * and this manager keeps lightweight mappings for user ownership and participants.
 */
export class ClaudeSessionManager {
  private sessions = new Map<string, ActiveSessionEntry>();
  private storage: CLISessionStorage;
  private usersDir: string;
  private agentApiBaseUrl?: string;
  private sessionLoadingLocks = new Map<string, Promise<ClaudeSession | undefined>>();
  private usersDirInitialized = false;

  constructor(
    storage: CLISessionStorage,
    options: { usersDir?: string; agentApiBaseUrl?: string } = {}
  ) {
    this.storage = storage;
    this.usersDir = resolve(options.usersDir || process.env.USERS_DIR || './users');
    this.agentApiBaseUrl = options.agentApiBaseUrl;
    // Initialize storage async
    this.storage.initialize().catch(err => log.error({ err }, 'Failed to initialize storage'));
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

    // Ensure user exists and check quota
    const user = await this.storage.getOrCreateUser(ownerId);
    const userSessionCount = await this.storage.getUserSessionCount(ownerId);
    const maxSessions = user.maxSessions;

    if (userSessionCount >= maxSessions) {
      throw new Error(`Session quota exceeded. Max ${maxSessions} sessions allowed.`);
    }

    const sessionId = randomUUID();
    const resolvedPath = await this.resolveUserPath(ownerId, options.path);

    // Register session in cache for immediate access
    this.storage.registerSession(sessionId, ownerId, resolvedPath);

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
      this.storage.unregisterSession(sessionId);
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
    const canAccess = await this.storage.canAccessSession(sessionId, userId);
    if (!canAccess) {
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

    // Need to lazy load - check if session exists in CLI storage
    const sessionExists = await this.storage.sessionExists(sessionId);
    if (!sessionExists) {
      return undefined;
    }

    const ownerId = await this.storage.getSessionOwner(sessionId);

    // Lazy load from CLI
    const loadPromise = this.lazyLoadSession({
      id: sessionId,
      ownerId: ownerId || 'unknown',
      path: '', // Will be determined from CLI storage
    });
    
    this.sessionLoadingLocks.set(sessionId, loadPromise);
    loadPromise.finally(() => this.sessionLoadingLocks.delete(sessionId));

    return loadPromise;
  }


  private async lazyLoadSession(metadata: {
    id: string;
    ownerId: string;
    path: string;
  }): Promise<ClaudeSession> {
    log.info({ sessionId: metadata.id, ownerId: metadata.ownerId }, 'Lazy loading session from CLI storage');

    // Get session info from CLI storage
    const sessionInfo = await this.storage.getSessionInfo(metadata.id);
    const resolvedPath = sessionInfo?.projectPath || metadata.path || process.cwd();

    const session = new ClaudeSession({
      id: metadata.id,
      path: resolvedPath,
      isNewSession: false,
    });

    // Sync history from Claude CLI
    await session.syncHistory();

    this.sessions.set(metadata.id, {
      session,
      ownerId: metadata.ownerId,
      metadata: {
        id: metadata.id,
        path: resolvedPath,
        createdAt: sessionInfo?.createdAt?.toISOString() || new Date().toISOString(),
        updatedAt: sessionInfo?.lastModified?.toISOString() || new Date().toISOString(),
      },
    });

    return session;
  }

  async listSessions(userId: string): Promise<SessionInfo[]> {
    const userSessions = await this.storage.listUserSessions(userId);
    
    return userSessions.map(s => ({
      id: s.id,
      path: s.path || '',
      createdAt: new Date().toISOString(),
      ownerId: s.ownerId,
    }));
  }

  async deleteSession(sessionId: string, userId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    const ownerId = await this.storage.getSessionOwner(sessionId);

    // Check ownership
    if (ownerId !== userId) {
      return false;
    }

    // Destroy the process
    if (entry?.session && entry.session instanceof ClaudeSession) {
      entry.session.destroy();
    }

    this.sessions.delete(sessionId);
    this.storage.unregisterSession(sessionId);
    await this.storage.deleteSessionFile(sessionId);

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

  async getUserSessionCount(userId: string): Promise<number> {
    return this.storage.getUserSessionCount(userId);
  }

  async isSessionOwner(sessionId: string, userId: string): Promise<boolean> {
    const ownerId = await this.storage.getSessionOwner(sessionId);
    return ownerId === userId;
  }

  /**
   * Add a participant to a session
   */
  async addParticipant(sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)?.session;
    if (session instanceof ClaudeSession) {
      session.addParticipant(userId);
    }
    return this.storage.addParticipant(sessionId, userId);
  }

  /**
   * Get participants of a session
   */
  async getSessionParticipants(sessionId: string): Promise<Array<{ userId: string; status: string; joinedAt?: string }>> {
    return this.storage.getSessionParticipants(sessionId);
  }
}
