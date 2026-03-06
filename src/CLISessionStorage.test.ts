import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CLISessionStorage, DEFAULT_MAX_SESSIONS } from './CLISessionStorage';
import { ClaudeSessionManager } from './ClaudeSessionManager';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('evictStaleSessions', () => {
    let usersDir: string;
    let claudeDir: string;
    let storage: CLISessionStorage;

    beforeEach(() => {
        usersDir = mkdtempSync(join(tmpdir(), 'cc-portal-evict-users-'));
        claudeDir = mkdtempSync(join(tmpdir(), 'cc-portal-evict-claude-'));
        storage = new CLISessionStorage(usersDir, claudeDir);
    });

    afterEach(() => {
        rmSync(usersDir, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
    });

    function createMockSession(userId: string, sessionId: string, mtime: Date): string {
        const userDir = join(usersDir, userId);
        mkdirSync(userDir, { recursive: true });
        const hash = CLISessionStorage.calculateProjectHash(userDir);
        const projectDir = join(claudeDir, 'projects', hash);
        mkdirSync(projectDir, { recursive: true });
        const filePath = join(projectDir, `${sessionId}.jsonl`);
        writeFileSync(filePath, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
        // Set the file modification time
        utimesSync(filePath, mtime, mtime);
        return filePath;
    }

    test('should evict the oldest sessions by lastModified', async () => {
        const userId = 'test-user';
        const now = Date.now();

        // Create 5 sessions with increasing modification times
        createMockSession(userId, 'session-oldest', new Date(now - 5000));
        createMockSession(userId, 'session-old', new Date(now - 4000));
        createMockSession(userId, 'session-mid', new Date(now - 3000));
        createMockSession(userId, 'session-recent', new Date(now - 2000));
        createMockSession(userId, 'session-newest', new Date(now - 1000));

        // Evict the 2 oldest
        const evicted = await storage.evictStaleSessions(userId, 2);

        expect(evicted).toEqual(['session-oldest', 'session-old']);

        // Verify files are actually deleted
        const hash = CLISessionStorage.calculateProjectHash(join(usersDir, userId));
        const projectDir = join(claudeDir, 'projects', hash);
        expect(existsSync(join(projectDir, 'session-oldest.jsonl'))).toBe(false);
        expect(existsSync(join(projectDir, 'session-old.jsonl'))).toBe(false);
        // Remaining sessions should still exist
        expect(existsSync(join(projectDir, 'session-mid.jsonl'))).toBe(true);
        expect(existsSync(join(projectDir, 'session-recent.jsonl'))).toBe(true);
        expect(existsSync(join(projectDir, 'session-newest.jsonl'))).toBe(true);
    });

    test('should return empty array when count is 0', async () => {
        const evicted = await storage.evictStaleSessions('test-user', 0);
        expect(evicted).toEqual([]);
    });

    test('should handle evicting more sessions than available', async () => {
        const userId = 'test-user';
        const now = Date.now();
        createMockSession(userId, 'session-1', new Date(now - 2000));
        createMockSession(userId, 'session-2', new Date(now - 1000));

        const evicted = await storage.evictStaleSessions(userId, 5);
        expect(evicted.length).toBe(2);
    });

    test('should clean up participant config for evicted sessions', async () => {
        const userId = 'test-user';
        const now = Date.now();
        createMockSession(userId, 'session-with-participants', new Date(now - 5000));
        createMockSession(userId, 'session-keep', new Date(now - 1000));

        // Add a participant to the session that will be evicted
        await storage.addParticipant('session-with-participants', 'other-user');

        const evicted = await storage.evictStaleSessions(userId, 1);
        expect(evicted).toEqual(['session-with-participants']);

        // Participant config should be cleaned up
        const participants = await storage.getSessionParticipants('session-with-participants');
        expect(participants).toEqual([]);
    });
});

describe('createSession auto-eviction', () => {
    let usersDir: string;
    let claudeDir: string;

    beforeEach(() => {
        usersDir = mkdtempSync(join(tmpdir(), 'cc-portal-create-users-'));
        claudeDir = mkdtempSync(join(tmpdir(), 'cc-portal-create-claude-'));
    });

    afterEach(() => {
        rmSync(usersDir, { recursive: true, force: true });
        rmSync(claudeDir, { recursive: true, force: true });
    });

    test('should auto-evict oldest sessions when quota is reached', async () => {
        const storage = new CLISessionStorage(usersDir, claudeDir);
        const manager = new ClaudeSessionManager(storage, { usersDir });

        const userId = 'quota-test-user';
        const userDir = join(usersDir, userId);
        mkdirSync(userDir, { recursive: true });

        // Create mock session files to simulate quota being reached
        // We'll use a small number to avoid creating 200 files
        // Instead, we patch maxSessions by overriding getOrCreateUser
        const originalGetOrCreateUser = storage.getOrCreateUser.bind(storage);
        storage.getOrCreateUser = async (uid: string) => {
            const user = await originalGetOrCreateUser(uid);
            return { ...user, maxSessions: 3 };
        };

        const hash = CLISessionStorage.calculateProjectHash(userDir);
        const projectDir = join(claudeDir, 'projects', hash);
        mkdirSync(projectDir, { recursive: true });

        const now = Date.now();
        // Create 3 existing session files (reaching the limit of 3)
        for (let i = 0; i < 3; i++) {
            const filePath = join(projectDir, `existing-session-${i}.jsonl`);
            writeFileSync(filePath, JSON.stringify({ type: 'system' }) + '\n');
            utimesSync(filePath, new Date(now - (3 - i) * 1000), new Date(now - (3 - i) * 1000));
        }

        // Verify we're at the limit
        const countBefore = await storage.getUserSessionCount(userId);
        expect(countBefore).toBe(3);

        // Create a new session — should NOT throw, should auto-evict the oldest
        const session = await manager.createSession({
            ownerId: userId,
            bypassPermission: true,
        });

        expect(session).toBeDefined();
        expect(session.id).toBeDefined();

        // The oldest session should have been evicted
        expect(existsSync(join(projectDir, 'existing-session-0.jsonl'))).toBe(false);

        // The other two + the new one should exist
        expect(existsSync(join(projectDir, 'existing-session-1.jsonl'))).toBe(true);
        expect(existsSync(join(projectDir, 'existing-session-2.jsonl'))).toBe(true);

        // Final count should still be at the limit (3 = 2 remaining + 1 new)
        const countAfter = await storage.getUserSessionCount(userId);
        expect(countAfter).toBe(3);

        // Clean up session
        session.destroy();
    });
});
