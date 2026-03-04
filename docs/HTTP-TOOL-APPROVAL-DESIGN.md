# HTTP 工具审批功能设计

当通过 HTTP 使用 cc-portal 且 `permissionMode` 不为 `bypassPermissions` 时，无法传入 `canCallTool` 回调。本设计通过「待审批队列 + 审批接口」让前端/客户端在收到工具请求后，通过 HTTP 批准或拒绝。

---

## 1. 流程概览

```
Claude 子进程                Backend                     Session                      HTTP 客户端
     |                          |                            |                               |
     | control_request          |                            |                               |
     | (can_use_tool) ---------->| handleControlRequest       |                               |
     |                          | permissionResolver?        |                               |
     |                          | (no canCallTool) --------->| waitForPermission()           |
     |                          |                            | 存入 pendingPermissions       |
     |                          |                            | return Promise (pending)      |
     |                          | (await...)                 |                               |
     |                          |                            |     GET /pending-permissions  |
     |                          |                            | <-----------------------------|
     |                          |                            | 返回 [{ requestId, toolName, input }]
     |                          |                            |                               |
     |                          |                            |     POST /permissions/:id     |
     |                          |                            |     { approved, updatedInput }|
     |                          |                            | respondToPermission() ------->|
     |                          | Promise resolved           |                               |
     |                          | <--------------------------|                               |
     | control_response         |                            |                               |
     | <-------------------------| write(stdin)               |                               |
     | 继续执行工具...            |                            |                               |
```

- Backend 收到 `control_request` 时，若未配置 `canCallTool`，则调用可选的 **permissionResolver** 取得 `Promise<PermissionResult>`。
- Session 实现 permissionResolver：将本次请求放入 **待审批队列**，并返回一个 Promise，该 Promise 在客户端调用 **POST /permissions/:requestId** 时被 resolve。
- 客户端可先 **GET /pending-permissions** 轮询或配合 SSE 展示待审批列表，用户操作后再 **POST /permissions/:requestId** 完成审批。

---

## 2. 数据模型

### 2.1 待审批项（Session 内）

```ts
interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  createdAt: Date;  // ISO string 对外
  resolve: (result: PermissionResult) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}
```

- 用 `Map<requestId, PendingPermission>` 存储；resolve 后从 map 中删除。

### 2.2 PermissionResult（已有）

```ts
type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
```

---

## 3. 组件职责

### 3.1 ClaudeAgentBackend

- 新增可选参数：**permissionResolver**: `(requestId, toolName, input) => Promise<PermissionResult>`。
- 在 `handleControlRequest` 中：
  - 若有 `canCallTool`：行为不变，继续用 callback。
  - 若无 `canCallTool` 但有 **permissionResolver**：`response = await permissionResolver(request_id, tool_name, input)`；若 reject 或抛错，则视为拒绝并回写 `control_response`（deny）。
  - 若两者皆无：继续当前逻辑，直接回写 deny。

### 3.2 ClaudeSession

- **pendingPermissions**: `Map<string, PendingPermission>`（仅在有 pending 时存在条目）。
- **waitForPermission(requestId, toolName, input)**:  
  - 创建 Promise，将 resolve/reject 与 requestId/toolName/input/createdAt 存入 map。  
  - 可选：设置超时（如 5 分钟），超时则 reject 并从 map 删除。  
  - 返回该 Promise。
- **respondToPermission(requestId, result)**:  
  - 从 map 中取出对应项，调用 `resolve(result)`，清除 timeout（若有），并从 map 删除。  
  - 若 requestId 不存在或已处理，返回 false 或抛错，由上层返回 404。
- **listPendingPermissions()**: 返回 `{ requestId, toolName, input, createdAt }[]`，供 GET 使用。
- 构造 Backend 时：若未传 `canCallTool`，则传入 `permissionResolver: (rid, name, input) => this.waitForPermission(rid, name, input)`（仅在非 bypass 时需要；若为 bypass 则不会收到 control_request）。

### 3.3 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sessions/:sessionId/pending-permissions` | 返回该 session 当前待审批列表。无 pending 时返回 `{ pending: [] }`。 |
| POST | `/sessions/:sessionId/permissions/:requestId` | 对指定 requestId 完成审批。Body: `{ approved: boolean, updatedInput?: Record<string, unknown>, message?: string }`。approved 时可将修改后的工具入参通过 updatedInput 传回；deny 时可选 message。返回 200 { ok: true } 或 404（requestId 无效/已处理/session 不存在）。 |

- **超时**：由 Session 侧实现；超时后 Promise reject，Backend 捕获后向 Claude 回写 deny，并可从 pending 中移除，无需单独 HTTP 接口。

---

## 4. 错误与边界

- **requestId 不存在或已响应**：POST 返回 404，Body 可带 `{ error: 'request_not_found_or_already_responded' }`。
- **Session 不存在**：GET/POST 均 404。
- **超时**：Session 内 reject Promise，Backend 发送 deny；GET pending-permissions 不再包含该项（已从 map 删除）。
- **Session 已 stop**：若仍有 pending，respondToPermission 仍可调用并 resolve，避免子进程一直卡住；若进程已销毁，写 stdin 可能无效，可忽略或记录日志。

