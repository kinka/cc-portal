# 跨 Session 交互与数字分身通信方案（修订版）

## 修订说明

原方案存在以下问题，已修正：

1. **CLAUDE.md 管理与 Claude Code 原生能力重复** — Claude Code 自身已有 CLAUDE.md 机制，无需自建加载/注入逻辑。去掉 ClaudeMdLoader 和 `--append-system-prompt` 注入。
2. **自定义工具无法注册到 Claude CLI** — Claude CLI 的 stream-json 协议不支持动态注册自定义工具。未来通过 MCP Server 实现，本期不做。
3. **保留跨 Session 通信** — 这是 Agent-to-Agent (A2A) 协议的实现，是数字分身场景的核心基础设施。
4. **多租户基础已有** — `X-User-Id` + `DatabaseManager` + `auth middleware` 已实现，直接在此基础上扩展。

---

## 当前架构基线

### 已有能力

```
src/
├── app.ts                    # Fastify 应用，含 buildApp() 和 buildLegacyApp()
├── index.ts                  # 入口
├── ClaudeSession.ts          # Session 封装（EventEmitter），管理消息历史和权限队列
├── ClaudeSessionManager.ts   # Session 管理器，含用户路径隔离和配额检查
├── ClaudeAgentBackend.ts     # 管理 claude CLI 子进程，stream-json 协议
├── db.ts                     # SQLite (bun:sqlite)，users + sessions 表
├── sdk-types.ts              # SDK 类型定义
├── admin-routes.ts           # /admin/* 管理端点
├── middleware/auth.ts        # X-User-Id 认证中间件，自动创建用户
└── logger.ts                 # pino 日志
```

