import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { createLogger } from './logger';

const log = createLogger({ module: 'ClaudeAgent' });
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKLog,
  PermissionResult,
  CanCallToolCallback,
  CanUseToolControlRequest,
  CanUseToolControlResponse,
  ControlCancelRequest,
  PermissionMode,
} from './sdk-types';

export type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  PermissionResult,
  CanCallToolCallback,
  PermissionMode,
} from './sdk-types';

/** Stream chunk types aligned with happy-cli message handling */
export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_end' | 'tool_output' | 'error' | 'done' | 'system' | 'log' | 'permission_request';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolUseId?: string;
  error?: string;
  /** system init */
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  /** log */
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  /** permission request (HTTP flow) */
  requestId?: string;
}

/** Async queue: read loop pushes, query/queryStream pull */
class AsyncMessageQueue {
  private queue: SDKMessage[] = [];
  private waiters: Array<(msg: SDKMessage) => void> = [];

  enqueue(msg: SDKMessage): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }

  async next(): Promise<SDKMessage> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<SDKMessage>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export interface ClaudeAgentBackendOptions {
  cwd: string;
  claudeSessionId: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** @default 'bypassPermissions' - use 'default' or 'acceptEdits' with canCallTool for approval */
  permissionMode?: PermissionMode;
  /** When permissionMode is not bypassPermissions, tool calls are approved via this callback. If missing, tool calls are denied. */
  canCallTool?: CanCallToolCallback;
  /** When canCallTool is not set (e.g. HTTP), use this to get approval; returns Promise that resolves when client calls respondToPermission. */
  permissionResolver?: (requestId: string, toolName: string, input: unknown) => Promise<PermissionResult>;
  /** @deprecated use permissionMode: 'bypassPermissions' instead */
  bypassPermission?: boolean;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  maxTurns?: number;
}

export class ClaudeAgentBackend extends EventEmitter {
  private cwd: string;
  private claudeSessionId: string;
  private model?: string;
  private allowedTools?: string[];
  private disallowedTools?: string[];
  private permissionMode: PermissionMode;
  private canCallTool?: CanCallToolCallback;
  private permissionResolver?: (requestId: string, toolName: string, input: unknown) => Promise<PermissionResult>;
  private mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  private maxTurns?: number;

  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private isInitialized = false;
  private messageQueue = new AsyncMessageQueue();
  private readLoopStarted = false;
  private cancelControllers = new Map<string, AbortController>();
  /** Only one query or queryStream at a time */
  private consumerLock: Promise<void> = Promise.resolve();
  private releaseLock: (() => void) | null = null;
  /** Permission request notifications for HTTP SSE flow */
  private permissionRequestQueue: Array<{ requestId: string; toolName: string; input: unknown }> = [];
  private permissionRequestWaiter?: (value: { requestId: string; toolName: string; input: unknown }) => void;

  constructor(options: ClaudeAgentBackendOptions) {
    super();
    this.cwd = options.cwd;
    this.claudeSessionId = options.claudeSessionId;
    this.model = options.model;
    this.allowedTools = options.allowedTools;
    this.disallowedTools = options.disallowedTools;
    this.canCallTool = options.canCallTool;
    this.permissionResolver = options.permissionResolver;
    this.mcpServers = options.mcpServers;
    this.maxTurns = options.maxTurns;
    // Backward compat: bypassPermission true => bypassPermissions
    if (options.bypassPermission !== undefined) {
      this.permissionMode = options.bypassPermission ? 'bypassPermissions' : 'default';
    } else {
      this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    }
  }

  private acquireLock(): Promise<void> {
    const prev = this.consumerLock;
    let release: () => void;
    this.consumerLock = new Promise<void>((r) => {
      release = r;
    });
    this.releaseLock = release!;
    return prev;
  }

  private releaseConsumerLock(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
  }

  private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
    if (!this.child?.stdin) return;
    const controller = new AbortController();
    this.cancelControllers.set(request.request_id, controller);

