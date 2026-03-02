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