### 已有 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 健康检查 |
| GET | /sessions | 列出用户 Session |
| POST | /sessions | 创建 Session |
| GET | /sessions/:id | Session 详情 |
| POST | /sessions/:id/messages | 发送消息 |
| GET | /sessions/:id/stream | SSE 流式消息 |
| GET | /sessions/:id/pending-permissions | 待审批列表/SSE |
| POST | /sessions/:id/permissions/:reqId | 审批工具调用 |
| DELETE | /sessions/:id | 删除 Session |
| GET/PUT/DELETE | /admin/* | 管理端点 |

### 关键模式

- **EventEmitter**：ClaudeSession 和 ClaudeAgentBackend 都继承 EventEmitter
- **Logger**：`import { createLogger } from './logger'` → `const log = createLogger({ module: 'Name' })`
- **UUID**：`import { randomUUID } from 'node:crypto'`
- **认证**：`requireUserContext(request)` 返回 `{ userId, maxSessions }`
- **SQLite**：bun:sqlite 同步查询，DatabaseManager 封装
- **Session 配额**：每个用户有 maxSessions 限制
- **进程复用**：每个 Session 一个 claude 子进程，多轮复用

---

## 本期目标

实现 HTTP 层的 Agent-to-Agent 通信基础设施：

1. **用户文件管理** — 用户维度的文件存储（记忆、项目上下文等），纯 CRUD
2. **跨 Session 消息路由** — 同用户的不同 Session 之间通信
3. **跨用户通信** — 不同用户之间的通知和消息
4. **Session 直连** — 两个 Session 建立双向通道，实时对话

**不做的事**：
- 不修改 ClaudeSession / ClaudeAgentBackend（不注入 system prompt、不注册工具）
- 不实现 MCP Server（后续单独做）
- 不自建 CLAUDE.md 管理逻辑（利用 Claude Code 原生能力）

---

## 新增文件结构

```
src/
├── (现有文件不动)
├── userFiles/
│   └── UserFileManager.ts          # 用户文件 CRUD
├── crossSession/
│   ├── SessionRegistry.ts          # 活跃 Session 注册/发现
│   ├── MessageRouter.ts            # Session 间消息路由
│   ├── UserDirectory.ts            # 用户目录/资料
│   ├── CrossUserNotifier.ts        # 跨用户通知
│   └── SessionLinkManager.ts       # Session 直连管理
└── routes/
    ├── userFileRoutes.ts           # /users/:userId/files/* 端点
    ├── crossSessionRoutes.ts       # /sessions/:id/messages 端点
    ├── crossUserRoutes.ts          # /users/:userId/notify 端点
    └── sessionLinkRoutes.ts        # /sessions/:id/links 端点
```

用户数据目录：
```
~/.claude/users/
├── {userId-a}/
│   ├── core.md                     # 用户核心信息
│   ├── log.md                      # 活跃日志
│   ├── log/
│   │   └── 2024-Q1.md              # 季度归档
│   └── projects/
│       └── project-a.md            # 项目上下文
└── {userId-b}/
    └── ...
```

---

## Phase 1: UserFileManager

### 文件：`src/userFiles/UserFileManager.ts`

纯粹的文件 CRUD 存储层，不含任何 Claude/记忆注入逻辑。

```typescript
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { resolve, join, dirname, relative, normalize } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger';

const log = createLogger({ module: 'UserFileManager' });

export interface UserFile {
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

export class UserFileManager {
  private baseDir: string;
  private writeLocks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir || resolve(homedir(), '.claude', 'users');
  }

  getUserDir(userId: string): string;
  async ensureUserDir(userId: string): Promise<string>;
  async readFile(userId: string, relativePath: string): Promise<string>;
  async writeFile(userId: string, relativePath: string, content: string): Promise<void>;
  async appendFile(userId: string, relativePath: string, content: string): Promise<void>;
  async deleteFile(userId: string, relativePath: string): Promise<void>;
  async listFiles(userId: string): Promise<UserFile[]>;
  async userExists(userId: string): Promise<boolean>;
}
```

### 关键实现细节

- `baseDir` 默认 `~/.claude/users/`
- `ensureUserDir` 创建 `{userId}/`、`{userId}/log/`、`{userId}/projects/` 子目录
- `listFiles` 递归列出所有 `.md` 文件
- `writeFile` 使用写锁防止同用户并发写入
- **路径安全**：validateUserId 禁止 `..`/`/`/`\`，resolveUserFilePath 验证解析后路径在用户目录内

### 不做的事

- 不创建默认 claude.md 模板（Claude Code 原生管理）
- 不解析文件内容
- 不注入任何东西到 Claude 会话

---

## Phase 2: SessionRegistry + MessageRouter

### 文件：`src/crossSession/SessionRegistry.ts`

管理所有活跃 Session 的注册表，是跨 Session 通信的前提。

```typescript
import { EventEmitter } from 'node:events';
import { createLogger } from '../logger';

export interface RegisteredSession {
  sessionId: string;
  userId: string;
  project?: string;
  status: 'active' | 'idle';
  registeredAt: Date;
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, RegisteredSession>();

  register(sessionId: string, userId: string, project?: string): void;
  unregister(sessionId: string): void;
  getSession(sessionId: string): RegisteredSession | undefined;
  getSessionsByUser(userId: string): RegisteredSession[];
  getSessionsByProject(project: string): RegisteredSession[];
  updateStatus(sessionId: string, status: 'active' | 'idle'): void;
  getAllSessions(): RegisteredSession[];
  // Events: 'registered', 'unregistered', 'statusChanged'
}
```

### 文件：`src/crossSession/MessageRouter.ts`

Session 间消息路由，这是 A2A 的核心。

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SessionRegistry } from './SessionRegistry';
import { createLogger } from '../logger';

export interface SessionMessage {
  id: string;
  fromSessionId: string;
  targetSessionId: string;
  fromUserId: string;
  type: 'notification' | 'request' | 'share_context' | 'delegate_task';
  content: string;
  payload?: Record<string, unknown>;
  requireResponse: boolean;
  timeoutMs?: number;
  createdAt: Date;
  readAt?: Date;
}

export class MessageRouter extends EventEmitter {
  private messages = new Map<string, SessionMessage>();
  // sessionId -> messageId[] 索引
  private sessionInbox = new Map<string, string[]>();

  constructor(private registry: SessionRegistry);

  // 发送消息给指定 Session
  sendMessage(msg: Omit<SessionMessage, 'id' | 'createdAt'>): string;
  // 广播给用户的所有 Session（排除指定的）
  broadcastToUser(
    fromSessionId: string, userId: string,
    type: SessionMessage['type'], content: string,
    excludeSessionIds?: string[]
  ): string[];
  // 获取 Session 的未读消息
  getUnreadMessages(sessionId: string): SessionMessage[];
  // 获取 Session 的所有消息
  getMessages(sessionId: string): SessionMessage[];
  // 标记已读
  markAsRead(messageId: string): boolean;
  // Events: 'message' (data: { sessionId, message })
}
```

### 关键设计决策

- **纯内存**：所有数据在 Map 中，服务重启丢失（与现有 Session 行为一致）
- **消息不阻塞**：sendMessage 是同步的，通过 EventEmitter 通知目标 Session
- **广播时验证**：broadcastToUser 通过 SessionRegistry 发现目标 Session
- **消息上限**：每个 Session 最多保留 1000 条消息，FIFO 淘汰

---

## Phase 3: UserDirectory + CrossUserNotifier

### 文件：`src/crossSession/UserDirectory.ts`

用户目录，支持查找和资料管理。

```typescript
import { createLogger } from '../logger';

export interface UserProfile {
  userId: string;
  displayName?: string;
  skills?: string[];
  currentProjects?: string[];
  messagePermission: 'everyone' | 'contacts' | 'project_members' | 'none';
  registeredAt: Date;
  lastActiveAt: Date;
}

export class UserDirectory {
  private profiles = new Map<string, UserProfile>();

  upsertProfile(userId: string, partial: Partial<Omit<UserProfile, 'userId' | 'registeredAt'>>): UserProfile;
  getProfile(userId: string): UserProfile | undefined;
  findUser(query: string, by?: 'name' | 'id' | 'auto'): UserProfile[];
  getProjectMembers(projectName: string): UserProfile[];
  canReceiveFrom(targetUserId: string, fromUserId: string): boolean;
  touchUser(userId: string): void;
}
```

### 文件：`src/crossSession/CrossUserNotifier.ts`

跨用户通知。

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { UserDirectory } from './UserDirectory';
import type { SessionRegistry } from './SessionRegistry';
import { createLogger } from '../logger';

export interface UserNotification {
  id: string;
  fromUserId: string;
  targetUserId: string;
  type: 'notification' | 'request' | 'collaboration_invite';
  content: string;
  payload?: {
    project?: string;
    urgency?: 'low' | 'normal' | 'high';
    actionRequired?: boolean;
    [key: string]: unknown;
  };
  createdAt: Date;
  readAt?: Date;
}

export class CrossUserNotifier extends EventEmitter {
  private notifications = new Map<string, UserNotification>();
  private userInbox = new Map<string, string[]>(); // userId -> notificationId[]

  constructor(private directory: UserDirectory, private registry: SessionRegistry);

  notifyUser(notification: Omit<UserNotification, 'id' | 'createdAt'>): string;
  notifyProjectMembers(
    fromUserId: string, projectName: string,
    type: UserNotification['type'], content: string,
    excludeUserIds?: string[]
  ): string[];
  getNotifications(userId: string, unreadOnly?: boolean): UserNotification[];
  markAsRead(notificationId: string): boolean;
  // Events: 'notification' (data: { userId, notification })
}
```

### 权限控制

- `canReceiveFrom` 检查目标用户的 `messagePermission` 设置
- `everyone`：任何人可发送
- `contacts`：预留，当前等同 everyone
- `project_members`：只有同项目成员可发送
- `none`：拒绝所有消息

---

## Phase 4: SessionLinkManager

### 文件：`src/crossSession/SessionLinkManager.ts`

Session 直连对话通道，实现数字分身之间的实时通信。

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SessionRegistry } from './SessionRegistry';
import type { UserDirectory } from './UserDirectory';
import { createLogger } from '../logger';

export interface SessionLink {
  id: string;
  initiatorSessionId: string;
  initiatorUserId: string;
  targetSessionId: string | null; // null until accepted
  targetUserId: string;
  mode: 'bidirectional' | 'readonly';
  status: 'pending' | 'active' | 'disconnected';
  createdAt: Date;
}

export interface LinkedMessage {
  fromSessionId: string;
  fromUserId: string;
  fromUserName: string;
  content: string;
  timestamp: Date;
  isMention: boolean;
}

export class SessionLinkManager extends EventEmitter {
  private links = new Map<string, SessionLink>();

  constructor(private registry: SessionRegistry, private directory: UserDirectory);

  // 发起连接邀请
  createLink(
    initiatorSessionId: string, initiatorUserId: string,
    targetUserId: string, mode?: 'bidirectional' | 'readonly',
    initialMessage?: string
  ): SessionLink;
  // 接受邀请（需提供目标 Session ID）
  acceptLink(linkId: string, targetSessionId: string): boolean;
  declineLink(linkId: string): boolean;
  disconnect(linkId: string): boolean;
  disconnectAll(sessionId: string): void;
  // 通过连接发送消息
  sendLinkedMessage(linkId: string, message: LinkedMessage): boolean;
  // 查询连接
  getLinks(sessionId: string, status?: 'active' | 'pending' | 'all'): SessionLink[];
  getPendingInvitations(userId: string): SessionLink[];
  // 工具方法
  static parseMentions(text: string): string[];  // 解析 +user-id 提及

  // Events:
  //   'link_created'      (data: SessionLink)
  //   'link_accepted'     (data: SessionLink)
  //   'link_declined'     (data: { linkId })
  //   'linked_message'    (data: { linkId, message: LinkedMessage, targetSessionId })
  //   'link_disconnected' (data: { linkId })
}
```

### +user-id 提及解析

```typescript
static parseMentions(text: string): string[] {
  const regex = /\+([a-zA-Z0-9_-]+)/g;
  const mentions: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return [...new Set(mentions)];
}
```

### 直连对话流程

```
1. User A 发送 "+lisi 这个问题你怎么看？"
2. 客户端检测到 +lisi，调用 POST /sessions/:id/links { targetUserId: "lisi" }
3. lisi 的客户端收到邀请通知
4. lisi 接受：POST /me/links/invitations/:linkId/accept { sessionId: "lisi-session-id" }
5. 双向通道建立
6. 双方通过 POST /sessions/:id/links/:linkId/messages 发送消息
7. 对方通过 SSE 或轮询接收消息
```

---

## Phase 5: API 端点

### 用户文件管理

```
GET    /users/:userId/files                 # 列出用户文件
GET    /users/:userId/files/*               # 读取文件（通配路径）
PUT    /users/:userId/files/*               # 写入文件
DELETE /users/:userId/files/*               # 删除文件
```

### 文件：`src/routes/userFileRoutes.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { UserFileManager, FileNotFoundError } from '../userFiles/UserFileManager';
import { requireUserContext } from '../middleware/auth';

export function registerUserFileRoutes(
  fastify: FastifyInstance,
  fileManager: UserFileManager
): void {
  // GET /users/:userId/files
  // 权限：只能访问自己的文件（request.userContext.userId === params.userId）
  // 返回：{ files: UserFile[] }

  // GET /users/:userId/files/*
  // 权限：同上
  // 返回：{ content: string, path: string }

  // PUT /users/:userId/files/*
  // body: { content: string }
  // 返回：{ ok: true, path: string }

  // DELETE /users/:userId/files/*
  // 返回：{ ok: true }
}
```

### 跨 Session 通信

```
GET    /sessions/:id/inbox                  # 获取 Session 收到的消息
POST   /sessions/:id/inbox/:msgId/read      # 标记消息已读
POST   /sessions/:id/send                   # 发送消息给其他 Session
POST   /sessions/:id/broadcast              # 广播给同用户所有 Session
GET    /my-sessions                          # 获取当前用户的活跃 Session 列表
```

### 文件：`src/routes/crossSessionRoutes.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import type { MessageRouter } from '../crossSession/MessageRouter';
import type { SessionRegistry } from '../crossSession/SessionRegistry';
import { requireUserContext } from '../middleware/auth';

export function registerCrossSessionRoutes(
  fastify: FastifyInstance,
  router: MessageRouter,
  registry: SessionRegistry
): void {
  // GET /sessions/:id/inbox
  // query: ?unread=1 只返回未读
  // 返回：{ messages: SessionMessage[] }

  // POST /sessions/:id/send
  // body: { targetSessionId, type, content, payload?, requireResponse?, timeoutMs? }
  // 验证：发送者拥有该 Session，目标 Session 属于同一用户
  // 返回：{ messageId }

  // POST /sessions/:id/broadcast
  // body: { type, content, excludeSessionIds? }
  // 返回：{ messageIds: string[] }

  // GET /my-sessions
  // 返回当前用户在 registry 中的所有活跃 Session
  // 返回：{ sessions: RegisteredSession[] }
}
```

### 跨用户通信

```
GET    /users                               # 搜索用户（?query=xxx）
GET    /users/:userId/profile               # 获取用户公开资料
PUT    /me/profile                           # 更新自己的资料
POST   /users/:userId/notify                # 通知指定用户
GET    /me/notifications                    # 获取我的通知
POST   /me/notifications/:id/read           # 标记通知已读
```

### 文件：`src/routes/crossUserRoutes.ts`

### Session 直连对话

```
POST   /sessions/:id/links                  # 发起连接邀请
GET    /sessions/:id/links                  # 获取 Session 的连接列表
DELETE /sessions/:id/links/:linkId          # 断开连接
POST   /sessions/:id/links/:linkId/messages # 通过连接发送消息
GET    /me/links/invitations                # 获取待处理的连接邀请
POST   /me/links/invitations/:id/accept     # 接受邀请
POST   /me/links/invitations/:id/decline    # 拒绝邀请
```

### 文件：`src/routes/sessionLinkRoutes.ts`

---

## Phase 6: Session 创建集成

修改现有文件以集成新组件：

### 修改 `src/ClaudeSessionManager.ts`

```diff
+ import { UserFileManager } from './userFiles/UserFileManager';

  export interface CreateSessionOptions {
    ownerId: string;
    path?: string;
+   project?: string;           // 关联项目
    // ... 其他现有字段
  }

  export class ClaudeSessionManager {
+   private fileManager: UserFileManager;

    constructor(
      private db: DatabaseManager,
-     options: { usersDir?: string } = {}
+     options: { usersDir?: string; userFilesDir?: string } = {}
    ) {
+     this.fileManager = new UserFileManager(options.userFilesDir);
    }

+   getFileManager(): UserFileManager {
+     return this.fileManager;
+   }

+   getActiveSessionsForUser(userId: string): Array<{ sessionId: string; project?: string }> {
+     // 遍历 this.sessions 返回用户的活跃 Session
+   }
  }
```

### 修改 `src/app.ts`

```diff
+ import { SessionRegistry } from './crossSession/SessionRegistry';
+ import { MessageRouter } from './crossSession/MessageRouter';
+ import { UserDirectory } from './crossSession/UserDirectory';
+ import { CrossUserNotifier } from './crossSession/CrossUserNotifier';
+ import { SessionLinkManager } from './crossSession/SessionLinkManager';
+ import { registerUserFileRoutes } from './routes/userFileRoutes';
+ import { registerCrossSessionRoutes } from './routes/crossSessionRoutes';
+ import { registerCrossUserRoutes } from './routes/crossUserRoutes';
+ import { registerSessionLinkRoutes } from './routes/sessionLinkRoutes';

  export function buildApp(options?: BuildAppOptions): FastifyInstance {
+   // 初始化跨 Session 基础设施
+   const registry = new SessionRegistry();
+   const messageRouter = new MessageRouter(registry);
+   const userDirectory = new UserDirectory();
+   const crossUserNotifier = new CrossUserNotifier(userDirectory, registry);
+   const sessionLinkManager = new SessionLinkManager(registry, userDirectory);
+
+   // 注册新路由
+   registerUserFileRoutes(fastify, manager.getFileManager());
+   registerCrossSessionRoutes(fastify, messageRouter, registry);
+   registerCrossUserRoutes(fastify, userDirectory, crossUserNotifier);
+   registerSessionLinkRoutes(fastify, sessionLinkManager, registry);

    // 在 POST /sessions 中添加 project 支持
    // Session 创建后自动注册到 registry
+   registry.register(session.id, userContext.userId, body.project);

    // 在 DELETE /sessions/:id 中自动注销
+   registry.unregister(sessionId);
+   sessionLinkManager.disconnectAll(sessionId);
  }
```

### 修改 `POST /sessions` body 类型

```diff
  const body = request.body as {
    path?: string;
+   project?: string;
    initialMessage?: string;
    // ... 其他现有字段
  };
```

---

## Phase 7: 验证

```bash
# TypeScript 类型检查
bun run typecheck

# 运行现有测试确保无回归
bun test

# 手动验证流程
# 1. 创建两个 Session（同用户）
# 2. Session A 发送消息给 Session B
# 3. Session B 查看收件箱
# 4. 创建两个用户的 Session
# 5. User A 通知 User B
# 6. User B 查看通知列表
# 7. Session 直连：发起邀请 → 接受 → 双向发消息
```

---

## 依赖关系

```
Phase 1 (UserFileManager)     ── 独立，无依赖
Phase 2 (Registry + Router)   ── 独立，无依赖
Phase 3 (Directory + Notifier) ── 依赖 Phase 2 (SessionRegistry)
Phase 4 (SessionLinkManager)  ── 依赖 Phase 2 + 3
Phase 5 (API routes)          ── 依赖 Phase 1-4
Phase 6 (Session 集成)         ── 依赖 Phase 1-5
Phase 7 (验证)                 ── 依赖全部
```

Phase 1 和 Phase 2 可以并行实现。Phase 3 和 4 可以在 2 完成后并行。

---

## 注意事项

1. **全内存存储**：跨 Session 基础设施全部在内存中，服务重启丢失。与现有 Session 行为一致。
2. **向后兼容**：所有新端点都是新增的，不修改现有 API 行为。未提供 `X-User-Id` 的请求走 legacy 路径。
3. **文件并发**：UserFileManager 用简单的 per-user 写锁防止同用户并发写冲突。
4. **消息容量**：每 Session 收件箱上限 1000 条，FIFO 淘汰。每用户通知上限 500 条。
5. **路径安全**：所有文件路径都经过 traversal 检查，userId 不允许包含 `../` 等。
6. **MCP 工具（后续）**：当前只建基础设施和 HTTP API。Claude 工具注册将通过 MCP Server 在后续迭代实现，届时 Claude 可自主调用 `send_session_message` 等工具。