---

## 5. 配置与可选参数

- **审批超时时间**：建议可配置（如 `permissionTimeoutMs`，默认 300_000），在 Session 或 CreateSessionOptions 中传入，用于 `waitForPermission` 的 setTimeout。
- **permissionMode**：仅当不为 `bypassPermissions` 时才会收到 control_request，因此审批接口仅在非 bypass 模式下有意义；bypass 时 GET 恒返回 `{ pending: [] }`。

---

## 6. 实现顺序建议

1. **Backend**：增加 `permissionResolver` 选项及 handleControlRequest 中的分支。
2. **Session**：实现 `waitForPermission`、`respondToPermission`、`listPendingPermissions`，以及可选的超时；在构造 Backend 时注入 permissionResolver（未传 canCallTool 时）。
3. **HTTP**：实现 GET `/sessions/:sessionId/pending-permissions` 与 POST `/sessions/:sessionId/permissions/:requestId`。
4. **文档**：在 README 或 ALIGNMENT 中补充「HTTP 下工具审批」用法与示例。

完成以上后，HTTP 客户端即可先轮询或监听 pending-permissions，再通过 POST 完成审批，与「程序化 canCallTool」行为对齐。

---

## 7. 流式权限审批流程（/stream 端点）

当使用 SSE 流式端点 `GET /sessions/:id/stream` 时，权限请求采用「流中断 + 重连」模式：

### 7.1 流程图

```
客户端                       Backend                    Claude 子进程
   |                            |                            |
   | GET /stream?message=xxx    |                            |
   |--------------------------->|                            |
   |                            | spawn / send message       |
   |                            |--------------------------->|
   |                            |                            |
   | SSE chunks (text/log...)   |                            |
   |<---------------------------| stdout chunks              |
   |                            |<---------------------------|
   |                            |                            |
   |                            | control_request (can_use_tool)
   |                            |<---------------------------|
   |                            | permissionResolver()       |
   |                            | await Promise...           |
   |                            |                            |
   | permission_request chunk   |                            |
   | { approvalUrl, ... }       |                            |
   |<---------------------------|                            |
   |                            |                            |
   | [STREAM CLOSES]            | (Promise pending...)       |
   |                            |                            |
   | 用户确认对话框               |                            |
   |                            |                            |
   | POST /permissions/:id      |                            |
   | { approved: true }         |                            |
   |--------------------------->|                            |
   |                            | Promise resolved           |
   |                            | control_response           |
   |                            |--------------------------->|
   |                            |                            |
   | GET /stream (无 message)   | 继续执行工具...              |
   |--------------------------->| stdout chunks              |
   |                            |<---------------------------|
   | SSE chunks (续)            |                            |
   |<---------------------------|                            |
   |                            |                            |
   | [DONE]                     |                            |
   |<---------------------------|                            |
```

### 7.2 permission_request Chunk 格式

当 Claude 请求使用需要审批的工具时，`/stream` 会发送以下 chunk 并**关闭流**：

```json
{
  "type": "permission_request",
  "requestId": "req_abc123",
  "toolName": "Bash",
  "toolInput": { "command": "rm -rf /" },
  "content": "Claude requests to use tool: Bash",
  "sessionId": "sess_xyz",
  "approvalUrl": "/sessions/sess_xyz/permissions/req_abc123",
  "approvalMethod": "POST",
  "approvalBody": {
    "approved": true,
    "updatedInput": {},
    "message": "optional reason for denial"
  },
  "reconnectHint": "Reconnect to /stream without message parameter to continue after approval."
}
```

### 7.3 客户端处理流程

```javascript
const eventSource = new EventSource('/sessions/xxx/stream?message=hello');

eventSource.onmessage = (event) => {
  if (event.data === '[DONE]') {
    eventSource.close();
    return;
  }
  
  const chunk = JSON.parse(event.data);
  
  if (chunk.type === 'permission_request') {
    // 流会自动关闭
    eventSource.close();
    
    // 显示确认对话框
    showPermissionDialog({
      toolName: chunk.toolName,
      toolInput: chunk.toolInput,
      onApprove: async () => {
        // 发送审批
        await fetch(chunk.approvalUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true })
        });
        
        // 重新连接流继续对话（不传 message）
        reconnectStream();
      },
      onDeny: async () => {
        await fetch(chunk.approvalUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: false, message: '用户拒绝' })
        });
        
        // 重新连接流继续对话
        reconnectStream();
      }
    });
  }
};
```

### 7.4 关键点

1. **流中断**：`permission_request` chunk 发送后，SSE 流会立即关闭。这是设计行为，非错误。

2. **重连机制**：审批完成后，客户端需要重新发起 `GET /stream`，**不传 message 参数**，以继续当前对话。

3. **审批有效期**：审批 Promise 在 Session 中等待，直到：
   - 客户端 POST 审批结果
   - 超时（默认 5 分钟）

