import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ClaudeAgentBackend } from './ClaudeAgentBackend';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { buildApp } from './app';
import { CLISessionStorage } from './CLISessionStorage';
import { ClaudeSessionManager } from './ClaudeSessionManager';

describe('ClaudeAgentBackend', () => {
  test('should calculate hash for simple path', () => {
    // The hash is the path components joined with '-' and prefixed with '-'
    const result = (ClaudeAgentBackend as any).calculateProjectHash('/Users/kinka/space');
    expect(result).toBe('-Users-kinka-space');
  });

  test('should handle path with trailing slash', () => {
    const result = (ClaudeAgentBackend as any).calculateProjectHash('/Users/kinka/space/');
    expect(result).toBe('-Users-kinka-space');
  });

  test('should handle nested paths', () => {
    const result = (ClaudeAgentBackend as any).calculateProjectHash('/Users/kinka/space/happy-coder/cc-portal');
    expect(result).toBe('-Users-kinka-space-happy-coder-cc-portal');
  });

  test('should automatically destroy process after idle timeout', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'cc-portal-idle-'));
    // Set a short idle timeout (1000ms / 1s) for the test
    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: 'idle-test-session',
      permissionMode: 'bypassPermissions',
      idleTimeoutMs: 1000,
    });

    // Force initialize directly using query
    // (This creates the process and starts the idle timer)
    // Since query can be slow, we'll try initializing and tracking destruction.
    // We will use the 'processDied' or just check isProcessAlive

    // Stub the initialize method or spawn to avoid actual heavy claude process if possible,
    // but testing the real timer behaviour requires initializing.
    // Instead we can test by calling `(backend as any).resetIdleTimer()` and `(backend as any).isInitialized = true`

    let destroyed = false;
    const originalDestroy = backend.destroy.bind(backend);
    (backend as any).destroy = () => {
      destroyed = true;
      originalDestroy();
    };

    (backend as any).isInitialized = true;
    (backend as any).resetIdleTimer();

    expect(destroyed).toBe(false);

    // Wait for slightly more than idleTimeoutMs
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(destroyed).toBe(true);

    backend.cancel(); // ensure cleanup
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('getHistory', () => {
  const testSessionId = 'test-session-12345';
  let sessionFile: string;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cc-portal-history-'));
    const projectHash = (ClaudeAgentBackend as any).calculateProjectHash(testDir);
    const claudeDir = join(homedir(), '.claude', 'projects', projectHash);
    sessionFile = join(claudeDir, `${testSessionId}.jsonl`);
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(sessionFile)) {
      rmSync(sessionFile);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test('should return empty array when session file does not exist', async () => {
    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: 'non-existent-session',
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();
    expect(history).toEqual([]);
  });

  test('should load history from jsonl file', async () => {
    // Create test session file
    const testEntries = [
      { type: 'system', subtype: 'init', session_id: testSessionId },
      {
        type: 'user',
        message: { role: 'user', content: 'Hello, how are you?' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: "I'm doing well, thank you!" }],
          id: 'msg-res-001',
        },
        uuid: 'msg-002',
        timestamp: '2026-02-27T10:00:05.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'Can you help me with code?' },
        uuid: 'msg-003',
        timestamp: '2026-02-27T10:01:00.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Of course! What do you need help with?' }],
          id: 'msg-res-002',
        },
        uuid: 'msg-004',
        timestamp: '2026-02-27T10:01:03.000Z',
        sessionId: testSessionId,
      },
    ];

    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();

    expect(history.length).toBe(4);
    expect(history[0]).toEqual({
      role: 'user',
      content: 'Hello, how are you?',
      timestamp: new Date('2026-02-27T10:00:00.000Z'),
    });
    expect(history[1]).toEqual({
      role: 'assistant',
      content: "I'm doing well, thank you!",
      timestamp: new Date('2026-02-27T10:00:05.000Z'),
    });
  });

  test('should handle array content with multiple text blocks', async () => {
    const testEntries = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First part. ' },
            { type: 'text', text: 'Second part.' },
          ],
          id: 'msg-001',
        },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
    ];

    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();

    expect(history.length).toBe(1);
    expect(history[0].content).toBe('First part. Second part.');
  });

  test('should skip non-message entries (system, file-history-snapshot, etc.)', async () => {
    const testEntries = [
      { type: 'system', subtype: 'init', session_id: testSessionId },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'log', log: { level: 'info', message: 'test' } },
      {
        type: 'user',
        message: { role: 'user', content: 'Real message' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
    ];

    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();

    expect(history.length).toBe(1);
    expect(history[0].content).toBe('Real message');
  });

  test('should handle malformed JSON lines gracefully', async () => {
    const testContent = [
      '{"type": "user", "message": {"role": "user", "content": "valid"}, "timestamp": "2026-02-27T10:00:00.000Z"}',
      'not valid json',
      '{"type": "assistant", "message": {"role": "assistant", "content": "also valid"}, "timestamp": "2026-02-27T10:00:01.000Z"}',
    ].join('\n');

    writeFileSync(sessionFile, testContent);

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();

    // Should still load valid entries
    expect(history.length).toBe(2);
  });

  test('should handle string content directly', async () => {
    const testEntries = [
      {
        type: 'user',
        message: { role: 'user', content: 'Simple string content' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
    ];

    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const history = await backend.getHistory();

    expect(history.length).toBe(1);
    expect(history[0].content).toBe('Simple string content');
  });
});

describe('getHistoryDetailed', () => {
  const testSessionId = 'test-session-detailed-12345';
  let sessionFile: string;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cc-portal-detailed-'));
    const projectHash = (ClaudeAgentBackend as any).calculateProjectHash(testDir);
    const claudeDir = join(homedir(), '.claude', 'projects', projectHash);
    sessionFile = join(claudeDir, `${testSessionId}.jsonl`);
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(sessionFile)) {
      rmSync(sessionFile);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test('should load detailed history including tool calls', async () => {
    const testEntries = [
      {
        type: 'user',
        message: { role: 'user', content: 'List files in current directory' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: "Let me check the files." },
            { type: 'tool_use', id: 'tool-001', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
        uuid: 'msg-002',
        timestamp: '2026-02-27T10:00:02.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'tool_use',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        uuid: 'tool-001',
        timestamp: '2026-02-27T10:00:02.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'tool_result',
        tool_name: 'Bash',
        tool_output: { content: 'total 48\ndrwxr-xr-x  4 files' },
        uuid: 'tool-result-001',
        timestamp: '2026-02-27T10:00:03.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: "Here's what I found:\n\ntotal 48\ndrwxr-xr-x  4 files" },
          ],
        },
        uuid: 'msg-003',
        timestamp: '2026-02-27T10:00:04.000Z',
        sessionId: testSessionId,
      },
    ];

    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: testSessionId,
      permissionMode: 'bypassPermissions',
    });

    const detailed = await backend.getHistoryDetailed();

    expect(detailed.length).toBe(5);

    // Check tool_use entry
    const toolUse = detailed.find(e => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse?.tool_name).toBe('Bash');
    expect(toolUse?.tool_input).toEqual({ command: 'ls -la' });

    // Check tool_result entry
    const toolResult = detailed.find(e => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.tool_name).toBe('Bash');
    expect(toolResult?.tool_output).toEqual({ content: 'total 48\ndrwxr-xr-x  4 files' });
  });

  test('should return empty array when file does not exist', async () => {
    const backend = new ClaudeAgentBackend({
      cwd: testDir,
      claudeSessionId: 'non-existent-session',
      permissionMode: 'bypassPermissions',
    });

    const detailed = await backend.getHistoryDetailed();
    expect(detailed).toEqual([]);
  });
});

