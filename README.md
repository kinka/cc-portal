# ClaudePortal

将 Claude Code CLI 封装为 HTTP 服务，提供有状态的会话管理。基于 Bun 开发，支持持久对话、多用户协作。

**核心特点**：像调用大模型 API 一样简单，但自动保持对话上下文，无需每次传递历史消息。

## 功能特性

### 核心功能

- 🚀 直接调用 Claude Code CLI，进程复用优化
- 💬 持续对话支持，多轮对话复用同一进程
- 📡 SSE 流式消息推送（含 system/log/tool 等 chunk 类型）
- 📝 会话管理和历史记录持久化（存储在 Claude CLI 的 `~/.claude/projects/`）
- 🔄 进程复用机制，避免重复启动开销

### 会话管理

- 支持自定义 Session ID（UUID v4）
- 会话配额管理（默认每用户最多 200 个会话）
- 自动清理最旧的会话
- 支持恢复已有会话
- 实时文本流（partial messages）

### 权限控制

- 🛠️ 支持自定义模型、allowedTools/disallowedTools、MCP、maxTurns
- 🔐 权限模式：`default` | `acceptEdits` | `bypassPermissions` | `plan`
- 🔐 **HTTP 工具审批**：支持 HTTP/REST 审批流程（SSE 实时推送、pending-permissions 队列）
- ⚡ **自动允许只读工具**：Read、Glob、Grep 等无需审批

**权限模式说明：**

| 模式 | 说明 |
|------|------|
| `bypassPermissions` | 自动允许所有工具调用（默认） |
| `default` | 需要审批危险操作，自动允许只读工具 |
| `acceptEdits` | 自动允许编辑操作 |
| `plan` | 规划模式 |

**自动允许的工具（无需审批）：**

- 只读工具：`Read`, `Glob`, `Grep`, `LS`, `TodoRead`, `WebFetch`, `WebSearch`
- MCP 只读模式：`mcp__*__*get*`, `mcp__*__*list*`, `mcp__*__*search*`, `mcp__*__*fetch*`, `mcp__*__*read*`, `mcp__*__*find*`

### 多用户协作

- 👥 **多用户 Session**：支持 Owner + Participants 共享会话
- 👤 **用户目录**：用户 Profile 管理与搜索
- 🔒 **用户隔离**：基于 X-User-ID 的会话隔离
- 🤝 **会话共享**：邀请其他用户参与会话

### MCP 集成

- 📦 用户级 MCP 服务器配置
- 🔧 动态加载 MCP 服务器
- 🔗 支持 inline MCP 配置（跳过信任提示）

### 管理功能

- 📊 管理员 API（用户管理、会话统计）
- 📈 服务监控（健康检查、统计信息）
- ⚙️ 配额管理

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HTTP API (Fastify)                            │
├─────────────────────────────────────────────────────────────────────────┤
│  POST /sessions          │  GET /sessions/:id/stream (SSE)              │
│  GET  /sessions          │  GET /sessions/:id/pending-permissions (?stream=1) │
│  POST /sessions/:id/messages  │  POST /sessions/:id/permissions/:requestId   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ClaudeSession (EventEmitter)                    │
├─────────────────────────────────────────────────────────────────────────┤
│  - 会话管理    │  - 消息历史    │  - 待审批队列 Map<requestId, Pending>   │
│  - Event: 'permissionPending'  │  - Event: 'permissionResolved'           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      ClaudeAgentBackend (EventEmitter)                  │
├─────────────────────────────────────────────────────────────────────────┤
│  - 进程复用    │  - 单读循环    │  - control 协议处理    │  - SSE chunks   │
│  - Event: 'permissionRequest' → StreamChunk with type: 'permission_request' │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          spawn once, reuse
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Claude Process                                │
├─────────────────────────────────────────────────────────────────────────┤
│  stdin/stdout JSON streaming  │  --permission-mode default/bypass/...    │
│  control_request (can_use_tool) → waitForPermission → HTTP 审批          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心优化

**进程复用机制**：
- 每个 session 只启动一次 `claude` 进程
- 通过 stdin/stdout 进行 JSON 流式通信
- 多轮对话复用同一进程，性能提升 66%
- session 销毁时正确清理进程资源

