# 长期记忆使用指南

## 快速开始

### 1. 查看当前内核

```bash
curl -H "X-User-ID: demo-user" \
  http://localhost:3333/users/demo-user/kernel
```

### 2. 获取用于 System Prompt 的摘要

```bash
curl -H "X-User-ID: demo-user" \
  http://localhost:3333/users/demo-user/kernel/prompt
```

### 3. 更新内核

```bash
curl -X POST \
  -H "X-User-ID: demo-user" \
  -H "Content-Type: application/json" \
  -d '{
    "section": "技能标签",
    "content": "- **精通**: TypeScript, Rust\n- **学习ing**: Go, 微服务",
    "append": false
  }' \
  http://localhost:3333/users/demo-user/kernel/update
```

### 4. 添加单条记忆

```bash
curl -X POST \
  -H "X-User-ID: demo-user" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "habits",
    "memory": "喜欢在晚上 10 点后 review 代码"
  }' \
  http://localhost:3333/users/demo-user/memory
```

### 5. 记录对话摘要

```bash
curl -X POST \
  -H "X-User-ID: demo-user" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "设计长期记忆方案",
    "keyDecisions": ["使用 Markdown 而非数据库", "让 Claude 主动管理记忆"],
    "newMemories": ["用户偏好: 不要数据库，用文件", "设计哲学: 透明、人类可读"]
  }' \
  http://localhost:3333/sessions/xxx/summarize
```

## MCP Server 配置

在 `claude_desktop_config.json` 中添加:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp-server.js"],
      "env": {
        "API_BASE": "http://localhost:3333",
        "DEFAULT_USER_ID": "demo-user"
      }
    }
  }
}
```

## System Prompt 注入

在 ClaudeSession 中集成:

```typescript
class ClaudeSession {
  private memoryManager: MemoryManager;
  private userId: string;

  async initialize() {
    // 加载用户内核
    const kernelPrompt = await this.memoryManager.getKernelPrompt(this.userId);
    
    // 注入到 system prompt
    this.systemPrompt = `
You are Claude, an AI assistant with long-term memory.

${kernelPrompt}

## Memory Management Instructions

You have access to the user's kernel file which contains their habits, 
preferences, and skills. During conversation:

1. Use the kernel information to personalize your responses
2. Identify new information worth remembering
3. Proactively update the kernel using available tools

When you notice:
- A new habit ("我以后都用 Bun 了")
- A new skill ("最近在学 Rust")
- A preference change ("我喜欢简洁的代码")
- An important goal ("下个月要发布 MVP")

Use the update_kernel tool to record it.
    `;
  }
}
```

## 内核文件结构

```markdown
# User Kernel: {userId}

> 最后更新: 2025-02-25 16:30:00
> 由 Claude 自动维护

## 基础画像

- **身份**: 全栈工程师
- **专业领域**: TypeScript, React
- **工作模式**: 偏好简洁代码

## 日常习惯

- 上午 9-11 点最高效
- 习惯先写测试再实现

## 技能标签

- **精通**: TypeScript, React
- **熟练**: Python
- **学习ing**: Rust

## 偏好设置

| 类别 | 偏好 |
|------|------|
| 代码风格 | 2空格缩进 |
| 通信方式 | 直接、简洁 |

## 重要上下文

- 当前项目: cc-agents
- 近期目标: 完成长期记忆功能

## 关系网络

- **user-b**: 前端专家
```

## 工作流示例

### 场景: 用户提到新习惯

**用户**: "我习惯早上先 review 昨天的代码再开始新工作"

**Claude**: (识别为重要习惯)

```
检测到新的日常习惯，正在更新内核...
```

**内核更新**:
```markdown
## 日常习惯

- 上午 9-11 点最高效
- 习惯先写测试再实现
- **早上先 review 昨天的代码再开始新工作** ← 新增
```

### 场景: 利用记忆个性化回复

**用户**: "帮我看看这个函数怎么优化"

**Claude**: (读取内核 - 知道用户偏好简洁代码和函数式风格)

```
基于你对简洁代码和函数式编程的偏好，我建议:

1. 使用函数组合替代复杂的 if-else
2. 提取纯函数，减少副作用
3. 示例:

// 优化前
function process(data) {
  if (data.valid) {
    return transform(data);
  }
  return null;
}

// 优化后（更符合你的风格）
const process = (data) => 
  data.valid ? transform(data) : null;
```

## 最佳实践

### 1. 定期 Review

建议用户每季度 review 一次 kernel.md:
```bash
# 查看当前内核
cat memory/demo-user/kernel.md

# 手动编辑修正
vim memory/demo-user/kernel.md
```

### 2. 隐私控制

用户可以:
- 直接编辑 kernel.md 删除敏感信息
- 设置某些信息为"不记录"
- 完全禁用长期记忆功能

### 3. 备份与迁移

内核文件是纯 Markdown，易于:
- 版本控制 (git)
- 备份 (rsync, cloud storage)
- 迁移 (直接复制文件)

### 4. 与其他系统集成

可以通过 API 读取内核，用于:
- 个性化推荐系统
- 团队协作画像
- 技能匹配
- 项目分配优化

## API 参考

### GET /users/:userId/kernel
读取完整内核内容

### GET /users/:userId/kernel/prompt?maxLength=2000
获取用于 System Prompt 的摘要

### POST /users/:userId/kernel/update
更新内核特定部分

Body:
```json
{
  "section": "技能标签",
  "content": "- TypeScript\n- Rust",
  "append": false
}
```

### POST /users/:userId/memory
添加单条记忆

Body:
```json
{
  "category": "habits",
  "memory": "喜欢在晚上 review 代码"
}
```

### GET /users/:userId/conversations?days=7
获取近期对话历史

### POST /sessions/:sessionId/summarize
总结会话并更新记忆

Body:
```json
{
  "topic": "讨论主题",
  "keyDecisions": ["决策1", "决策2"],
  "newMemories": ["新记忆1", "新记忆2"]
}
```
