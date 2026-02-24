import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeAgentBackend, type StreamChunk } from './ClaudeAgentBackend';
import type { CanCallToolCallback, PermissionMode, PermissionResult } from './sdk-types';
import { createLogger } from './logger';

export interface ClaudeSessionOptions {
  id: string;
  path: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** default | acceptEdits | bypassPermissions | plan. Default bypassPermissions for backward compat. */
  permissionMode?: PermissionMode;
  /** Required when permissionMode is not bypassPermissions; used for programmatic approval. */
  canCallTool?: CanCallToolCallback;
  /** Timeout in ms for HTTP permission approval; used when canCallTool is not set. Default 300000 (5 min). */
  permissionTimeoutMs?: number;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  maxTurns?: number;
  envVars?: Record<string, string>;
  initialMessage?: string;
  /** @deprecated use permissionMode: 'bypassPermissions' */
  bypassPermission?: boolean;
  /** Whether this is a brand new session (--session-id) or resuming existing (--resume). Default true. */
  isNewSession?: boolean;
}

/** One pending tool approval request (HTTP flow). */
export interface PendingPermissionItem {
  requestId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  createdAt: Date;
  resolve: (result: PermissionResult) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class ClaudeSession extends EventEmitter {
  private _onPermissionPending?: () => void;
  private log;
  readonly id: string;
  readonly path: string;
  readonly createdAt: Date;
  readonly claudeSessionId: string;
  private backend: ClaudeAgentBackend;
  private messages: Message[] = [];
  private pendingPermissions = new Map<string, PendingPermission>();
  private permissionTimeoutMs: number;

  constructor(options: ClaudeSessionOptions) {
    super();
    this.id = options.id;
    this.log = createLogger({ module: 'Session', sessionId: options.id });
    this.path = options.path;
    this.createdAt = new Date();
    this.claudeSessionId = options.id; // Use session ID as Claude session ID
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 300_000;

    const needsPermissionResolver =
      !options.canCallTool &&
      options.permissionMode !== 'bypassPermissions' &&
      (options.bypassPermission === undefined || options.bypassPermission === false);

    this.backend = new ClaudeAgentBackend({
      cwd: options.path,
      claudeSessionId: this.claudeSessionId,
      model: options.model,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode,
      canCallTool: options.canCallTool,
      permissionResolver: needsPermissionResolver
        ? (requestId, toolName, input) => this.waitForPermission(requestId, toolName, input)
        : undefined,
      mcpServers: options.mcpServers,
      maxTurns: options.maxTurns,
      bypassPermission: options.bypassPermission,
      isNewSession: options.isNewSession,
    });

    // Send initial message if provided
    if (options.initialMessage) {
      this.sendMessage(options.initialMessage).catch(err =>
        this.log.error({ err }, 'Initial message failed')
      );
    }
  }

  /** Used by backend when permissionResolver is set: enqueue request and wait for respondToPermission. */
  waitForPermission(
    requestId: string,
    toolName: string,
    input: unknown,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      const createdAt = new Date();
      const timeoutHandle = setTimeout(() => {
        if (this.pendingPermissions.delete(requestId)) {
          reject(new Error('Permission request timed out'));
        }
      }, this.permissionTimeoutMs);

      this.pendingPermissions.set(requestId, {
        requestId,
        toolName,
        input,
        createdAt,
        resolve,
        reject,
        timeoutHandle,
      });
      this.log.debug({ requestId, toolName }, 'Pending permission');
      // Notify SSE subscribers
      this.emit('permissionPending', { requestId, toolName, input, createdAt: createdAt.toISOString() });
      this._onPermissionPending?.();
    });
  }

  /** Resolve a pending permission (e.g. from HTTP POST). Returns false if requestId not found or already resolved. */
  respondToPermission(requestId: string, result: PermissionResult): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    pending.resolve(result);
    // Notify SSE subscribers
    this.emit('permissionResolved', { requestId, result });
    return true;
  }

  /** List pending tool approval requests for HTTP GET. */
  listPendingPermissions(): PendingPermissionItem[] {
    return Array.from(this.pendingPermissions.values()).map((p) => ({
      requestId: p.requestId,
      toolName: p.toolName,
      input: p.input,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async sendMessage(content: string): Promise<string> {
    // Add user message
    this.messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    });

    // Query Claude (backend will auto-restart process if needed)
    const response = await this.backend.query(content);

    // Add assistant message
    this.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: response,
      timestamp: new Date(),
    });

    return response;
  }

  // 流式发送消息 - 实时返回 chunks
  // content 可选：有值时发送消息，无值时只监听响应
  async *sendMessageStream(content?: string): AsyncGenerator<StreamChunk> {
    // Add user message if content provided
    if (content !== undefined && content !== null) {
      this.messages.push({
        id: randomUUID(),
        role: 'user',
        content,
        timestamp: new Date(),
      });
    }

    let fullResponse = '';

    // Query Claude with stream (backend will auto-restart process if needed)
    try {
      for await (const chunk of this.backend.queryStream(content)) {
        if (chunk.type === 'text' && chunk.content) {
          fullResponse += chunk.content;
        }
        yield chunk;
      }
    } catch (error) {
      // Propagate error to client
      const errorMsg = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: errorMsg } as StreamChunk;
    } finally {
      // Add assistant message (只有在有内容时才添加)
      if (fullResponse) {
        this.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date(),
        });
      }
    }
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Sync conversation history from Claude CLI backend */
  async syncHistory(): Promise<void> {
    try {
      const history = await this.backend.getHistory();
      if (history.length > 0) {
        // Convert to Message format
        this.messages = history.map(h => ({
          id: randomUUID(),
          role: h.role,
          content: h.content,
          timestamp: h.timestamp || new Date(),
        }));
        this.log.info({ count: history.length }, 'Synced conversation history');
      }
    } catch (err) {
      this.log.warn({ err }, 'Failed to sync history');
    }
  }

  /** Check if the underlying Claude process is alive. */
  isProcessAlive(): boolean {
    return this.backend.isProcessAlive();
  }

  /** Destroy the underlying process and clear pending permissions. Called when session is deleted. */
  destroy() {
    // Clear pending permissions
    const pendingIds = Array.from(this.pendingPermissions.keys());
    for (const [, pending] of this.pendingPermissions) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('Session destroyed'));
    }
    this.pendingPermissions.clear();
    for (const requestId of pendingIds) {
      this.emit('permissionResolved', { requestId, result: { behavior: 'deny' as const, message: 'Session destroyed' } });
    }
    // Destroy process
    this.backend.destroy();
    this.emit('destroyed');
  }
}
