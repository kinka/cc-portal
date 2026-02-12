import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { logger } from './logger';

/**
 * SDK Message types from Claude Code
 */
export interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

export interface SDKAssistantMessage extends SDKMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
}

export interface SDKResultMessage extends SDKMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result?: string;
  num_turns: number;
  session_id: string;
  is_error: boolean;
}

export interface SDKSystemMessage extends SDKMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
  model?: string;
}

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_end' | 'tool_output' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  error?: string;
}

export class ClaudeAgentBackend {
  private cwd: string;
  private claudeSessionId: string;
  private model?: string;
  private allowedTools?: string[];
  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private isInitialized = false;

  constructor(options: {
    cwd: string;
    claudeSessionId: string;
    model?: string;
    allowedTools?: string[];
  }) {
    this.cwd = options.cwd;
    this.claudeSessionId = options.claudeSessionId;
    this.model = options.model;
    this.allowedTools = options.allowedTools;
  }

  // 初始化进程（只调用一次）
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--session-id', this.claudeSessionId
    ];

    if (this.model) args.push('--model', this.model);
    if (this.allowedTools?.length) args.push('--allowedTools', this.allowedTools.join(','));

    logger.info(`[ClaudeAgent] Initializing: claude ${args.slice(0, 4).join(' ')}...`);

    this.child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    this.rl = createInterface({ input: this.child.stdout! });

    // 处理进程错误
    this.child.on('error', (error) => {
      logger.error(`[ClaudeAgent] Process error: ${error.message}`);
      this.isInitialized = false;
    });

    // 处理进程退出
    this.child.on('close', (code) => {
      logger.info(`[ClaudeAgent] Process exited with code ${code}`);
      this.isInitialized = false;
      this.rl?.close();
    });

    // 处理 stderr
    this.child.stderr!.on('data', (data) => {
      logger.debug(`[Claude stderr] ${data.toString()}`);
    });

    this.isInitialized = true;
  }

  async query(message: string): Promise<string> {
    await this.initialize();

    return new Promise((resolve, reject) => {
      if (!this.child || !this.rl) {
        reject(new Error('Claude process not initialized'));
        return;
      }

      let fullText = '';
      let resultMessage: SDKResultMessage | null = null;
      let timeoutHandle: NodeJS.Timeout;

      const lineHandler = (line: string) => {
        if (!line.trim()) return;

        try {
          const msg = JSON.parse(line) as SDKMessage;

          switch (msg.type) {
            case 'assistant': {
              const assistantMsg = msg as SDKAssistantMessage;
              for (const content of assistantMsg.message.content) {
                if (content.type === 'text' && content.text) {
                  fullText += content.text;
                }
              }
              break;
            }

            case 'result': {
              resultMessage = msg as SDKResultMessage;
              cleanup();

              if (resultMessage.is_error) {
                reject(new Error(`Claude error: ${resultMessage.result || 'Unknown error'}`));
              } else {
                resolve(fullText.trim() || resultMessage.result || '');
              }
              break;
            }

            case 'system': {
              const systemMsg = msg as SDKSystemMessage;
              logger.debug(`[Claude] System: ${systemMsg.subtype}`);
              break;
            }

            case 'log': {
              break;
            }

            default:
              logger.debug(`[Claude] Unknown message type: ${msg.type}`);
          }
        } catch (e) {
          logger.debug(`[Claude stdout] ${line}`);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.rl?.off('line', lineHandler);
      };

      // 监听输出
      this.rl.on('line', lineHandler);

      // 发送用户消息
      const userMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: message
        }
      };
      this.child.stdin!.write(JSON.stringify(userMessage) + '\n');

      // 5分钟超时
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Query timeout after 300s'));
      }, 300000);
    });
  }

  // 流式查询 - 实时返回 chunks
  async *queryStream(message: string): AsyncGenerator<StreamChunk> {
    await this.initialize();

    if (!this.child || !this.rl) {
      yield { type: 'error', error: 'Claude process not initialized' };
      return;
    }

    let resultMessage: SDKResultMessage | null = null;
    const buffer: StreamChunk[] = [];
    let resolveNext: (() => void) | null = null;
    let isDone = false;
    let timeoutHandle: NodeJS.Timeout;

    const lineHandler = (line: string) => {
      if (!line.trim()) return;

      try {
        const msg = JSON.parse(line) as SDKMessage;

        switch (msg.type) {
          case 'assistant': {
            const assistantMsg = msg as SDKAssistantMessage;
            for (const content of assistantMsg.message.content) {
              if (content.type === 'text' && content.text) {
                buffer.push({ type: 'text', content: content.text });
              } else if (content.type === 'tool_use' && content.name) {
                buffer.push({
                  type: 'tool_start',
                  toolName: content.name,
                  toolInput: content.input
                });
              } else if (content.type === 'tool_result') {
                buffer.push({
                  type: 'tool_output',
                  toolOutput: content
                });
              }
            }
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
            break;
          }

          case 'result': {
            resultMessage = msg as SDKResultMessage;
            if (resultMessage.is_error) {
              buffer.push({ type: 'error', error: resultMessage.result || 'Unknown error' });
            }
            buffer.push({ type: 'done' });
            isDone = true;
            if (resolveNext) resolveNext();
            break;
          }

          case 'system': {
            const systemMsg = msg as SDKSystemMessage;
            logger.debug(`[Claude] System: ${systemMsg.subtype}`);
            break;
          }

          case 'log': {
            break;
          }

          default:
            logger.debug(`[Claude] Unknown message type: ${msg.type}`);
        }
      } catch (e) {
        logger.debug(`[Claude stdout] ${line}`);
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      this.rl?.off('line', lineHandler);
    };

    // 监听输出
    this.rl.on('line', lineHandler);

    // 发送用户消息
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: message
      }
    };
    this.child.stdin!.write(JSON.stringify(userMessage) + '\n');

    // 超时处理 - 5分钟
    timeoutHandle = setTimeout(() => {
      buffer.push({ type: 'error', error: 'Timeout after 300s' });
      isDone = true;
      if (resolveNext) resolveNext();
    }, 300000);

    // 生成器循环
    try {
      while (!isDone || buffer.length > 0) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
        } else {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      }
    } finally {
      cleanup();
    }
  }

  // 销毁进程
  destroy(): void {
    if (this.child && !this.child.killed) {
      logger.info('[ClaudeAgent] Destroying process');
      this.child.kill('SIGTERM');
    }
    this.rl?.close();
    this.isInitialized = false;
  }

  // 兼容旧的 cancel 方法
  cancel(): void {
    this.destroy();
  }
}
