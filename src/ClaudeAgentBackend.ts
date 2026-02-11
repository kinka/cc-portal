import { randomUUID } from 'node:crypto';
import {
  AgentBackend,
  AgentBackendConfig,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from './AgentBackend';
import { query } from './sdk/query';
import type { Query } from './sdk/query';
import { SDKMessage, AbortError, QueryOptions } from './sdk/types';
import { logger } from './logger';

export interface ClaudeAgentBackendOptions extends AgentBackendConfig {
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
}

interface ActiveSession {
  id: SessionId;
  query: Query;
  abortController: AbortController;
  messageQueue: SDKMessage[];
  isRunning: boolean;
}

/**
 * Claude Agent Backend implementation using happy-cli SDK
 */
export class ClaudeAgentBackend implements AgentBackend {
  private config: ClaudeAgentBackendOptions;
  private messageHandlers: AgentMessageHandler[] = [];
  private sessions: Map<SessionId, ActiveSession> = new Map();

  constructor(config: ClaudeAgentBackendOptions) {
    this.config = config;
  }

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    const sessionId = randomUUID();
    const abortController = new AbortController();

    logger.info(`[ClaudeAgentBackend] Starting session ${sessionId}`);

    // Build query options
    const options: QueryOptions = {
      abort: abortController.signal,
      cwd: this.config.cwd,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: this.config.appendSystemPrompt,
      maxTurns: this.config.maxTurns ?? 100,
      model: this.config.model,
      mcpServers: this.config.mcpServers,
      // Note: canCallTool requires AsyncIterable prompt, skip for now
      // canCallTool: this.handleCanCallTool.bind(this),
    };

    // Create query
    const prompt = initialPrompt || 'Hello';
    const sdkQuery = query({ prompt, options });

    const session: ActiveSession = {
      id: sessionId,
      query: sdkQuery,
      abortController,
      messageQueue: [],
      isRunning: true,
    };

    this.sessions.set(sessionId, session);

    // Start processing messages
    this.processMessages(session);

    // Emit status
    this.emitMessage({ type: 'status', status: 'starting' });

    return { sessionId };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.debug(`[ClaudeAgentBackend] Sending prompt to session ${sessionId}`);

    // For now, we need to create a new query for each prompt
    // In a real implementation, we'd maintain a persistent connection
    const options: QueryOptions = {
      abort: session.abortController.signal,
      cwd: this.config.cwd,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      model: this.config.model,
      mcpServers: this.config.mcpServers,
      // Note: canCallTool requires AsyncIterable prompt, skip for now
      // canCallTool: this.handleCanCallTool.bind(this),
    };

    // Cancel previous query if running
    if (session.isRunning) {
      session.abortController.abort();
      // Create new abort controller for new query
      session.abortController = new AbortController();
      options.abort = session.abortController.signal;
    }

    // Create new query
    session.query = query({ prompt, options });
    session.isRunning = true;

    // Process messages
    this.processMessages(session);
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.info(`[ClaudeAgentBackend] Cancelling session ${sessionId}`);
    session.abortController.abort();
    session.isRunning = false;

    this.emitMessage({ type: 'status', status: 'idle' });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index > -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    // TODO: Implement permission handling
    logger.debug(`[ClaudeAgentBackend] Permission response: ${requestId} = ${approved}`);
    this.emitMessage({ type: 'permission-response', id: requestId, approved });
  }

  async waitForResponseComplete(_timeoutMs?: number): Promise<void> {
    // This method should be called per-session, but the interface doesn't support it
    // For now, just wait for all sessions to complete
    const timeout = _timeoutMs ?? 120000;
    const startTime = Date.now();
    while (Array.from(this.sessions.values()).some(s => s.isRunning)) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for response');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async dispose(): Promise<void> {
    logger.info('[ClaudeAgentBackend] Disposing...');

    // Cancel all sessions
    for (const [sessionId, session] of this.sessions) {
      await this.cancel(sessionId);
    }

    this.sessions.clear();
    this.messageHandlers = [];
  }

  private async processMessages(session: ActiveSession): Promise<void> {
    try {
      this.emitMessage({ type: 'status', status: 'running' });

      for await (const message of session.query) {
        if (session.abortController.signal.aborted) {
          break;
        }

        session.messageQueue.push(message);
        const agentMessage = this.convertSDKMessage(message);
        this.emitMessage(agentMessage);
      }

      session.isRunning = false;
      this.emitMessage({ type: 'status', status: 'idle' });

    } catch (error) {
      if (error instanceof AbortError) {
        logger.debug(`[ClaudeAgentBackend] Session ${session.id} aborted`);
        session.isRunning = false;
        this.emitMessage({ type: 'status', status: 'idle' });
      } else {
        logger.error(`[ClaudeAgentBackend] Session ${session.id} error:`, error);
        session.isRunning = false;
        this.emitMessage({
          type: 'error',
          error: String(error),
        });
        this.emitMessage({ type: 'status', status: 'error', detail: String(error) });
      }
    }
  }

  private convertSDKMessage(sdkMsg: SDKMessage): AgentMessage {
    const msg = sdkMsg as any;
    switch (msg.type) {
      case 'user':
        return {
          type: 'model-output',
          fullText: typeof msg.message?.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message?.content),
        };

      case 'assistant':
        const content = msg.message?.content;
        let text = '';
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              text += item.text;
            }
          }
        }
        return { type: 'model-output', textDelta: text, fullText: text };

      case 'result':
        return {
          type: 'model-output',
          fullText: msg.result || '',
        };

      case 'system':
        return {
          type: 'status',
          status: 'running',
          detail: `Model: ${msg.model || 'unknown'}`,
        };

      case 'log':
        return {
          type: 'terminal-output',
          data: msg.log?.message || '',
        };

      default:
        return {
          type: 'event',
          name: msg.type,
          payload: msg,
        };
    }
  }

  private async handleCanCallTool(
    toolName: string,
    input: unknown,
    _options: { signal: AbortSignal }
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    // Emit permission request
    const requestId = randomUUID();
    this.emitMessage({
      type: 'permission-request',
      id: requestId,
      reason: `Tool call: ${toolName}`,
      payload: { toolName, input },
    });

    // For now, auto-allow all tools
    // In a real implementation, you'd wait for user approval
    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
  }

  private emitMessage(message: AgentMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('[ClaudeAgentBackend] Error in message handler:', error);
      }
    }
  }
}