## 安装

```bash
cd /Users/kinka/space/happy-coder/cc-portal
bun install
```

## 使用

### 启动服务

```bash
# 开发模式（热重载）
bun run dev

# 生产模式
bun run start
```

服务默认运行在 `http://0.0.0.0:9033`

### API 端点

#### 健康检查
```bash
GET /health
```

#### 创建会话
```bash
POST /sessions
Content-Type: application/json
X-User-ID: your-user-id

{
  "sessionId": "可选的 UUID v4，不传则自动生成",
  "path": "/path/to/project",
  "project": "项目名称（可选）",
  "initialMessage": "可选的初始消息",
  "model": "claude-sonnet-4-6",
  "allowedTools": ["Read", "Edit", "Bash"],
  "disallowedTools": [],
  "permissionMode": "default",
  "permissionTimeoutMs": 300000,
  "maxTurns": 100,
  "envVars": { "CUSTOM_VAR": "value" },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "KEY": "value" }
    }
  },
  "autoAllowToolPatterns": ["mcp__my__*"]
}
```

- `permissionMode`: `default` | `acceptEdits` | `bypassPermissions` | `plan`，默认 `bypassPermissions`。
- `permissionTimeoutMs`: HTTP 工具审批超时时间（毫秒），默认 300000（5 分钟）。
- `autoAllowToolPatterns`: 额外的自动允许工具模式（如 `["mcp__my__*"]`），与预设的只读工具合并。
- `sessionId`: 可选的 UUID v4，用于幂等创建或恢复会话。

#### 列出所有会话
```bash
GET /sessions
X-User-ID: your-user-id

# 返回
{
  "sessions": [
    { "sessionId": "xxx", "path": "/path", "createdAt": "..." }
  ],
  "quota": { "max": 200, "used": 1 }
}
```

#### 获取会话详情
```bash
GET /sessions/:sessionId
X-User-ID: your-user-id
```

#### 获取消息历史
```bash
GET /sessions/:sessionId/messages
GET /sessions/:sessionId/messages?detailed=1&limit=10
X-User-ID: your-user-id

# 返回
{
  "sessionId": "xxx",
  "source": "cli",
  "detailed": false,
  "count": 5,
  "messages": [
    { "role": "user", "content": "Hello", "timestamp": "..." },
    { "role": "assistant", "content": "Hi!", "timestamp": "..." }
  ]
}
```

#### 发送消息
```bash
POST /sessions/:sessionId/messages
Content-Type: application/json
X-User-ID: your-user-id

{
  "message": "你的消息",
  "from": "user-id"  // 可选，标识消息发送者（多用户场景）
}

# 返回
{
  "sessionId": "xxx",
  "response": "Claude 的回复",
  "timestamp": "..."
}
```

#### 流式接收消息 (SSE)
```bash
GET /sessions/:sessionId/stream?message=你的消息
X-User-ID: your-user-id

# SSE 响应格式：
# data: {"type":"text","content":"Hello"}
# data: {"type":"tool_start","toolName":"Read","toolUseId":"xxx","toolInput":{}}
# data: {"type":"tool_output","toolOutput":{},"toolUseId":"xxx"}
# data: {"type":"permission_request","requestId":"xxx","toolName":"Write","toolInput":{}}
# data: [DONE]
```

**无消息参数时**：仅监听当前响应（用于权限审批后继续）：
```bash
GET /sessions/:sessionId/stream
X-User-ID: your-user-id
```

#### 停止会话
```bash
POST /sessions/:sessionId/stop
X-User-ID: your-user-id

# 返回 { "sessionId": "xxx", "status": "stopped" }
```

#### 工具审批（permissionMode 非 bypass 时）

创建 Session 时使用 `permissionMode: 'default'`（或 `acceptEdits`/`plan`）且不传 `canCallTool`，Claude 请求工具时会挂起，由客户端通过 HTTP 审批：

