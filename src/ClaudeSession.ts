import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeAgentBackend } from './ClaudeAgentBackend';
import { logger } from './logger';

export interface ClaudeSessionOptions {
  id: string;
  path: string;
  model?: string;
  allowedTools?: string[];
  envVars?: Record<string, string>;
  initialMessage?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export class ClaudeSession extends EventEmitter {
  readonly id: string;
  readonly path: string;
  readonly createdAt: Date;
  readonly claudeSessionId: string;
  private backend: ClaudeAgentBackend;
  private messages: Message[] = [];
  private _status: 'running' | 'stopped' = 'running';

  constructor(options: ClaudeSessionOptions) {
    super();
    this.id = options.id;
    this.path = options.path;
    this.createdAt = new Date();
    this.claudeSessionId = options.id; // Use session ID as Claude session ID

    this.backend = new ClaudeAgentBackend({
      cwd: options.path,
      claudeSessionId: this.claudeSessionId,
      model: options.model,
      allowedTools: options.allowedTools,
    });

    // Send initial message if provided
    if (options.initialMessage) {
      this.sendMessage(options.initialMessage).catch(err =>
        logger.error('Initial message failed:', err)
      );
    }
  }

  async sendMessage(content: string): Promise<string> {
    if (this._status !== 'running') {
      throw new Error('Session not running');
    }

    // Add user message
    this.messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    });

    // Query Claude
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

  getMessages(): Message[] {
    return [...this.messages];
  }

  get status() {
    return this._status;
  }

  stop() {
    this._status = 'stopped';
    this.emit('stopped');
  }
}