    try {
      let response: PermissionResult;
      if (request.request.subtype === 'can_use_tool') {
        if (this.canCallTool) {
          response = await this.canCallTool(request.request.tool_name, request.request.input, {
            signal: controller.signal,
          });
        } else if (this.permissionResolver) {
          // Notify SSE stream that a permission request is pending
          this.emit('permissionRequest', {
            requestId: request.request_id,
            toolName: request.request.tool_name,
            input: request.request.input,
          });
          try {
            response = await this.permissionResolver(
              request.request_id,
              request.request.tool_name,
              request.request.input,
            );
          } catch (err) {
            response = {
              behavior: 'deny',
              message: err instanceof Error ? err.message : 'Permission request failed or timed out',
            };
          }
        } else {
          response = { behavior: 'deny', message: 'No canCallTool callback configured' };
        }
      } else {
        throw new Error('Unsupported control request subtype: ' + (request.request as { subtype?: string }).subtype);
      }

      const controlResponse: CanUseToolControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response,
        },
      };
      this.child.stdin.write(JSON.stringify(controlResponse) + '\n');
    } catch (err) {
      const controlError: CanUseToolControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: err instanceof Error ? err.message : String(err),
        },
      };
      this.child.stdin!.write(JSON.stringify(controlError) + '\n');
    } finally {
      this.cancelControllers.delete(request.request_id);
    }
  }

  private startReadLoop(): void {
    if (!this.rl || !this.child || this.readLoopStarted) return;
    this.readLoopStarted = true;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as SDKMessage & { type: string; request_id?: string; request?: { subtype: string } };

        if (msg.type === 'control_response') {
          // Handled by pending handlers if we add request/response matching later; for can_use_tool we reply directly
          return;
        }
        if (msg.type === 'control_request') {
          this.handleControlRequest(msg as unknown as CanUseToolControlRequest);
          return;
        }
        if (msg.type === 'control_cancel_request') {
          const ctrl = this.cancelControllers.get((msg as unknown as ControlCancelRequest).request_id);
          if (ctrl) {
            ctrl.abort();
            this.cancelControllers.delete((msg as unknown as ControlCancelRequest).request_id);
          }
          return;
        }

        this.messageQueue.enqueue(msg);
      } catch {
        log.debug({ line }, 'Claude stdout');
      }
    };

    this.rl.on('line', processLine);
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized && this.isProcessAlive()) return;

    // If process died, clean up and reinitialize
    if (this.isInitialized && !this.isProcessAlive()) {
      log.warn('Process died, reinitializing');
      this.rl?.close();
      this.isInitialized = false;
      this.readLoopStarted = false;
    }

    const args = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--session-id',
      this.claudeSessionId,
      '--permission-mode',
      this.permissionMode,
    ];

    if (this.model) args.push('--model', this.model);
    if (this.allowedTools?.length) args.push('--allowedTools', this.allowedTools.join(','));
    if (this.disallowedTools?.length) args.push('--disallowedTools', this.disallowedTools.join(','));
    if (this.maxTurns != null) args.push('--max-turns', String(this.maxTurns));
    if (this.canCallTool) args.push('--permission-prompt-tool', 'stdio');
    if (this.mcpServers && Object.keys(this.mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: this.mcpServers }));
    }

    log.info({ args: args.slice(0, 6) }, 'Initializing Claude process');

    this.child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    this.rl = createInterface({ input: this.child.stdout! });

    this.child.on('error', (error) => {
      log.error({ error: error.message }, 'Process error');
      this.isInitialized = false;
    });

    this.child.on('close', (code) => {
      log.info({ code }, 'Process exited');
      this.isInitialized = false;
      this.rl?.close();
    });

    this.child.stderr!.on('data', (data) => {
      log.debug({ stderr: data.toString() }, 'Claude stderr');
    });

    this.isInitialized = true;
    this.startReadLoop();
  }

  async query(message: string): Promise<string> {
    await this.initialize();
    await this.acquireLock();

    try {
      if (!this.child?.stdin) {
        throw new Error('Claude process not initialized');
      }

      const userMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: message },
      };
      this.child.stdin.write(JSON.stringify(userMessage) + '\n');

      let fullText = '';
      const timeoutMs = 300_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Query timeout after 300s')), timeoutMs);
      });

      const nextWithTimeout = () => Promise.race([this.messageQueue.next(), timeoutPromise]);

      while (true) {
        const msg = await nextWithTimeout();

        if (msg.type === 'assistant') {
          const assistantMsg = msg as SDKAssistantMessage;
          for (const content of assistantMsg.message.content) {
            if (content.type === 'text' && content.text) fullText += content.text;
          }
        } else if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.is_error) {
            throw new Error(`Claude error: ${resultMsg.result ?? 'Unknown error'}`);
          }
          return (fullText.trim() || resultMsg.result) ?? '';
        }
      }
    } finally {
      this.releaseConsumerLock();
    }
  }

  async *queryStream(message?: string): AsyncGenerator<StreamChunk> {
    await this.initialize();
    await this.acquireLock();

    try {
      if (!this.child?.stdin) {
        yield { type: 'error', error: 'Claude process not initialized' };
        return;
      }

      // Send message if provided
      if (message !== undefined && message !== null) {
        const userMessage: SDKUserMessage = {
          type: 'user',
          message: { role: 'user', content: message },
        };
        this.child.stdin.write(JSON.stringify(userMessage) + '\n');
      }

      const timeoutMs = 300_000;
      let timeoutHandle: ReturnType<typeof setTimeout>;

      // Create a promise that resolves on permission request event
      const waitForPermissionRequest = (): Promise<{ type: 'permission_request'; requestId: string; toolName: string; input: unknown }> =>
        new Promise((resolve) => {
          const handler = (data: { requestId: string; toolName: string; input: unknown }) => {
            this.off('permissionRequest', handler);
            resolve({ type: 'permission_request', ...data });
          };
          this.once('permissionRequest', handler);
        });

      const nextWithTimeout = (): Promise<SDKMessage | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }> =>
        Promise.race([
          this.messageQueue.next(),
          waitForPermissionRequest(),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Timeout after 300s')), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timeoutHandle!));

      while (true) {
        const msgOrEvent = await nextWithTimeout();

        // Handle permission request event from HTTP flow
        if (msgOrEvent && typeof msgOrEvent === 'object' && 'type' in msgOrEvent && msgOrEvent.type === 'permission_request') {
          const event = msgOrEvent as { type: 'permission_request'; requestId: string; toolName: string; input: unknown };
          yield {
            type: 'permission_request',
            requestId: event.requestId,
            toolName: event.toolName,
            toolInput: event.input,
            content: `Claude requests to use tool: ${event.toolName}`,
          };
          continue;
        }

        const msg = msgOrEvent as SDKMessage;

        if (msg.type === 'system') {
          const sys = msg as SDKSystemMessage;
          yield {
            type: 'system',
            subtype: sys.subtype,
            session_id: sys.session_id,
            model: sys.model,
            cwd: sys.cwd,
            tools: sys.tools,
          };
        } else if (msg.type === 'log') {
          const logMsg = msg as SDKLog;
          yield {
            type: 'log',
            level: logMsg.log.level,
            message: logMsg.log.message,
          };
        } else if (msg.type === 'assistant') {
          const assistantMsg = msg as SDKAssistantMessage;
          for (const content of assistantMsg.message.content) {
            if (content.type === 'text' && content.text) {
              yield { type: 'text', content: content.text };
            } else if (content.type === 'tool_use' && content.name) {
              yield {
                type: 'tool_start',
                toolName: content.name,
                toolInput: content.input,
                toolUseId: content.id,
              };
            } else if (content.type === 'tool_result') {
              yield { type: 'tool_output', toolOutput: content, toolUseId: (content as { tool_use_id?: string }).tool_use_id };
            }
          }
        } else if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.is_error) {
            yield { type: 'error', error: resultMsg.result ?? 'Unknown error' };
          }
          yield { type: 'done' };
          return;
        }
      }
    } finally {
      this.releaseConsumerLock();
    }
  }

  isProcessAlive(): boolean {
    if (!this.child) return false;
    try {
      // Check if process is still running (kill -0 doesn't actually kill)
      process.kill(this.child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    for (const ctrl of this.cancelControllers.values()) ctrl.abort();
    this.cancelControllers.clear();
    if (this.child && !this.child.killed) {
      log.info('Destroying process');
      this.child.kill('SIGTERM');
    }
    this.rl?.close();
    this.isInitialized = false;
    this.readLoopStarted = false;
  }

  cancel(): void {
    this.destroy();
  }
}
