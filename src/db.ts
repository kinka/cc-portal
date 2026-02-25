import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from './logger';

const log = createLogger({ module: 'Database' });

export interface User {
  id: string;
  maxSessions: number;
  createdAt: string;
}

export interface SessionMetadata {
  id: string;
  ownerId: string;
  path: string;
  model?: string;
  status: 'active' | 'stopped' | 'error';
  createdAt: string;
  updatedAt: string;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath: string = process.env.DATABASE_URL || './data/app.db') {
    // Ensure directory exists
    mkdir(dirname(dbPath), { recursive: true }).catch(() => {});

    this.db = new Database(dbPath);
    this.initTables();
    log.info({ dbPath }, 'Database initialized');
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        max_sessions INTEGER DEFAULT 200,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        joined_at DATETIME,
        PRIMARY KEY (session_id, user_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    `);
  }

  // User operations
  getOrCreateUser(userId: string, defaultMaxSessions: number = 200): User {
    // Try to get existing user
    const existing = this.db
      .query<{ id: string; max_sessions: number; created_at: string }, string>(
        'SELECT id, max_sessions, created_at FROM users WHERE id = ?'
      )
      .get(userId);

    if (existing) {
      return {
        id: existing.id,
        maxSessions: existing.max_sessions,
        createdAt: existing.created_at,
      };
    }

    // Create new user
    this.db
      .query('INSERT INTO users (id, max_sessions) VALUES (?, ?)')
      .run(userId, defaultMaxSessions);

    log.info({ userId }, 'New user created');

    return {
      id: userId,
      maxSessions: defaultMaxSessions,
      createdAt: new Date().toISOString(),
    };
  }

  getUser(userId: string): User | undefined {
    const row = this.db
      .query<{ id: string; max_sessions: number; created_at: string }, string>(
        'SELECT id, max_sessions, created_at FROM users WHERE id = ?'
      )
      .get(userId);

    if (!row) return undefined;

    return {
      id: row.id,
      maxSessions: row.max_sessions,
      createdAt: row.created_at,
    };
  }

  updateUserQuota(userId: string, maxSessions: number): boolean {
    const result = this.db
      .query('UPDATE users SET max_sessions = ? WHERE id = ?')
      .run(maxSessions, userId);

    return result.changes > 0;
  }

  listUsers(): User[] {
    const rows = this.db.query<
      { id: string; max_sessions: number; created_at: string },
      []
    >('SELECT id, max_sessions, created_at FROM users ORDER BY created_at DESC').all();

    return rows.map((row) => ({
      id: row.id,
      maxSessions: row.max_sessions,
      createdAt: row.created_at,
    }));
  }

  deleteUser(userId: string): boolean {
    // First delete all sessions owned by this user
    this.db.query('DELETE FROM sessions WHERE owner_id = ?').run(userId);

    const result = this.db.query('DELETE FROM users WHERE id = ?').run(userId);

    return result.changes > 0;
  }

  // Session operations
  createSession(
    sessionId: string,
    ownerId: string,
    path: string,
    model?: string
  ): SessionMetadata {
    const now = new Date().toISOString();

    this.db
      .query(
        'INSERT INTO sessions (id, owner_id, path, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(sessionId, ownerId, path, model || null, 'active', now, now);

    return {
      id: sessionId,
      ownerId,
      path,
      model,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(sessionId: string): SessionMetadata | undefined {
    const row = this.db
      .query<
        {
          id: string;
          owner_id: string;
          path: string;
          model: string | null;
          status: 'active' | 'stopped' | 'error';
          created_at: string;
          updated_at: string;
        },
        string
      >(
        'SELECT id, owner_id, path, model, status, created_at, updated_at FROM sessions WHERE id = ?'
      )
      .get(sessionId);

    if (!row) return undefined;

    return {
      id: row.id,
      ownerId: row.owner_id,
      path: row.path,
      model: row.model || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listUserSessions(userId: string): SessionMetadata[] {
    const rows = this.db
      .query<
        {
          id: string;
          owner_id: string;
          path: string;
          model: string | null;
          status: 'active' | 'stopped' | 'error';
          created_at: string;
          updated_at: string;
        },
        string
      >(
        'SELECT id, owner_id, path, model, status, created_at, updated_at FROM sessions WHERE owner_id = ? ORDER BY created_at DESC'
      )
      .all(userId);

    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      path: row.path,
      model: row.model || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listAllSessions(): SessionMetadata[] {
    const rows = this.db.query<
      {
        id: string;
        owner_id: string;
        path: string;
        model: string | null;
        status: 'active' | 'stopped' | 'error';
        created_at: string;
        updated_at: string;
      },
      []
    >(
      'SELECT id, owner_id, path, model, status, created_at, updated_at FROM sessions ORDER BY created_at DESC'
    ).all();

    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      path: row.path,
      model: row.model || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateSessionStatus(
    sessionId: string,
    status: 'active' | 'stopped' | 'error'
  ): boolean {
    const result = this.db
      .query('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), sessionId);

    return result.changes > 0;
  }

  deleteSession(sessionId: string): boolean {
    const result = this.db
      .query('DELETE FROM sessions WHERE id = ?')
      .run(sessionId);

    return result.changes > 0;
  }

  getUserSessionCount(userId: string): number {
    const row = this.db
      .query<{ count: number }, string>(
        "SELECT COUNT(*) as count FROM sessions WHERE owner_id = ? AND status = 'active'"
      )
      .get(userId);

    return row?.count || 0;
  }

  getActiveSessions(): SessionMetadata[] {
    const rows = this.db
      .query<
        {
          id: string;
          owner_id: string;
          path: string;
          model: string | null;
          status: 'active' | 'stopped' | 'error';
          created_at: string;
          updated_at: string;
        },
        []
      >(
        "SELECT id, owner_id, path, model, status, created_at, updated_at FROM sessions WHERE status = 'active'"
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      path: row.path,
      model: row.model || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  close() {
    this.db.close();
  }

  // Session participants operations
  inviteParticipant(sessionId: string, userId: string): boolean {
    try {
      this.db
        .query('INSERT INTO session_participants (session_id, user_id, status) VALUES (?, ?, ?)')
        .run(sessionId, userId, 'pending');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Directly add a user as a joined participant (no confirmation needed). */
  addParticipant(sessionId: string, userId: string): boolean {
    try {
      this.db
        .query(
          'INSERT OR REPLACE INTO session_participants (session_id, user_id, status, joined_at) VALUES (?, ?, ?, ?)'
        )
        .run(sessionId, userId, 'joined', new Date().toISOString());
      return true;
    } catch (e) {
      return false;
    }
  }

  acceptInvitation(sessionId: string, userId: string): boolean {
    const result = this.db
      .query('UPDATE session_participants SET status = ?, joined_at = ? WHERE session_id = ? AND user_id = ?')
      .run('joined', new Date().toISOString(), sessionId, userId);
    return result.changes > 0;
  }

  getSessionParticipants(sessionId: string): Array<{ userId: string; status: string; joinedAt?: string }> {
    const rows = this.db
      .query<{ user_id: string; status: string; joined_at: string | null }, string>(
        'SELECT user_id, status, joined_at FROM session_participants WHERE session_id = ?',
      )
      .all(sessionId);
    return rows.map((r) => ({
      userId: r.user_id,
      status: r.status,
      joinedAt: r.joined_at || undefined,
    }));
  }

  getUserParticipatingSessions(userId: string): string[] {
    const rows = this.db
      .query<{ session_id: string }, string>(
        "SELECT session_id FROM session_participants WHERE user_id = ? AND status = 'joined'",
      )
      .all(userId);
    return rows.map((r) => r.session_id);
  }

  canAccessSession(sessionId: string, userId: string): boolean {
    // Check if owner
    const session = this.getSession(sessionId);
    if (session?.ownerId === userId) return true;
    // Check if participant
    const participant = this.db
      .query<{ status: string }, [string, string]>(
        'SELECT status FROM session_participants WHERE session_id = ? AND user_id = ?',
      )
      .get(sessionId, userId);
    return participant?.status === 'joined';
  }
}
