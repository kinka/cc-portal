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
            logger: {
                debug: (...args) => {
                    // 仅在主进程设置了 WECOM_DEBUG 或处于开发模式时输出 SDK 内部 debug 日志
                    if (process.env.WECOM_DEBUG === '1') {
                        log.debug({}, ...args);
                    }
                },
                info: (...args) => log.info({}, ...args),
                warn: (...args) => log.warn({}, ...args),
                error: (...args) => log.error({}, ...args),
            }
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

        // WeCom 侧的基础信息
        const body = frame.body as {
            from?: { userid?: string };
            sender?: string;
            chattype?: 'single' | 'group';
            chatid?: string;
        };

        const wecomUserId: string = body.from?.userid ?? body.sender ?? 'unknown';
        const isGroup = body.chattype === 'group';
        const chatid = body.chatid;

        log.debug({ frame }, 'Incoming WeCom Frame');

        // Session 路由逻辑：如果是群聊，使用 chatid 隔离；如果是私聊，使用 userid 隔离
        // 增加前缀以防止 userid 和 chatid 冲突
        const sessionKey = isGroup && chatid ? `group:${chatid}` : wecomUserId;

        log.info(
            { wecomUserId, sessionKey, isGroup, chatid, textLen: userText.length },
            'Received WeCom message'
        );

        try {
            // 查找或创建 cc-portal session
            // 传入 wecomUserId 作为 configOwnerId，确保会话继承说话人的工具配置
            const sessionId = await this.getOrCreateSession(sessionKey, wecomUserId, manager, storage);
            const session = await manager.getSession(sessionId, wecomUserId);

            if (!session) {
                log.error({ sessionKey, sessionId }, 'Session not found after creation');
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
                    let currentBuffer = buffer;
                    if (currentBuffer.length > 2000) {
                        currentBuffer = currentBuffer.substring(0, 1900) + '\n\n... (内容已达限额)';
                    }
                    await this.wsClient.replyStream(frame, streamId, currentBuffer, false);
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
                        let currentContent = buffer;
                        // 流式更新时，如果接近限额，提示用户后续会有更多消息
                        if (currentContent.length > 2000) {
                            currentContent = currentContent.substring(0, 1900) + '\n\n... (内容较长，将分段发送)';
                        }
                        await this.wsClient.replyStream(frame, streamId, currentContent, false);
                        lastSentLength = buffer.length;
                        lastSentTime = now;
                    }
                }
            } // end for await loop

            // 分段发送最终内容，确保不丢失信息
            const finalContent = buffer.trim() || '（无内容）';
            const segments = this.splitMessage(finalContent, 2000);

            for (let i = 0; i < segments.length; i++) {
                // 如果是第一段，复用已经开始的 streamId
                // 如果是后续段落，需要产生新的 reqId/streamId（虽然对 WeCom 来说都是独立回复）
                const currentId = i === 0 ? streamId : generateReqId('stream');
                await this.wsClient.replyStream(frame, currentId, segments[i], true);
            }

            log.info({ wecomUserId, sessionId, segments: segments.length }, 'WeCom multi-segment reply completed');
        } catch (err: any) {
            const errMsg = err?.message || err?.error || String(err);
            log.error({ err, wecomUserId, errMsg }, 'Failed to handle WeCom message');

            // 如果是对象，尝试详细字符串化
            let detailMsg = '';
            if (typeof err === 'object' && err !== null) {
                try {
                    detailMsg = JSON.stringify(err);
                } catch {
                    detailMsg = '[Unserializable Object]';
                }
            } else {
                detailMsg = String(err);
            }

            try {
                await this.wsClient.replyStream(
                    frame,
                    generateReqId('stream'),
                    `❌ 处理消息时出错：${detailMsg.substring(0, 1000)}`,
                    true,
                );
            } catch (replyErr) {
                log.error({ err: String(replyErr) }, 'Failed to send error reply');
            }
        }
    }

    /**
     * 获取或创建该 WeCom 用户对应的 cc-portal session
     */
    private async getOrCreateSession(
        sessionKey: string,
        initiatorUserId: string,
        manager: ClaudeSessionManager,
        storage: CLISessionStorage,
    ): Promise<string> {
        // 1. First check in-memory map
        let sessionId = this.userSessionMap.get(sessionKey);

        if (sessionId) {
            // Validate session is still active/valid in manager
            const session = await manager.getSession(sessionId, sessionKey);
            if (session) return sessionId;
            // session invalid or expired, remove from map
            this.userSessionMap.delete(sessionKey);
        }

        // 2. If not in memory, check storage for existing sessions (persistence across restarts)
        log.info({ sessionKey }, 'Checking storage for existing sessions');
        const existingSessions = await storage.listUserSessions(sessionKey);

        if (existingSessions.length > 0) {
            // Sort by lastModified descending and pick the newest one
            existingSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            const mostRecent = existingSessions[0];

            log.info({ sessionKey, sessionId: mostRecent.id, lastModified: mostRecent.lastModified }, 'Resuming existing session');
            this.userSessionMap.set(sessionKey, mostRecent.id);
            return mostRecent.id;
        }

        // 3. Create new session if none found
        log.info({ sessionKey }, 'Creating new cc-portal session');

        // Ensure user exists in storage
        await storage.getOrCreateUser(sessionKey);

        const session = await manager.createSession({
            ownerId: sessionKey,
            configOwnerId: initiatorUserId, // 关键：继承创建者的配置
            permissionMode: 'bypassPermissions',
        });

        this.userSessionMap.set(sessionKey, session.id);
        log.info({ sessionKey, sessionId: session.id }, 'Session created');
        return session.id;
    }

    /**
     * 将长文本切分为多个片段，尽量在换行符处切割
     */
    private splitMessage(text: string, maxLength: number): string[] {
        if (text.length <= maxLength) return [text];

        const segments: string[] = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                segments.push(remaining);
                break;
            }

            let splitIndex = -1;
            const chunk = remaining.substring(0, maxLength);

            // 优先在双换行切分（段落）
            splitIndex = chunk.lastIndexOf('\n\n');
            // 其次在单换行切分
            if (splitIndex < maxLength * 0.6) {
                splitIndex = chunk.lastIndexOf('\n');
            }
            // 实在不行在空格切分
            if (splitIndex < maxLength * 0.6) {
                splitIndex = chunk.lastIndexOf(' ');
            }
            // 如果都找不到合适的切分点，或者切分点太靠前，则强制切分
            if (splitIndex < maxLength * 0.2) {
                splitIndex = maxLength;
            }

            segments.push(remaining.substring(0, splitIndex).trim());
            remaining = remaining.substring(splitIndex).trim();
        }

        return segments;
    }
}
