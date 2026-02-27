# HTTP API 文档

## 基础信息

- **Base URL**: `http://localhost:3333`
- **认证**: 通过 `X-User-ID` header 或 `userId` 查询参数传递用户 ID

## 会话管理

### `GET /sessions` - 列出所有会话

```bash
curl "http://localhost:3333/sessions?userId=user-b"
```

**响应**:
```json
{
  "sessions": [
    {
      "id": "session-uuid",
      "path": "/project/path",
      "createdAt": "2026-02-27T10:00:00.000Z",
      "status": "active",
      "ownerId": "user-a"
    }
  ]
}
```

---

### `POST /sessions` - 创建会话

```bash
curl -X POST "http://localhost:3333/sessions?userId=user-b" \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "/path/to/project",
    "model": "sonnet"
  }'
```

**响应**:
```json
{
  "id": "new-session-uuid",
  "path": "/path/to/project",
  "createdAt": "2026-02-27T10:00:00.000Z",
  "ownerId": "user-b"
}
```

---

### `GET /sessions/:sessionId` - 获取会话信息

```bash
curl "http://localhost:3333/sessions/SESSION_ID?userId=user-b"
```

**响应**:
```json
{
  "sessionId": "SESSION_ID",
  "path": "/project/path",
  "createdAt": "2026-02-27T10:00:00.000Z",
  "status": "active"
}
```

> 注意：此端点只返回会话元数据，不包含消息历史。获取消息历史请使用 `GET /sessions/:sessionId/messages`。

---

### `DELETE /sessions/:sessionId` - 删除会话

```bash
curl -X DELETE "http://localhost:3333/sessions/SESSION_ID?userId=user-b"
```

---

## 消息交互

### `POST /sessions/:sessionId/messages` - 发送消息（等待完整响应）

**适用场景**: 简单问答，不需要实时流式输出

```bash
curl -X POST "http://localhost:3333/sessions/SESSION_ID/messages?userId=user-b" \
  -H 'Content-Type: application/json' \
  -d '{"message": "明天深圳天气如何", "from": "user-b"}'
```

**请求体**:
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 要发送的消息内容 |
| `from` | string | 否 | 发送者 ID（默认为 userId） |

**响应**:
```json
{
  "sessionId": "SESSION_ID",
  "response": "明天深圳天气晴朗，气温 20-28°C...",
  "timestamp": "2026-02-27T12:00:00.000Z"
}
```

---

### `GET /sessions/:sessionId/messages` - 查询消息历史

**适用场景**: 查询历史对话，支持分页和过滤

```bash
# 获取所有消息
curl "http://localhost:3333/sessions/SESSION_ID/messages?userId=user-b"

# 获取最近 10 条
curl "http://localhost:3333/sessions/SESSION_ID/messages?userId=user-b&limit=10"

# 获取完整历史（含工具调用）
curl "http://localhost:3333/sessions/SESSION_ID/messages?userId=user-b&detailed=true"
```

**查询参数**:
| 参数 | 类型 | 说明 |
|------|------|------|
| `detailed` | boolean | 返回完整历史（包含 tool_use, tool_result） |
| `limit` | number | 限制返回消息数量（返回最新的 N 条） |

**响应**:
```json
{
  "sessionId": "SESSION_ID",
  "source": "cli",
  "detailed": false,
  "count": 10,
  "messages": [...]
}
```

---

### `GET /sessions/:sessionId/stream` - 流式消息（SSE）

**适用场景**: 需要实时显示 Claude 的响应（类似 ChatGPT 的打字效果）

```bash
# 监听实时响应
curl -N "http://localhost:3333/sessions/SESSION_ID/stream?message=你好&userId=user-b"

# 不带 message 参数时，仅监听已有的响应（不发送新消息）
curl -N "http://localhost:3333/sessions/SESSION_ID/stream?userId=user-b"
```

**查询参数**:
| 参数 | 类型 | 说明 |
|------|------|------|
| `message` | string | 要发送的消息（可选，无则仅监听） |

**SSE 数据流**:
```
data: {"type":"text-delta","textDelta":"你"}
data: {"type":"text-delta","textDelta":"好"}
data: {"type":"tool-use","toolUse":{"id":"tool-1","name":"Bash","input":{"command":"ls"}}}
data: {"type":"stop","stopReason":"endTurn"}
```

**Chunk 类型**:
| type | 说明 |
|------|------|
| `text-delta` | 文本片段 |
| `tool-use` | 工具调用 |
| `tool-result` | 工具结果 |
| `permission-request` | 需要用户批准工具 |
| `error` | 错误 |
| `stop` | 结束 |

---

## 工具调用审批

当 `permissionMode` 不是 `bypassPermissions` 时，工具调用需要审批：

### `GET /sessions/:sessionId/pending-permissions` - 获取待审批列表

```bash
# 普通查询
curl "http://localhost:3333/sessions/SESSION_ID/pending-permissions?userId=user-b"

# SSE 实时监控
curl -N "http://localhost:3333/sessions/SESSION_ID/pending-permissions?userId=user-b&stream=1"
```

**响应**:
```json
{
  "pending": [
    {
      "requestId": "req-123",
      "toolName": "Bash",
      "input": {"command": "rm -rf /tmp/*"},
      "createdAt": "2026-02-27T12:00:00.000Z"
    }
  ]
}
```

---

### `POST /sessions/:sessionId/permissions/:requestId` - 审批工具调用

```bash
curl -X POST "http://localhost:3333/sessions/SESSION_ID/permissions/req-123?userId=user-b" \
  -H 'Content-Type: application/json' \
  -d '{"approved": true}'
```

**请求体**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `approved` | boolean | 是否批准 |
| `message` | string | 拒绝时的原因（可选） |

---

## 使用示例

### 完整对话流程

```bash
# 1. 创建会话
SESSION_ID=$(curl -X POST "http://localhost:3333/sessions?userId=alice" \
  -H 'Content-Type: application/json' \
  -d '{"path": "/Users/alice/project"}' | jq -r '.id')

# 2. 发送消息（等待响应）
curl -X POST "http://localhost:3333/sessions/$SESSION_ID/messages?userId=alice" \
  -H 'Content-Type: application/json' \
  -d '{"message": "帮我分析项目结构"}'

# 3. 查看历史
curl "http://localhost:3333/sessions/$SESSION_ID/messages?userId=alice"

# 4. 流式对话
curl -N "http://localhost:3333/sessions/$SESSION_ID/stream?message=继续分析&userId=alice"
```

### 前端 SSE 示例

```javascript
const eventSource = new EventSource(
  `http://localhost:3333/sessions/${sessionId}/stream?message=${encodeURIComponent(prompt)}`
);

eventSource.onmessage = (event) => {
  const chunk = JSON.parse(event.data);
  switch (chunk.type) {
    case 'text-delta':
      // 追加文本
      display += chunk.textDelta;
      break;
    case 'tool-use':
      // 显示工具调用
      showToolUse(chunk.toolUse);
      break;
    case 'stop':
      // 对话结束
      eventSource.close();
      break;
    case 'error':
      // 处理错误
      showError(chunk.error);
      eventSource.close();
      break;
  }
};
```

---

## 错误码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 401 | 未认证（缺少 userId） |
| 404 | Session 不存在或无访问权限 |
| 500 | 服务器错误 |
| 503 | 服务未初始化完成 |
