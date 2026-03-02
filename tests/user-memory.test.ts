/**
 * 用户 Memory 系统自动化测试
 *
 * 测试目标：确保为每个用户自动创建 Claude Code memory 系统
 * 包括：
 * - 用户目录自动创建
 * - CLAUDE.md 自动生成（指导 Claude 管理记忆）
 * - kernel.md 自动生成（用户内核文件）
 * - conversations 目录自动创建
 * - 与 Claude Code auto memory 集成
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { UserMemoryInitializer } from '../src/UserMemoryInitializer';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

describe('UserMemoryInitializer', () => {
  let testBaseDir: string;
  let usersDir: string;
  let initializer: UserMemoryInitializer;

  beforeEach(() => {
    // 创建临时测试目录
    testBaseDir = mkdtempSync(join(tmpdir(), 'cc-portal-memory-test-'));
    usersDir = join(testBaseDir, 'users');
    mkdirSync(usersDir, { recursive: true });

    initializer = new UserMemoryInitializer({
      usersDir,
      templateDir: join(__dirname, '../templates'),
    });
  });

  afterEach(() => {
    // 清理测试文件
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe('ensureUserMemory', () => {
    test('should create user directory and memory files for new user', async () => {
      const userId = 'test-user-alice';

      await initializer.ensureUserMemory(userId);

      const userDir = join(usersDir, userId);
      expect(existsSync(userDir)).toBe(true);
      expect(existsSync(join(userDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(userDir, 'kernel.md'))).toBe(true);
      expect(existsSync(join(userDir, 'conversations'))).toBe(true);
    });

    test('should be idempotent - not overwrite existing files', async () => {
      const userId = 'test-user-bob';
      const userDir = join(usersDir, userId);

      // 首次创建
      await initializer.ensureUserMemory(userId);

      // 读取初始内容
      const initialClaudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();
      const initialKernelMd = readFileSync(join(userDir, 'kernel.md')).toString();

      // 等待一小段时间
      await new Promise(resolve => setTimeout(resolve, 10));

      // 再次调用
      await initializer.ensureUserMemory(userId);

      // 内容应该不变
      expect(readFileSync(join(userDir, 'CLAUDE.md')).toString()).toBe(initialClaudeMd);
      expect(readFileSync(join(userDir, 'kernel.md')).toString()).toBe(initialKernelMd);
    });

    test('should create files with correct content structure', async () => {
      const userId = 'test-user-charlie';

      await initializer.ensureUserMemory(userId);

      const userDir = join(usersDir, userId);

      // 验证 CLAUDE.md 内容
      const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();
      expect(claudeMd).toContain(userId);
      expect(claudeMd).toContain('kernel.md');
      expect(claudeMd).toContain('conversations');
      expect(claudeMd).toContain('Read file: kernel.md');

      // 验证 kernel.md 内容
      const kernelMd = readFileSync(join(userDir, 'kernel.md')).toString();
      expect(kernelMd).toContain(userId);
      expect(kernelMd).toContain('基础画像');
      expect(kernelMd).toContain('日常习惯');
      expect(kernelMd).toContain('技能标签');
    });
  });

  describe('getUserDir', () => {
    test('should return correct path for user directory', () => {
      const userId = 'test-user-dave';
      const expectedPath = join(usersDir, userId);

      expect(initializer.getUserDir(userId)).toBe(expectedPath);
    });

    test('should handle special characters in userId', () => {
      const userId = 'user-with-special_chars.test';
      const expectedPath = join(usersDir, userId);

      expect(initializer.getUserDir(userId)).toBe(expectedPath);
    });
  });

  describe('multiple users', () => {
    test('should create independent memory systems for multiple users', async () => {
      const users = ['user-a', 'user-b', 'user-c'];

      // 为每个用户初始化
      for (const user of users) {
        await initializer.ensureUserMemory(user);
      }

      // 验证每个用户都有独立的记忆系统
      for (const user of users) {
        const userDir = join(usersDir, user);
        expect(existsSync(userDir)).toBe(true);
        expect(existsSync(join(userDir, 'CLAUDE.md'))).toBe(true);
        expect(existsSync(join(userDir, 'kernel.md'))).toBe(true);

        // 验证 CLAUDE.md 包含正确的 userId
        const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();
        expect(claudeMd).toContain(user);
      }
    });

    test('should not affect other users when one user is updated', async () => {
      const user1 = 'user-1';
      const user2 = 'user-2';

      await initializer.ensureUserMemory(user1);
      await initializer.ensureUserMemory(user2);

      const user1Dir = join(usersDir, user1);
      const user2Dir = join(usersDir, user2);

      const user1InitialContent = readFileSync(join(user1Dir, 'CLAUDE.md')).toString();

      // 再次初始化 user2
      await initializer.ensureUserMemory(user2);

      // user1 的内容应该不受影响
      const user1NewContent = readFileSync(join(user1Dir, 'CLAUDE.md')).toString();
      expect(user1InitialContent).toBe(user1NewContent);
    });
  });

  describe('file permissions and structure', () => {
    test('conversations directory should be empty initially', async () => {
      const userId = 'test-user-eve';

      await initializer.ensureUserMemory(userId);

      const conversationsDir = join(usersDir, userId, 'conversations');
      const files = readdirSync(conversationsDir);
      expect(files.length).toBe(0);
    });

    test('should create valid markdown files', async () => {
      const userId = 'test-user-frank';

      await initializer.ensureUserMemory(userId);

      const userDir = join(usersDir, userId);

      // 验证 markdown 语法基本正确
      const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();
      expect(claudeMd).toMatch(/^#.+/m); // 有标题
      expect(claudeMd).toContain('##'); // 有二级标题

      const kernelMd = readFileSync(join(userDir, 'kernel.md')).toString();
      expect(kernelMd).toMatch(/^#.+/m);
      expect(kernelMd).toContain('---'); // 有分隔线
    });
  });
});

describe('UserMemory with Claude Code Auto Memory Integration', () => {
  let testBaseDir: string;
  let usersDir: string;
  let initializer: UserMemoryInitializer;

  beforeEach(() => {
    testBaseDir = mkdtempSync(join(tmpdir(), 'cc-portal-claude-memory-'));
    usersDir = join(testBaseDir, 'users');
    mkdirSync(usersDir, { recursive: true });

    initializer = new UserMemoryInitializer({
      usersDir,
      templateDir: join(__dirname, '../templates'),
    });
  });

  afterEach(() => {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  test('CLAUDE.md should instruct Claude to use native file tools', async () => {
    const userId = 'claude-integration-user';

    await initializer.ensureUserMemory(userId);

    const userDir = join(usersDir, userId);
    const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();

    // 验证 Claude 被指导使用原生工具
    expect(claudeMd).toContain('Read file');
    expect(claudeMd).toContain('Edit file');
    expect(claudeMd).toContain('Write file');
    expect(claudeMd).toContain('Glob pattern');
    expect(claudeMd).toContain('Grep pattern');
  });

  test('CLAUDE.md should define memory signals', async () => {
    const userId = 'memory-signal-user';

    await initializer.ensureUserMemory(userId);

    const userDir = join(usersDir, userId);
    const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();

    // 验证记忆信号类型
    expect(claudeMd).toContain('习惯');
    expect(claudeMd).toContain('偏好');
    expect(claudeMd).toContain('技能');
    expect(claudeMd).toContain('目标');
    expect(claudeMd).toContain('关系');
  });

  test('kernel.md should have sections for all memory types', async () => {
    const userId = 'kernel-sections-user';

    await initializer.ensureUserMemory(userId);

    const userDir = join(usersDir, userId);
    const kernelMd = readFileSync(join(userDir, 'kernel.md')).toString();

    // 验证所有记忆分类章节
    expect(kernelMd).toContain('日常习惯');
    expect(kernelMd).toContain('技能标签');
    expect(kernelMd).toContain('偏好设置');
    expect(kernelMd).toContain('重要上下文');
    expect(kernelMd).toContain('关系网络');
  });

  test('should support conversation summary storage', async () => {
    const userId = 'conversation-user';

    await initializer.ensureUserMemory(userId);

    const userDir = join(usersDir, userId);
    const claudeMd = readFileSync(join(userDir, 'CLAUDE.md')).toString();

    // 验证对话摘要指导
    expect(claudeMd).toContain('conversations/');
    expect(claudeMd).toContain('YYYY-MM-DD.md');
    expect(claudeMd).toContain('对话结束时');
    expect(claudeMd).toContain('生成摘要');
  });
});
