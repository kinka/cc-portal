# 基于 CLAUDE.md 的自动记忆方案

## 核心思想

让 **Claude CLI 本身** 成为记忆的管理者：

1. 每个用户在 `users/{userId}/` 目录下有 `CLAUDE.md` 文件
2. 启动时，Claude CLI 自动读取该文件
3. `CLAUDE.md` 指导 Claude 如何识别和记录记忆
4. 通过 MCP Server 提供记忆读写工具
5. Claude 在对话中**主动**管理记忆

## 目录结构

```
users/
├── {userId}/
│   ├── CLAUDE.md          # 指导 Claude 如何管理记忆
│   ├── kernel.md          # 用户内核（自动维护）
│   └── conversations/     # 对话历史（自动归档）
│       └── 2025-02-25.md
```

## 工作流程

### 1. 用户启动会话

用户通过 cc-agents 创建 session：

```bash
curl -X POST http://localhost:3333/sessions \
  -H "X-User-ID: demo-user" \
  -d '{"path": ".", "mcpServers": {"memory": {...}}}'
```

### 2. Claude CLI 启动

cc-agents 启动 Claude CLI 进程，配置：
- 工作目录: `users/demo-user/`
- MCP Servers: 包含 memory-server

### 3. 自动加载 CLAUDE.md

Claude CLI 自动读取 `users/demo-user/CLAUDE.md`，其中包含：

```markdown
## 启动时自动执行

1. **读取当前内核**
   使用 read_kernel 工具读取 kernel.md

2. **了解用户画像**
   - 根据 kernel.md 调整回复风格
   - 记住用户的专业领域和技能水平
```

### 4. 对话中进行记忆管理

根据 CLAUDE.md 的指示，Claude：

- **识别记忆点**: 当用户说"我习惯..."、"我喜欢..."
- **主动更新**: 调用 `update_kernel_section` 工具
- **对话结束总结**: 调用 `append_conversation_summary` 生成摘要

### 5. 记忆持久化

所有记忆操作都写入文件：
- `kernel.md` - 更新用户画像
- `conversations/YYYY-MM-DD.md` - 追加对话摘要

## 组件说明

### 1. users/{userId}/CLAUDE.md

**作用**: 指导 Claude 如何管理记忆

**内容**:
- 启动时的自动执行指令
- 如何识别值得记录的信息
- 记忆更新流程
- 回复风格调整建议

**特点**:
- 用户可自定义
- 支持特定指令
- 与普通 CLAUDE.md 兼容

### 2. users/{userId}/kernel.md

**作用**: 存储用户的核心画像

**内容**:
- 基础画像（身份、专业领域）
- 日常习惯
- 技能标签
- 偏好设置
- 重要上下文
- 关系网络

**维护者**: Claude AI（自动更新）

### 3. mcp/memory-server.ts

**作用**: 为 Claude CLI 提供记忆管理工具

**提供的工具**:

| 工具名 | 功能 |
|--------|------|
| `read_kernel` | 读取 kernel.md |
| `update_kernel_section` | 更新特定章节 |
| `append_conversation_summary` | 追加对话摘要 |
| `search_conversations` | 搜索历史对话 |
| `get_kernel_prompt` | 获取精简版内核 |

## 配置方法

### 1. 准备用户目录

```bash
mkdir -p users/demo-user/conversations
```

### 2. 创建 CLAUDE.md

复制模板并根据需要调整：

```bash
cp docs/claude-memory-template.md users/demo-user/CLAUDE.md
```

### 3. 配置 MCP Server

在启动 session 时配置 MCP：

```typescript
const session = await manager.createSession({
  ownerId: 'demo-user',
  path: './users/demo-user',
  mcpServers: {
    memory: {
      command: 'bun',
      args: ['mcp/memory-server.ts'],
      env: { MEMORY_BASE_PATH: './users' }
    }
  }
});
```

### 4. 启动服务

```bash
bun run dev
```

### 5. 创建会话并测试

```bash
curl -X POST http://localhost:3333/sessions \
  -H "X-User-ID: demo-user" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "./users/demo-user",
    "mcpServers": {
      "memory": {
        "command": "bun",
        "args": ["mcp/memory-server.ts"],
        "env": {"MEMORY_BASE_PATH": "./users"}
      }
    }
  }'
```

## 使用示例

### 场景 1：记录新习惯

**对话过程**:

```
用户: 我发现我早上 9-11 点效率最高

Claude: 这是个很有价值的信息！我会记录下来。
      
      [调用 update_kernel_section]
      章节: "日常习惯"
      内容: "- 🌅 上午 9-11 点最高效"
      
      已记录到您的个人档案。
```

**结果** (`kernel.md`):

