import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
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

export class ClaudeAgentBackend {
  private cwd: string;
  private claudeSessionId: string;
  private model?: string;
  private allowedTools?: string[];
  private isFirstQuery = true;
  private child?: ChildProcessWithoutNullStreams;

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

  async query(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose'
      ];

      if (this.isFirstQuery) {
        args.push('--session-id', this.claudeSessionId);
        this.isFirstQuery = false;
      } else {
        args.push('--resume', this.claudeSessionId);
      }

      if (this.model) args.push('--model', this.model);
      if (this.allowedTools?.length) args.push('--allowedTools', this.allowedTools.join(','));

      logger.info(`[ClaudeAgent] Spawning: claude ${args.slice(0, 4).join(' ')}...`);

      // 使用本地安装的 claude 命令
      this.child = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      }) as ChildProcessWithoutNullStreams;

      let fullText = '';
      let resultMessage: SDKResultMessage | null = null;
      let errorOutput = '';
      let isCompleted = false;

      // 处理 stdout - JSON stream
      const rl = createInterface({ input: this.child.stdout! });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
          const msg = JSON.parse(line) as SDKMessage;

          switch (msg.type) {
            case 'assistant': {
              const assistantMsg = msg as SDKAssistantMessage;
              // 收集文本增量
              for (const content of assistantMsg.message.content) {
                if (content.type === 'text' && content.text) {
                  fullText += content.text;
                }
              }
              break;
            }

            case 'result': {
              resultMessage = msg as SDKResultMessage;
              isCompleted = true;
              // 收到 result 后关闭 stdin，让进程正常退出
              this.child?.stdin?.end();
              break;
            }

            case 'system': {
              const systemMsg = msg as SDKSystemMessage;
              logger.debug(`[Claude] System: ${systemMsg.subtype}`);
              break;
            }

            case 'log': {
              // 忽略日志消息
              break;
            }

            default:
              logger.debug(`[Claude] Unknown message type: ${msg.type}`);
          }
        } catch (e) {
          // 非 JSON 行，可能是调试输出
          logger.debug(`[Claude stdout] ${line}`);
        }
      });

      // 处理 stderr
      this.child.stderr!.on('data', (data) => {
        errorOutput += data.toString();
      });

      // 处理错误
      this.child.on('error', (error) => {
        reject(new Error(`Failed to spawn Claude: ${error.message}`));
      });

      // 处理退出
      this.child.on('close', (code) => {
        if (code !== 0 && !resultMessage && !fullText) {
          reject(new Error(`Claude exited with code ${code}: ${errorOutput}`));
          return;
        }

        if (resultMessage?.is_error) {
          reject(new Error(`Claude error: ${resultMessage.result || 'Unknown error'}`));
          return;
        }

        resolve(fullText.trim() || resultMessage?.result || '');
      });

      // 发送用户消息
      const userMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: message
        }
      };
      this.child.stdin!.write(JSON.stringify(userMessage) + '\n');

      // 2分钟超时
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill('SIGTERM');
          reject(new Error('Timeout'));
        }
      }, 120000);
    });
  }

  cancel(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }
}
