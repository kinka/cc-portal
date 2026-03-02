# CC-Portal 共享 Session（群聊模式）架构文档

## 1. 架构概述

### 1.1 设计理念

**共享 Session（群聊模式）** 允许多个用户共享同一个 Claude CLI Session，实现真正的实时协作。所有参与者在同一个对话上下文中，可以看到彼此的消息和 Claude 的回复。

### 1.2 核心特性

- 👥 **多用户共享**: 一个 Session 支持最多 200 个参与者
- 💬 **实时同步**: 所有参与者通过 SSE 流实时接收消息
- 🏷️ **身份标识**: 每条消息包含 `from` 字段标识发送者
- 🔐 **权限控制**: 基于邀请制的加入机制
- 📡 **流式响应**: Claude 的回复通过 SSE 实时推送给所有参与者

---

## 2. 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HTTP API (Fastify)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  POST /sessions                    GET  /sessions/:id/stream (SSE)          │
│  POST /sessions/:id/invite         GET  /sessions/:id/participants          │
│  POST /sessions/:id/join           GET  /my/shared-sessions                 │
│  POST /sessions/:id/messages                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ClaudeSessionManager                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  - Session 生命周期管理                                                      │
│  - 权限验证 (canAccessSession)                                              │
│  - 参与者管理                                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│     ClaudeSession      │ │      Database         │ │   SessionRegistry     │
│  ┌─────────────────┐  │ │  ┌─────────────────┐  │ │  ┌─────────────────┐  │
│  │ EventEmitter    │  │ │  │ users           │  │ │  │ session Map     │  │
│  │ - messages[]    │  │ │  │ - id            │  │ │  │ - metadata      │  │
│  │ - pendingQueue  │  │ │  │ - max_sessions  │  │ │  │ - participants  │  │
│  │ - broadcast()   │  │ │  └─────────────────┘  │ │  └─────────────────┘  │
│  └─────────────────┘  │ │                       │ │                       │
│         │             │ │  ┌─────────────────┐  │ └───────────────────────┘
│         ▼             │ │  │ sessions        │  │
│  ┌─────────────────┐  │ │  │ - id            │  │
│  │ClaudeAgentBackend│  │ │  │ - owner_id      │  │
│  │ - claude process│  │ │  │ - path          │  │
│  │ - stdin/stdout  │  │ │  │ - status        │  │
│  └─────────────────┘  │ │  └─────────────────┘  │
└───────────────────────┘ │                       │
                          │  ┌─────────────────┐  │
                          │  │session_participants│
                          │  │ - session_id    │  │
                          │  │ - user_id       │  │
                          │  │ - status        │  │
                          │  │ - invited_at    │  │
                          │  │ - joined_at     │  │
                          │  └─────────────────┘  │
                          └───────────────────────┘
```

---

## 3. 数据流

### 3.1 创建共享 Session

```
Alice                        Server                        Database
  │                            │                              │
  ├─ POST /sessions ──────────▶│                              │
  │  { path?: string }         │                              │
  │                            ├─ createSession() ───────────▶│
  │                            │                              ├─ INSERT sessions
  │                            │                              │   (owner=alice)
  │                            │◀─────────────────────────────┤
  │◀───────────────────────────┤                              │
  │  { sessionId: xxx }        │                              │
  │                            │                              │
```

### 3.2 邀请参与者

```
Alice                        Server                        Database
  │                            │                              │
  ├─ POST /sessions/:id/invite▶│                              │
  │  { userId: "bob" }         ├─ inviteParticipant() ──────▶│
  │                            │                              ├─ INSERT 
  │                            │                              │   session_participants
  │                            │                              │   (status=pending)
  │                            │◀─────────────────────────────┤
  │◀───────────────────────────┤                              │
  │  { success: true }         │                              │
