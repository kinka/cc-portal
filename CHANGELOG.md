# Changelog

## [Unreleased]

### Added

- **与 happy-cli 对齐**（详见 [docs/ALIGNMENT.md](docs/ALIGNMENT.md)）：
  - 新增 `src/sdk-types.ts`：SDK 消息类型、PermissionResult、CanCallToolCallback、control 协议类型、PermissionMode
  - 权限模式：`permissionMode`（default / acceptEdits / bypassPermissions / plan），替代仅布尔 `bypassPermission`
  - 工具审批：`canCallTool` 回调，处理 control_request（can_use_tool）并回写 control_response
  - 单读循环 + AsyncMessageQueue：stdout 统一解析，control 先处理再入队，query/queryStream 串行消费（consumerLock）
  - StreamChunk 扩展：`system`（init）、`log`、`toolUseId` 等，与 happy-cli 消息处理对齐
  - 创建会话/API：支持 `disallowedTools`、`mcpServers`、`maxTurns`、`permissionMode`

### Changed

- `ClaudeAgentBackend` 构造函数选项：`permissionMode`、`canCallTool`、`disallowedTools`、`mcpServers`、`maxTurns`；保留 `bypassPermission`（deprecated）
- POST /sessions 请求体：同上字段；未传时默认行为与改造前一致（bypass）

### Limitations

- **HTTP 下无法使用 canCallTool**：仅程序化创建 Session 时可传回调；HTTP 下可用 `permissionMode: 'bypassPermissions'` 或接受无回调时自动 deny。未来可通过「待审批队列 + 审批接口」支持。

---

## 0.1.0

- 初始版本：HTTP 服务、Session 管理、进程复用、多轮对话、SSE 流式
