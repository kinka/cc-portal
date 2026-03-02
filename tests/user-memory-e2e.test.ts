/**
 * E2E 测试：用户 Memory 系统与 Claude Code Auto Memory 集成
 *
 * 测试真实场景下，用户创建 session 时 memory 系统的自动初始化和使用
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildApp } from '../src/app';
import { DatabaseManager } from '../src/db';
import { ClaudeSessionManager } from '../src/ClaudeSessionManager';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runE2E = !!process.env.RUN_E2E;

describe('E2E: User Memory System Integration', () => {
  let testBaseDir: string;
  let usersDir: string;
  let db: DatabaseManager;
  let manager: ClaudeSessionManager;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    testBaseDir = mkdtempSync(join(tmpdir(), 'cc-portal-e2e-memory-'));
    usersDir = join(testBaseDir, 'users');

    db = new DatabaseManager(':memory:');
    manager = new ClaudeSessionManager(db, { usersDir });
    app = buildApp({ sessionManager: manager, db });
  });

  afterEach(async () => {
    await app.close().catch(() => {});
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe('HTTP API - User Memory (MemoryManager)', () => {
    test('GET /users/:userId/kernel should return kernel content (auto-create)', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'alice-e2e';

      // 读取 kernel（应该自动创建）
      const res = await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { kernel: string; userId: string };
      expect(body.userId).toBe(userId);
      expect(body.kernel).toContain('基础画像');

      // 验证文件已在 memory 目录创建（不是 usersDir）
      const memoryDir = join(process.cwd(), 'memory', userId);
      expect(existsSync(memoryDir)).toBe(true);
      expect(existsSync(join(memoryDir, 'kernel.md'))).toBe(true);
    });

    test('GET /users/:userId/kernel should return kernel content (auto-create)', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'bob-e2e';

      // 读取 kernel（应该自动创建）
      const res = await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { kernel: string; userId: string };
      expect(body.userId).toBe(userId);
      expect(body.kernel).toContain('基础画像');
    });

    test('POST /users/:userId/kernel/update should update kernel', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'charlie-e2e';

      // 先初始化 kernel（自动创建）
      await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });

      // 更新 kernel
      const updateRes = await fetch(`${base}/users/${userId}/kernel/update`, {
        method: 'POST',
        headers: {
          'X-User-ID': userId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          section: '技能标签',
          content: '- **精通**: TypeScript, Python\n- **熟练**: Rust, Go',
        }),
      });

      expect(updateRes.status).toBe(200);

      // 验证更新
      const getRes = await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });
      const body = await getRes.json() as { kernel: string };
      expect(body.kernel).toContain('TypeScript');
      expect(body.kernel).toContain('Python');
    });

    test('POST /users/:userId/memory should add memory', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'david-e2e';

      // 先初始化 kernel
      await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });

      // 添加记忆（使用正确的 body 格式）
      const res = await fetch(`${base}/users/${userId}/memory`, {
        method: 'POST',
        headers: {
          'X-User-ID': userId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          category: 'preferences',
          memory: '喜欢使用 2 空格缩进',
        }),
      });

      expect(res.status).toBe(200);
    });

    test('GET /users/:userId/conversations should list conversation history', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'eve-e2e';

      // 先初始化 kernel
      await fetch(`${base}/users/${userId}/kernel`, {
        headers: { 'X-User-ID': userId },
      });

      // 创建模拟对话历史（在 MemoryManager 的目录下）
      const memoryDir = join(process.cwd(), 'memory', userId, 'conversations');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, '2026-03-01.md'),
        '# Conversation 2026-03-01\n\n讨论了项目架构...'
      );

      const res = await fetch(`${base}/users/${userId}/conversations`, {
        headers: { 'X-User-ID': userId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { conversations: Array<{ file: string; date: string }> };
      expect(body.conversations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Session Creation with Memory', () => {
    test.skipIf(!runE2E)('should auto-initialize memory when creating session', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const userId = 'session-memory-user';
      const projectDir = mkdtempSync(join(tmpdir(), 'cc-portal-project-'));

      try {
        // 创建 session
        const createRes = await fetch(`${base}/sessions?userId=${userId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectDir }),
        });

        expect(createRes.status).toBe(200);

        // 验证用户 memory 已初始化
        const userDir = join(usersDir, userId);
        expect(existsSync(userDir)).toBe(true);
        expect(existsSync(join(userDir, 'CLAUDE.md'))).toBe(true);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('Multi-User Memory Isolation', () => {
    test('each user should have isolated memory', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server!.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const users = ['multi-user-a', 'multi-user-b'];

      // 为每个用户初始化 memory（通过读取 kernel 自动创建）
      for (const userId of users) {
        const res = await fetch(`${base}/users/${userId}/kernel`, {
          headers: { 'X-User-ID': userId },
        });
        expect(res.status).toBe(200);
      }

      // 验证每个用户的 memory 独立（MemoryManager 使用 ./memory 目录）
      for (const userId of users) {
        const memoryDir = join(process.cwd(), 'memory', userId);
        expect(existsSync(memoryDir)).toBe(true);

        // 读取 kernel 验证内容包含自己的 userId
        const kernelPath = join(memoryDir, 'kernel.md');
        const kernelContent = readFileSync(kernelPath).toString();
        expect(kernelContent).toContain(userId);

        // 确保不包含其他用户的 ID
        for (const otherUser of users) {
          if (otherUser !== userId) {
            expect(kernelContent).not.toContain(otherUser);
          }
        }
      }

      // 清理测试文件
      for (const userId of users) {
        const memoryDir = join(process.cwd(), 'memory', userId);
        if (existsSync(memoryDir)) {
          rmSync(memoryDir, { recursive: true, force: true });
        }
      }
    });
  });
});
