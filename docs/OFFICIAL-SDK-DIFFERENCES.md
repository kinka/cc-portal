# cc-portal 与官方 Claude Agent SDK 的差异

本文档对比 **cc-portal** 与 Anthropic 官方 **Claude Agent SDK**（[@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) / [platform.claude.com Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)）的差异。

---

## 1. 架构与运行方式

| 维度 | 官方 Agent SDK | cc-portal |
|------|----------------|-----------|
| **形态** | npm 库，直接依赖、在进程内运行 | HTTP 服务 + 子进程 |
| **与 Claude 的通信** | 调用 Anthropic API（Messages API + 内置 agent 循环） | **spawn `claude` CLI**，通过 stdin/stdout 传 **stream-json**（换行分隔 JSON） |
| **进程模型** | 无子进程，每次 `query()` 由库内完成请求与工具循环 | 每个 Session **一个常驻** `claude` 子进程，多轮对话复用同一进程 |
| **部署** | 嵌入到你的 Node/TS 应用 | 独立服务，通过 REST + SSE 对外提供能力 |

结论：官方 SDK 是「库 + 直连 API」；我们是「CLI 子进程 + HTTP 封装」，走的是 [Claude Code 无头模式](https://code.claude.com/docs/en/headless)（`claude -p` + `--output-format stream-json`）。

### 官方 SDK「无子进程」是怎么实现的？

官方 SDK **不启动 `claude` CLI**，全部在你的 Node/Python 进程内完成：

1. **和 Claude 的通信**：用 **HTTP** 直接调 [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)（例如 `POST https://api.anthropic.com/v1/messages`），带上 API Key、`model`、`messages` 等。一次请求 = 一轮「用户/助手/工具结果」的对话。
2. **Agent 循环在库内实现**：
   - 你调用 `query({ prompt, options })`；
   - 库发第一次请求（prompt 作为 user message）；
   - 若响应里包含 `tool_use`，库在**当前进程**里执行对应工具（Read → `fs.readFile`、Bash → `child_process`、Edit → 写文件等）；
   - 把「助手消息 + 工具结果」拼进 `messages`，再发下一次 HTTP 请求；
   - 重复直到 API 返回的 `stop_reason` 不再是 `tool_use`，然后给你 `ResultMessage`。
3. **内置工具都在本进程**：Read / Write / Edit / Bash / Glob / Grep 等由 SDK 用 Node/Python 的 fs、child_process 等实现，不依赖外部 CLI。只有 MCP 等会再起子进程跑独立 server。

所以「无子进程」指的是：**没有 `claude` 这个子进程**；只有你的应用进程 + 对 Anthropic API 的 HTTP 调用 + 库内实现的工具执行。和 cc-portal（必须 spawn 一个 `claude` 进程、用 stdin/stdout 传 stream-json）是两条完全不同的实现路径。

### 实际表现：官方 SDK 与 CLI 行为不完全一致

因为官方 SDK 是**另一套实现**（直连 API + 自研工具循环），和 Claude Code **CLI** 并非同一代码路径，所以会出现「CLI 正常、SDK 异常」的情况，例如：

- **MCP 服务**：SDK 里 MCP 的加载/生命周期和 CLI 不同，容易出现加载不到、连接不稳等问题；
- 其他依赖 CLI 行为（配置、hooks、环境）的能力，在 SDK 里可能缺失或表现不一致。

**cc-portal 走的是 CLI**：spawn 的就是桌面/无头用的同一个 `claude`，所以 MCP、权限、stream-json 等行为与「直接跑 claude」一致，更适合「我要和 Claude Code 行为完全对齐」的场景。代价是多一个子进程和 stream-json 的解析，而不是用官方 SDK 的库 API。

---

## 2. 消息与流式格式

| 维度 | 官方 Agent SDK | cc-portal |
|------|----------------|-----------|
| **消息来源** | 库内部产生的结构化消息对象 | CLI 标准输出的一行一个 JSON（stream-json 协议） |
| **常见类型** | `SystemMessage`、`AssistantMessage`、`ResultMessage`、`StreamEvent`（`includePartialMessages` 时） | `system`、`user`、`assistant`、`result`、`log`、`control_request`、`control_response` |
| **流式粒度** | `StreamEvent`：`message_start` → `content_block_start` → `content_block_delta`（`text_delta` / `input_json_delta`）→ `content_block_stop` → `message_delta` → `message_stop` | 按 **完整 assistant 消息** 的 content 块解析后，再转成自研 `StreamChunk`（`text`、`tool_start`、`tool_output`、`system`、`log`、`done`） |
| **流式开关** | 通过选项 `includePartialMessages: true` 开启 | 始终按「行解析 + 按类型产出 chunk」，无单独“是否流式”开关 |

因此：**消息类型与流式格式并不一一对应**。官方是 API 的 event 流（content_block_delta 等）；我们是 CLI 的 stream-json（assistant/result 等）再映射成自己的 chunk。

---

## 3. 能力对比

| 能力 | 官方 Agent SDK | cc-portal |
|------|----------------|-----------|
| **权限模式** | `permissionMode`（default / acceptEdits / bypassPermissions / plan） | ✅ 已对齐（同上 + `--permission-mode` 传给 CLI） |
| **工具审批** | 通过 [Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input) 等交互式审批 | ✅ `canCallTool` 回调 + control_request/control_response（仅程序化；HTTP 下不可用） |
| **allowedTools / disallowedTools** | ✅ | ✅（透传 CLI） |
| **MCP** | ✅ `mcpServers` | ✅ `mcpServers`（`--mcp-config`） |
| **Session / 多轮** | 从 system init 取 `session_id`，下次 `query({ resume: sessionId })`；每次 query 可新进程 | ✅ 一个 Session 一个进程，多轮在同一进程内顺序发消息，无需显式 resume |
| **Hooks** | ✅ PreToolUse、PostToolUse、SessionStart、SessionEnd、UserPromptSubmit 等 | ❌ 未实现（CLI 若支持需在子进程侧配置，我们未暴露） |
| **Subagents（Task 工具）** | ✅ `agents: { "name": AgentDefinition }`，`parent_tool_use_id` | ❌ 未实现 |
| **AskUserQuestion / 用户输入** | ✅ 多选、澄清问题等 | ❌ 未实现 |
| **Skills / Slash commands / Memory** | 通过 `settingSources: ['project']` 等读 .claude/、CLAUDE.md | ⚠️ 依赖子进程 cwd；未在 API 层显式配置 setting_sources |
| **Structured output** | ✅ `--output-format json` + `--json-schema`，结果在 `ResultMessage.structured_output` | ❌ 未暴露 json-schema / structured_output |
| **includePartialMessages** | ✅ 细粒度 StreamEvent（content_block_delta） | ⚠️ 流式为「按 assistant 块」的 chunk，非 API 级 delta |

---

## 4. API 形态

| 维度 | 官方 Agent SDK | cc-portal |
|------|----------------|-----------|
| **调用方式** | `query({ prompt, options })` 返回 AsyncIterable\<Message\> | HTTP：POST /sessions、POST /sessions/:id/messages、GET /sessions/:id/stream（SSE） |
| **多轮** | 每次 `query(...)` 可带 `resume: sessionId`，由库管理会话 | 创建 Session 后多次 POST messages 或 GET stream，同一 session 对应同一子进程 |
| **流式消费** | `for await (const message of query(...))`，根据 `message.type` 处理 | GET /sessions/:id/stream?message=... 得到 SSE，每条 `data` 为 StreamChunk JSON |

---

## 5. 总结表

| 项目 | 官方 Agent SDK | cc-portal |
|------|----------------|-----------|
| **定位** | 库：嵌入应用、直连 API、完整 SDK 能力 | 服务：包装 CLI、HTTP/SSE、进程复用多轮 |
| **协议/传输** | Anthropic API（含 stream_event 等） | Claude Code CLI stream-json（stdin/stdout） |
| **消息/流式** | System/Assistant/Result/StreamEvent，content_block_delta | system/user/assistant/result/log/control_* → StreamChunk |
| **权限与工具** | permissionMode + 交互式审批 + AskUserQuestion | permissionMode + canCallTool（仅程序化） |
| **Hooks / Subagents / 用户输入** | ✅ | ❌ |
| **Structured output** | ✅ | ❌ |
| **Session** | resume + session_id | 一 session 一进程，无需 resume |
| **canCallTool 在 HTTP 下** | N/A（库内直接回调） | ❌ 无法传回调，需 bypass 或后续做审批 API |

若要「与官方 SDK 行为更一致」且仍用 cc-portal 架构，可考虑的方向：在现有 stream 上暴露更细粒度事件（若 CLI 支持）、或增加 Hooks/Subagents 的配置透传（若 CLI 支持）；若要完整 StreamEvent + Hooks + Subagents，需改用官方 `@anthropic-ai/claude-agent-sdk` 或在其之上再包一层 HTTP。
