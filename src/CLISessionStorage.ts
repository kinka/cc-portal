import { readdir, readFile, stat, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
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

  /**
   * Discover all sessions from CLI's storage
   */
  async discoverSessions(): Promise<CLISessionInfo[]> {
    await this.initialize();
    const sessions: CLISessionInfo[] = [];

    try {
      const projectDirs = await readdir(this.claudeProjectsDir);

      for (const projectHash of projectDirs) {
        const projectDir = join(this.claudeProjectsDir, projectHash);
        const projectStat = await stat(projectDir);
        
        if (!projectStat.isDirectory()) continue;

        const files = await readdir(projectDir);
        
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;

          const sessionId = file.replace('.jsonl', '');
          const filePath = join(projectDir, file);
          const fileStat = await stat(filePath);

          const content = await readFile(filePath, 'utf-8');
          const messageCount = content.split('\n').filter(line => line.trim()).length;

          sessions.push({
            id: sessionId,
            projectPath: this.getProjectPathFromHash(projectHash),
            projectHash,
            lastModified: fileStat.mtime,
            createdAt: fileStat.birthtime,
            messageCount,
          });
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to discover sessions from CLI storage');
    }

    log.info({ count: sessions.length }, 'Discovered sessions from CLI');
    return sessions;
  }

  private getProjectPathFromHash(projectHash: string): string {
    if (projectHash.startsWith('-')) {
      return '/' + projectHash.slice(1).replace(/-/g, '/');
    }
    return projectHash;
  }

  /**
   * Extract owner userId from project path
   */
  private extractOwnerFromProjectPath(projectPath: string): string | undefined {
    const usersIndex = projectPath.indexOf('/users/');
    if (usersIndex === -1) return undefined;
    const afterUsers = projectPath.slice(usersIndex + '/users/'.length);
    return afterUsers.split('/')[0] || undefined;
  }

  // ============ Session Methods ============

  /**
   * Check if a session exists in CLI storage
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    await this.initialize();
    
    // Check memory cache first (newly created sessions)
    if (this.newSessionsCache.has(sessionId)) return true;
    
    try {
      const projectDirs = await readdir(this.claudeProjectsDir);
      
      for (const projectHash of projectDirs) {
        const sessionFile = join(this.claudeProjectsDir, projectHash, `${sessionId}.jsonl`);
        try {
          await access(sessionFile);
          return true;
        } catch {
          // Not in this project, continue
        }
      }
    } catch {
      // Projects dir doesn't exist
    }
    
    return false;
  }

  /**
   * Get session info from CLI storage or cache
   */
  async getSessionInfo(sessionId: string): Promise<CLISessionInfo | undefined> {
    await this.initialize();
    
    // Check memory cache first (newly created sessions)
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
    
    try {
      const projectDirs = await readdir(this.claudeProjectsDir);
      
      for (const projectHash of projectDirs) {
        const sessionFile = join(this.claudeProjectsDir, projectHash, `${sessionId}.jsonl`);
        try {
          await access(sessionFile);
          const fileStat = await stat(sessionFile);
          const content = await readFile(sessionFile, 'utf-8');
          const messageCount = content.split('\n').filter(line => line.trim()).length;

          return {
            id: sessionId,
            projectPath: this.getProjectPathFromHash(projectHash),
            projectHash,
            lastModified: fileStat.mtime,
            createdAt: fileStat.birthtime,
            messageCount,
          };
        } catch {
          // Not in this project, continue
        }
      }
    } catch {
      // Projects dir doesn't exist
    }
    
    return undefined;
  }

  /**
   * Get the owner of a session (from cache or extracted from project path)
   */
  async getSessionOwner(sessionId: string): Promise<string | undefined> {
    // Check memory cache first
    const cached = this.newSessionsCache.get(sessionId);
    if (cached) return cached.ownerId;
    
    const info = await this.getSessionInfo(sessionId);
    if (!info) return undefined;
    return this.extractOwnerFromProjectPath(info.projectPath);
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
   * Get session count for a user (from CLI storage + cache)
   */
  async getUserSessionCount(userId: string): Promise<number> {
    const sessions = await this.discoverSessions();
    let count = sessions.filter(s => {
      const owner = this.extractOwnerFromProjectPath(s.projectPath);
      return owner === userId;
    }).length;
    
    // Add sessions from memory cache
    for (const [id, data] of this.newSessionsCache) {
      if (data.ownerId === userId) count++;
    }
    
    return count;
  }

  /**
   * List sessions for a user (from CLI storage + cache)
   */
  async listUserSessions(userId: string): Promise<Array<{ id: string; ownerId: string; path?: string }>> {
    const sessions = await this.discoverSessions();
    const result: Array<{ id: string; ownerId: string; path?: string }> = [];
    const addedIds = new Set<string>();

    // From memory cache (newly created sessions)
    for (const [id, data] of this.newSessionsCache) {
      if (data.ownerId === userId) {
        result.push({ id, ownerId: userId, path: data.path });
        addedIds.add(id);
      }
    }

    // Owned sessions from CLI
    for (const s of sessions) {
      if (addedIds.has(s.id)) continue;
      const owner = this.extractOwnerFromProjectPath(s.projectPath);
      if (owner === userId) {
        result.push({ id: s.id, ownerId: userId, path: s.projectPath });
        addedIds.add(s.id);
      }
    }

    // Participated sessions
    for (const [sessionId, data] of Object.entries(this.config.participants)) {
      if (addedIds.has(sessionId)) continue;
      const joined = data.participants.find(p => p.userId === userId && p.status === 'joined');
      if (joined) {
        const info = await this.getSessionInfo(sessionId);
        if (info) {
          const owner = this.extractOwnerFromProjectPath(info.projectPath);
          if (owner && owner !== userId) {
            result.push({ id: sessionId, ownerId: owner, path: info.projectPath });
          }
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