```bash
# 方式1: 轮询待审批列表
GET /sessions/:sessionId/pending-permissions
# 返回 { "pending": [{ "requestId", "toolName", "input", "createdAt" }] }

# 方式2: SSE 实时推送（推荐）
GET /sessions/:sessionId/pending-permissions?stream=1
# 实时收到: { "type": "pending", "requestId", "toolName", "input", "createdAt" }
# 审批后收到: { "type": "resolved", "requestId", "result" }

# 批准或拒绝
POST /sessions/:sessionId/permissions/:requestId
Content-Type: application/json
{ "approved": true, "updatedInput": {} }   # 批准，可选修改入参
{ "approved": false, "message": "拒绝原因" } # 拒绝
```

**SSE 流中的实时通知**：在使用 `/sessions/:id/stream` 时，如果工具需要审批，会收到 `permission_request` 类型的 chunk：

```json
{ "type": "permission_request", "requestId": "...", "toolName": "Edit", "toolInput": {...}, "content": "..." }
```

可选 `permissionTimeoutMs`（默认 300000）控制等待审批超时。

#### MCP 配置

```bash
# 获取用户 MCP 配置
GET /mcp
X-User-ID: your-user-id

# 返回
{ "mcpServers": { "my-server": { "command": "...", "args": [], "env": {} } } }

# 更新用户 MCP 配置
PUT /mcp
X-User-ID: your-user-id
Content-Type: application/json

{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server"],
      "env": { "API_KEY": "xxx" }
    }
  }
}

# 返回 { "success": true }
```

> **注意**：更新 MCP 配置后，该用户的所有活跃会话会被自动关闭，新会话将使用新配置。

#### 删除会话
```bash
DELETE /sessions/:sessionId
X-User-ID: your-user-id

# 返回 { "sessionId": "xxx", "status": "deleted" }
```

### 管理员 API

管理端点需要 `X-Admin-Token` 认证：

```bash
X-Admin-Token: your-admin-token  # 默认为 "change-me-in-production"
```

#### 列出所有用户
```bash
GET /admin/users
X-Admin-Token: your-admin-token

# 返回
{
  "users": [
    { "userId": "alice", "maxSessions": 200, "used": 5 }
  ]
}
```

#### 列出所有会话
```bash
GET /admin/sessions
X-Admin-Token: your-admin-token

# 返回
{
  "sessions": [
    {
      "sessionId": "xxx",
      "ownerId": "alice",
      "projectPath": "/Users/alice/project",
      "lastModified": "...",
      "createdAt": "..."
    }
  ]
}
```

#### 服务统计
```bash
GET /admin/stats
X-Admin-Token: your-admin-token

# 返回
{
  "users": { "total": 10 },
  "sessions": {
    "total": 25,
    "byProject": { "/path/to/project": 5 }
  }
}
```

### 用户管理 API

#### 搜索用户
```bash
GET /users?query=alice
Header: X-User-ID: your-user-id

# 返回
{
  "users": [
    { "userId": "alice", "displayName": "Alice Smith", "skills": ["typescript"] }
  ]
}
```

#### 获取用户 Profile
```bash
GET /users/:userId/profile
Header: X-User-ID: your-user-id

# 返回
{
  "userId": "alice",
  "displayName": "Alice Smith",
  "skills": ["typescript", "rust"],
  "currentProjects": ["cc-portal"]
}
```

#### 更新自己的 Profile
```bash
PUT /me/profile
Header: X-User-ID: your-user-id
Content-Type: application/json

{
  "displayName": "Alice Smith",
  "skills": ["typescript", "rust"],
  "currentProjects": ["cc-portal"]
}

# 返回更新后的 Profile
```

### 参与者管理（多用户 Session）

#### 添加参与者
```bash
POST /sessions/:sessionId/participants
Header: X-User-ID: your-user-id
Content-Type: application/json

{
  "userId": "bob"
}
```

#### 列出参与者
```bash
GET /sessions/:sessionId/participants
Header: X-User-ID: your-user-id
```

#### 获取我参与的共享会话
```bash
GET /my/shared-sessions
Header: X-User-ID: your-user-id
```

## Demo

### Chat Demo

打开 `demo/chat-demo.html` 体验多用户共享 Session：

```bash
open demo/chat-demo.html
```

**演示流程**：
1. Alice 创建 Session
2. Alice 拉入 Bob
3. 双方共享同一 Session，消息实时同步
4. Claude 感知多用户上下文，知道谁在说话

