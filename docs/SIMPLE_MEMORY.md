# 简化版长期记忆方案

## 核心思想

**极简设计**：完全利用 Claude CLI 的原生能力，无需任何额外组件。

```
用户启动 session → Claude CLI 自动读取 CLAUDE.md → 按提示词管理记忆

                  (无需 MCP Server，无需额外进程)
```

## 目录结构

```
users/
└── {userId}/
    ├── CLAUDE.md          # 指导 Claude 如何管理记忆
    ├── kernel.md          # 用户内核（由 Claude 自动维护）
    └── conversations/     # 对话历史（由 Claude 自动归档）
        └── 2025-02-25.md
```

## 工作流程

### 1. 启动时自动执行

当 cc-agents 为用户创建 session 时：

```typescript
const session = await manager.createSession({
  ownerId: 'demo-user',
  path: './users/demo-user',  // 工作目录设为 users/demo-user/
});
```

Claude CLI 启动后会**自动读取** `CLAUDE.md`。

### 2. CLAUDE.md 指导记忆管理

`CLAUDE.md` 中包含完整的指令，告诉 Claude：

1. **启动时**：读取 `kernel.md` 了解用户
2. **对话中**：识别值得记录的信息
3. **更新时**：使用 `Edit` 工具修改 `kernel.md`
4. **结束时**：使用 `Write` 工具生成对话摘要

### 3. 使用原生工具

Claude 使用内置的文件工具管理记忆：

| 工具 | 用途 |
|------|------|
| `Read file: kernel.md` | 读取用户画像 |
| `Edit file: kernel.md` | 更新特定章节 |
| `Write file: conversations/...` | 创建对话摘要 |
| `Glob pattern: ...` | 列出历史对话 |
| `Grep pattern: ...` | 搜索关键词 |

## 配置方法

### 1. 准备用户目录

```bash
mkdir -p users/demo-user/conversations
```

### 2. 创建 CLAUDE.md

复制模板：

```bash
cp users/demo-user/CLAUDE.md users/alice/CLAUDE.md
```

或手动创建，包含以下内容：

```markdown
# User Context: {userId}

你是 Claude，拥有长期记忆能力。

## 启动时执行

1. Read file: kernel.md
2. 根据画像调整回复风格

## 记忆管理

当识别到以下信息时，更新 kernel.md：
- 习惯："我习惯..."
- 偏好："我喜欢..."
- 技能："我精通..."
- 目标："我计划..."

## 对话结束时

生成摘要并写入 conversations/YYYY-MM-DD.md
```

### 3. 创建空 kernel.md（可选）

如果不存在，Claude 会在首次读取时提示创建。

### 4. 启动服务

```bash
bun run dev
```

### 5. 创建会话

```bash
curl -X POST http://localhost:3333/sessions \
  -H "X-User-ID: demo-user" \
  -H "Content-Type: application/json" \
  -d '{"path": "./users/demo-user"}'
```

## 使用示例

### 场景 1：记录新习惯

**对话过程**：

```
用户: 我发现我早上 9-11 点效率最高

Claude: 这是个很有价值的信息！我会记录下来。
      
      [执行: Edit file: kernel.md]
      在 "## 日常习惯" 章节添加:
      "- 🌅 上午 9-11 点最高效"
      
      已记录到您的个人档案。
```

### 场景 2：利用记忆个性化回复

```
用户: 帮我看看这个函数怎么优化

Claude: [之前已读取 kernel.md，知道用户偏好函数式编程]
      
      基于您对函数式编程的偏好，我建议：
      ```typescript
      const result = pipe(data, transform, filter);
      ```
```

### 场景 3：对话结束总结

```
用户: 先这样，我去吃饭了

Claude: 好的！我为您总结一下今天的对话：
      
      [执行: Write file: conversations/2025-02-25.md]
      
      **主题**: 设计长期记忆系统
      **关键决策**: 使用 Markdown 而非数据库
      **新记忆**: 您偏好简洁的架构设计
      
      已保存到您的对话历史。
```

## 方案对比

| 特性 | 原方案 (MCP) | 简化方案 (原生工具) |
|------|-------------|-------------------|
| **组件数量** | cc-agents + MCP Server + Claude CLI | cc-agents + Claude CLI |
| **配置复杂度** | 需要配置 MCP | 无需额外配置 |
| **故障点** | MCP 可能崩溃 | 少一个故障点 |
| **延迟** | 多一层通信 | 直接文件操作 |
| **灵活性** | 受限于 MCP API | 完全自由 |
| **代码量** | 500+ 行 | 仅 CLAUDE.md |
| **维护成本** | 高 | 极低 |

## 优势

1. **极简** - 零额外依赖
2. **透明** - 用户可以直接看到 CLAUDE.md 中的指令
3. **可控** - 用户可以编辑 CLAUDE.md 自定义行为
4. **灵活** - Claude 可以自由决定如何操作文件
5. **稳定** - 少一个故障点
6. **易调试** - 直接看文件变化

## 最佳实践

### 1. 模板化管理

为不同类型的用户创建不同的 CLAUDE.md 模板：

```
templates/
├── developer.md      # 开发者模板
├── designer.md       # 设计师模板
└── manager.md        # 管理者模板
```

### 2. 版本控制

建议对 users/ 目录进行 git 版本控制：

```bash
git init users/
git add users/demo-user/
git commit -m "Initialize user memory"
```

### 3. 定期 Review

用户可以定期查看和编辑自己的 kernel.md：

```bash
cat users/demo-user/kernel.md
vim users/demo-user/kernel.md  # 修正或补充
```

### 4. 隐私保护

在 CLAUDE.md 中设置隐私边界：

```markdown
## 隐私设置

不要记录：
- 具体的公司机密信息
- 个人敏感信息（身份证号、密码等）
- 他人的隐私信息
```

## 故障排除

### 记忆没有更新

检查：
1. CLAUDE.md 是否包含记忆管理指令
2. Claude 是否有权限写入文件
3. 查看 kernel.md 是否有写入痕迹

### kernel.md 格式错乱

可以手动修复：

```bash
cp memory/.template.md users/demo-user/kernel.md
```

### 想禁用记忆功能

删除或重命名 CLAUDE.md：

```bash
mv users/demo-user/CLAUDE.md users/demo-user/CLAUDE.md.disabled
```

## 扩展思路

### 1. 多用户协作

在关系网络中记录协作者：

```markdown
## 关系网络

- @alice: 前端专家，经常协作 UI/UX
- @bob: 后端专家，API 设计咨询
```

### 2. 项目专属记忆

为每个项目创建子目录：

```
users/demo-user/
├── CLAUDE.md
├── kernel.md
├── conversations/
└── projects/
    ├── cc-agents/
    │   └── context.md
    └── other-project/
        └── context.md
```

### 3. 时间线追踪

在 kernel.md 中增加时间线章节：

```markdown
## 时间线

### 2025-02
- 学习了 Rust 基础
- 完成了 cc-agents 项目

### 2025-01
- 内核初始化
```

## 总结

这个简化方案的核心是：**让 Claude CLI 自己管理记忆，不需要额外的 MCP Server**。

通过精心设计的 CLAUDE.md 提示词，Claude 可以：
1. 自主读取和理解用户画像
2. 在对话中识别和记录重要信息
3. 主动更新内核文件
4. 生成对话摘要

**大道至简**。
