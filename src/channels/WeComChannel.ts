/**
 * WeComChannel — 企业微信智能机器人长连接渠道
 *
 * 通过 @wecom/aibot-node-sdk 建立 WebSocket 长连接，
 * 将企业微信用户消息桥接到 cc-portal Claude 会话。
 */
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { ClaudeSessionManager } from '../ClaudeSessionManager';
import { CLISessionStorage } from '../CLISessionStorage';
import { createLogger } from '../logger';

const log = createLogger({ module: 'WeComChannel' });

export interface WeComChannelOptions {
    /** 企业微信后台获取的机器人 BotID */
    botId: string;
    /** 企业微信后台获取的机器人 Secret */
    secret: string;
    /** session 管理器 */
    manager: ClaudeSessionManager;
    /** 存储 */
    storage: CLISessionStorage;
    /** 用户目录 */
    usersDir?: string;
    /** 欢迎语，进入会话时发送 */
    welcomeMsg?: string;
    /** 最大并发回复 session 数，超出则排队 */
    maxConcurrent?: number;
}

export class WeComChannel {
    private wsClient: InstanceType<typeof AiBot.WSClient>;
    private options: Required<WeComChannelOptions>;

    /** 正在处理中的 WeCom userId → cc-portal sessionId 映射 */
    private userSessionMap: Map<string, string> = new Map();

    constructor(options: WeComChannelOptions) {
        this.options = {
            usersDir: './users',
            welcomeMsg: '你好！我是 Claude AI 助手，有什么可以帮你的吗？',
            maxConcurrent: 10,
            ...options,
        };

        this.wsClient = new AiBot.WSClient({
            botId: this.options.botId,
            secret: this.options.secret,
        });
    }

    connect(): this {
        const { wsClient } = this;

        wsClient.on('authenticated', () => {
            log.info({ botId: this.options.botId }, 'WeCom channel connected and authenticated');
        });

        wsClient.on('disconnected', (reason: string) => {
            log.warn({ reason }, 'WeCom channel disconnected');
        });

        wsClient.on('reconnecting', (attempt: number) => {
            log.info({ attempt }, 'WeCom channel reconnecting...');
        });

        // 用户进入会话时发送欢迎语
        wsClient.on('event.enter_chat', (frame: WsFrame) => {
            wsClient.replyWelcome(frame, {
                msgtype: 'text',
                text: { content: this.options.welcomeMsg },
            }).catch((err: Error) => {
                log.error({ err: String(err) }, 'Failed to send welcome message');
            });
        });

        // 处理文本消息
        wsClient.on('message.text', (frame: WsFrame) => {
            const content = frame.body?.text?.content as string | undefined;
            if (!content) return;
            this.handleMessage(frame, content).catch((err: Error) => {
                log.error({ err: String(err) }, 'Error handling WeCom text message');
            });
        });

        // 处理混合消息（文字+图片等）
        wsClient.on('message.mixed', (frame: WsFrame) => {
            // 提取文本部分
            const items = (frame.body?.mixed_msg?.items as Array<{ type: string; text?: { content: string } }>) ?? [];
            const textContent = items
                .filter((i) => i.type === 'text')
                .map((i) => i.text?.content ?? '')
                .join('\n')
                .trim();
            if (!textContent) return;
            this.handleMessage(frame, textContent).catch((err: Error) => {
                log.error({ err: String(err) }, 'Error handling WeCom mixed message');
            });
        });

        wsClient.connect();
        return this;
    }

    disconnect(): void {
        this.wsClient.disconnect();
        log.info('WeCom channel disconnected by application');
    }

    get isConnected(): boolean {
        return this.wsClient.isConnected;
    }