## 示例

### 创建并对话

```bash
# 1. 创建会话
SESSION=$(curl -s -X POST http://localhost:9033/sessions \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"path": "/Users/kinka/project", "initialMessage": "你好"}' | jq -r '.sessionId')

echo "Session ID: $SESSION"

# 2. 发送消息
curl -X POST "http://localhost:9033/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"message": "帮我查看当前目录的文件"}'

# 3. 流式接收消息
curl "http://localhost:9033/sessions/$SESSION/stream" \
  -H "X-User-ID: alice"

# 4. 删除会话
curl -X DELETE "http://localhost:9033/sessions/$SESSION" \
  -H "X-User-ID: alice"
```

### 多用户共享会话示例

```bash
# Alice 创建会话
SESSION=$(curl -s -X POST http://localhost:9033/sessions \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"project": "demo"}' | jq -r '.sessionId')

# Alice 添加 Bob 为参与者
curl -X POST "http://localhost:9033/sessions/$SESSION/participants" \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"userId": "bob"}'

# Alice 发送消息
curl -X POST "http://localhost:9033/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"message": "Hello everyone!"}'

# Bob 也能看到消息（使用同一个 sessionId）
curl "http://localhost:9033/sessions/$SESSION" \
  -H "X-User-ID: bob"
```

## 核心组件

### ClaudeAgentBackend

直接调用 Claude Code CLI 的实现：

```typescript
const backend = new ClaudeAgentBackend({
  cwd: '/path/to/project',
  claudeSessionId: 'unique-session-id',
  model: 'claude-sonnet-4.5',
  allowedTools: ['Read', 'Edit', 'Bash']
});

// 普通查询
const response = await backend.query('帮我查看文件');

// 流式查询（实时响应）
for await (const chunk of backend.queryStream('帮我查看文件')) {
  if (chunk.type === 'text') {
    console.log(chunk.content);
  }
}
```

### ClaudeSession

会话管理封装：

```typescript
const session = new ClaudeSession({
  cwd: '/path/to/project',
  model: 'claude-sonnet-4.5',
  allowedTools: ['Read', 'Edit'],
  ownerId: 'alice',
  initialParticipants: ['bob']
});

// 发送消息
const response = await session.sendMessage('你好', 'alice');

// 流式发送消息
for await (const chunk of session.sendMessageStream('你好', 'alice')) {
  console.log(chunk);
}

// 添加参与者
session.addParticipant('charlie');

// 停止会话（自动清理进程）
session.destroy();
```

### 多用户 Session 上下文

当 Session 有多个参与者时，Claude 会自动收到 Session Context：

```
[Session Context]
CC-Portal API: http://localhost:9033
Auth header: X-User-ID: alice
Your session ID: xxx-xxx

This is a multi-user session.
Owner: alice
Participants: alice, bob
Current speaker: alice

[alice]: Hello everyone!
```

这让 Claude 能够：
- 识别当前说话者
- 理解多用户协作场景
- 在回复中提及特定用户

### 进程生命周期

- `initialize()`: 首次查询时自动初始化进程
- `query()`: 复用已有进程进行查询
- `queryStream()`: 流式查询，实时返回响应
- `destroy()`: 清理进程和资源
- 超时保护：5 分钟自动超时

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9033` | 服务端口 |
| `HOST` | `0.0.0.0` | 服务主机 |
| `USERS_DIR` | `./users` | 用户数据目录 |
| `ADMIN_TOKEN` | `change-me-in-production` | 管理员令牌 |
| `DEFAULT_MAX_SESSIONS` | `200` | 每用户最大会话数 |
| `CC_AGENTS_URL` | `http://localhost:9033` | Agent API 基础 URL |
| `LOG_LEVEL` | `info` | 日志级别 |

## 数据存储

### 会话数据

会话数据存储在 Claude CLI 的本地存储中：

```
~/.claude/projects/{project-hash}/{session-id}.jsonl
```

### 用户数据

用户相关数据存储在 `USERS_DIR` 目录下：

