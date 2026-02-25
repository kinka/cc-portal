import { mkdir, readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger';

const log = createLogger({ module: 'MemoryManager' });

export interface KernelData {
  userId: string;
  lastUpdated: string;
  profile: {
    identity?: string;
    expertise?: string[];
    workMode?: string;
  };
  habits: string[];
  skills: {
    master?: string[];
    proficient?: string[];
    learning?: string[];
  };
  preferences: Record<string, string>;
  context: {
    currentProject?: string;
    techDebt?: string;
    recentGoals?: string[];
  };
  relationships?: Record<string, string>;
}

export interface ConversationSummary {
  date: string;
  sessions: Array<{
    sessionId: string;
    startTime: string;
    endTime?: string;
    topic: string;
    keyDecisions: string[];
    newMemories: string[];
  }>;
}

export class MemoryManager {
  private basePath: string;

  constructor(basePath: string = './memory') {
    this.basePath = basePath;
  }

  private getUserDir(userId: string): string {
    // Sanitize userId to prevent path traversal
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.basePath, safeUserId);
  }

  private async ensureUserDir(userId: string): Promise<string> {
    const userDir = this.getUserDir(userId);
    await mkdir(userDir, { recursive: true });
    await mkdir(join(userDir, 'conversations'), { recursive: true });
    await mkdir(join(userDir, 'working'), { recursive: true });
    return userDir;
  }

  /**
   * 读取用户内核文件
   * 如果不存在，基于模板创建
   */
  async readKernel(userId: string): Promise<string> {
    const userDir = await this.ensureUserDir(userId);
    const kernelPath = join(userDir, 'kernel.md');

    try {
      await access(kernelPath);
      const content = await readFile(kernelPath, 'utf-8');
      log.debug({ userId }, 'Kernel file read');
      return content;
    } catch {
      // File doesn't exist, create from template
      const template = await this.getKernelTemplate();
      const content = template.replace(/\{userId\}/g, userId);
      await writeFile(kernelPath, content);
      log.info({ userId }, 'Kernel file created from template');
      return content;
    }
  }

  /**
   * 更新内核文件的特定部分
   * 使用 Claude 生成的 Markdown 内容
   */
  async updateKernelSection(
    userId: string,
    section: string,
    content: string,
    append: boolean = false
  ): Promise<void> {
    const userDir = await this.ensureUserDir(userId);
    const kernelPath = join(userDir, 'kernel.md');

    let kernel = await this.readKernel(userId);

    // Update timestamp
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    kernel = kernel.replace(
      />&#160;最后更新:.*$/m,
      `> 最后更新: ${now}`
    );

    // Find or create section
    const sectionRegex = new RegExp(`## ${section}\\b`, 'i');
    if (sectionRegex.test(kernel)) {
      // Section exists, update it
      const sectionStart = kernel.search(sectionRegex);
      const afterSection = kernel.slice(sectionStart + 1);
      const nextSectionMatch = afterSection.match(/^## /m);
      const nextSection = nextSectionMatch ? sectionStart + 1 + nextSectionMatch.index! : -1;
      const endPos = nextSection === -1 ? kernel.length : nextSection;

      if (append) {
        // Append new content
        const existingContent = kernel.slice(sectionStart, endPos);
        const updatedSection = existingContent + '\n' + content;
        kernel = kernel.slice(0, sectionStart) + updatedSection + kernel.slice(endPos);
      } else {
        // Replace section content
        const sectionHeader = kernel.match(sectionRegex)?.[0] || `## ${section}`;
        kernel =
          kernel.slice(0, sectionStart) +
          sectionHeader + '\n\n' + content +
          kernel.slice(endPos);
      }
    } else {
      // Section doesn't exist, append to end
      kernel = kernel.trim() + `\n\n## ${section}\n\n${content}`;
    }

    await writeFile(kernelPath, kernel);
    log.info({ userId, section }, 'Kernel section updated');
  }

  /**
   * 追加单条记忆项
   */
  async appendMemory(
    userId: string,
    category: 'habits' | 'skills' | 'preferences' | 'context',
    memory: string
  ): Promise<void> {
    const formatted = `- ${memory}`;
    await this.updateKernelSection(userId, this.getSectionName(category), formatted, true);
  }

  private getSectionName(category: string): string {
    const mapping: Record<string, string> = {
      habits: '日常习惯',
      skills: '技能标签',
      preferences: '偏好设置',
      context: '重要上下文',
      profile: '基础画像',
      relationships: '关系网络',
    };
    return mapping[category] || category;
  }

  /**
   * 记录对话摘要
   */
  async appendConversationSummary(
    userId: string,
    sessionId: string,
    summary: {
      topic: string;
      keyDecisions: string[];
      newMemories: string[];
    }
  ): Promise<void> {
    const userDir = await this.ensureUserDir(userId);
    const today = new Date().toISOString().split('T')[0];
    const convPath = join(userDir, 'conversations', `${today}.md`);

    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const entry = `
## Session ${sessionId.slice(0, 8)} (${now})

**主题**: ${summary.topic}

**关键决策**:
${summary.keyDecisions.map(d => `- ${d}`).join('\n') || '- 无'}

**新增记忆**:
${summary.newMemories.map(m => `- ${m}`).join('\n') || '- 无'}

---
`;

    try {
      const existing = await readFile(convPath, 'utf-8');
      await writeFile(convPath, existing + entry);
    } catch {
      // File doesn't exist, create new
      const header = `# ${today} 对话记录\n\n> 用户: ${userId}\n\n`;
      await writeFile(convPath, header + entry);
    }

    log.debug({ userId, sessionId }, 'Conversation summary appended');
  }

  /**
   * 读取近期对话（用于归纳总结）
   */
  async getRecentConversations(userId: string, days: number = 7): Promise<string[]> {
    const userDir = this.getUserDir(userId);
    const convDir = join(userDir, 'conversations');

    try {
      const files = await readdir(convDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      // Sort by date (filename is YYYY-MM-DD.md)
      mdFiles.sort().reverse();

      const recentFiles = mdFiles.slice(0, days);
      const contents: string[] = [];

      for (const file of recentFiles) {
        const content = await readFile(join(convDir, file), 'utf-8');
        contents.push(content);
      }

      return contents;
    } catch {
      return [];
    }
  }

  /**
   * 生成用于 System Prompt 的内核摘要
   * 提取关键信息，控制 token 使用
   */
  async getKernelPrompt(userId: string, maxLength: number = 2000): Promise<string> {
    const kernel = await this.readKernel(userId);

    // Parse and extract key sections
    const sections = this.parseKernel(kernel);

    // Build concise prompt
    let prompt = `## 用户画像\n\n`;

    if (sections.profile) {
      prompt += `${sections.profile}\n\n`;
    }

    const habits = sections.habits;
    const skills = sections.skills;
    
    if (Array.isArray(habits) && habits.length > 0) {
      prompt += `**习惯**: ${habits.slice(0, 5).join(', ')}\n`;
    }

    if (Array.isArray(skills) && skills.length > 0) {
      prompt += `**技能**: ${skills.slice(0, 5).join(', ')}\n`;
    }

    if (sections.context) {
      prompt += `\n**当前上下文**:\n${sections.context}\n`;
    }

    if (prompt.length > maxLength) {
      prompt = prompt.slice(0, maxLength) + '\n...';
    }

    return prompt;
  }

  private parseKernel(kernel: string): Record<string, string | string[]> {
    const sections: Record<string, string | string[]> = {};

    // Extract sections by regex
    const profileMatch = kernel.match(/## 基础画像\n+([\s\S]*?)(?=\n## |$)/);
    if (profileMatch) {
      sections.profile = profileMatch[1].trim();
    }

    const habitsMatch = kernel.match(/## 日常习惯\n+([\s\S]*?)(?=\n## |$)/);
    if (habitsMatch) {
      sections.habits = habitsMatch[1]
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim());
    }

    const skillsMatch = kernel.match(/## 技能标签\n+([\s\S]*?)(?=\n## |$)/);
    if (skillsMatch) {
      sections.skills = skillsMatch[1]
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim());
    }

    const contextMatch = kernel.match(/## 重要上下文\n+([\s\S]*?)(?=\n## |$)/);
    if (contextMatch) {
      sections.context = contextMatch[1].trim();
    }

    return sections;
  }

  /**
   * 获取内核模板
   */
  private async getKernelTemplate(): Promise<string> {
    const defaultTemplate = `# User Kernel: {userId}

> 最后更新: ${new Date().toISOString().split('T')[0]} 00:00:00
> 由 Claude 自动维护

## 基础画像

- **身份**: 待填写
- **专业领域**: 待填写
- **工作模式**: 待填写

## 日常习惯

- 待观察记录

## 技能标签

- **精通**: 待填写
- **熟练**: 待填写
- **学习ing**: 待填写

## 偏好设置

- 代码风格: 待填写
- 通信方式: 直接、简洁
- 反馈风格: 待填写

## 重要上下文

- 当前项目: 待填写
- 技术债务: 待填写
- 近期目标: 待填写

## 关系网络

- 待填写
`;

    try {
      const templatePath = join(this.basePath, '.template.md');
      await access(templatePath);
      return await readFile(templatePath, 'utf-8');
    } catch {
      return defaultTemplate;
    }
  }

  /**
   * 深度洞察生成（由 Claude 调用）
   * 分析近期对话，更新内核的深层洞察
   */
  async generateInsights(userId: string): Promise<string> {
    const conversations = await this.getRecentConversations(userId, 30);

    if (conversations.length === 0) {
      return 'No recent conversations to analyze.';
    }

    // Combine conversations for analysis
    const combined = conversations.join('\n\n---\n\n');

    // This will be processed by Claude to generate insights
    const prompt = `
基于以下近期对话记录，总结用户的关键模式:

${combined.slice(0, 8000)}

请生成:
1. 行为模式（如工作习惯、决策风格）
2. 技能发展趋势
3. 优先事项变化
4. 建议记住的关键点

以 Markdown 格式返回。
`;

    return prompt;
  }
}