    /**
     * 处理用户消息，路由到对应的 cc-portal session 并流式回复
     */
    private async handleMessage(frame: WsFrame, userText: string): Promise<void> {
        const { manager, storage } = this.options;

        // WeCom 侧发消息的 userId（可能是 from 或 sender）
        const wecomUserId: string = (
            (frame.body as { from?: { userid?: string }; sender?: string }).from?.userid ??
            (frame.body as { sender?: string }).sender ??
            'unknown'
        );

        log.info({ wecomUserId, textLen: userText.length }, 'Received WeCom message');

        try {
            // 查找或创建 cc-portal session
            const sessionId = await this.getOrCreateSession(wecomUserId, manager, storage);
            const session = await manager.getSession(sessionId, wecomUserId);

            if (!session) {
                log.error({ wecomUserId, sessionId }, 'Session not found after creation');
                await this.wsClient.replyStream(frame, generateReqId('stream'), '❌ 会话初始化失败，请稍后重试。', true);
                return;
            }

            // 使用流式回复
            const streamId = generateReqId('stream');
            let lastSentLength = 0;
            let lastSentTime = Date.now();
            let buffer = '';
            const UPDATE_THRESHOLD_CHARS = 20;
            const UPDATE_THRESHOLD_MS = 500;

            log.debug({ wecomUserId, sessionId, streamId }, 'Starting streaming reply to WeCom');

            // 立即发送"思考中"状态
            await this.wsClient.replyStream(frame, streamId, '🤔 正在思考中...', false);
            lastSentLength = '🤔 正在思考中...'.length;

            const stream = session.sendMessageStream(userText, wecomUserId);

            for await (const chunk of stream) {
                // 跳过权限请求
                if (chunk.type === 'permission_request') {
                    const msg = '\n> ⚠️ 工具执行需要权限，在 WeCom 渠道已自动绕过或跳过。\n';
                    buffer += msg;
                    await this.wsClient.replyStream(frame, streamId, buffer, false);
                    lastSentLength = buffer.length;
                    continue;
                }

                let appendText = '';

                switch (chunk.type) {
                    case 'text':
                        appendText = chunk.content ?? '';
                        break;
                    case 'tool_start':
                        appendText = `\n> 🛠️ **正在调用工具**: \`${chunk.toolName}\`...\n`;
                        break;
                    case 'tool_output':
                    case 'tool_end':
                        if (chunk.type === 'tool_end' || (chunk.type === 'tool_output' && chunk.toolOutput)) {
                            appendText = `> ✅ 工具调用完成\n\n`;
                        }
                        break;
                    case 'error':
                        appendText = `\n> ❌ **错误**: ${chunk.error}\n`;
                        break;
                    case 'system':
                        if (chunk.subtype === 'init') {
                            appendText = `> 🔄 初始化会话...\n`;
                        }
                        break;
                }

                if (appendText) {
                    buffer += appendText;

                    // 节流处理：
                    // 1. 新增字符超过阈值
                    // 2. 或者距离上次发送超过一定时间
                    const now = Date.now();
                    const charsSinceLast = buffer.length - lastSentLength;
                    const timeSinceLast = now - lastSentTime;

                    if (charsSinceLast >= UPDATE_THRESHOLD_CHARS || timeSinceLast >= UPDATE_THRESHOLD_MS) {
                        await this.wsClient.replyStream(frame, streamId, buffer, false);
                        lastSentLength = buffer.length;
                        lastSentTime = now;
                    }
                }
            } // end for await loop

            // 发送最终完整内容（finish=true）
            const finalContent = buffer.trim() || '（无内容）';
            await this.wsClient.replyStream(frame, streamId, finalContent, true);

            log.info({ wecomUserId, sessionId }, 'WeCom stream reply completed');
        } catch (err) {
            log.error({ err: String(err), wecomUserId }, 'Failed to handle WeCom message');
            try {
                await this.wsClient.replyStream(
                    frame,
                    generateReqId('stream'),
                    `❌ 处理消息时出错：${String(err)}`,
                    true,
                );
            } catch {
                // 忽略回复失败
            }
        }
    }

    /**
     * 获取或创建该 WeCom 用户对应的 cc-portal session
     */
    private async getOrCreateSession(
        wecomUserId: string,
        manager: ClaudeSessionManager,
        storage: CLISessionStorage,
    ): Promise<string> {
        // 1. First check in-memory map
        let sessionId = this.userSessionMap.get(wecomUserId);

        if (sessionId) {
            // Validate session is still active/valid in manager
            const session = await manager.getSession(sessionId, wecomUserId);
            if (session) return sessionId;
            // session invalid or expired, remove from map
            this.userSessionMap.delete(wecomUserId);
        }

        // 2. If not in memory, check storage for existing sessions (persistence across restarts)
        log.info({ wecomUserId }, 'Checking storage for existing sessions for WeCom user');
        const existingSessions = await storage.listUserSessions(wecomUserId);

        if (existingSessions.length > 0) {
            // Sort by lastModified descending and pick the newest one
            existingSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            const mostRecent = existingSessions[0];

            log.info({ wecomUserId, sessionId: mostRecent.id, lastModified: mostRecent.lastModified }, 'Resuming existing session for WeCom user');
            this.userSessionMap.set(wecomUserId, mostRecent.id);
            return mostRecent.id;
        }

        // 3. Create new session if none found
        log.info({ wecomUserId }, 'Creating new cc-portal session for WeCom user');

        // Ensure user exists in storage
        await storage.getOrCreateUser(wecomUserId);

        const session = await manager.createSession({
            ownerId: wecomUserId,
            permissionMode: 'bypassPermissions',
        });

        this.userSessionMap.set(wecomUserId, session.id);
        log.info({ wecomUserId, sessionId: session.id }, 'WeCom session created');
        return session.id;
    }
}
