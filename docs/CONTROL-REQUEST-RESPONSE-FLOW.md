# control_request / control_response 流程说明

本文档描述 cc-portal 与 Claude CLI 子进程之间，通过 **stdio** 进行的工具权限请求/响应协议（control_request / control_response）。

> [!TIP]
> 想要直观了解完整审批时序（包含前端 SSE 交互），请查看：[工具权限申请时序图与流程说明](./PERMISSION-REQUEST-SEQUENCE.md)。

---

## 1. 概述

- **通信方向**：CLI（子进程）→ stdout 发出请求；cc-portal（父进程）→ 子进程 stdin 写入响应。
- **触发条件**：启动 CLI 时传入 `--permission-prompt-tool stdio`，且 cc-portal 配置了 `canCallTool` 或 `permissionResolver`（HTTP 审批）时，会加上该参数。
- **进程**：cc-portal 统一通过 `srt` 启动子进程（`srt claude ...`），权限流 control_request/control_response 在 srt 下正常工作。

---

## 2. 消息类型与格式

### 2.1 control_request（CLI → cc-portal，经 stdout）

CLI 在需要工具调用权限时，向 **stdout** 写一行 JSON（以换行结尾）。

**can_use_tool 请求**（当前唯一使用的 subtype）：

```json
{
  "type": "control_request",
  "request_id": "<uuid 或唯一字符串>",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "mcp__jira__jira_find_issue",
    "input": { "issueKey": "INFO-12954" }
  }
}
```

- `request_id`：本次请求唯一 ID，响应时必须原样带回。
- `request.subtype`：目前仅处理 `can_use_tool`。
- `request.tool_name`：工具全名（如 MCP 工具为 `mcp__<server>__<tool>`）。
- `request.input`：该次调用的入参（任意 JSON 可序列化对象）。

### 2.2 control_response（cc-portal → CLI，经 stdin）

cc-portal 在决定允许/拒绝后，向子进程 **stdin** 写一行 JSON（以 `\n` 结尾）。

**允许调用**：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<与 control_request 相同>",
    "response": {
      "behavior": "allow",
      "updatedInput": { "issueKey": "INFO-12954" }
    }
  }
}
```

**拒绝调用**：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<与 control_request 相同>",
    "response": {
      "behavior": "deny",
      "message": "用户拒绝"
    }
  }
}
```

