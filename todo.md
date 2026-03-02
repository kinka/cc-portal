# 待办事项

- [ ] 增加终止请求的功能
- [ ] 增加跨session交互的功能, 可以 +user-a +user-b 进行双向沟通
- [ ] session context 需要一个区分度更高的标识

## 功能增强

### 跨会话交互
  userA可以在当前会话直接把userB拉进来， 进行群聊， 同一个上下文下，可以进行双向沟通， 人也可以直接进行对话， 在同一个/stream 都能收到相同的消息

### 消息历史持久化
- **状态**: 待实现
- **描述**: 当前服务重启后，HTTP 层看不到历史消息（仅保留在 Claude CLI 内部）
- **技术方案**:
  1. 添加 `messages` 表到 SQLite 数据库
  2. 每次对话后保存消息到数据库
  3. 启动时从数据库加载历史到内存
- **相关文件**:
  - `src/db.ts` - 添加 messages 表
  - `src/ClaudeSession.ts` - 保存/加载消息
  - `src/ClaudeSessionManager.ts` - 启动时加载历史

## 已完成

### 多租户支持 ✅
- SQLite 存储用户和 session 元数据
- 用户隔离和配额管理
- 支持 `X-User-ID` Header 和 `userId` Query 参数

### Session 自动恢复 ✅
- 服务重启后自动从数据库加载 session
- 访问已停止的 session 时自动重新激活
- 解决 Claude CLI "Session ID is already in use" 问题

### 权限模式修复 ✅
- `bypassPermissions` 模式下自动允许工具调用
- 修复 EventTarget 内存泄漏警告
- 添加进程启动错误处理
