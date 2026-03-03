# 历史消息中「工具调用对却无结果」分析

## 对比的两个 Session

| Session     | permissionMode     | 现象简述 |
|------------|--------------------|----------|
| 1dbc82ec…  | **default**        | 工具名对（mcp__jira__jira_find_issue），但要么参数错要么权限超时，没有成功结果 |
| 71b87cea…  | **bypassPermissions** | 有一次用错 Skill 失败，后来用对工具并**拿到 Jira 成功结果** |

---

## Session 1dbc82ec（有调用、无成功结果）

- **permissionMode: "default"**，需要走审批/stdio。
- 历史里有多轮 `mcp__jira__jira_find_issue` / `jira_find_issues`，每条都有对应 `tool_result`，但内容都是**错误**或**超时**，没有一次成功返回 Jira 数据。

### 原因 1：参数错误（issueKey 未传）

多次出现：

```text
MCP error -32602: Input validation error: Invalid arguments for tool jira_find_issue:
  "path": ["issueKey"], "expected": "string", "received": "undefined", "message": "Required"
```

- 模型发起的工具名是对的（`mcp__jira__jira_find_issue`），但 **issueKey 为 undefined**。
- MCP 校验失败，直接返回错误，不会去查 Jira，所以「有调用、无业务结果」。

可能原因：  
- 审批/control_response 里把 `updatedInput` 写丢或写错；  
- 或模型在构造 tool_use 时没把 issueKey 放进 input。  
需要对照当时 control_request/control_response 的 payload 和 CLI 写入 jsonl 的 tool_use 内容。

### 原因 2：权限超时（Permission request timed out）

有一条 tool_result 内容为：

```text
Permission request timed out
```

- 说明该次工具调用触发了 permission（例如 jira_find_issues），但：
  - 要么用户未在超时前点批准，
  - 要么前端点了批准但 control_response 没被 CLI 收到（例如 stdio 未打通）。
- CLI 按超时处理，往历史里写的是这条错误信息，而不是 Jira 的返回数据。

### 原因 3：最后一次 jira_find_issues 可能无结果

- 历史末尾有一次 assistant 的 `mcp__jira__jira_find_issues`。
- 若其后没有对应的 user/tool_result 条目，说明该轮要么会话被关掉，要么再次超时/未完成，CLI 没写入 tool_result。

---

## Session 71b87cea（有成功结果）

- **permissionMode: "bypassPermissions"**，不弹审批，工具直接执行。
- 第一次用错了 **Skill**（`Skill` + `mcp__jira__jira_find_issue`），返回 `Unknown skill: mcp__jira__jira_find_issue`，这是预期内的失败。
- 之后用对工具 **mcp__jira__jira_find_issue**，对应的 tool_result 里是**真实 Jira 数据**（如 `key: "INFO-12954"`, `summary: "3 月"`, `description: "3月份的日常工作"` 等），说明「工具调用对且有结果」。

---

## 结论与建议

- **「工具调用对了却没有结果」** 在 1dbc82ec 里主要来自：
  1. **参数错误**：issueKey 未传或未传到 MCP，导致校验失败，只有错误没有数据。
  2. **权限超时**：default 模式下审批未在超时前完成或 control_response 未到达 CLI，结果被写成 "Permission request timed out"。
  3. **最后一轮** 可能未完成，没有对应的 tool_result 写入。

- **和 71b87cea 的对比**：  
  71b87cea 用 bypassPermissions，没有审批链，且有一次调用**参数正确**，所以历史里能看到成功的 Jira 返回；1dbc82ec 在 default 下既有参数问题又有超时问题，所以看起来就是「调用对、结果不对/没有」。

建议后续排查：

1. **issueKey 传递**：在 default 模式下确认 control_response 的 `updatedInput` 以及 CLI 写入的 tool_use 里是否都包含正确的 `issueKey`。
2. **权限与 stdio**：确认用户批准后 control_response 是否真的写入了子进程 stdin，以及 CLI 是否在超时前收到（参考 [CONTROL-REQUEST-RESPONSE-FLOW.md](./CONTROL-REQUEST-RESPONSE-FLOW.md)）。
3. **超时时间**：若审批流程较慢，可适当调大 permission 超时，避免正常审批被判成 "Permission request timed out"。