```markdown
## 日常习惯

- 🌅 上午 9-11 点最高效
- 📝 习惯先写测试再实现
```

### 场景 2：利用记忆个性化回复

**对话过程**:

```
用户: 帮我优化这个函数

Claude: [读取 kernel.md，发现用户偏好函数式编程]
      
      基于您对函数式编程的偏好，我建议：
      
      ```typescript
      // 使用函数组合
      const result = pipe(data, transform, filter);
      ```
```

### 场景 3：对话结束总结

**对话过程**:

```
用户: 好了，今天就到这里

Claude: 好的！让我为您总结一下今天的对话：
      
      **主题**: 设计长期记忆系统
      **关键决策**:
      1. 使用 Markdown 而非数据库
      2. 由 Claude 主动管理记忆
      
      **新发现的记忆**:
      - 您偏好简洁的架构设计
      - 您习惯在早上处理复杂问题
      
      [调用 append_conversation_summary]
      
      已更新到您的档案。明天见！
```

**结果** (`conversations/2025-02-25.md`):

```markdown
# 2025-02-25 对话记录

> 用户: demo-user

## 18:30

**主题**: 设计长期记忆系统

**要点**:
- 使用 Markdown 而非数据库
- 由 Claude 主动管理记忆

**新记忆**:
- 偏好简洁的架构设计
- 习惯在早上处理复杂问题
```

## 优势

### 1. 完全自动化
- 用户无需手动操作
- Claude 自动识别和记录
- 对话结束自动生成摘要

### 2. 透明可控
- 用户可以查看 kernel.md 知道记住了什么
- 可以直接编辑修正
- 可以随时禁用

### 3. 个性化体验
- 根据用户画像调整回复
- 记住用户的偏好和习惯
- 持续学习优化

### 4. 简单可扩展
- 纯 Markdown，易于理解和修改
- 支持自定义 CLAUDE.md
- 可以添加更多记忆维度

## 最佳实践

### 1. 定期 Review

建议用户每月查看一次 kernel.md：

```bash
cat users/demo-user/kernel.md
```

### 2. 隐私保护

用户可以在 CLAUDE.md 中设置隐私规则：

```markdown
## 隐私设置

不要记录以下信息：
- 具体的公司内部数据
- 敏感个人信息
- 临时性的抱怨或情绪
```

### 3. 备份

定期备份用户目录：

```bash
cp -r users/demo-user backups/demo-user-$(date +%Y%m%d)
```

### 4. 多用户支持

每个用户完全隔离：

```
users/
├── alice/
│   ├── CLAUDE.md
│   └── kernel.md
└── bob/
    ├── CLAUDE.md
    └── kernel.md
```

## 进阶用法

### 自定义记忆维度

在 CLAUDE.md 中添加自定义指令：

```markdown
## 额外记忆维度

除了基本信息，还请记录：

1. **健康状态**
   - 用户的精力水平
   - 工作压力情况

2. **学习进度**
   - 正在学习的技术
   - 遇到的难点

3. **项目状态**
   - 每个项目的当前阶段
   - 阻塞点
```

### 集成其他工具

在 CLAUDE.md 中集成其他 MCP 工具：

```markdown
## 工具集成

你可以使用以下工具：

1. **memory** - 管理长期记忆
2. **todo** - 管理待办事项
3. **calendar** - 查看日程安排

对话中根据需要使用这些工具。
```

## 故障排除

### 记忆没有更新

检查：
1. MCP Server 是否正常启动
2. CLAUDE.md 是否包含记忆管理指令
3. Claude 是否有权限写入文件

### 内核文件损坏

可以手动修复或重置：

```bash
# 备份
cp users/demo-user/kernel.md users/demo-user/kernel.md.bak

# 重置为模板
cp memory/.template.md users/demo-user/kernel.md
```

### MCP Server 连接失败

检查日志：

```bash
# 手动测试 MCP Server
MEMORY_BASE_PATH=./users bun mcp/memory-server.ts
```

## 与其他方案对比

| 方案 | 存储 | 自动化 | 透明度 | 复杂度 |
|------|------|--------|--------|--------|
| **本方案** | Markdown | 高 | 高 | 低 |
| 数据库存储 | SQLite | 中 | 中 | 中 |
| 向量数据库 | Pinecone | 高 | 低 | 高 |
| 外部服务 | 第三方 API | 高 | 低 | 低 |

## 未来扩展

1. **记忆归纳**: 定期让 Claude 分析对话历史，生成深度洞察
2. **跨用户记忆**: 团队协作时的共享上下文
3. **记忆迁移**: 导入/导出记忆文件
4. **版本控制**: 对 kernel.md 进行 git 版本控制
