import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SessionRegistry } from './SessionRegistry';
import { createLogger } from '../logger';

const log = createLogger({ module: 'MessageRouter' });

const MAX_INBOX_SIZE = 1000;

export interface SessionMessage {
  id: string;
  fromSessionId: string;
  targetSessionId: string;
  fromUserId: string;
  type: 'notification' | 'request' | 'share_context' | 'delegate_task';
  content: string;
  payload?: Record<string, unknown>;
  requireResponse: boolean;
  timeoutMs?: number;
  createdAt: Date;
  readAt?: Date;
}

/**
 * Routes messages between active Claude sessions (Agent-to-Agent).
 * All data is in-memory; lost on service restart.
 */
export class MessageRouter extends EventEmitter {
  private messages = new Map<string, SessionMessage>();
  /** sessionId -> ordered list of messageIds in that session's inbox */
  private sessionInbox = new Map<string, string[]>();

  constructor(private registry: SessionRegistry) {
    super();
  }

  /**
   * Send a message to a specific session.
   * Returns the new message ID.
   */
  sendMessage(msg: Omit<SessionMessage, 'id' | 'createdAt'>): string {
    const id = randomUUID();
    const message: SessionMessage = { ...msg, id, createdAt: new Date() };

    this.messages.set(id, message);
    this.addToInbox(msg.targetSessionId, id);

    log.debug(
      { id, from: msg.fromSessionId, to: msg.targetSessionId, type: msg.type },
      'Message routed'
    );
    this.emit('message', { sessionId: msg.targetSessionId, message });
    return id;
  }

  /**
   * Broadcast a message to all sessions owned by userId,
   * optionally excluding certain session IDs.
   * Returns the list of created message IDs.
   */
  broadcastToUser(
    fromSessionId: string,
    userId: string,
    type: SessionMessage['type'],
    content: string,
    excludeSessionIds: string[] = [],
  ): string[] {
    const targets = this.registry
      .getSessionsByUser(userId)
      .filter(s => s.sessionId !== fromSessionId && !excludeSessionIds.includes(s.sessionId));

    const fromSession = this.registry.getSession(fromSessionId);
    const fromUserId = fromSession?.userId ?? userId;

    return targets.map(target =>
      this.sendMessage({
        fromSessionId,
        targetSessionId: target.sessionId,
        fromUserId,
        type,
        content,
        requireResponse: false,
      })
    );
  }

  /** Get unread messages for a session, ordered by createdAt ascending. */
  getUnreadMessages(sessionId: string): SessionMessage[] {
    return this.getMessages(sessionId).filter(m => !m.readAt);
  }

  /** Get all messages for a session, ordered by createdAt ascending. */
  getMessages(sessionId: string): SessionMessage[] {
    const ids = this.sessionInbox.get(sessionId) ?? [];
    return ids
      .map(id => this.messages.get(id))
      .filter((m): m is SessionMessage => m !== undefined);
  }

  /** Mark a message as read. Returns false if not found. */
  markAsRead(messageId: string): boolean {
    const msg = this.messages.get(messageId);
    if (!msg) return false;
    msg.readAt = new Date();
    return true;
  }

  // --- private ---

  private addToInbox(sessionId: string, messageId: string): void {
    if (!this.sessionInbox.has(sessionId)) {
      this.sessionInbox.set(sessionId, []);
    }
    const inbox = this.sessionInbox.get(sessionId)!;
    inbox.push(messageId);

    // Evict oldest messages if over limit
    if (inbox.length > MAX_INBOX_SIZE) {
      const evicted = inbox.splice(0, inbox.length - MAX_INBOX_SIZE);
      for (const id of evicted) {
        this.messages.delete(id);
      }
    }
  }
}
