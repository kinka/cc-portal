import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeAgentBackend, ClaudeAgentBackendOptions } from './ClaudeAgentBackend';
import { AgentMessage } from './AgentBackend';
import { logger } from './logger';

export interface ClaudeSessionOptions {
  id: string;
  path: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  envVars?: Record<string, string>;
  initialMessage?: string;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: {
    thinking?: boolean;
    toolCalls?: any[];
    error?: string;
    status?: string;
  };
}

export class ClaudeSession extends EventEmitter {
  readonly id: string;
  readonly path: string;
  readonly createdAt: Date;
  private messages: Message[] = [];
  private backend: ClaudeAgentBackend;
  private _status: 'starting' | 'running' | 'stopped' | 'error' = 'starting';
  private _lastActivityAt: Date | null = null;
  private messageCallbacks: ((message: Message) => void)[] = [];
  private currentResponseBuffer: string = '';
  private options: ClaudeSessionOptions;
  private sessionId: string | null = null;

  constructor(options: ClaudeSessionOptions) {
    super();
    this.id = options.id;
    this.path = options.path;
    this.options = options;
    this.createdAt = new Date();

    // Create backend config
    const backendConfig: ClaudeAgentBackendOptions = {
      cwd: options.path,
      agentName: 'claude',
      transport: 'native-claude',
      env: options.envVars,
      model: options.model,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      customSystemPrompt: options.customSystemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: options.maxTurns,
      mcpServers: options.mcpServers,
    };

    this.backend = new ClaudeAgentBackend(backendConfig);

    // Register message handler
    this.backend.onMessage(this.handleAgentMessage.bind(this));
  }

  async start(): Promise<void> {
    logger.info(`[Session ${this.id}] Starting Claude Code via SDK...`);
    this._status = 'starting';

    try {
      const result = await this.backend.startSession(this.options.initialMessage);
      this.sessionId = result.sessionId;
      this._status = 'running';
      this._lastActivityAt = new Date();

      logger.success(`[Session ${this.id}] Claude Code started, session: ${this.sessionId}`);

      this.emit('started', { sessionId: this.sessionId });
    } catch (error) {
      this._status = 'error';
      logger.error(`[Session ${this.id}] Failed to start:`, error);
      throw error;
    }
  }

  private handleAgentMessage(msg: AgentMessage): void {
    this._lastActivityAt = new Date();

    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          this.currentResponseBuffer += msg.textDelta;
        }
        if (msg.fullText) {
          // Final output
          const message: Message = {
            id: randomUUID(),
            role: 'assistant',
            content: msg.fullText,
            timestamp: new Date(),
          };
          this.messages.push(message);
          this.notifyMessageCallbacks(message);
          this.emit('message', message);
          this.currentResponseBuffer = '';
        }
        break;

      case 'tool-call':
        const toolMessage: Message = {
          id: randomUUID(),
          role: 'system',
          content: `Tool call: ${msg.toolName}`,
          timestamp: new Date(),
          metadata: { toolCalls: [{ name: msg.toolName, args: msg.args }] },
        };
        this.messages.push(toolMessage);
        this.notifyMessageCallbacks(toolMessage);
        break;

      case 'tool-result':
        const resultMessage: Message = {
          id: randomUUID(),
          role: 'system',
          content: `Tool result: ${JSON.stringify(msg.result)}`,
          timestamp: new Date(),
        };
        this.messages.push(resultMessage);
        this.notifyMessageCallbacks(resultMessage);
        break;

      case 'status':
        this._status = msg.status as any;
        const statusMessage: Message = {
          id: randomUUID(),
          role: 'system',
          content: `Status: ${msg.status}${msg.detail ? ` - ${msg.detail}` : ''}`,
          timestamp: new Date(),
          metadata: { status: msg.status },
        };
        this.messages.push(statusMessage);
        this.notifyMessageCallbacks(statusMessage);
        break;

      case 'error':
        const errorMessage: Message = {
          id: randomUUID(),
          role: 'system',
          content: `Error: ${msg.error}`,
          timestamp: new Date(),
          metadata: { error: msg.error },
        };
        this.messages.push(errorMessage);
        this.notifyMessageCallbacks(errorMessage);
        this.emit('error', new Error(msg.error));
        break;

      case 'terminal-output':
        // Log terminal output but don't add to messages
        logger.debug(`[Session ${this.id}] Terminal:`, msg.data);
        break;
    }
  }

  async sendMessage(content: string): Promise<string> {
    if (this._status !== 'running') {
      throw new Error('Session is not running');
    }

    // Add user message to history
    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    };
    this.messages.push(userMessage);
    this.notifyMessageCallbacks(userMessage);

    // Clear response buffer
    this.currentResponseBuffer = '';

    // Send to backend
    if (!this.sessionId) {
      throw new Error('Session not initialized');
    }

    await this.backend.sendPrompt(this.sessionId, content);
    this._lastActivityAt = new Date();

    // Wait for response (this is a simplified version)
    // In a real implementation, you'd wait for the model-output with fullText
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Response timeout'));
      }, 120000);

      const checkResponse = () => {
        // Find the last assistant message after our user message
        const userIndex = this.messages.findIndex(m => m.id === userMessage.id);
        const assistantMessages = this.messages.slice(userIndex + 1).filter(m => m.role === 'assistant');

        if (assistantMessages.length > 0) {
          clearTimeout(timeout);
          resolve(assistantMessages[assistantMessages.length - 1].content);
        } else {
          setTimeout(checkResponse, 100);
        }
      };

      checkResponse();
    });
  }

  onMessage(callback: (message: Message) => void): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      const index = this.messageCallbacks.indexOf(callback);
      if (index > -1) {
        this.messageCallbacks.splice(index, 1);
      }
    };
  }

  private notifyMessageCallbacks(message: Message): void {
    for (const callback of this.messageCallbacks) {
      try {
        callback(message);
      } catch (error) {
        logger.error('Error in message callback:', error);
      }
    }
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  get status(): 'starting' | 'running' | 'stopped' | 'error' {
    return this._status;
  }

  get lastActivityAt(): Date | null {
    return this._lastActivityAt;
  }

  async stop(): Promise<void> {
    logger.info(`[Session ${this.id}] Stopping...`);

    if (this.sessionId) {
      await this.backend.cancel(this.sessionId);
    }

    await this.backend.dispose();
    this._status = 'stopped';
    this.emit('stopped');
  }

  cleanup(): void {
    this.stop().catch(err => logger.error('Error during cleanup:', err));
    this.messageCallbacks = [];
    this.removeAllListeners();
  }
}
