# 与 happy-cli 对齐改造成果

本文档记录 cc-agents 与 happy-cli 在 Claude Agent SDK 层面的对齐改造。

## 改造时间

- 完成时间：2025-02

## 1. SDK 类型对齐（`src/sdk-types.ts`）

新增独立类型模块，与 happy-cli 的 `claude/sdk/types.ts` 对齐：

| 类型 | 说明 |
|------|------|
| `SDKMessage` / `SDKUserMessage` / `SDKAssistantMessage` | 消息基础类型；User 支持 `content: string \| array`（含 tool_result） |
| `SDKSystemMessage` | 增加 `cwd`、`tools`、`slash_commands` |
| `SDKResultMessage` | 增加 `usage`、`duration_ms`、`duration_api_ms`、`total_cost_usd` |
| `SDKLog` | `type: 'log'`，含 `level`、`message` |
| `PermissionResult` | `{ behavior: 'allow', updatedInput } \| { behavior: 'deny', message }` |
| `CanCallToolCallback` | 工具调用审批回调 `(toolName, input, { signal }) => Promise<PermissionResult>` |
| `CanUseToolControlRequest` / `CanUseToolControlResponse` | control 协议请求/响应 |
| `ControlCancelRequest` | 取消进行中的 control 请求 |
| `PermissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan'` |

## 2. 权限与工具调用

### 2.1 权限模式（permissionMode）

- **bypassPermissions**（默认）：不弹审批，工具直接执行。
- **default** / **acceptEdits** / **plan**：需要审批；若提供 `canCallTool` 则通过回调决定，否则自动 **deny**。

### 2.2 control 协议处理

- **单读循环**：stdout 单线程解析，先处理 control 再入队。
- **control_request（can_use_tool）**：调用 `canCallTool`，将结果写回 stdin（`control_response`）。
- **control_cancel_request**：中止对应 AbortController。
- **无 canCallTool 时**：对工具请求回复 deny（`{ behavior: 'deny', message: '...' }`）。

### 2.3 新增/统一的 CLI 参数

- `--permission-mode`：使用 `permissionMode`，不再仅布尔 `bypassPermission`。
- `--permission-prompt-tool stdio`：在提供 `canCallTool` 时自动加上。
- `--disallowedTools`、`--mcp-config`、`--max-turns`：与 happy-cli 一致。

## 3. 消息类型与流式 Chunk

### 3.1 StreamChunk 扩展

| chunk.type | 说明 |
|------------|------|
| `text` | 助手文本片段 |
| `tool_start` | 工具开始，含 `toolName`、`toolInput`、`toolUseId` |
| `tool_output` | 工具输出，含 `toolUseId` |
| `error` / `done` | 错误或本轮结束 |
| `system` | 对应 system init：`subtype`、`session_id`、`model`、`cwd`、`tools` |
| `log` | Claude 日志：`level`、`message` |

### 3.2 单读循环与消费锁

- **单读循环**：一个 session 一个 readline 循环，解析出的非 control 消息进入 `AsyncMessageQueue`，由 `query()` / `queryStream()` 消费。
- **consumerLock**：同一 backend 上同时只允许一个 `query()` 或 `queryStream()` 在跑，避免多请求抢同一队列导致串线。**与「一个进程多轮对话」不冲突**：顺序发消息（发一条等一条）完全支持。

## 4. Session 与 HTTP API

### 4.1 创建会话选项（CreateSessionOptions / POST /sessions body）

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 工作目录（必填） |
| `initialMessage` | string | 可选初始消息 |
| `model` | string | 模型 |
| `allowedTools` | string[] | 允许的工具列表 |
| `disallowedTools` | string[] | 禁止的工具列表 |
| `permissionMode` | 'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' | 权限模式，默认未传时为 bypass |
| `permissionTimeoutMs` | number | HTTP 工具审批超时（毫秒），默认 300000 |
| `mcpServers` | Record<...> | MCP 服务配置 |
| `maxTurns` | number | 最大轮数 |
| `envVars` | Record<string, string> | 环境变量 |
| `bypassPermission` | boolean | 已废弃，请用 `permissionMode: 'bypassPermissions'` |

### 4.2 HTTP 工具审批流程

- **程序化使用**：`new ClaudeSession({ permissionMode: 'default', canCallTool: async (...) => ... })` 可完整使用工具审批回调。
- **纯 HTTP 使用**：支持实时审批通知，无需传回调：

  **审批接口**：
  - `GET /sessions/:sessionId/pending-permissions`：返回当前待审批列表 `{ pending: [...] }`
  - `GET /sessions/:sessionId/pending-permissions?stream=1`：SSE 实时推送，新审批请求自动推送 `{ type: 'pending', ... }`，审批完成推送 `{ type: 'resolved', ... }`
  - `POST /sessions/:sessionId/permissions/:requestId`：Body `{ approved, updatedInput?, message? }`，完成批准或拒绝

  **流式通知**：
  - `/sessions/:id/stream` SSE 流中，当需要审批时自动产生 `permission_request` chunk，含 `requestId`, `toolName`, `toolInput`

  创建 Session 时使用 `permissionMode: 'default'`（或 acceptEdits/plan）且不传 `canCallTool`，即走 HTTP 审批；可选 `permissionTimeoutMs`（默认 5 分钟）。

## 5. 文件与职责

| 文件 | 职责 |
|------|------|
| `src/sdk-types.ts` | 与 happy-cli 对齐的 SDK 类型与 PermissionMode |
| `src/ClaudeAgentBackend.ts` | 单读循环、control 处理、permissionMode/canCallTool、permissionResolver、StreamChunk 产出 |
| `src/ClaudeSession.ts` | 会话管理、HTTP 审批队列、EventEmitter 事件通知 |
| `src/ClaudeSessionManager.ts` | CreateSessionOptions 扩展 |
| `src/index.ts` | HTTP API、SSE 审批实时推送 |

## 6. 向后兼容

- **bypassPermission**：仍支持，内部映射为 `permissionMode: 'bypassPermissions'` 或 `'default'`，已标记为 deprecated。
- **默认行为**：未传 `permissionMode` 且未传 `bypassPermission` 时，仍为 `bypassPermissions`，与改造前一致。