**处理异常（如审批超时、内部错误）**：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "<与 control_request 相同>",
    "error": "Permission request timed out"
  }
}
```

- `response.request_id` 必须与对应 `control_request` 的 `request_id` 一致。
- 成功时 `subtype` 为 `success`，且 `response` 为 `PermissionResult`：`allow` 时可带 `updatedInput` 覆盖工具入参，`deny` 时带 `message`。
- 出错时 `subtype` 为 `error`，用 `error` 字符串描述原因。

### 2.3 control_cancel_request（CLI → cc-portal，经 stdout）

CLI 取消某次权限请求时发出（例如用户中断），cc-portal 应中止对该 `request_id` 的等待并清理状态。

```json
{
  "type": "control_cancel_request",
  "request_id": "<要取消的 request_id>"
}
```

---

## 3. cc-portal 侧流程

### 3.1 读循环（stdout）

- `ClaudeAgentBackend` 使用 `readline` 按行读取子进程 **stdout**。
- 每行解析为 JSON 后：
  - `type === 'control_request'` → 调用 `handleControlRequest(msg)`（不 await，避免阻塞读循环）。
  - `type === 'control_cancel_request'` → 从 `cancelControllers` 取出对应 `AbortController` 并 `abort()`，删除该 request_id。
  - `type === 'control_response'` → 当前实现仅忽略（由 CLI 内部使用）。
  - 其他类型 → 入队 `messageQueue`，供 `queryStream` / `query` 消费。

### 3.2 handleControlRequest（处理权限决策）

1. 为本次 `request_id` 创建 `AbortController`，存入 `cancelControllers`（便于被 cancel 时中止）。
2. 仅处理 `request.subtype === 'can_use_tool'`，否则抛错。
3. 按优先级决定结果 `PermissionResult`：
   - `permissionMode === 'bypassPermissions'` → 直接 `allow`。
   - `isToolAutoAllow(toolName, input)`（如匹配 `autoAllowToolPatterns` 或 `isAutoAllowTool`）→ 直接 `allow`。
   - 若配置了 `canCallTool` → 调用 `await canCallTool(toolName, input, { signal })`，用其返回的 `PermissionResult`。
   - 若配置了 `permissionResolver`（HTTP 审批）：
     - 先 `emit('permissionRequest', { requestId, toolName, input })`（供 SSE 推送 `permission_request` 等）。
     - 再 `await permissionResolver(requestId, toolName, input)`，用其返回的 `PermissionResult`（或 catch 后返回 deny）。
   - 否则 → 返回 `deny`（无审批途径）。
4. 构造 `control_response`（success 或 error），通过 **`writeAndFlushStdin(payload)`** 写入子进程 stdin，并 **await** 确保写完再返回。
5. 在 `finally` 中从 `cancelControllers` 删除该 `request_id`。

### 3.3 两种审批方式

| 方式 | 配置 | 行为 |
|------|------|------|
| **程序内回调** | `canCallTool(toolName, input, { signal }) => Promise<PermissionResult>` | Backend 直接 await 回调结果，然后写 control_response。 |
| **HTTP 审批** | `permissionResolver` 由 Session 提供，内部是 `waitForPermission` | Backend emit `permissionRequest`，Session 把请求挂到 `pendingPermissions`；前端收到 SSE `permission_request` 后调 `POST /sessions/:id/permissions/:requestId`，Session 调 `respondToPermission(requestId, result)` 使 Promise resolve，Backend 拿到结果后写 control_response。 |

无论哪种方式，最终都由 `ClaudeAgentBackend.handleControlRequest` 向 stdin 写同一格式的 `control_response`。

### 3.4 写 stdin 与冲刷

- 使用 **`writeAndFlushStdin(payload)`**：`child.stdin.write(payload, callback)`，在 **callback 被调用后再 resolve**，保证该行已从 Node 缓冲写出，便于 CLI 在 stdin 上读到完整一行。
- 所有 control_response（成功/失败）都通过该方法写入，避免“写了但子进程还没读到”的时序问题。

---

## 4. 类型定义参考（sdk-types.ts）

```ts
// 请求（CLI → 我们）
interface CanUseToolControlRequest {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: 'can_use_tool';
    tool_name: string;
    input: unknown;
  };
}

// 响应（我们 → CLI）
interface CanUseToolControlResponse {
  type: 'control_response';
  response: {
    subtype: 'success' | 'error';
    request_id: string;
    response?: PermissionResult;  // success 时
    error?: string;               // error 时
  };
}

type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
```

---

## 5. 流程简图（文字）

```
[Claude CLI 子进程]                    [cc-portal]
        |                                    |
        |  stdout: control_request           |
        |  (request_id, can_use_tool,       |
        |   tool_name, input)               |
        | ---------------------------------->  readline 解析
        |                                    | → handleControlRequest
        |                                    |   → canCallTool 或 permissionResolver
        |                                    |   → 得到 PermissionResult
        |  stdin: control_response           |
        |  (request_id, success/error,      |
        |   response/error)                 |
        | <----------------------------------  writeAndFlushStdin
        |                                    |
        |  继续执行工具 / 取消工具             |
```

---

## 6. 相关代码位置

- **Backend 读/写**：`ClaudeAgentBackend.ts` — `startReadLoop`（按行解析、分发 control_request/control_cancel_request）、`handleControlRequest`（决策并写 control_response）、`writeAndFlushStdin`（写 stdin 并等待 flush）。
- **启动参数**：`doInitialize` 中 `needPermissionStdio === true` 时使用 `claude`、添加 `--permission-prompt-tool stdio`。
- **Session 侧**：`ClaudeSession.ts` — `waitForPermission`（挂起 Promise）、`respondToPermission`（HTTP 审批时解析）。
- **类型**：`sdk-types.ts` — `CanUseToolControlRequest`、`CanUseToolControlResponse`、`PermissionResult`。
