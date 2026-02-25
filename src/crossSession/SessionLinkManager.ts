import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { SessionRegistry } from './SessionRegistry';
import type { UserDirectory } from './UserDirectory';
import { createLogger } from '../logger';

const log = createLogger({ module: 'SessionLinkManager' });

export interface SessionLink {
  id: string;
  initiatorSessionId: string;
  initiatorUserId: string;
  /** null until the invitation is accepted */
  targetSessionId: string | null;
  targetUserId: string;
  mode: 'bidirectional' | 'readonly';
  status: 'pending' | 'active' | 'disconnected';
  initialMessage?: string;
  createdAt: Date;
  acceptedAt?: Date;
}

export interface LinkedMessage {
  fromSessionId: string;
  fromUserId: string;
  fromUserName: string;
  content: string;
  timestamp: Date;
  isMention: boolean;
}

/**
 * Manages direct-connect links between two Claude sessions.
 * Used for "digital avatar" real-time dialogue.
 *
 * Flow:
 *   1. Session A calls createLink(targetUserId) → returns pending SessionLink
 *   2. Target user sees invitation via getPendingInvitations(userId)
 *   3. Target session calls acceptLink(linkId, targetSessionId) → status becomes 'active'
 *   4. Either side sends messages via sendLinkedMessage(linkId, message)
 *   5. Recipients subscribe to 'linked_message' event or poll
 */
export class SessionLinkManager extends EventEmitter {
  private links = new Map<string, SessionLink>();

  constructor(
    private registry: SessionRegistry,
    private directory: UserDirectory,
  ) {
    super();
  }

  /**
   * Create a link invitation from initiator session to a target user.
   * The target user must accept before messages can flow.
   */
  createLink(
    initiatorSessionId: string,
    initiatorUserId: string,
    targetUserId: string,
    mode: 'bidirectional' | 'readonly' = 'bidirectional',
    initialMessage?: string,
  ): SessionLink {
    const link: SessionLink = {
      id: randomUUID(),
      initiatorSessionId,
      initiatorUserId,
      targetSessionId: null,
      targetUserId,
      mode,
      status: 'pending',
      initialMessage,
      createdAt: new Date(),
    };
    this.links.set(link.id, link);
    log.debug(
      { linkId: link.id, from: initiatorUserId, to: targetUserId },
      'Session link invitation created'
    );
    this.emit('link_created', link);
    return link;
  }

  /**
   * Accept a pending invitation.
   * @param linkId - the invitation to accept
   * @param targetSessionId - the accepting user's current session ID
   */
  acceptLink(linkId: string, targetSessionId: string): boolean {
    const link = this.links.get(linkId);
    if (!link || link.status !== 'pending') return false;

    link.targetSessionId = targetSessionId;
    link.status = 'active';
    link.acceptedAt = new Date();

    log.debug({ linkId, targetSessionId }, 'Session link accepted');
    this.emit('link_accepted', link);
    return true;
  }

  declineLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link || link.status !== 'pending') return false;
    link.status = 'disconnected';
    log.debug({ linkId }, 'Session link declined');
    this.emit('link_declined', { linkId });
    return true;
  }

  disconnect(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link || link.status === 'disconnected') return false;
    link.status = 'disconnected';
    log.debug({ linkId }, 'Session link disconnected');
    this.emit('link_disconnected', { linkId });
    return true;
  }

  /** Disconnect all active/pending links involving a session (call on session destroy). */
  disconnectAll(sessionId: string): void {
    for (const link of this.links.values()) {
      if (
        (link.initiatorSessionId === sessionId || link.targetSessionId === sessionId) &&
        link.status !== 'disconnected'
      ) {
        this.disconnect(link.id);
      }
    }
  }

  /**
   * Send a message through an active link.
   * Emits 'linked_message' event so the other side can receive it.
   */
  sendLinkedMessage(linkId: string, message: LinkedMessage): boolean {
    const link = this.links.get(linkId);
    if (!link || link.status !== 'active') return false;

    // Determine which session should receive the message
    const targetSessionId =
      message.fromSessionId === link.initiatorSessionId
        ? link.targetSessionId
        : link.initiatorSessionId;

    if (!targetSessionId) return false;

    log.debug(
      { linkId, from: message.fromSessionId, to: targetSessionId },
      'Linked message sent'
    );
    this.emit('linked_message', { linkId, message, targetSessionId });
    return true;
  }

  /**
   * Get all links for a session.
   * @param status - filter by status; 'all' returns everything
   */
  getLinks(sessionId: string, status: 'active' | 'pending' | 'all' = 'all'): SessionLink[] {
    return Array.from(this.links.values()).filter(link => {
      const involved =
        link.initiatorSessionId === sessionId || link.targetSessionId === sessionId;
      if (!involved) return false;
      if (status === 'all') return true;
      return link.status === status;
    });
  }

  /** Get pending invitations where this user is the target (not yet accepted). */
  getPendingInvitations(userId: string): SessionLink[] {
    return Array.from(this.links.values()).filter(
      link => link.targetUserId === userId && link.status === 'pending'
    );
  }

  /**
   * Parse +user-id mentions from message text.
   * e.g. "+lisi 看看这个" → ["lisi"]
   */
  static parseMentions(text: string): string[] {
    const regex = /\+([a-zA-Z0-9_-]+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      mentions.push(match[1]);
    }
    return [...new Set(mentions)];
  }
}
