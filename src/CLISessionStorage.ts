import { readdir, readFile, stat, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger';

const log = createLogger({ module: 'CLISessionStorage' });

/** Default max sessions per user (code constant) */
export const DEFAULT_MAX_SESSIONS = 200;

export interface CLISessionInfo {
  id: string;
  projectPath: string;
  projectHash: string;
  lastModified: Date;
  createdAt: Date;
  messageCount: number;
}

interface PortalConfig {
  /** Map of sessionId -> participants */
  participants: Record<string, { participants: Array<{ userId: string; status: string; joinedAt?: string }> }>;
  /** Map of sessionId -> { ownerId, path } - for newly created sessions not yet in CLI */
  newSessions: Record<string, { ownerId: string; path: string }>;
}
/**
 * CLI-based session storage that uses Claude Code CLI's storage as the source of truth.
 * 
 * Sessions: Stored in CLI's ~/.claude/projects/{projectHash}/{sessionId}.jsonl
 * Participants: Stored in portal-config.json
 * 
 * No user quotas - everyone has the same limit (DEFAULT_MAX_SESSIONS).
 */
export class CLISessionStorage {
  private claudeProjectsDir: string;
  private configFilePath: string;
  private config: PortalConfig = { participants: {}, newSessions: {} };
  private initialized = false;
  /** In-memory cache for newly created sessions (sync access) */
  private newSessionsCache = new Map<string, { ownerId: string; path: string }>();
  /** Short-lived cache for discoverSessions to avoid repeated disk scans within a burst */
  private discoverCache: { sessions: CLISessionInfo[]; expiresAt: number } | null = null;
  private static readonly DISCOVER_CACHE_TTL_MS = 2000;
  constructor(
    private usersDir: string,
    private claudeDir: string = join(homedir(), '.claude')
  ) {
    this.claudeProjectsDir = join(this.claudeDir, 'projects');
    this.configFilePath = join(this.usersDir, 'portal-config.json');
  }

  /**
   * Initialize storage
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.usersDir, { recursive: true });
    await this.loadConfig();

    this.initialized = true;
    log.info({ usersDir: this.usersDir }, 'CLI Session Storage initialized');
  }

  private async loadConfig(): Promise<void> {
    try {
      const content = await readFile(this.configFilePath, 'utf-8');
      this.config = JSON.parse(content);
      // Restore newSessions to memory cache
      for (const [id, data] of Object.entries(this.config.newSessions || {})) {
        this.newSessionsCache.set(id, data);
      }
      log.info({ participantCount: Object.keys(this.config.participants).length }, 'Loaded portal config');
    } catch {
      this.config = { participants: {}, newSessions: {} };
      log.info('No existing config, starting fresh');
    }
  }

  private async saveConfig(): Promise<void> {
    await writeFile(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * Calculate project hash from path (matches Claude CLI's hash algorithm)
   */
  static calculateProjectHash(projectPath: string): string {
    const normalized = projectPath
      .split('/')
      .filter(Boolean)
      .join('-');
    return `-${normalized}`;
  }

  /** Absolute working directory for a user (where their Claude sessions live) */
  private userWorkDir(userId: string): string {
    return resolve(this.usersDir, userId);
  }

  /** ~/.claude/projects/{hash} directory for a given user */
  private userProjectDir(userId: string): string {
    const hash = CLISessionStorage.calculateProjectHash(this.userWorkDir(userId));
    return join(this.claudeProjectsDir, hash);
  }

  /** List session files in a single project directory */
  private async listSessionsInDir(
    projectDir: string,
    projectPath: string,
  ): Promise<CLISessionInfo[]> {
    try {
      const files = await readdir(projectDir, { withFileTypes: true });
      const results: CLISessionInfo[] = [];
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const fileStat = await stat(join(projectDir, f.name));
        results.push({
          id: f.name.replace('.jsonl', ''),
          projectPath,
          projectHash: '',
          lastModified: fileStat.mtime,
          createdAt: fileStat.birthtime,
          messageCount: 0,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Discover all sessions from CLI's storage.
   * Results are cached for DISCOVER_CACHE_TTL_MS to avoid repeated disk scans within a burst.
   */
  async discoverSessions(): Promise<CLISessionInfo[]> {
    await this.initialize();

    const now = Date.now();
    if (this.discoverCache && now < this.discoverCache.expiresAt) {
      return this.discoverCache.sessions;
    }

    const sessions: CLISessionInfo[] = [];

    try {
      const projectDirs = await readdir(this.claudeProjectsDir, { withFileTypes: true });

      await Promise.all(
        projectDirs
          .filter((d: Dirent) => d.isDirectory())
          .map(async (d: Dirent) => {
            const projectHash = d.name;
            const projectDir = join(this.claudeProjectsDir, projectHash);
            try {
              const files = await readdir(projectDir, { withFileTypes: true });
              for (const file of files) {
                if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
                const sessionId = file.name.replace('.jsonl', '');
                const filePath = join(projectDir, file.name);
                const fileStat = await stat(filePath);
                sessions.push({
                  id: sessionId,
                  projectPath: this.getProjectPathFromHash(projectHash),
                  projectHash,
                  lastModified: fileStat.mtime,
                  createdAt: fileStat.birthtime,
                  messageCount: 0,
                });
              }
            } catch {
              // skip unreadable project dirs
            }
          })
      );
    } catch (err) {
      log.warn({ err }, 'Failed to discover sessions from CLI storage');
    }

    log.info({ count: sessions.length }, 'Discovered sessions from CLI');
    this.discoverCache = { sessions, expiresAt: now + CLISessionStorage.DISCOVER_CACHE_TTL_MS };
    return sessions;
  }

  /** Invalidate the discoverSessions cache (call after creating/deleting a session) */
  invalidateDiscoverCache(): void {
    this.discoverCache = null;
  }

  private getProjectPathFromHash(projectHash: string): string {
    if (projectHash.startsWith('-')) {
      return '/' + projectHash.slice(1).replace(/-/g, '/');
    }
    return projectHash;
  }

  // ============ Session Methods ============

  /**
   * Check if a session exists in CLI storage.
   * Scans per-user project directories instead of all project directories.
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    await this.initialize();

    if (this.newSessionsCache.has(sessionId)) return true;

    const users = await this.listUsers();
    for (const user of users) {
      const sessionFile = join(this.userProjectDir(user.id), `${sessionId}.jsonl`);
      try {
        await access(sessionFile);
        return true;
      } catch {
        // not this user's session
      }
    }
    return false;
  }

  /**
   * Get session info from CLI storage or cache.
   * Scans per-user project directories instead of all project directories.
   */
  async getSessionInfo(sessionId: string): Promise<CLISessionInfo | undefined> {
    await this.initialize();

    const cached = this.newSessionsCache.get(sessionId);
    if (cached) {
      return {
        id: sessionId,
        projectPath: cached.path,
        projectHash: '',
        lastModified: new Date(),
        createdAt: new Date(),
        messageCount: 0,
      };
    }

    const users = await this.listUsers();
    for (const user of users) {
      const projectDir = this.userProjectDir(user.id);
      const sessionFile = join(projectDir, `${sessionId}.jsonl`);
      try {
        const fileStat = await stat(sessionFile);
        return {
          id: sessionId,
          projectPath: this.userWorkDir(user.id),
          projectHash: '',
          lastModified: fileStat.mtime,
          createdAt: fileStat.birthtime,
          messageCount: 0,
        };
      } catch {
        // not this user's session
      }
    }
    return undefined;
  }

  /**
   * Get the owner of a session.
   * Checks the in-memory cache first, then scans per-user project directories.
   */
  async getSessionOwner(sessionId: string): Promise<string | undefined> {
    const cached = this.newSessionsCache.get(sessionId);
    if (cached) return cached.ownerId;

    const users = await this.listUsers();
    for (const user of users) {
      const sessionFile = join(this.userProjectDir(user.id), `${sessionId}.jsonl`);
      try {
        await access(sessionFile);
        return user.id;
      } catch {
        // not this user's session
      }
    }
    return undefined;
  }

  /**
   * Register a newly created session (in memory cache)
   */
  registerSession(sessionId: string, ownerId: string, path: string): void {
    this.newSessionsCache.set(sessionId, { ownerId, path });
  }

  /**
   * Unregister a session from cache
   */
  unregisterSession(sessionId: string): void {
    this.newSessionsCache.delete(sessionId);
  }

  /**
   * Delete a session's .jsonl file from disk (~/.claude/projects/)
   */
  async deleteSessionFile(sessionId: string): Promise<boolean> {
    try {
      const projectDirs = await readdir(this.claudeProjectsDir);
      for (const projectHash of projectDirs) {
        const sessionFile = join(this.claudeProjectsDir, projectHash, `${sessionId}.jsonl`);
        try {
          await access(sessionFile);
          await unlink(sessionFile);
          this.invalidateDiscoverCache();
          log.info({ sessionId, projectHash }, 'Deleted session file from disk');
          return true;
        } catch {
          // Not in this project, continue
        }
      }
    } catch (err) {
      log.warn({ err, sessionId }, 'Failed to delete session file');
    }
    return false;
  }
  // ============ User Methods (no storage needed) ============

  /**
   * Get or create a user (no persistence, just return defaults)
   */
  async getOrCreateUser(userId: string): Promise<{ id: string; maxSessions: number; createdAt: string }> {
    // Check if user directory exists
    const userDir = join(this.usersDir, userId);
    try {
      await access(userDir);
    } catch {
      // Create user directory
      await mkdir(userDir, { recursive: true });
    }

    return {
      id: userId,
      maxSessions: DEFAULT_MAX_SESSIONS,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get a user (check directory existence)
   */
  async getUser(userId: string): Promise<{ id: string; maxSessions: number; createdAt: string } | undefined> {
    const userDir = join(this.usersDir, userId);
    try {
      const userStat = await stat(userDir);
      if (!userStat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    return {
      id: userId,
      maxSessions: DEFAULT_MAX_SESSIONS,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * List all users (based on users directory subdirectories)
   */
  async listUsers(): Promise<Array<{ id: string; maxSessions: number; createdAt: string }>> {
    await this.initialize();
    
    const users: Array<{ id: string; maxSessions: number; createdAt: string }> = [];
    
    try {
      const entries = await readdir(this.usersDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        
        users.push({
          id: entry.name,
          maxSessions: DEFAULT_MAX_SESSIONS,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      log.warn({ err }, 'Failed to read users directory');
    }
    
    return users;
  }

  /**
   * Get session count for a user.
   * Directly reads the user's project directory — no full scan needed.
   */
  async getUserSessionCount(userId: string): Promise<number> {
    const sessions = await this.listUserSessions(userId);
    return sessions.length;
  }

  /**
   * List sessions for a user.
   * Reads the user's own project directory directly; no full scan of all projects.
   */
  async listUserSessions(userId: string): Promise<Array<{ id: string; ownerId: string; path?: string }>> {
    await this.initialize();

    const result: Array<{ id: string; ownerId: string; path?: string }> = [];
    const addedIds = new Set<string>();

    // Sessions tracked in memory cache (e.g. custom-path sessions)
    for (const [id, data] of this.newSessionsCache) {
      if (data.ownerId === userId) {
        result.push({ id, ownerId: userId, path: data.path });
        addedIds.add(id);
      }
    }

    // Sessions in the user's default project directory
    const userDir = this.userWorkDir(userId);
    const projectDir = this.userProjectDir(userId);
    const ownedSessions = await this.listSessionsInDir(projectDir, userDir);
    for (const s of ownedSessions) {
      if (!addedIds.has(s.id)) {
        result.push({ id: s.id, ownerId: userId, path: userDir });
        addedIds.add(s.id);
      }
    }

    // Sessions the user joined as a participant
    for (const [sessionId, data] of Object.entries(this.config.participants)) {
      if (addedIds.has(sessionId)) continue;
      const joined = data.participants.find(p => p.userId === userId && p.status === 'joined');
      if (joined) {
        const owner = await this.getSessionOwner(sessionId);
        if (owner && owner !== userId) {
          result.push({ id: sessionId, ownerId: owner });
          addedIds.add(sessionId);
        }
      }
    }

    return result;
  }

  // ============ Participant Methods ============

  /**
   * Add a participant to a session
   */
  async addParticipant(sessionId: string, userId: string): Promise<boolean> {
    await this.initialize();
    
    if (!this.config.participants[sessionId]) {
      this.config.participants[sessionId] = { participants: [] };
    }
    
    const existing = this.config.participants[sessionId].participants.find(p => p.userId === userId);
    if (existing) {
      existing.status = 'joined';
      existing.joinedAt = new Date().toISOString();
    } else {
      this.config.participants[sessionId].participants.push({
        userId,
        status: 'joined',
        joinedAt: new Date().toISOString(),
      });
    }
    
    await this.saveConfig();
    return true;
  }

  /**
   * Get participants of a session
   */
  async getSessionParticipants(sessionId: string): Promise<Array<{ userId: string; status: string; joinedAt?: string }>> {
    await this.initialize();
    return this.config.participants[sessionId]?.participants || [];
  }

  /**
   * Check if a user can access a session (owner or participant)
   */
  async canAccessSession(sessionId: string, userId: string): Promise<boolean> {
    // Check if owner
    const owner = await this.getSessionOwner(sessionId);
    if (owner === userId) return true;

    // Check if participant
    const participants = this.config.participants[sessionId]?.participants || [];
    return participants.some(p => p.userId === userId && p.status === 'joined');
  }

  /**
   * Get sessions a user is participating in
   */
  async getUserParticipatingSessions(userId: string): Promise<string[]> {
    await this.initialize();
    
    const sessionIds: string[] = [];
    
    for (const [sessionId, data] of Object.entries(this.config.participants)) {
      if (data.participants.some(p => p.userId === userId && p.status === 'joined')) {
        sessionIds.push(sessionId);
      }
    }
    
    return sessionIds;
  }
}
