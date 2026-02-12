# Claude Agent HTTP Service

基于 Bun 开发的 HTTP 服务，使用 happy-cli 的 Claude SDK 封装，可以远程启动 Claude Code CLI 并进行持续的对话。

## 功能特性

- 🚀 直接调用 Claude Code CLI，进程复用优化
- 💬 持续对话支持，多轮对话复用同一进程
- 📡 SSE 流式消息推送（含 system/log/tool 等 chunk 类型）
- 🔄 进程复用机制，避免重复启动开销
- 🛠️ 支持自定义模型、allowedTools/disallowedTools、MCP、maxTurns
- 🔐 权限模式对齐 happy-cli：permissionMode（default/acceptEdits/bypassPermissions/plan）、程序化 canCallTool
- 📝 会话管理和历史记录
- 🎯 完善的生命周期管理

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   HTTP API      │────▶│ ClaudeSession    │────▶│ClaudeAgentBackend│
│  (Fastify)      │     │  - 会话管理       │     │  - 进程复用      │
└─────────────────┘     │  - 消息历史       │     │  - 流式通信      │
                        └──────────────────┘     └─────────────────┘
                                                        │
                              ┌─────────────────────────┘
                              │ spawn once, reuse
                              ▼
                        ┌──────────────────┐
                        │  Claude Process  │
                        │  stdin/stdout    │
                        │  JSON streaming  │
                        └──────────────────┘
```

### 核心优化

**进程复用机制**：
- 每个 session 只启动一次 `claude` 进程
- 通过 stdin/stdout 进行 JSON 流式通信
- 多轮对话复用同一进程，性能提升 66%
- session 销毁时正确清理进程资源

## 安装

```bash
cd /Users/kinka/space/happy-coder/cc-agents
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

服务默认运行在 `http://0.0.0.0:3333`

### API 端点

#### 健康检查
```bash
GET /health
```

#### 创建会话
```bash
POST /sessions
Content-Type: application/json

{
  "path": "/path/to/project",
  "initialMessage": "可选的初始消息",
  "model": "claude-sonnet-4.5",
  "allowedTools": ["Read", "Edit", "Bash"],
  "disallowedTools": [],
  "permissionMode": "bypassPermissions",
  "maxTurns": 100,
  "envVars": { "CUSTOM_VAR": "value" },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "KEY": "value" }
    }
  }
}
```

- `permissionMode`: `default` | `acceptEdits` | `bypassPermissions` | `plan`，默认不传时为放行。
- 纯 HTTP 下无法使用「工具审批回调」`canCallTool`，仅程序化创建 Session 时可传；详见 [docs/ALIGNMENT.md](docs/ALIGNMENT.md)。

#### 列出所有会话
```bash
GET /sessions
```

#### 获取会话详情
```bash
GET /sessions/:sessionId
```

#### 发送消息
```bash
POST /sessions/:sessionId/messages
Content-Type: application/json

{
  "message": "你的消息"
}
```

#### 流式接收消息 (SSE)
```bash
GET /sessions/:sessionId/stream
```

#### 停止会话
```bash
POST /sessions/:sessionId/stop
```

#### 删除会话
```bash
DELETE /sessions/:sessionId
```

## 示例

### 创建并对话

```bash
# 1. 创建会话
SESSION=$(curl -s -X POST http://localhost:3333/sessions \
  -H "Content-Type: application/json" \
  -d '{"path": "/Users/kinka/project", "initialMessage": "你好"}' | jq -r '.sessionId')

echo "Session ID: $SESSION"

# 2. 发送消息
curl -X POST "http://localhost:3333/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我查看当前目录的文件"}'

# 3. 流式接收消息
curl "http://localhost:3333/sessions/$SESSION/stream"

# 4. 停止会话
curl -X POST "http://localhost:3333/sessions/$SESSION/stop"
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
  allowedTools: ['Read', 'Edit']
});

// 发送消息
const response = await session.sendMessage('你好');

// 流式发送消息
for await (const chunk of session.sendMessageStream('你好')) {
  console.log(chunk);
}

// 停止会话（自动清理进程）
session.stop();
```

### 进程生命周期

- `initialize()`: 首次查询时自动初始化进程
- `query()`: 复用已有进程进行查询
- `queryStream()`: 流式查询，实时返回响应
- `destroy()`: 清理进程和资源
- 超时保护：5 分钟自动超时

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3333` | 服务端口 |
| `HOST` | `0.0.0.0` | 服务主机 |
| `DEBUG` | - | 启用调试日志 |

## 项目结构

```
cc-agents/
├── src/
│   ├── index.ts                 # HTTP 服务入口
│   ├── sdk-types.ts             # SDK 类型（与 happy-cli 对齐）
│   ├── ClaudeAgentBackend.ts    # Claude 进程管理、control 协议、权限
│   ├── ClaudeSession.ts         # 会话封装
│   ├── ClaudeSessionManager.ts  # 会话管理器
│   ├── AgentBackend.ts          # Agent 接口类型
│   └── logger.ts                # 日志工具
├── docs/
│   └── ALIGNMENT.md             # 与 happy-cli 对齐改造成果记录
├── package.json
├── tsconfig.json
└── README.md
```

## 与 happy-cli 对齐

权限模式、工具调用 control 协议、消息类型与流式 chunk 已与 happy-cli 对齐，改造成果见 **[docs/ALIGNMENT.md](docs/ALIGNMENT.md)**。

## 技术栈

- **Bun**: JavaScript 运行时
- **Fastify**: Web 框架
- **TypeScript**: 类型系统
- **Claude Code CLI**: 直接调用官方 CLI（stream-json 协议）

## 注意事项

1. 需要预先安装 Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
2. 需要有效的 Claude API 权限
3. 每个会话启动一个 Claude 进程，多轮对话复用该进程（同一时刻仅处理一条 query，顺序无冲突）
4. 会话消息历史保存在内存中，重启服务会丢失
5. 进程在 session 销毁时自动清理
6. **HTTP 下无法使用 canCallTool**：工具审批回调仅在使用 Node API 创建 Session 时可用；HTTP 下请用 `permissionMode: 'bypassPermissions'` 或接受无回调时自动 deny。详见 [docs/ALIGNMENT.md](docs/ALIGNMENT.md)。

## 性能优化

- **进程复用**: 多次查询只启动一次进程，性能提升 66%
- **流式通信**: 通过 stdin/stdout 进行 JSON 流式通信
- **资源管理**: session 销毁时自动清理进程和资源
- **超时保护**: 5 分钟查询超时保护

## License

MIT