describe('HTTP API - /sessions/:sessionId loads from CLI', () => {
  test('should load history from CLI storage by default', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'cc-portal-api-1-'));
    const storage = new CLISessionStorage('./test-users');
    const manager = new ClaudeSessionManager(storage, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, storage });
    // Create session first and get the actual session ID
    const session = await manager.createSession({
      ownerId: 'test-user',
      path: testDir,
      bypassPermission: true,
    });

    const testSessionId = session.id;
    const projectHash = (ClaudeAgentBackend as any).calculateProjectHash(testDir);
    const claudeDir = join(homedir(), '.claude', 'projects', projectHash);
    const sessionFile = join(claudeDir, `${testSessionId}.jsonl`);

    // Create test session file in CLI storage
    mkdirSync(claudeDir, { recursive: true });
    const testEntries = [
      {
        type: 'user',
        message: { role: 'user', content: 'Test message from CLI storage' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response from CLI' }] },
        uuid: 'msg-002',
        timestamp: '2026-02-27T10:00:01.000Z',
        sessionId: testSessionId,
      },
    ];
    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    try {
      // Request from /sessions/:id/messages loads from CLI
      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${testSessionId}/messages`,
        headers: { 'x-user-id': 'test-user' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.source).toBe('cli');
      expect(body.count).toBeGreaterThan(0);
      expect(body.messages[0].content).toContain('Test message from CLI storage');

    } finally {
      // Cleanup
      if (existsSync(sessionFile)) {
        rmSync(sessionFile);
      }
      manager.deleteSession(testSessionId, 'test-user');
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('should support detailed=true for full history with tool calls', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'cc-portal-api-2-'));
    const storage = new CLISessionStorage('./test-users');
    const manager = new ClaudeSessionManager(storage, { usersDir: './test-users' });
    const app = buildApp({ sessionManager: manager, storage });
    // Create session first
    const session = await manager.createSession({
      ownerId: 'test-user',
      path: testDir,
      bypassPermission: true,
    });

    const testSessionId = session.id;
    const projectHash = (ClaudeAgentBackend as any).calculateProjectHash(testDir);
    const claudeDir = join(homedir(), '.claude', 'projects', projectHash);
    const sessionFile = join(claudeDir, `${testSessionId}.jsonl`);

    // Create test session file with tool calls
    mkdirSync(claudeDir, { recursive: true });
    const testEntries = [
      {
        type: 'user',
        message: { role: 'user', content: 'Run ls' },
        uuid: 'msg-001',
        timestamp: '2026-02-27T10:00:00.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'tool_use',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        uuid: 'tool-001',
        timestamp: '2026-02-27T10:00:01.000Z',
        sessionId: testSessionId,
      },
      {
        type: 'tool_result',
        tool_output: { content: 'file1.txt' },
        uuid: 'tool-result-001',
        timestamp: '2026-02-27T10:00:02.000Z',
        sessionId: testSessionId,
      },
    ];
    writeFileSync(sessionFile, testEntries.map(e => JSON.stringify(e)).join('\n'));

    try {
      // detailed=true - should include tool entries
      const detailedResponse = await app.inject({
        method: 'GET',
        url: `/sessions/${testSessionId}/messages?detailed=true`,
        headers: { 'x-user-id': 'test-user' },
      });

      expect(detailedResponse.statusCode).toBe(200);
      const detailedBody = JSON.parse(detailedResponse.body);
      expect(detailedBody.source).toBe('cli');
      expect(detailedBody.detailed).toBe(true);
      // Should include all entries including tool_use and tool_result
      expect(detailedBody.count).toBe(3);

    } finally {
      // Cleanup
      if (existsSync(sessionFile)) {
        rmSync(sessionFile);
      }
      manager.deleteSession(testSessionId, 'test-user');
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