```
{USERS_DIR}/
├── {user-id}/                  # 用户目录（作为 Claude 工作目录）
│   ├── .git/                   # Git 目录（用于 auto memory）
│   ├── mcp-config.json         # 用户 MCP 配置
│   └── profile.json            # 用户 Profile
├── portal-config.json          # 参与者映射等元数据
└── CLAUDE.md                   # 共享的 Claude 指令
```

## 测试

- **API / 无 Claude**：`bun test` 会运行 `tests/e2e.test.ts` 中的健康检查、会话 CRUD、pending-permissions 等用例（不依赖 Claude CLI）。
- **E2E（真实 Claude）**：需安装 Claude Code CLI，执行 `bun run test:e2e`（即 `RUN_E2E=1 bun test tests/e2e --timeout 120000`）会跑单轮与多轮对话的端到端用例。

## 项目结构

```
cc-portal/
├── src/
│   ├── app.ts                   # Fastify 应用构建（buildApp，供测试注入）
│   ├── index.ts                 # HTTP 服务入口
│   ├── sdk-types.ts             # SDK 类型（与 happy-cli 对齐）
│   ├── ClaudeAgentBackend.ts    # Claude 进程管理、control 协议、权限
│   ├── ClaudeSession.ts         # 会话封装
│   ├── ClaudeSessionManager.ts  # 会话管理器
│   ├── AgentBackend.ts          # Agent 接口类型
│   ├── logger.ts                # 日志工具
│   ├── middleware/
│   │   └── auth.ts               # 认证中间件
│   ├── crossSession/
│   │   └── UserDirectory.ts      # 用户目录
│   └── routes/
│       ├── crossUserRoutes.ts    # 用户管理 API
│       └── participantRoutes.ts  # 参与者管理 API
│
├── docs/
│   └── ALIGNMENT.md             # 与 happy-cli 对齐改造成果记录
├── tests/
│   └── e2e.test.ts              # Bun 端到端与 API 测试
├── demo/
│   └── chat-demo.html           # 多用户 Session 演示
├── package.json
├── tsconfig.json
└── README.md
```

## 与 happy-cli / 官方 SDK

- **与 happy-cli 对齐**：权限模式、control 协议、消息类型与流式 chunk，见 **[docs/ALIGNMENT.md](docs/ALIGNMENT.md)**。
- **与官方 Claude Agent SDK 的差异**：架构（CLI 子进程 vs 直连 API）、消息格式、能力对比，见 **[docs/OFFICIAL-SDK-DIFFERENCES.md](docs/OFFICIAL-SDK-DIFFERENCES.md)**。

## 技术栈

- **Bun**: JavaScript 运行时
- **Fastify**: Web 框架
- **TypeScript**: 类型系统
- **Claude Code CLI**: 直接调用官方 CLI（stream-json 协议）

## 注意事项

1. 需要预先安装 Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
2. 需要有效的 Claude API 权限
3. 每个会话启动一个 Claude 进程，多轮对话复用该进程（同一时刻仅处理一条 query，顺序无冲突）
4. 会话消息历史持久化存储在 `~/.claude/projects/` 目录，重启服务不会丢失
5. 进程在 session 销毁时或空闲 10 分钟后自动清理
6. **HTTP 工具审批**：HTTP 下不提供 `canCallTool` 回调时，工具调用会进入待审批队列，通过 `GET /sessions/:id/pending-permissions` 和 `POST /sessions/:id/permissions/:requestId` 进行审批。
7. **生产环境**：请务必修改 `ADMIN_TOKEN` 环境变量

## 性能优化

- **进程复用**: 多次查询只启动一次进程，性能提升 66%
- **流式通信**: 通过 stdin/stdout 进行 JSON 流式通信
- **实时响应**: 支持 partial messages，实现真正的打字机效果
- **资源管理**: session 销毁时或空闲 10 分钟后自动清理进程
- **超时保护**: 5 分钟查询超时保护，权限审批默认 5 分钟超时
- **自动清理**: 会话配额满时自动淘汰最旧的会话

## 开发命令

```bash
# 安装依赖
bun install

# 开发模式（热重载）
bun run dev

# 生产模式
bun run start

# 构建
bun run build

# 类型检查
bun run typecheck

# 运行测试（不需要 Claude CLI）
bun test

# E2E 测试（需要 Claude CLI）
bun run test:e2e
```

## License

MIT
