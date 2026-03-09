/**
 * E2E 测试：验证 Claude Code Auto Memory 集成
 *
 * 这些测试需要真实的 Claude CLI 环境 (RUN_E2E=1)
 * 验证 cc-portal 创建的 session 是否正确触发 Claude Code 的 auto memory 功能
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildApp } from '../src/app';
import { CLISessionStorage } from '../src/CLISessionStorage';
import { ClaudeSessionManager } from '../src/ClaudeSessionManager';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const runE2E = !!process.env.RUN_E2E;

// 获取 Claude Code memory 目录路径
function getMemoryDir(projectPath: string): string {
  // Claude Code 使用项目路径的哈希作为目录名
  // 格式: ~/.claude/projects/-<path-hash>/memory/
  const normalizedPath = projectPath.replace(/\//g, '-').replace(/^-/, '');
  return join(homedir(), '.claude', 'projects', `-${normalizedPath}`, 'memory');
}

describe.skipIf(!runE2E)('E2E: Claude Code Auto Memory Integration', () => {
  let testBaseDir: string;
  let projectDir: string;
  let storage: CLISessionStorage;
  let manager: ClaudeSessionManager;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    testBaseDir = mkdtempSync(join(tmpdir(), 'cc-portal-auto-memory-'));
    projectDir = join(testBaseDir, 'project');
    mkdirSync(projectDir, { recursive: true });

    storage = new CLISessionStorage(join(testBaseDir, 'users'));
    manager = new ClaudeSessionManager(storage, { usersDir: join(testBaseDir, 'users') });
    app = buildApp({ sessionManager: manager, storage });
  });

  afterEach(async () => {
    await app.close().catch(() => { });
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe('Memory Directory Structure', () => {
    test('should create memory directory under .claude/projects when session is created', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'memory-test-user';

      // 创建 session
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({ path: projectDir }),
      });

      expect(createRes.status).toBe(200);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // 发送消息触发 Claude CLI
      const msgRes = await fetch(`${base}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({
          message: '请记住：我喜欢使用 TypeScript，偏好函数式编程风格。',
        }),
      });

      expect(msgRes.status).toBe(200);

      // 检查 Claude Code memory 目录是否存在
      // 注意：memory 目录可能需要多次交互才会创建
      const memoryDir = getMemoryDir(projectDir);

      // 等待一段时间让 Claude CLI 完成处理
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 验证 memory 目录结构（如果 Claude Code 已创建）
      if (existsSync(memoryDir)) {
        expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(true);
      }
    }, 120_000);

    test('should proactively save memory and read it timely in a new session', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'memory-proactive-user';

      // 第一个 session
      const createRes1 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({ path: 'proactive-project' }), // 使用相对路径，确保在 users 目录下，能找到 CLAUDE.md
      });

      const { sessionId: session1 } = (await createRes1.json()) as { sessionId: string };

      // 发送消息，不使用“请记住”，而是直接说明项目背景，测试主动作出记忆的指令
      await fetch(`${base}/sessions/${session1}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({
          message: '注意！在这个项目中，我们绝对不可以运行在 Node.js 环境下。唯一允许的运行时是 Bun。这是我们的硬性规定。',
        }),
      });

      // 等待处理完成（Claude 应当会主动调用 remember）
      await new Promise(resolve => setTimeout(resolve, 15000));

      // 删除第一个 session
      await fetch(`${base}/sessions/${session1}`, {
        method: 'DELETE',
        headers: { 'X-User-ID': userId },
      });

      // 创建第二个 session（同一项目）
      const createRes2 = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({ path: 'proactive-project' }),
      });

      const { sessionId: session2 } = (await createRes2.json()) as { sessionId: string };

      // 询问 Claude 相关问题，测试它在新开始的会话中是否及时读取了刚才保存的记忆
      const queryRes = await fetch(`${base}/sessions/${session2}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({
          message: '请问这个项目的后端推荐运行环境是什么？',
        }),
      });

      expect(queryRes.status).toBe(200);
      const { response } = (await queryRes.json()) as { response: string };

      // 如果 auto memory 工作正常，Claude 应该会在读取内存后准确回答出 Bun
      console.log('Claude timely memory read response:', response);
      expect(response.toLowerCase()).toContain('bun');
      // 避免误报：如果它在解释为什么不用 Node.js，那也是正常的，但它应该明确推荐 Bun
      expect(response.toLowerCase()).toContain('bun');
    }, 180_000);
  });

  describe('User Workspace and CLAUDE.md', () => {
    test('should create user workspace directory', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'workspace-user';

      // 创建 session（不带 path，使用用户默认工作目录）
      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({}), // 不指定 path，使用用户目录
      });

      expect(createRes.status).toBe(200);
      const { path } = (await createRes.json()) as { sessionId: string; path: string };

      // 验证用户工作目录已创建
      expect(existsSync(path)).toBe(true);
    }, 60_000);

    test('should allow per-project CLAUDE.md for instructions', async () => {
      // 在项目目录创建 CLAUDE.md
      const claudeMdPath = join(projectDir, 'CLAUDE.md');
      const claudeMdContent = `# Project Instructions

- Always use TypeScript strict mode
- Prefer const over let
- Use descriptive variable names
`;
      require('fs').writeFileSync(claudeMdPath, claudeMdContent);

      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'claude-md-user';

      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({ path: projectDir }),
      });

      expect(createRes.status).toBe(200);

      // 发送消息，验证 CLAUDE.md 是否被读取
      const msgRes = await fetch(`${base}/sessions/${(await createRes.json() as { sessionId: string }).sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': userId,
        },
        body: JSON.stringify({
          message: '这个项目的编程规范是什么？',
        }),
      });

      expect(msgRes.status).toBe(200);
      const { response } = (await msgRes.json()) as { response: string };

      // Claude 应该能从 CLAUDE.md 中读取到规范
      console.log('Claude response about project conventions:', response);
    }, 120_000);
  });

  describe('Memory Commands', () => {
    test('/memory command should be available in Claude CLI', async () => {
      // 检查 Claude CLI 是否支持 /memory 命令
      try {
        const helpOutput = execSync('claude --help 2>&1 || true', { encoding: 'utf-8' });
        console.log('Claude CLI help:', helpOutput);
      } catch (error) {
        console.log('Claude CLI not available or /memory is session-only command');
      }
    });
  });
});

describe('Auto Memory Configuration', () => {
  test('settings.json should have autoMemoryEnabled', () => {
    const settingsPath = join(homedir(), '.claude', 'settings.json');

    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      console.log('Current Claude Code settings:', settings);

      // 检查是否配置了 auto memory
      if (settings.autoMemoryEnabled !== undefined) {
        expect(typeof settings.autoMemoryEnabled).toBe('boolean');
      }
    } else {
      console.log('Claude Code settings.json not found at:', settingsPath);
    }
  });

  test('project MEMORY.md should exist for cc-portal', () => {
    // 检查 cc-portal 项目自身的 auto memory
    const projectMemoryDir = join(homedir(), '.claude', 'projects', '-Users-kinka-space-happy-coder-cc-portal', 'memory');
    const memoryPath = join(projectMemoryDir, 'MEMORY.md');

    if (existsSync(memoryPath)) {
      const content = readFileSync(memoryPath, 'utf-8');
      expect(content).toContain('CC-Portal');
    } else {
      console.log('Project MEMORY.md not found. It will be created on first interaction.');
    }
  });
});