4. **多轮审批**：如果一次对话中有多个工具需要审批，每次都会触发流中断，客户端依次处理。

---

## 8. 与原设计的差异

| 项目 | 原设计 | 新实现 |
|------|--------|--------|
| /stream 遇到 permission_request | 继续保持连接，yield chunk 后 continue | 发送 chunk 后关闭流 |
| 客户端处理 | 监听流的同时处理审批 | 审批后重新连接流 |
| 优势 | 单次连接 | 简化前端逻辑，避免长连接等待 |
| 劣势 | 前端需要处理并行的流+审批 | 多次连接开销 |

---

## 9. API 参考

### 9.1 创建 Session（启用权限审批）

```bash
POST /sessions
Content-Type: application/json

{
  "path": "/path/to/project",
  "permissionMode": "default",  // 或 "acceptEdits"、"plan"
  "autoAllowToolPatterns": [],  // 可选，默认只读工具自动放行
  "permissionTimeoutMs": 300000  // 可选，默认 5 分钟
}
```

### 9.2 流式消息（含权限审批）

```bash
# 发送消息
GET /sessions/:sessionId/stream?message=你的消息

# 审批后重连（继续对话）
GET /sessions/:sessionId/stream
```

### 9.3 审批接口

```bash
# 批准
POST /sessions/:sessionId/permissions/:requestId
Content-Type: application/json

{ "approved": true, "updatedInput": {} }

# 拒绝
POST /sessions/:sessionId/permissions/:requestId
Content-Type: application/json

{ "approved": false, "message": "拒绝原因" }
```

### 9.4 查看待审批列表（轮询模式，可选）

```bash
GET /sessions/:sessionId/pending-permissions

# 返回
{ "pending": [{ "requestId", "toolName", "input", "createdAt" }] }
```

---

## 10. 自动放行规则

默认情况下，以下工具**无需审批**，自动放行：

- `Read` - 读取文件
- `mcp__*__*get*` - MCP get 操作
- `mcp__*__*read*` - MCP read 操作  
- `mcp__*__*search*` - MCP search 操作
- `mcp__*__*fetch*` - MCP fetch 操作
- `mcp__*__*list*` - MCP list 操作

可通过 `autoAllowToolPatterns` 自定义：

```json
{
  "autoAllowToolPatterns": ["Read", "Bash:ls *", "mcp__jira__*"]
}
```

---

## 11. 错误处理

| 错误场景 | HTTP 状态 | 响应 |
|----------|----------|------|
| requestId 无效/已处理 | 404 | `{ "error": "request_not_found" }` |
| Session 不存在 | 404 | `{ "error": "Session not found" }` |
| 审批超时 | - | Promise reject，Claude 收到 deny |
| 流中断后未重连 | - | 对话暂停，待审批项保留 |

---

## 12. 进程崩溃恢复

### 12.1 场景说明

当 Claude 子进程在等待权限审批时意外终止（OOM、网络问题、手动 kill 等）：

```
T0: GET /stream?message=xxx
T1: permission_request chunk → 流关闭
T2: Claude 子进程崩溃
T3: 用户看到确认对话框
T4: 用户点击「允许」→ POST /permissions/:id
    → requestId 已被清理，返回 404
    或
    用户直接点击「重试」→ 重新发送消息
```

### 12.2 自动清理机制

子进程崩溃时，Backend 会发出 `processDied` 事件，Session 收到后会：

1. 清理所有 pending permissions
2. Reject 所有等待中的 permissionResolver Promise
3. 记录日志

```typescript
// ClaudeAgentBackend.ts
this.child.on('close', (code) => {
  this.isInitialized = false;
  this.emit('processDied', { code });
});

// ClaudeSession.ts
this.backend.on('processDied', () => {
  for (const [requestId, pending] of this.pendingPermissions) {
    pending.reject(new Error('Claude process terminated unexpectedly'));
  }
  this.pendingPermissions.clear();
});
```

### 12.3 用户重试

用户可以通过以下方式恢复：

1. **发送新消息**：`GET /stream?message=xxx`
   - Backend 会检测到 `isInitialized = false`
   - 自动重新 spawn 进程（使用 `--resume` 恢复历史）
   - 对话可以继续

2. **审批失败处理**：
   - 如果审批 POST 返回 404，说明 requestId 已被清理
   - 前端应提示用户重试

### 12.4 前端建议

```javascript
// 审批请求失败时
if (res.status === 404) {
  alert('请求已过期或进程已重启，请重试发送消息');
  // 清理 UI 状态
}

// 用户点击重试
async function retry() {
  // 直接发送新消息，会自动恢复进程
  await streamMessage(originalMessage);
}
```

### 12.5 恢复流程图

```
进程崩溃
    ↓
emit('processDied')
    ↓
Session 清理 pending permissions
    ↓
用户重试：GET /stream?message=xxx
    ↓
initialize() 检测 isInitialized = false
    ↓
重新 spawn 进程（--resume）
    ↓
对话恢复正常 ✅
```