```

### 3.3 接受邀请加入

```
Bob                          Server                        Database
  │                            │                              │
  ├─ POST /sessions/:id/join ─▶│                              │
  │  (headers: X-User-ID: bob) ├─ acceptInvitation() ────────▶│
  │                            │                              ├─ UPDATE
  │                            │                              │   session_participants
  │                            │                              │   (status=joined)
  │                            │◀─────────────────────────────┤
  │◀───────────────────────────┤                              │
  │  { success: true }         │                              │
  │                            │                              │
```

### 3.4 发送消息（群聊）

```
Alice                        Server        ClaudeSession     Other Users
  │                            │                  │               │
  ├─ POST /sessions/:id/msg ─▶│                  │               │
  │  { message, from }         ├─ broadcast() ────┤               │
  │                            │                  ├─ send to Claude│
  │                            │                  │               │
  │                            │◀─ SSE chunks ────┤               │
  │                            │   (text chunks)  │               │
  │                            │                  │               │
  │◀─ SSE: text chunks ────────┤                  │               │
  │                            ├─ broadcast SSE ─────────────────▶│
  │                            │  to all participants             │
  │                            │                  │               │
Bob◀─ SSE: text chunks ────────┤                  │               │
  │                            │                  │               │
```

---

## 4. 数据库设计

### 4.1 表结构

```sql
-- 用户表
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  max_sessions INTEGER DEFAULT 200,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Session 表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- Session 参与者表（核心新增）
CREATE TABLE session_participants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | joined
  invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  joined_at DATETIME,
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 4.2 权限模型

```typescript
// 访问控制逻辑
function canAccessSession(sessionId: string, userId: string): boolean {
  // 1. 检查是否是所有者
  if (session.ownerId === userId) return true;
  
  // 2. 检查是否是已加入的参与者
  const participant = db.query(
    'SELECT status FROM session_participants WHERE session_id = ? AND user_id = ?',
    [sessionId, userId]
  );
  return participant?.status === 'joined';
}
```

---

## 5. API 设计

### 5.1 核心 Session API

| 方法 | 路径 | 描述 | 权限 |
|------|------|------|------|
| GET | `/sessions` | 列出当前用户的会话列表 | 任意用户 |
| POST | `/sessions` | 创建 Session（自动成为所有者） | 任意用户 |
| GET | `/sessions/:id` | 获取会话元数据（不含消息） | 参与者 |
| GET | `/sessions/:id/messages` | 获取消息历史（从 CLI 存储加载） | 参与者 |
| POST | `/sessions/:id/messages` | 发送消息（等待完整响应） | 参与者 |
| GET | `/sessions/:id/stream` | SSE 流式接收消息 | 参与者 |
| DELETE | `/sessions/:id` | 删除会话 | 参与者 |

### 5.2 查询参数说明

#### `GET /sessions/:id/messages`

| 参数 | 类型 | 说明 |
|------|------|------|
| `detailed` | boolean | 返回完整历史（包含 `tool_use`、`tool_result`） |
| `limit` | number | 限制返回消息数量（返回最新的 N 条） |

**响应示例（简化模式）**:
```json
{
  "sessionId": "xxx",
  "source": "cli",
  "detailed": false,
  "count": 5,
  "messages": [
    {"role": "user", "content": "你好", "timestamp": "..."},
    {"role": "assistant", "content": "你好！有什么可以帮助你的吗？", "timestamp": "..."}
  ]
}
```

**响应示例（详细模式）**:
```json
{
  "sessionId": "xxx",
  "source": "cli",
  "detailed": true,
  "count": 8,
  "messages": [
    {"type": "user", ...},
    {"type": "tool_use", "tool_name": "Bash", "tool_input": {...}, ...},
    {"type": "tool_result", "tool_output": {...}, ...},
    {"type": "assistant", ...}
  ]
}
```

---

## 6. 数据来源

### 6.1 Claude CLI 本地存储

