# 多用户感知 + Agent 发现能力：手动验证指南

## 功能概述

本文档描述如何验证以下能力：

1. **多用户感知**：Claude 在多用户 session 中能识别当前发言者、所有参与者、及 session 归属
2. **Agent 发现**：Claude 在 prompt 中收到 CC-Agents API 地址和认证信息，可通过内置工具自主调用

---

## 前置条件

- Bun 运行环境
- `@anthropic-ai/claude-code` 已安装并完成认证（E2E 测试需要）
- 项目依赖已安装：`bun install`

---

## 步骤一：启动服务

```bash
# 使用默认端口 3333
bun run dev

# 如果 3333 端口已占用，指定其他端口
PORT=3334 CC_AGENTS_URL=http://localhost:3334 bun run dev
```

服务启动后日志输出形如：

```
INFO: Server listening at http://127.0.0.1:3334
INFO: Claude Agent HTTP Service running
```

> `CC_AGENTS_URL` 是注入给每个 session 的 API 基础地址。不设置时默认为 `http://localhost:PORT`。

---

## 步骤二：Alice 创建 Session

```bash
SESSION=$(curl -s -X POST http://localhost:3334/sessions \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"permissionMode":"bypassPermissions"}')

echo $SESSION
SESSION_ID=$(echo $SESSION | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")
echo "SESSION_ID=$SESSION_ID"
```

预期响应：

```json
{
  "sessionId": "c9f9d682-b020-422a-8c8f-941623219051",
  "path": "/Users/.../users/alice",
  "createdAt": "2026-02-25T08:41:28.234Z",
  "quota": { "max": 5, "used": 1 }
}
```

此时 session 内部处于**单用户状态**（participants 为空），发消息时不会注入 Session Context header。

---

## 步骤三：Alice 将 Bob 加入 Session

```bash
curl -s -X POST http://localhost:3334/sessions/$SESSION_ID/participants \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"userId":"bob"}'
```

预期响应：

```json
{ "success": true }
```

此操作同时更新数据库和内存中的 `participants` 集合。之后所有消息都会触发多用户 Session Context 注入。

---

## 步骤四：确认参与者列表

```bash
curl -s http://localhost:3334/sessions/$SESSION_ID/participants \
  -H "X-User-ID: alice"
```

预期响应：

```json
{
  "ownerId": "alice",
  "participants": [
    { "userId": "bob", "status": "joined", "joinedAt": "2026-02-25T08:41:49.490Z" }
  ],
  "pending": []
}
```

---

## 步骤五：Bob 发消息

```bash
curl -s -X POST http://localhost:3334/sessions/$SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -H "X-User-ID: bob" \
  -d '{"message":"请用一句话介绍你自己，并告诉我你知道谁在参与这个会话","from":"bob"}'
```

Claude 实际接收到的 prompt（非用户可见）：

```
[Session Context]
CC-Agents API: http://localhost:3334
Auth header: X-User-ID: alice
Your session ID: c9f9d682-b020-422a-8c8f-941623219051

This is a multi-user session.
Owner: alice
Participants: alice, bob
Current speaker: bob

[bob]: 请用一句话介绍你自己，并告诉我你知道谁在参与这个会话
```

Claude 的回复应能提及：
- 当前发言者是 **bob**
- 会话参与者为 **alice** 和 **bob**

---

## 步骤六：验证历史消息干净性

```bash
curl -s http://localhost:3334/sessions/$SESSION_ID \
  -H "X-User-ID: alice" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
print(f'消息数量: {len(msgs)}')
for m in msgs:
    has_header = '[Session Context]' in m['content']
    print(f\"  [{m['role']}] from={m.get('from','')} | header污染={has_header} | content={repr(m['content'][:80])}\")
"
```

**预期**：所有 `user` 消息的 `content` 不含 `[Session Context]`，`from` 字段正确记录发言者：

```
消息数量: 2
  [user] from=bob | header污染=False | content='请用一句话介绍你自己，并告诉我你知道谁在参与这个会话'
  [assistant] from= | header污染=False | content='我是 Claude，...'
```

---

## 步骤七：验证 Agent 发现能力

让 Alice 指示 Claude 通过 Bash 工具调用自身 API：

```bash
curl -s -X POST http://localhost:3334/sessions/$SESSION_ID/messages \
  -H "Content-Type: application/json" \
  -H "X-User-ID: alice" \
  -d '{"message":"用 curl 列出我的所有 session，API 地址和认证信息在 Session Context 里","from":"alice"}'
```

Claude 应能执行类似以下的 Bash 调用：

```bash
curl http://localhost:3334/sessions -H "X-User-ID: alice"
```

并返回当前用户的 session 列表。

> 此功能需要 Claude 有 `Bash` 工具权限（`permissionMode` 不为 `bypassPermissions` 时需手动批准）。

---

## 自动化验证（无需 Claude CLI）

以下命令不依赖真实 Claude 进程，可直接验证 prompt 构建逻辑：

```bash
bun run - << 'EOF'
import { ClaudeSession } from './src/ClaudeSession';

const ctx = {
  apiBaseUrl: 'http://localhost:3334',
  userId: 'alice',
  sessionId: 'test-session-id',
  ownerId: 'alice',
  participants: ['alice', 'bob'],
};

// 多用户：Bob 发消息
console.log('=== 多用户 prompt ===');
console.log(ClaudeSession.buildPrompt('帮我看一下这段代码', 'bob', ctx));

// 单用户：仅 owner 时不注入 header
console.log('\n=== 单用户 prompt ===');
const singleCtx = { ...ctx, participants: ['alice'] };
console.log(ClaudeSession.buildPrompt('你好', 'alice', singleCtx));
EOF
```

运行单元测试：

```bash
bun test
# 预期：51 pass, 4 skip, 0 fail
```

---

## 预期行为速查

| 场景 | participants.length | prompt 是否含 [Session Context] | messages[n].content 是否含 header |
|------|--------------------|---------------------------------|----------------------------------|
| 单用户（无参与者） | 1 | 否 | 否 |
| 多用户（已加入参与者） | ≥ 2 | 是 | 否（存储原始内容） |
| 无 from 字段 | - | 取决于 participants | 否 |
