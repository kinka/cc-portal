import { mkdir, access, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from './logger';

const log = createLogger({ module: 'UserMemory' });

export interface UserMemoryOptions {
  usersDir: string;
  templateDir?: string;
}

/**
 * 用户长期记忆初始化器
 * 
 * 负责为每个用户自动创建记忆系统所需的文件：
 * - CLAUDE.md: 指导 Claude 如何管理记忆
 * - kernel.md: 用户内核文件
 * - conversations/: 对话历史目录
 */
export class UserMemoryInitializer {
  private usersDir: string;
  private templateDir: string;

  constructor(options: UserMemoryOptions) {
    this.usersDir = options.usersDir;
    this.templateDir = options.templateDir || join(dirname(__dirname), 'templates');
  }

  /**
   * 确保用户的记忆系统已初始化
   * 如果文件不存在，从模板创建
   */
  async ensureUserMemory(userId: string): Promise<void> {
    const userDir = join(this.usersDir, userId);
    
    // 确保目录存在
    await mkdir(userDir, { recursive: true });
    await mkdir(join(userDir, 'conversations'), { recursive: true });
    
    // 检查并创建 CLAUDE.md
    const claudeMdPath = join(userDir, 'CLAUDE.md');
    const claudeMdExists = await this.fileExists(claudeMdPath);
    
    if (!claudeMdExists) {
      await this.createClaudeMd(userId, claudeMdPath);
      log.info({ userId }, 'Created CLAUDE.md for user');
    }
    
    // 检查并创建 kernel.md
    const kernelPath = join(userDir, 'kernel.md');
    const kernelExists = await this.fileExists(kernelPath);
    
    if (!kernelExists) {
      await this.createKernelMd(userId, kernelPath);
      log.info({ userId }, 'Created kernel.md for user');
    }
  }

  /**
   * 创建 CLAUDE.md 文件
   * 优先从模板复制，否则使用内建模板
   */
  private async createClaudeMd(userId: string, targetPath: string): Promise<void> {
    // 尝试从模板目录复制
    const templatePath = join(this.templateDir, 'CLAUDE.md.template');
    
    if (await this.fileExists(templatePath)) {
      // 复制模板并替换变量
      let content = await readFile(templatePath, 'utf-8');
      content = content.replace(/\{userId\}/g, userId);
      await writeFile(targetPath, content);
    } else {
      // 使用内建模板
      const defaultTemplate = this.getDefaultClaudeMdTemplate(userId);
      await writeFile(targetPath, defaultTemplate);
    }
  }

  /**
   * 创建 kernel.md 文件
   */
  private async createKernelMd(userId: string, targetPath: string): Promise<void> {
    const template = this.getDefaultKernelTemplate(userId);
    await writeFile(targetPath, template);
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 默认 CLAUDE.md 模板
   */
  private getDefaultClaudeMdTemplate(userId: string): string {
    return `# User Context: ${userId}

你是 Claude，一个拥有长期记忆能力的 AI 助手。你正在为用户 **${userId}** 提供服务。

## 你的记忆系统

你拥有一套自动记忆管理系统，所有记忆存储在当前目录：

| 文件/目录 | 用途 |
|-----------|------|
| \`kernel.md\` | 用户核心画像（习惯、偏好、技能等） |
| \`conversations/\` | 对话历史摘要 |

## 启动时自动执行

每次对话开始时，请执行：

\`\`\`
Read file: kernel.md
\`\`\`

了解用户画像后，调整你的回复风格。

## 对话中识别记忆

当用户说以下话时，记录到 \`kernel.md\`：

| 类型 | 信号 | 示例 | 更新位置 |
|------|------|------|----------|
| 习惯 | "我习惯..." | "我习惯早上 review 代码" | kernel.md - 日常习惯 |
| 偏好 | "我喜欢..." | "我喜欢用单引号" | kernel.md - 偏好设置 |
| 技能 | "我精通..." | "最近在学 Rust" | kernel.md - 技能标签 |
| 目标 | "我计划..." | "下个月发布 MVP" | kernel.md - 重要上下文 |
| 关系 | "我和 XXX..." | "我和 user-b 合作" | kernel.md - 关系网络 |

## 记忆更新流程

1. **判断重要性** - 持久信息才记录
2. **分类** - 确定属于哪个章节
3. **更新** - 使用 \`Edit file: kernel.md\`
4. **告知** - 简要说明已记录

## 对话结束时

生成摘要并保存：

\`\`\`
Write file: conversations/YYYY-MM-DD.md
\`\`\`

内容包括：主题、关键决策、新记忆、后续行动。

## 使用原生工具

- \`Read file: kernel.md\` - 读取用户画像
- \`Edit file: kernel.md\` - 更新特定章节
- \`Write file: conversations/...\` - 创建对话记录
- \`Glob pattern: conversations/*.md\` - 列出历史
- \`Grep pattern: ...\` - 搜索关键词

## 记忆原则

✅ **应该做的**：
- 主动识别记忆点
- 简洁记录（bullet point）
- 分类存放
- 用删除线标记过时信息

❌ **不应该做的**：
- 记录临时信息（"我今天很忙"）
- 记录敏感信息（密码、密钥）
- 过度记录（每次 1-3 点即可）
- 删除旧信息

---

## 当前任务

请立即执行：
1. Read file: kernel.md
2. 基于用户画像开始服务
`;
  }

  /**
   * 默认 kernel.md 模板
   */
  private getDefaultKernelTemplate(userId: string): string {
    return `# User Kernel: ${userId}

> 最后更新: ${new Date().toISOString().split('T')[0]} 00:00:00
> 维护者: Claude AI

---

## 基础画像

- **身份**: 待了解
- **专业领域**: 待了解
- **工作模式**: 待观察

---

## 日常习惯

- 待观察记录...

---

## 技能标签

- **精通**: 待填写
- **熟练**: 待填写
- **学习ing**: 待填写

---

## 偏好设置

- 代码风格: 待了解
- 通信方式: 直接、简洁
- 反馈风格: 待了解

---

## 重要上下文

### 当前项目
- 待填写

### 技术债务
- 待填写

### 近期目标
- 待填写

---

## 关系网络

- 待填写

---

*新用户内核，等待 Claude 填充...*
`;
  }

  /**
   * 获取用户目录路径
   */
  getUserDir(userId: string): string {
    return join(this.usersDir, userId);
  }
}
