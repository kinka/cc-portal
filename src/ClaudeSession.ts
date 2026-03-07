import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeAgentBackend, type StreamChunk, type HistoryMessage, type RawHistoryEntry } from './ClaudeAgentBackend';
import type { CanCallToolCallback, PermissionMode, PermissionResult } from './sdk-types';
import { createLogger } from './logger';

/** Session context injected into each message prompt for multi-user awareness and agent discovery. */
export interface SessionContext {
  apiBaseUrl: string;
  userId: string;
  sessionId: string;
  ownerId: string;
  participants: string[];
}

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
  mcpConfigPaths?: string[];
  maxTurns?: number;
  envVars?: Record<string, string>;
  initialMessage?: string;
  /** @deprecated use permissionMode: 'bypassPermissions' */
  bypassPermission?: boolean;
  /** Owner user ID for multi-user sessions. */
  /** Owner user ID for multi-user sessions. */
  ownerId?: string;
  /** Initial list of participant user IDs (besides owner). */
  initialParticipants?: string[];
  /** API base URL and auth info for injecting into session context header. */
  sessionContext?: { apiBaseUrl: string; userId: string };
  /** Tool name patterns to auto-allow without approval (e.g. Read, mcp__*__get*). When set, overrides backend default. */
  autoAllowToolPatterns?: string[];
  /** Custom (toolName, input) => true to auto-allow. Used only when creating session in code. */
  isAutoAllowTool?: (toolName: string, input: unknown) => boolean;
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
  from?: string; // userId of the sender for multi-user sessions
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
  private participants: Set<string> = new Set();
  private ownerId: string = '';
  private sessionContext?: SessionContext;

  constructor(options: ClaudeSessionOptions) {
    super();
    this.id = options.id;
    this.log = createLogger({ module: 'Session', sessionId: options.id });
    this.path = options.path;
    this.createdAt = new Date();
    this.claudeSessionId = options.id; // Use session ID as Claude session ID
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 300_000;
    this.ownerId = options.ownerId ?? '';
    for (const p of options.initialParticipants ?? []) {
      this.participants.add(p);
    }
    if (options.sessionContext) {
      this.sessionContext = {
        ...options.sessionContext,
        sessionId: this.id,
        ownerId: this.ownerId,
        participants: [this.ownerId, ...this.participants].filter(Boolean),
      };
    }

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
      mcpConfigPaths: options.mcpConfigPaths,
      maxTurns: options.maxTurns,
      bypassPermission: options.bypassPermission,
      autoAllowToolPatterns: options.autoAllowToolPatterns,
      isAutoAllowTool: options.isAutoAllowTool,
    });

    // Send initial message if provided
    if (options.initialMessage) {
      this.sendMessage(options.initialMessage).catch(err =>
        this.log.error({ err }, 'Initial message failed')
      );
    }

    // Clean up pending permissions when process dies unexpectedly

    // Clean up pending permissions when process dies unexpectedly
    this.backend.on('processDied', () => {
      const pendingIds = Array.from(this.pendingPermissions.keys());
      if (pendingIds.length > 0) {
        this.log.info({ pendingIds }, 'Process died, rejecting pending permissions');
        for (const [requestId, pending] of this.pendingPermissions) {
          if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
          pending.reject(new Error('Claude process terminated unexpectedly'));
        }
        this.pendingPermissions.clear();
      }
    });
  }

  /** Add a participant to this session and update session context participants list. */
  addParticipant(userId: string): void {
    this.participants.add(userId);
    if (this.sessionContext) {
      this.sessionContext.participants = [this.ownerId, ...this.participants].filter(Boolean);
    }
  }

  /** Get the full list of participants (owner + joined users). */
  getParticipants(): string[] {
    return [this.ownerId, ...this.participants].filter(Boolean);
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
    if (!pending) {
      this.log.warn({ requestId, pendingIds: [...this.pendingPermissions.keys()] }, 'respondToPermission: requestId not found');
      return false;
    }
    this.pendingPermissions.delete(requestId);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    pending.resolve(result);
    this.log.info({ requestId, allowed: result.behavior === 'allow' }, 'Permission resolved');
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

  /**
   * Build the prompt string to send to Claude.
   * - Single-user (no context or participants.length <= 1): prefixes with `[from]: ` when from is set.
   * - Multi-user (context with participants.length > 1): injects full Session Context header so Claude
   *   is aware of participants, the API endpoint, and who is currently speaking.
   * The original `content` stored in message history is never modified.
   */
  static buildPrompt(content: string, from?: string, context?: SessionContext): string {
    const isMultiUser = context && context.participants.length > 1;
    if (isMultiUser) {
      const lines = [
        '[Session Context]',
        `CC-Portal API: ${context.apiBaseUrl}`,
        `Auth header: X-User-ID: ${context.userId}`,
        `Your session ID: ${context.sessionId}`,
        '',
        'This is a multi-user session.',
        `Owner: ${context.ownerId}`,
        `Participants: ${context.participants.join(', ')}`,
        `Current speaker: ${from ?? context.userId}`,
        '',
        from ? `[${from}]: ${content}` : content,
      ];
      return lines.join('\n');
    }
    return from ? `[${from}]: ${content}` : content;
  }

  async sendMessage(content: string, from?: string): Promise<string> {
    // Add user message (store original content, from field tracks sender)
    this.messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
      from,
    });

    // Build prompt with session context for multi-user awareness
    const ctx = this.participants.size > 0 ? this.sessionContext : undefined;
    // Query Claude with sender-prefixed prompt so Claude knows who is speaking
    const response = await this.backend.query(ClaudeSession.buildPrompt(content, from, ctx));

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
  async *sendMessageStream(content?: string, from?: string): AsyncGenerator<StreamChunk> {
    // Add user message if content provided (store original content)
    if (content !== undefined && content !== null) {
      this.messages.push({
        id: randomUUID(),
        role: 'user',
        content,
        timestamp: new Date(),
        from,
      });
    }

    let fullResponse = '';

    // Build prompt with session context for multi-user awareness
    const ctx = this.participants.size > 0 ? this.sessionContext : undefined;
    // Query Claude with sender-prefixed prompt
    try {
      for await (const chunk of this.backend.queryStream(
        content !== undefined && content !== null ? ClaudeSession.buildPrompt(content, from, ctx) : content
      )) {
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
        this.messages = history.map((h: HistoryMessage) => ({
          id: randomUUID(),
          role: h.role,
          content: h.content,
          timestamp: h.timestamp,
        }));
        this.log.info({ count: history.length }, 'Synced conversation history');
      }
    } catch (err) {
      this.log.warn({ err }, 'Failed to sync history');
    }
  }

  /**
   * Load history from Claude CLI's local storage.
   * @param detailed - If true, returns full history including tool calls and results
   */
  async loadHistoryFromCLI(detailed?: boolean): Promise<HistoryMessage[] | RawHistoryEntry[]> {
    if (detailed) {
      return this.backend.getHistoryDetailed();
    }
    return this.backend.getHistory();
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