Claude CLI 在 `~/.claude/projects/{project-hash}/{sessionId}.jsonl` 中存储完整的对话历史，包括：
- 用户消息 (`type: "user"`)
- 助手消息 (`type: "assistant"`)
- 工具调用 (`type: "tool_use"`)
- 工具结果 (`type: "tool_result"`)
- 系统事件 (`type: "system"`)

**本项目以 CLI 本地存储为数据源（Source of Truth）**：
- `GET /sessions/:id/messages` - 从 CLI jsonl 文件加载历史
- 支持 `?detailed=true` 获取完整历史（包含工具调用）
- 支持 `?limit=10` 获取最近的 N 条消息

### 6.2 内存缓存

`ClaudeSession.messages` 数组在会话期间缓存消息，用于：
- 构建 prompt 上下文
- 快速访问最近的消息
- 作为 CLI 文件写入前的临时存储

---

## 7. 前端实现

### 6.1 Demo 页面

| 文件 | 功能 |
|------|------|
| `chat-demo.html` | Alice & Bob 双用户共享 Session 演示 |
| `simple-demo.html` | 单用户模式，支持 URL 指定用户 |

### 6.2 关键交互

```javascript
// 1. 创建共享 Session
const session = await api('POST', '/sessions', { project: 'demo' }, 'alice');

// 2. 邀请 Bob
await api('POST', `/sessions/${sessionId}/invite`, { userId: 'bob' }, 'alice');

// 3. Bob 加入
await api('POST', `/sessions/${sessionId}/join`, {}, 'bob');

// 4. 连接 SSE 流
const es = new EventSource(`/sessions/${sessionId}/stream?userId=alice`);
es.onmessage = (event) => {
  const chunk = JSON.parse(event.data);
  if (chunk.type === 'text') {
    displayMessage(chunk.content, chunk.from);
  }
};

// 5. 发送消息
await api('POST', `/sessions/${sessionId}/messages`, {
  message: '你好！',
  from: 'alice'
}, 'alice');
```

---

## 7. 配置变更

### 7.1 会话配额

```typescript
// middleware/auth.ts
defaultMaxSessions = 200  // 从 5 提升到 200

// db.ts
max_sessions INTEGER DEFAULT 200
```

### 7.2 路径策略

```typescript
// 移除路径限制，支持任意路径
resolveUserPath(ownerId: string, path?: string): string {
  if (!path) {
    return userDir;  // 默认使用用户目录
  }
  if (isAbsolute(path)) {
    return normalize(path);  // 直接使用绝对路径
  }
  return normalize(resolve(userDir, path));  // 相对路径基于用户目录
}
```

---

## 8. 技术要点

### 8.1 消息广播机制

```typescript
// ClaudeSession.ts
async sendMessageStream(message: string, from?: string) {
  // 1. 添加消息到历史
  this.addMessage({ role: 'user', content: message, from });
  
  // 2. 发送给 Claude
  const stream = this.backend.queryStream(message);
  
  // 3. 流式返回
  for await (const chunk of stream) {
    yield { ...chunk, from: 'claude' };
  }
}
```

### 8.2 并发控制

- 每个 Session 同时只能处理一个消息请求
- 使用 `sessionLoadingLocks` 防止重复加载
- SSE 连接独立，支持多个客户端同时监听

### 8.3 安全性

- X-User-ID 头部验证用户身份
- 只有所有者和已加入参与者可以访问 Session
- 邀请机制防止未授权加入

---

## 9. 部署与运行

```bash
# 1. 安装依赖
bun install

# 2. 启动服务
bun run dev

# 3. 打开 Demo
open http://localhost:3333/Demo/chat-demo.html

# 或使用 simple-demo 并指定用户
open http://localhost:3333/Demo/simple-demo.html?user=alice
```

---

## 10. 未来扩展

- [ ] 参与者离开 Session
- [ ] 所有者踢出参与者
- [ ] 只读模式参与者
- [ ] 消息编辑/删除
- [ ] 历史消息分页加载
- [ ] WebSocket 替代 SSE（更低延迟）
