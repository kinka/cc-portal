# Claude Agent HTTP Service

基于 Bun 开发的 HTTP 服务，使用 happy-cli 的 Claude SDK 封装，可以远程启动 Claude Code CLI 并进行持续的对话。

## 功能特性

- 🚀 基于 happy-cli Claude SDK 的完整封装
- 💬 持续对话支持
- 📡 SSE 流式消息推送
- 🔧 AgentBackend 统一接口
- 🛠️ 支持 MCP 服务器
- 🔒 权限控制回调
- 📝 会话管理和历史记录

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   HTTP API      │────▶│ ClaudeSession    │────▶│ClaudeAgentBackend│
│  (Fastify)      │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                        │
                              ┌─────────────────────────┘
                              ▼
                        ┌──────────────────┐
                        │   SDK (query)    │
                        │  happy-cli 封装   │
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Claude Code CLI │
                        └──────────────────┘
```

## 安装

```bash
cd /Users/kinka/space/happy-coder/claude-agent-http-service
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

服务默认运行在 `http://0.0.0.0:3456`

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
  "envVars": {
    "CUSTOM_VAR": "value"
  },
  "customSystemPrompt": "自定义系统提示",
  "appendSystemPrompt": "追加系统提示",
  "maxTurns": 100,
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {"KEY": "value"}
    }
  }
}
```

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
SESSION=$(curl -s -X POST http://localhost:3456/sessions \
  -H "Content-Type: application/json" \
  -d '{"path": "/Users/kinka/project", "initialMessage": "你好"}' | jq -r '.sessionId')

echo "Session ID: $SESSION"

# 2. 发送消息
curl -X POST "http://localhost:3456/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我查看当前目录的文件"}'

# 3. 流式接收消息
curl "http://localhost:3456/sessions/$SESSION/stream"

# 4. 停止会话
curl -X POST "http://localhost:3456/sessions/$SESSION/stop"
```

## 核心组件

### AgentBackend 接口

统一的 Agent 后端接口，支持多种 Agent（Claude、Codex 等）：

```typescript
interface AgentBackend {
  startSession(initialPrompt?: string): Promise<StartSessionResult>;
  sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;
  cancel(sessionId: SessionId): Promise<void>;
  onMessage(handler: AgentMessageHandler): void;
  respondToPermission?(requestId: string, approved: boolean): Promise<void>;
  dispose(): Promise<void>;
}
```

### ClaudeAgentBackend

基于 happy-cli SDK 的 Claude 实现：

```typescript
const backend = new ClaudeAgentBackend({
  cwd: '/path/to/project',
  agentName: 'claude',
  transport: 'native-claude',
  model: 'claude-sonnet-4.5',
  allowedTools: ['Read', 'Edit'],
  mcpServers: { ... }
});
```

### SDK 集成

使用了 happy-cli 的以下组件：

- `src/sdk/query.ts` - Claude Code 进程管理和消息流
- `src/sdk/types.ts` - SDK 类型定义
- `src/sdk/stream.ts` - 消息流处理
- `src/sdk/utils.ts` - 工具函数

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 服务端口 |
| `HOST` | `0.0.0.0` | 服务主机 |
| `DEBUG` | - | 启用调试日志 |

## 项目结构

```
claude-agent-http-service/
├── src/
│   ├── index.ts                 # HTTP 服务入口
│   ├── AgentBackend.ts          # Agent 后端接口
│   ├── ClaudeAgentBackend.ts    # Claude 实现
│   ├── ClaudeSession.ts         # 会话封装
│   ├── ClaudeSessionManager.ts  # 会话管理器
│   ├── logger.ts                # 日志工具
│   └── sdk/                     # happy-cli SDK
│       ├── index.ts
│       ├── query.ts
│       ├── types.ts
│       ├── stream.ts
│       ├── utils.ts
│       └── metadataExtractor.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 技术栈

- **Bun**: JavaScript 运行时
- **Fastify**: Web 框架
- **Zod**: 数据验证
- **TypeScript**: 类型系统
- **happy-cli SDK**: Claude Code 封装

## 与 happy-cli 的关系

本项目复制并适配了 happy-cli 的 Claude SDK 文件：

| 源文件 | 说明 |
|--------|------|
| `happy-cli/src/claude/sdk/query.ts` | Claude Code 进程管理 |
| `happy-cli/src/claude/sdk/types.ts` | SDK 类型定义 |
| `happy-cli/src/claude/sdk/stream.ts` | 消息流处理 |
| `happy-cli/src/claude/sdk/utils.ts` | 工具函数 |
| `happy-cli/src/agent/core/AgentBackend.ts` | Agent 接口定义 |

适配修改：
- 修改了导入路径（`@/ui/logger` → `../logger`）
- 添加了 `isBun()` 工具函数
- 简化了部分类型依赖

## 注意事项

1. 需要预先安装 Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
2. 需要有效的 Claude API 权限
3. 每个会话会启动独立的 Claude Code 进程
4. 会话消息历史保存在内存中，重启服务会丢失

## License

MIT
