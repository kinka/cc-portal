# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Install dependencies
bun install

# Development mode (hot reload)
bun run dev

# Production mode
bun run start

# TypeScript type checking
bun run typecheck

# Run API tests (no Claude CLI required)
bun test

# Run single test file
bun test tests/e2e.test.ts

# Run E2E tests with real Claude CLI (requires @anthropic-ai/claude-code installed)
bun run test:e2e
```

## Architecture Overview

This is a Bun-based HTTP service that provides remote control of Claude Code CLI with persistent conversations.

### Key Components

**HTTP Layer (`src/app.ts`, `src/index.ts`)**
- Fastify-based REST API with CORS support
- Main endpoints: `/sessions`, `/sessions/:id/stream`, `/sessions/:id/pending-permissions`
- Supports both regular JSON responses and SSE streaming

**ClaudeSession (`src/ClaudeSession.ts`)**
- Extends EventEmitter for real-time permission notifications
- Manages message history and pending permission queue
- Events: `permissionPending`, `permissionResolved`, `stopped`

**ClaudeAgentBackend (`src/ClaudeAgentBackend.ts`)**
- Spawns and manages `claude` CLI subprocess
- Handles stream-json protocol over stdin/stdout
- Implements control protocol for tool approval
- Extends EventEmitter for `permissionRequest` events

**HTTP Tool Approval Flow**
- When `permissionMode` is not `bypassPermissions` and no `canCallTool` callback provided, tool calls enter pending queue
- Client receives `permission_request` chunk in SSE stream
- Client polls or subscribes to `GET /sessions/:id/pending-permissions?stream=1`
- Client approves/denies via `POST /sessions/:id/permissions/:requestId`

### Testing Strategy

- Use `buildApp()` from `src/app.ts` to create testable Fastify instance with isolated session manager
- API tests use `bun test` (no external dependencies)
- E2E tests require `RUN_E2E=1` environment variable and Claude CLI installed
- Tests use dynamic ports via `app.listen({ port: 0 })`

### Prerequisites

- Bun runtime
- `@anthropic-ai/claude-code` CLI installed and authenticated
- Valid Claude API key in environment

### Auto Memory

本项目已启用 Claude Code Auto Memory 功能：
- **存储位置**: `~/.claude/projects/-Users-kinka-space-happy-coder-cc-portal/memory/`
- **MEMORY.md**: 前 200 行每 session 自动加载
- **主题文件**: Claude 按需读取详细笔记（如 debugging.md, patterns.md 等）
- **命令**: 使用 `/memory` 查看和管理记忆
